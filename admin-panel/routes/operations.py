"""Operational routes for orders, customer memory, analytics, and chat logs."""

import base64
import os
import requests
from datetime import datetime, timedelta, timezone
import json
import re
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from flask import Blueprint, current_app, jsonify, request
from werkzeug.utils import secure_filename

from admin_core.auth import login_required, require_internal_auth
from admin_core.db import get_db
from admin_core.helpers import merge_profile, normalize_wa_number, wa_number_variants


operations_bp = Blueprint('operations', __name__)

PAYMENT_PROOF_MIME_EXT = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
}


def _product_code(data):
    explicit = re.sub(r'[^A-Za-z0-9]', '', str(data.get('product_code') or '')).upper()
    if explicit:
        return explicit[:6]

    product = str(data.get('product') or '').upper()
    if 'SUKUMBA' in product:
        return 'SB'

    words = re.findall(r'[A-Z0-9]+', product)
    if len(words) >= 2:
        return ''.join(word[0] for word in words[:2])[:6]
    if words:
        return words[0][:2]
    return 'XX'


def _next_public_order_id(cursor, order_dt, product_code):
    prefix = f"OID{order_dt.strftime('%y%m%d')}{product_code}"
    row = cursor.execute(
        '''SELECT MAX(CAST(SUBSTR(public_order_id, ?) AS INTEGER)) AS last_seq
           FROM orders
           WHERE public_order_id LIKE ?''',
        (len(prefix) + 1, f'{prefix}%'),
    ).fetchone()
    next_seq = int(row['last_seq'] or 0) + 1
    return f'{prefix}{next_seq:03d}'


def _order_datetime():
    tz_name = os.getenv('ORDER_ID_TIMEZONE') or os.getenv('TZ') or 'Asia/Jakarta'
    try:
        return datetime.now(ZoneInfo(tz_name))
    except ZoneInfoNotFoundError:
        return datetime.now(timezone(timedelta(hours=7)))


def _existing_order_datetime(row, fallback_dt):
    raw_timestamp = str(row['timestamp'] or '').strip() if 'timestamp' in row.keys() else ''
    if raw_timestamp:
        try:
            return datetime.fromisoformat(raw_timestamp[:19])
        except ValueError:
            pass
    return fallback_dt


def _ensure_public_order_id(cursor, row, fallback_dt):
    if row['public_order_id']:
        return row['public_order_id']
    product_code = row['product_code'] or _product_code({'product': row['product'] or ''})
    public_order_id = _next_public_order_id(
        cursor,
        _existing_order_datetime(row, fallback_dt),
        product_code,
    )
    cursor.execute(
        'UPDATE orders SET public_order_id=?, product_code=? WHERE id=?',
        (public_order_id, product_code, row['id']),
    )
    return public_order_id


def _wa_gateway_urls():
    primary = os.getenv('WA_GATEWAY_URL', 'http://127.0.0.1:3000').rstrip('/')
    urls = [primary]
    fallback = 'http://127.0.0.1:3000'
    if primary != fallback:
        urls.append(fallback)
    return urls


def _send_wa_message(user_number, message):
    headers = {}
    internal_key = os.getenv('INTERNAL_API_KEY', '').strip()
    if internal_key:
        headers['X-Internal-Key'] = internal_key
    raw_number = str(user_number or '').strip()
    normalized = normalize_wa_number(raw_number)
    recipient = normalized
    if raw_number and '@' in raw_number:
        recipient = raw_number
    elif normalized and not (normalized.startswith('62') or normalized.startswith('0') or normalized.startswith('8')):
        recipient = f'{normalized}@lid'
    last_error = None
    for base_url in _wa_gateway_urls():
        try:
            res = requests.post(
                f'{base_url}/send-message',
                json={'to': recipient, 'message': message},
                headers=headers,
                timeout=6,
            )
            if res.ok:
                return True, ''
            last_error = f'HTTP {res.status_code}: {res.text[:200]}'
        except Exception as exc:
            last_error = str(exc)
    return False, last_error or 'WA gateway tidak tersedia'


def _payment_status_message(status):
    if status == 'valid':
        return (
            'Pembayaran Kakak sudah tervalidasi ya 🙏🏻\n\n'
            'Pesanan akan segera CS Syifa proses untuk pengiriman.\n'
            'Mohon pastikan nomor HP aktif. Resi akan CS Syifa infokan setelah paket diproses.'
        )
    if status == 'invalid':
        return (
            'Kak, bukti transfernya belum bisa kami validasi ya.\n\n'
            'Boleh kirim ulang bukti transfer yang lebih jelas, atau pastikan nominal dan rekening tujuannya sudah sesuai 🙏🏻'
        )
    return ''


@operations_bp.route('/api/orders', methods=['POST'])
@require_internal_auth
def create_order():
    data = request.json or {}
    now_dt = _order_datetime()
    now = now_dt.strftime('%Y-%m-%d %H:%M:%S')
    user_number = normalize_wa_number(data.get('user_number'))
    idempotency_key = str(data.get('idempotency_key') or '').strip()
    source = str(data.get('source') or 'WhatsApp').strip()[:40]

    if not user_number:
        return jsonify({'success': False, 'error': 'user_number wajib diisi'}), 400

    with get_db() as conn:
        c = conn.cursor()
        c.execute('BEGIN IMMEDIATE')
        if idempotency_key:
            existing = c.execute(
                'SELECT id, timestamp, public_order_id, product_code, product FROM orders WHERE idempotency_key=?',
                (idempotency_key,)
            ).fetchone()
            if existing:
                public_order_id = _ensure_public_order_id(c, existing, now_dt)
                return jsonify({
                    'success': True,
                    'id': existing['id'],
                    'order_id': public_order_id,
                    'public_order_id': public_order_id,
                    'duplicate': True,
                })

        product_code = _product_code(data)
        public_order_id = _next_public_order_id(c, now_dt, product_code)
        c.execute('''INSERT INTO orders
            (timestamp, public_order_id, product_code, user_number, user_name, phone, address, product, quantity,
             notes, status, total, idempotency_key, source, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)''',
            (data.get('timestamp', now), public_order_id, product_code, user_number, data.get('user_name'),
             data.get('phone'), data.get('address'), data.get('product'),
             data.get('quantity'), data.get('notes'), data.get('total', '-'),
             idempotency_key, source, now))
        db_order_id = c.lastrowid
    current_app.logger.info(f"Order created: #{public_order_id} (db #{db_order_id})")
    return jsonify({
        'success': True,
        'id': db_order_id,
        'order_id': public_order_id,
        'public_order_id': public_order_id,
    })


@operations_bp.route('/api/orders', methods=['GET'])
@login_required
def get_orders():
    status = request.args.get('status', '')
    with get_db() as conn:
        c = conn.cursor()
        if status:
            c.execute('SELECT * FROM orders WHERE status=? ORDER BY id DESC', (status,))
        else:
            c.execute('SELECT * FROM orders ORDER BY id DESC')
        return jsonify([dict(row) for row in c.fetchall()])


@operations_bp.route('/api/orders/<int:order_id>', methods=['PUT'])
@login_required
def update_order(order_id):
    data = request.json or {}
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with get_db() as conn:
        c = conn.cursor()
        c.execute('UPDATE orders SET status=?, updated_at=? WHERE id=?', (data.get('status'), now, order_id))
    return jsonify({'success': True})


@operations_bp.route('/api/orders/<int:order_id>', methods=['DELETE'])
@login_required
def delete_order(order_id):
    with get_db() as conn:
        c = conn.cursor()
        c.execute('DELETE FROM orders WHERE id=?', (order_id,))
    return jsonify({'success': True})


def _latest_matching_order_id(cursor, user_number):
    variants = wa_number_variants(user_number)
    placeholders = ','.join(['?'] * len(variants))
    row = cursor.execute(
        f'''SELECT id FROM orders
            WHERE user_number IN ({placeholders})
              AND status != 'cancelled'
            ORDER BY id DESC
            LIMIT 1''',
        variants,
    ).fetchone()
    return row['id'] if row else None


@operations_bp.route('/api/payment-proofs', methods=['POST'])
@require_internal_auth
def create_payment_proof():
    data = request.json or {}
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    user_number = normalize_wa_number(data.get('user_number'))
    caption = str(data.get('caption') or '').strip()[:500]
    mime_type = str(data.get('mime_type') or 'image/jpeg').split(';')[0].strip().lower()
    amount = str(data.get('amount') or '').strip()[:80]
    media_base64 = str(data.get('media_base64') or '').strip()
    order_id = data.get('order_id')

    if not user_number:
        return jsonify({'success': False, 'error': 'user_number wajib diisi'}), 400
    if mime_type not in PAYMENT_PROOF_MIME_EXT:
        return jsonify({'success': False, 'error': 'format bukti transfer tidak didukung'}), 400
    if not media_base64:
        return jsonify({'success': False, 'error': 'media_base64 wajib diisi'}), 400

    try:
        raw = base64.b64decode(media_base64, validate=True)
    except Exception:
        return jsonify({'success': False, 'error': 'media_base64 tidak valid'}), 400
    if len(raw) > 8 * 1024 * 1024:
        return jsonify({'success': False, 'error': 'ukuran bukti transfer terlalu besar'}), 400

    ext = PAYMENT_PROOF_MIME_EXT[mime_type]
    folder = os.path.join(current_app.config['UPLOAD_FOLDER'], 'payment_proofs')
    os.makedirs(folder, exist_ok=True)
    filename = secure_filename(f"{int(datetime.now().timestamp())}_{user_number}_{uuid4().hex[:10]}.{ext}")
    filepath = os.path.join(folder, filename)
    with open(filepath, 'wb') as f:
        f.write(raw)
    try:
        os.chmod(filepath, 0o644)
    except OSError:
        current_app.logger.debug("Could not chmod payment proof", exc_info=True)
    media_url = f'/static/uploads/payment_proofs/{filename}'

    with get_db() as conn:
        c = conn.cursor()
        if not order_id:
            order_id = _latest_matching_order_id(c, user_number)
        c.execute('''INSERT INTO payment_proofs
            (order_id, user_number, caption, media_url, mime_type, amount, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)''',
            (order_id, user_number, caption, media_url, mime_type, amount, now, now))
        proof_id = c.lastrowid

    current_app.logger.info(f"Payment proof created: #{proof_id} user={user_number} order={order_id or '-'}")
    return jsonify({'success': True, 'proof_id': proof_id, 'order_id': order_id, 'media_url': media_url})


@operations_bp.route('/api/payment-proofs', methods=['GET'])
@login_required
def get_payment_proofs():
    status = request.args.get('status', '').strip()
    with get_db() as conn:
        c = conn.cursor()
        base = '''SELECT pp.*, o.public_order_id, o.user_name, o.phone, o.product, o.total, o.status AS order_status
                  FROM payment_proofs pp
                  LEFT JOIN orders o ON o.id = pp.order_id'''
        if status:
            c.execute(base + ' WHERE pp.status=? ORDER BY pp.id DESC', (status,))
        else:
            c.execute(base + ' ORDER BY pp.id DESC')
        return jsonify([dict(row) for row in c.fetchall()])


@operations_bp.route('/api/payment-proofs/<int:proof_id>', methods=['PUT'])
@login_required
def update_payment_proof(proof_id):
    data = request.json or {}
    status = str(data.get('status') or '').strip()
    note = str(data.get('reviewer_note') or '').strip()[:500]
    if status not in {'pending', 'valid', 'invalid'}:
        return jsonify({'success': False, 'error': 'status tidak valid'}), 400
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    wa_sent = False
    wa_error = ''
    with get_db() as conn:
        c = conn.cursor()
        proof = c.execute('SELECT id, user_number, status FROM payment_proofs WHERE id=?', (proof_id,)).fetchone()
        if not proof:
            return jsonify({'success': False, 'error': 'bukti transfer tidak ditemukan'}), 404
        c.execute('UPDATE payment_proofs SET status=?, reviewer_note=?, updated_at=? WHERE id=?',
                  (status, note, now, proof_id))
        should_notify = status in {'valid', 'invalid'} and proof['status'] != status
        message = _payment_status_message(status) if should_notify else ''
        if message:
            wa_sent, wa_error = _send_wa_message(proof['user_number'], message)
            if wa_sent:
                c.execute('INSERT INTO conversation_history (user_number, role, content, timestamp) VALUES (?, ?, ?, ?)',
                          (proof['user_number'], 'assistant', message, now))
            else:
                current_app.logger.warning(f"Payment proof #{proof_id} WA notification failed: {wa_error}")
    return jsonify({'success': True, 'wa_sent': wa_sent, 'wa_error': wa_error})


@operations_bp.route('/api/conversation/history/<user_number>', methods=['GET'])
@require_internal_auth
def get_conversation_history(user_number):
    limit = request.args.get('limit', 10, type=int)
    limit = min(max(limit, 1), 100)
    variants = wa_number_variants(user_number)
    placeholders = ','.join(['?'] * len(variants))
    with get_db() as conn:
        c = conn.cursor()
        c.execute(f'''SELECT role, content, timestamp FROM conversation_history
                     WHERE user_number IN ({placeholders}) ORDER BY id DESC LIMIT ?''', (*variants, limit))
        history = list(reversed([dict(row) for row in c.fetchall()]))
    return jsonify(history)


@operations_bp.route('/api/conversation/history', methods=['POST'])
@require_internal_auth
def save_conversation_history():
    data = request.json
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    user_number = normalize_wa_number(data.get('user_number'))
    with get_db() as conn:
        c = conn.cursor()
        c.execute('INSERT INTO conversation_history (user_number, role, content, timestamp) VALUES (?, ?, ?, ?)',
                  (user_number, data.get('role'), data.get('content'), data.get('timestamp', now)))
    return jsonify({'success': True})


@operations_bp.route('/api/conversation/history/<user_number>', methods=['DELETE'])
@require_internal_auth
def clear_conversation_history(user_number):
    variants = wa_number_variants(user_number)
    placeholders = ','.join(['?'] * len(variants))
    with get_db() as conn:
        c = conn.cursor()
        c.execute(f'DELETE FROM conversation_history WHERE user_number IN ({placeholders})', variants)
    return jsonify({'success': True})


@operations_bp.route('/api/customer-profile/<user_number>', methods=['GET'])
@require_internal_auth
def get_customer_profile(user_number):
    normalized = normalize_wa_number(user_number)
    variants = wa_number_variants(user_number)
    placeholders = ','.join(['?'] * len(variants))
    with get_db() as conn:
        c = conn.cursor()
        c.execute(f'''SELECT user_number, profile_json, summary, updated_at
                      FROM customer_profiles
                      WHERE user_number IN ({placeholders})
                      ORDER BY CASE WHEN user_number=? THEN 0 ELSE 1 END
                      LIMIT 1''', (*variants, normalized))
        row = c.fetchone()

    if not row:
        return jsonify({'user_number': normalized, 'profile': {}, 'summary': '', 'updated_at': ''})

    try:
        profile = json.loads(row['profile_json'] or '{}')
    except Exception:
        profile = {}
    return jsonify({
        'user_number': normalized,
        'stored_user_number': row['user_number'],
        'profile': profile,
        'summary': row['summary'] or '',
        'updated_at': row['updated_at'] or '',
    })


@operations_bp.route('/api/customer-profile/<user_number>', methods=['POST'])
@require_internal_auth
def update_customer_profile(user_number):
    data = request.json or {}
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    normalized = normalize_wa_number(user_number)
    variants = wa_number_variants(user_number)
    placeholders = ','.join(['?'] * len(variants))
    updates = data.get('profile_updates') or data.get('profile') or {}
    summary = data.get('summary')

    with get_db() as conn:
        c = conn.cursor()
        c.execute(f'''SELECT user_number, profile_json, summary, created_at
                      FROM customer_profiles
                      WHERE user_number IN ({placeholders})
                      ORDER BY CASE WHEN user_number=? THEN 0 ELSE 1 END
                      LIMIT 1''', (*variants, normalized))
        row = c.fetchone()

        if row:
            try:
                current = json.loads(row['profile_json'] or '{}')
            except Exception:
                current = {}
            merged = merge_profile(current, updates)
            next_summary = summary if summary is not None else (row['summary'] or '')
            c.execute(f'''DELETE FROM customer_profiles
                          WHERE user_number IN ({placeholders}) AND user_number != ?''',
                      (*variants, normalized))
            c.execute('''INSERT OR REPLACE INTO customer_profiles
                         (user_number, profile_json, summary, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?)''',
                      (normalized, json.dumps(merged, ensure_ascii=False), next_summary, row['created_at'] or now, now))
        else:
            merged = merge_profile({}, updates)
            c.execute('''INSERT INTO customer_profiles
                         (user_number, profile_json, summary, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?)''',
                      (normalized, json.dumps(merged, ensure_ascii=False), summary or '', now, now))

    return jsonify({'success': True, 'profile': merged})


@operations_bp.route('/api/customer-memory/<user_number>', methods=['DELETE'])
@login_required
def reset_customer_memory(user_number):
    normalized = normalize_wa_number(user_number)
    if not normalized:
        return jsonify({'success': False, 'error': 'Nomor WA tidak valid'}), 400
    variants = wa_number_variants(user_number)
    placeholders = ','.join(['?'] * len(variants))

    with get_db() as conn:
        c = conn.cursor()
        c.execute(f'DELETE FROM conversation_history WHERE user_number IN ({placeholders})', variants)
        history_deleted = c.rowcount
        c.execute(f'DELETE FROM customer_profiles WHERE user_number IN ({placeholders})', variants)
        profile_deleted = c.rowcount

    current_app.logger.info(f"Customer memory reset: {normalized}")
    return jsonify({
        'success': True,
        'user_number': normalized,
        'history_deleted': history_deleted,
        'profile_deleted': profile_deleted,
    })


@operations_bp.route('/api/analytics', methods=['GET'])
@login_required
def get_analytics():
    today = datetime.now().strftime('%Y-%m-%d')
    with get_db() as conn:
        c = conn.cursor()
        c.execute('SELECT COUNT(*) FROM conversation_logs')
        total = c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM conversation_logs WHERE timestamp LIKE ?", (today + '%',))
        today_count = c.fetchone()[0]
        c.execute('SELECT COUNT(DISTINCT user_number) FROM conversation_logs')
        unique_users = c.fetchone()[0]
        c.execute("""SELECT DATE(timestamp) as day, COUNT(*) as count FROM conversation_logs
                     WHERE timestamp >= DATE('now', '-7 days') GROUP BY day ORDER BY day""")
        daily = [{'day': r[0], 'count': r[1]} for r in c.fetchall()]
        c.execute("""SELECT user_number, COUNT(*) as count FROM conversation_logs
                     GROUP BY user_number ORDER BY count DESC LIMIT 5""")
        top_users = [{'number': r[0], 'count': r[1]} for r in c.fetchall()]
    return jsonify({'total': total, 'today': today_count, 'unique_users': unique_users,
                    'daily': daily, 'top_users': top_users})


@operations_bp.route('/api/logs', methods=['GET'])
@login_required
def get_logs():
    page = request.args.get('page', 1, type=int)
    limit = 20
    with get_db() as conn:
        c = conn.cursor()
        c.execute('SELECT * FROM conversation_logs ORDER BY id DESC LIMIT ? OFFSET ?',
                  (limit, (page - 1) * limit))
        logs = [dict(row) for row in c.fetchall()]
        c.execute('SELECT COUNT(*) FROM conversation_logs')
        total = c.fetchone()[0]
    return jsonify({'logs': logs, 'total': total, 'page': page})


@operations_bp.route('/api/log-conversation', methods=['POST'])
@require_internal_auth
def log_conversation():
    data = request.json
    with get_db() as conn:
        c = conn.cursor()
        c.execute('''INSERT INTO conversation_logs (timestamp, user_number, user_message, ai_response, kb_context) VALUES (?, ?, ?, ?, ?)''',
                  (data.get('timestamp'), data.get('user_number'),
                   data.get('user_message'), data.get('ai_response'), data.get('kb_context', '')))
    return jsonify({'success': True})
