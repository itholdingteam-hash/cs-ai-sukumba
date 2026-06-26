"""Integration proxy routes for WhatsApp gateway and AI service."""

import re

import requests
from flask import Blueprint, jsonify, request

from admin_core.auth import login_required
from admin_core.db import get_db


BENEFIT_IMAGE_URL = '/static/uploads/manfaat-sukumba-sendi.jpeg'


def _is_testimonial_request(text):
    return re.search(r'\b(testimoni|testimomi|testimonial|review|ulasan|bukti|hasil)\b', str(text or ''), re.IGNORECASE)


def _is_benefit_request(text):
    return re.search(r'\b(manfaat|khasiat|kegunaan|fungsi|faedah)\b', str(text or ''), re.IGNORECASE)


def _load_photo_catalog():
    catalog = []
    with get_db() as conn:
        products = conn.execute("""
            SELECT id, name, image_url
            FROM products
            WHERE active = 1 AND COALESCE(image_url, '') != ''
        """).fetchall()
        faqs = conn.execute("""
            SELECT id, question, answer, image_url
            FROM faqs
            WHERE active = 1 AND COALESCE(image_url, '') != ''
        """).fetchall()
        testimonials = conn.execute("""
            SELECT id, title, caption, media_url, media_type
            FROM testimonials
            WHERE active = 1 AND COALESCE(media_url, '') != ''
            ORDER BY sort_order ASC, id DESC
        """).fetchall()

    for row in products:
        catalog.append({
            'type': 'product',
            'id': row['id'],
            'name': row['name'],
            'url': row['image_url'],
        })
    for row in faqs:
        catalog.append({
            'type': 'faq',
            'id': row['id'],
            'name': row['question'],
            'answer': row['answer'] or '',
            'url': row['image_url'],
        })
    for row in testimonials:
        catalog.append({
            'type': 'testimonial',
            'id': row['id'],
            'name': row['title'],
            'answer': row['caption'] or '',
            'url': row['media_url'],
            'media_type': row['media_type'] or 'image',
        })
    return catalog


def _benefit_media_from_catalog(catalog):
    for item in catalog:
        haystack = f"{item.get('name', '')} {item.get('answer', '')} {item.get('url', '')}".lower()
        if re.search(r'manfaat|khasiat', haystack) and re.search(r'sukumba|sendi|pegal|nyeri|linu', haystack):
            clean_item = dict(item)
            clean_item['name'] = ''
            return clean_item
    return {
        'type': 'faq',
        'id': 'benefit',
        'name': '',
        'url': BENEFIT_IMAGE_URL,
    }


def _media_for_chat_request(user_text, ai_text, catalog):
    media = []
    clean_text = str(ai_text or '')
    for match in re.finditer(r'\[PHOTO:(product|faq|testimonial):(\d+)\]', clean_text, re.IGNORECASE):
        media_type = match.group(1).lower()
        media_id = int(match.group(2))
        item = next((row for row in catalog if row.get('type') == media_type and row.get('id') == media_id), None)
        if item:
            media.append(item)
    clean_text = re.sub(r'\[PHOTO:(product|faq|testimonial):\d+\]', '', clean_text, flags=re.IGNORECASE).strip()

    if not media and _is_benefit_request(user_text):
        media.append(_benefit_media_from_catalog(catalog))

    if not media and _is_testimonial_request(user_text):
        media.extend([item for item in catalog if item.get('type') == 'testimonial'][:3])

    unique = []
    seen = set()
    for item in media:
        url = item.get('url') or ''
        if not url or url in seen:
            continue
        seen.add(url)
        unique.append({
            'type': item.get('type') or 'media',
            'id': item.get('id'),
            'name': item.get('name') or '',
            'url': url,
            'media_type': item.get('media_type') or ('video' if re.search(r'\.(mp4|mov|webm)(\?.*)?$', url, re.IGNORECASE) else 'image'),
        })
    return clean_text, unique


def create_integrations_bp(config, limiter, logger):
    bp = Blueprint('integrations', __name__)
    internal_headers = {'X-Internal-Key': config.internal_api_key} if config.internal_api_key else {}

    def wa_gateway_request(method, path, json_data=None, timeout=5):
        last_error = None
        for url in config.wa_gateway_urls:
            full_url = f"{url.rstrip('/')}/{path.lstrip('/')}"
            try:
                if method == 'get':
                    return requests.get(full_url, headers=internal_headers, timeout=timeout)
                if method == 'post':
                    return requests.post(full_url, json=json_data, headers=internal_headers, timeout=timeout)
                raise ValueError(f"Unsupported method: {method}")
            except Exception as exc:
                logger.warning(f"WA gateway attempt failed for {full_url}: {exc}")
                last_error = exc
        raise last_error

    @bp.route('/api/wa/status', methods=['GET'])
    @limiter.exempt
    @login_required
    def wa_status():
        try:
            res = wa_gateway_request('get', '/wa-status', timeout=5)
            return jsonify(res.json())
        except Exception as exc:
            logger.error(f"WA status error: {exc}")
            return jsonify({'status': 'error', 'message': str(exc)})

    @bp.route('/api/wa/qr', methods=['GET'])
    @limiter.exempt
    @login_required
    def wa_qr():
        try:
            res = wa_gateway_request('get', '/wa-qr', timeout=5)
            return jsonify(res.json())
        except Exception as exc:
            logger.error(f"WA QR error: {exc}")
            return jsonify({'success': False, 'error': str(exc)})

    @bp.route('/api/wa/reconnect', methods=['POST'])
    @limiter.limit("20 per minute")
    @login_required
    def wa_reconnect():
        try:
            res = wa_gateway_request('post', '/wa-reconnect', timeout=5)
            return jsonify(res.json())
        except Exception as exc:
            logger.error(f"WA reconnect error: {exc}")
            return jsonify({'success': False, 'error': str(exc)})

    @bp.route('/api/wa/reset-session', methods=['POST'])
    @limiter.limit("10 per minute")
    @login_required
    def wa_reset_session():
        try:
            res = wa_gateway_request('post', '/wa-reset-session', timeout=5)
            return jsonify(res.json())
        except Exception as exc:
            logger.error(f"WA reset session error: {exc}")
            return jsonify({'success': False, 'error': str(exc)})

    @bp.route('/api/wa/disconnect', methods=['POST'])
    @limiter.limit("20 per minute")
    @login_required
    def wa_disconnect():
        try:
            res = wa_gateway_request('post', '/wa-disconnect', timeout=5)
            return jsonify(res.json())
        except Exception as exc:
            logger.error(f"WA disconnect error: {exc}")
            return jsonify({'success': False, 'error': str(exc)})

    @bp.route('/api/chat-proxy', methods=['POST'])
    @login_required
    def chat_proxy():
        try:
            payload_in = request.get_json(silent=True) or {}
            catalog = _load_photo_catalog()
            payload_to_ai = dict(payload_in)
            payload_to_ai.setdefault('photoCatalog', catalog)
            res = requests.post(
                f'{config.ai_url}/ai-chat',
                json=payload_to_ai,
                headers=internal_headers,
                timeout=30
            )
            try:
                payload = res.json()
            except Exception:
                payload = {'error': res.text[:300] or f'AI service HTTP {res.status_code}'}
            if not res.ok:
                return jsonify(payload), res.status_code
            try:
                message = payload.get('choices', [{}])[0].get('message', {})
                reply = message.get('content', '')
                clean_reply, media = _media_for_chat_request(payload_in.get('content', ''), reply, catalog)
                message['content'] = clean_reply
                payload['choices'][0]['message'] = message
                payload['_media'] = media
            except Exception as exc:
                logger.warning(f"Chat proxy media enrichment failed: {exc}")
            return jsonify(payload)
        except Exception as exc:
            logger.error(f"Chat proxy error: {exc}")
            return jsonify({'error': str(exc)}), 500

    return bp
