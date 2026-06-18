"""Integration proxy routes for WhatsApp gateway and AI service."""

import requests
from flask import Blueprint, jsonify, request

from admin_core.auth import login_required


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
            res = requests.post(
                f'{config.ai_url}/ai-chat',
                json=request.json,
                headers=internal_headers,
                timeout=30
            )
            try:
                payload = res.json()
            except Exception:
                payload = {'error': res.text[:300] or f'AI service HTTP {res.status_code}'}
            if not res.ok:
                return jsonify(payload), res.status_code
            return jsonify(payload)
        except Exception as exc:
            logger.error(f"Chat proxy error: {exc}")
            return jsonify({'error': str(exc)}), 500

    return bp
