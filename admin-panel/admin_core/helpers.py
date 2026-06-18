"""Pure helper functions shared by admin panel routes."""

import json
import re


def allowed_file(filename, allowed_extensions):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in allowed_extensions


def normalize_wa_number(value):
    digits = re.sub(r'\D+', '', str(value or ''))
    if digits.startswith('0'):
        return '62' + digits[1:]
    if digits.startswith('8'):
        return '62' + digits
    if digits.startswith('620'):
        return '62' + digits[3:]
    return digits


def wa_number_variants(value):
    raw = re.sub(r'\D+', '', str(value or ''))
    normalized = normalize_wa_number(raw)
    variants = [normalized]
    if raw and raw not in variants:
        variants.append(raw)
    if normalized.startswith('62'):
        local_zero = '0' + normalized[2:]
        local_plain = normalized[2:]
        if local_zero not in variants:
            variants.append(local_zero)
        if local_plain not in variants:
            variants.append(local_plain)
    return [v for v in variants if v]


def merge_profile(existing, updates):
    if not isinstance(existing, dict):
        existing = {}
    if not isinstance(updates, dict):
        return existing

    allowed = {
        'name', 'age', 'customer_context', 'complaint', 'complaint_detail', 'duration',
        'diabetes', 'hypertension', 'heart_issue', 'medication', 'sleep',
        'smoking', 'stress', 'lifestyle', 'red_flags', 'last_offer',
        'objection', 'order_readiness', 'delivery_status', 'follow_up_stage',
        'conversation_mode', 'consultation_topic', 'consultation_stage',
        'consultation_goal', 'next_question', 'asked_questions',
        'active_flow', 'active_stage', 'last_question_id',
        'pending_slot', 'last_offer_type', 'state_confidence', 'topic',
        'last_order_id',
    }
    for key, value in updates.items():
        if key not in allowed:
            continue
        if value in (None, '', [], {}):
            continue
        existing[key] = value
    return existing


def is_sukumba_product_row(product):
    features = product.get('features', [])
    if not isinstance(features, list):
        features = []
    text = ' '.join([
        str(product.get('name', '')),
        str(product.get('price', '')),
        str(product.get('speed', '')),
        ' '.join(features),
        str(product.get('description', '')),
        str(product.get('target', '')),
    ]).lower()
    if re.search(r'\b(mbps|wifi|fiber|internet|modem|instalasi|berlangganan|paket home)\b', text):
        return False
    return bool(re.search(r'\b(sukumba|susu|kuda|sumbawa|herbal|stamina|vitalitas)\b', text))


def product_features_from_json(value):
    try:
        return json.loads(value)
    except Exception:
        return []


def normalize_media_type(media_url):
    return 'video' if str(media_url or '').lower().endswith(('.mp4', '.mov', '.webm')) else 'image'


def parse_money(value):
    if value is None:
        return 0
    digits = re.sub(r'\D+', '', str(value))
    return int(digits) if digits else 0


def format_rupiah(value):
    amount = parse_money(value)
    return 'Rp ' + f'{amount:,}'.replace(',', '.')


def normalize_location(value):
    text = re.sub(r'\s+', ' ', str(value or '').strip()).lower()
    text = re.sub(r'^(kab\.?|kabupaten)\s+', '', text)
    text = re.sub(r'^(kec\.?|kecamatan)\s+', '', text)
    return text
