#!/usr/bin/env python3
"""
Sukumba Admin Panel - Refactored Version
Fitur: Security Hardened + Export XLS + Context Manager DB

Deploy:
    1. cp .env /home/tunet/admin-panel/.env
    2. pip install flask python-dotenv flask-limiter openpyxl
    3. python3 app.py
"""

from flask import Flask, render_template, request, jsonify, session, redirect, url_for, send_file
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from contextlib import contextmanager
from datetime import datetime
from werkzeug.utils import secure_filename
from functools import wraps
import sqlite3
import json
import requests
import os
import time
import logging
import re
import io

# ------------------------------------------------------------------
# 0. ENVIRONMENT SETUP
# ------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
from dotenv import load_dotenv
load_dotenv(os.path.join(BASE_DIR, '.env'))

DB_FILE  = os.getenv('DB_PATH', os.path.join(BASE_DIR, 'admin_panel.db'))
SECRET_KEY       = os.getenv('SECRET_KEY', os.urandom(32))
ADMIN_PASSWORD   = os.getenv('ADMIN_PASSWORD', 'ganti-password-default!')
INTERNAL_API_KEY = os.getenv('INTERNAL_API_KEY', '')
TELEGRAM_BOT_TOKEN = os.getenv('TELEGRAM_BOT_TOKEN', '')
WA_GATEWAY_URL = os.getenv('WA_GATEWAY_URL', 'http://127.0.0.1:3000').rstrip('/')
AI_URL = os.getenv('AI_URL', 'http://127.0.0.1:5000').rstrip('/')
DEFAULT_WA_GATEWAY_URL = 'http://127.0.0.1:3000'
WA_GATEWAY_URLS = [WA_GATEWAY_URL]
if WA_GATEWAY_URL != DEFAULT_WA_GATEWAY_URL:
    WA_GATEWAY_URLS.append(DEFAULT_WA_GATEWAY_URL)

UPLOAD_FOLDER = os.path.join(BASE_DIR, 'static', 'uploads')
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'mp4', 'mov', 'webp'}

# ------------------------------------------------------------------
# 1. LOGGING
# ------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler(os.path.join(BASE_DIR, 'admin_panel.log')),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)
logger.info(f"WA gateway: {WA_GATEWAY_URL}")
logger.info(f"AI service: {AI_URL}")

# ------------------------------------------------------------------
# 2. FLASK APP
# ------------------------------------------------------------------
app = Flask(__name__)
app.secret_key = SECRET_KEY
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024

limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    default_limits=["2000 per hour"],
    storage_uri="memory://"
)

# ------------------------------------------------------------------
# 3. DATABASE LAYER (Context Manager)
# ------------------------------------------------------------------
@contextmanager
def get_db():
    """Context manager untuk koneksi database. Auto-commit & close."""
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        conn.close()

def init_db():
    """Inisialisasi database dengan semua tabel."""
    with get_db() as conn:
        c = conn.cursor()
        
        c.execute('''CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY, value TEXT NOT NULL)''')
        
        c.execute('''CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
            price TEXT NOT NULL, speed TEXT NOT NULL, features TEXT NOT NULL,
            promo TEXT, target TEXT, image_url TEXT, description TEXT,
            active INTEGER DEFAULT 1)''')
        
        c.execute('''CREATE TABLE IF NOT EXISTS faqs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL,
            answer TEXT NOT NULL, image_url TEXT, active INTEGER DEFAULT 1)''')
        
        c.execute('''CREATE TABLE IF NOT EXISTS conversation_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
            user_number TEXT, user_message TEXT, ai_response TEXT, kb_context TEXT)''')
        
        c.execute('''CREATE TABLE IF NOT EXISTS conversation_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_number TEXT,
            role TEXT, content TEXT, timestamp TEXT)''')

        c.execute('''CREATE TABLE IF NOT EXISTS customer_profiles (
            user_number TEXT PRIMARY KEY,
            profile_json TEXT DEFAULT '{}',
            summary TEXT DEFAULT '',
            created_at TEXT,
            updated_at TEXT)''')
        
        c.execute('''CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT,
            user_number TEXT, user_name TEXT, phone TEXT, address TEXT,
            product TEXT, quantity TEXT, notes TEXT, status TEXT DEFAULT 'new', total TEXT)''')
        
        c.execute('''CREATE TABLE IF NOT EXISTS closings (
            id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, created_at TEXT,
            user_wa TEXT, raw_text TEXT, nama TEXT DEFAULT '', alamat TEXT DEFAULT '',
            telepon TEXT DEFAULT '', kode_pos TEXT DEFAULT '', berat TEXT DEFAULT '1',
            harga_non_cod TEXT DEFAULT '', nilai_cod TEXT DEFAULT '', produk TEXT DEFAULT '',
            kelurahan TEXT DEFAULT '', qty TEXT DEFAULT '1', instruksi TEXT DEFAULT '',
            courier TEXT DEFAULT '', gudang TEXT DEFAULT '', status TEXT DEFAULT 'draft',
            source TEXT DEFAULT 'Manual')''')
        
        c.execute('''CREATE TABLE IF NOT EXISTS telegram_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL, created_at TEXT)''')
        
        # Migration untuk DB lama
        for col, default in [('image_url', "''"), ('description', "''")]:
            try: c.execute(f'ALTER TABLE products ADD COLUMN {col} TEXT DEFAULT {default}')
            except: pass
        for col in ['image_url']:
            try: c.execute(f'ALTER TABLE faqs ADD COLUMN {col} TEXT')
            except: pass
        for col, default in [('source', "'Manual'"), ('created_at', "''")]:
            try: c.execute(f'ALTER TABLE closings ADD COLUMN {col} TEXT DEFAULT {default}')
            except: pass
        
        # Default Settings
        defaults = {
            'company_name':    'Sukumba',
            'company_location':'Perumahan Puri Permata Alam Blok C No.11, Purwosari, Baturraden, Banyumas',
            'company_hours':   'Chat WA: 24 jam | Kantor: Senin-Sabtu 08:00-17:00',
            'company_contact': '6281997437474',
            'llm_provider':    'openrouter',
            'llm_api_url':     'https://openrouter.ai/api/v1/chat/completions',
            'llm_api_key':     '',
            'ai_model':        'qwen/qwen3-32b:free',
            'ai_temperature':  '0.7',
            'ai_max_tokens':   '600',
            'groq_api_key':    '',
            'telegram_bot_token': TELEGRAM_BOT_TOKEN,
            'prompt_greeting':
                'Kamu CS Sukumba — Susu Kuda Sumbawa Premium. Sambut customer hangat, '
                'tanya apakah Kakak ingin info produk atau konsultasi dulu. '
                'Jangan langsung jualan atau paksa order di pesan pertama. Maksimal 2 kalimat.',
            'prompt_product':
                'Kamu CS Sukumba. Jawab pertanyaan produk dengan informatif, singkat, dan natural. '
                'Jelaskan manfaat yang relevan saja. Jangan memaksa order kecuali customer sudah minat beli. '
                'Maksimal 3 kalimat.',
            'prompt_order':
                'Kamu Order Agent Sukumba. Bantu customer order step by step: konfirmasi '
                'produk & jumlah, minta nama/HP/alamat lengkap. Tanya satu per satu. '
                'Maksimal 2 kalimat.',
            'prompt_escalation':
                'Kamu Customer Care Sukumba. Tangani komplain dengan empati. Minta maaf, '
                'kumpulkan detail masalah (no order, tanggal beli), informasikan tim akan '
                'follow up segera. Maksimal 3 kalimat.',
        }
        for key, value in defaults.items():
            c.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', (key, value))
        
        logger.info(f"Database initialized at: {DB_FILE}")


# ------------------------------------------------------------------
# 4. HELPERS
# ------------------------------------------------------------------
def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def get_setting(key):
    with get_db() as conn:
        c = conn.cursor()
        c.execute('SELECT value FROM settings WHERE key = ?', (key,))
        result = c.fetchone()
        return result[0] if result else None

def set_setting(key, value):
    with get_db() as conn:
        c = conn.cursor()
        c.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', (key, value))

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

def require_internal_auth(f):
    """Decorator: cek X-Internal-Key header untuk antar-service calls."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        key = request.headers.get('X-Internal-Key', '')
        if session.get('logged_in'):
            return f(*args, **kwargs)
        if INTERNAL_API_KEY and key != INTERNAL_API_KEY:
            # Allow localhost tanpa key (backward compat)
            if request.remote_addr not in ('127.0.0.1', '::1', '172.31.6.3'):
                return jsonify({'error': 'Unauthorized'}), 401
        return f(*args, **kwargs)
    return wrapper

def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get('logged_in'):
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    wrapper.__name__ = f.__name__
    return wrapper


# ------------------------------------------------------------------
# 5. AUTH
# ------------------------------------------------------------------
@app.route('/login', methods=['GET', 'POST'])
@limiter.limit("10 per minute")
def login():
    if request.method == 'POST':
        if request.form.get('password') == ADMIN_PASSWORD:
            session['logged_in'] = True
            session['login_time'] = datetime.now().isoformat()
            logger.info(f"Admin login dari {request.remote_addr}")
            return redirect(url_for('dashboard'))
        logger.warning(f"Login gagal dari {request.remote_addr}")
        return render_template('login.html', error='Password salah!')
    return render_template('login.html')

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))

@app.route('/')
@login_required
def dashboard():
    return render_template('dashboard.html', company_name=get_setting('company_name') or 'Admin Panel')


# ------------------------------------------------------------------
# 6. SETTINGS
# ------------------------------------------------------------------
@app.route('/api/settings', methods=['GET'])
@login_required
def get_settings_api():
    with get_db() as conn:
        c = conn.cursor()
        c.execute('SELECT key, value FROM settings')
        settings = {row[0]: row[1] for row in c.fetchall()}
    return jsonify(settings)

@app.route('/api/settings', methods=['POST'])
@login_required
def update_settings():
    for key, value in request.json.items():
        # Jangan expose groq_api_key dan telegram_bot_token di response
        set_setting(key, value)
    logger.info("Settings updated")
    return jsonify({'success': True})

@app.route('/api/public/settings', methods=['GET'])
@require_internal_auth
def public_settings():
    with get_db() as conn:
        c = conn.cursor()
        c.execute('SELECT key, value FROM settings')
        settings = {row[0]: row[1] for row in c.fetchall()}
    return jsonify(settings)


# ------------------------------------------------------------------
# 7. PRODUCTS
# ------------------------------------------------------------------
@app.route('/api/products', methods=['GET'])
@login_required
def get_products():
    with get_db() as conn:
        c = conn.cursor()
        c.execute('SELECT * FROM products WHERE active = 1 ORDER BY id DESC')
        products = [dict(row) for row in c.fetchall()]
    for p in products:
        try: p['features'] = json.loads(p['features'])
        except: p['features'] = []
    return jsonify(products)

@app.route('/api/products', methods=['POST'])
@login_required
def add_product():
    data = request.json
    if not data or 'name' not in data or 'price' not in data:
        return jsonify({'success': False, 'error': 'Nama dan harga wajib diisi'}), 400
    with get_db() as conn:
        c = conn.cursor()
        c.execute('''INSERT INTO products (name, price, speed, features, promo, target, image_url, description, active)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)''',
                  (data['name'], data['price'], data.get('speed', ''),
                   json.dumps(data.get('features', [])),
                   data.get('promo', ''), data.get('target', ''),
                   data.get('image_url', ''), data.get('description', '')))
        product_id = c.lastrowid
    logger.info(f"Product added: #{product_id}")
    return jsonify({'success': True, 'id': product_id})

@app.route('/api/products/<int:product_id>', methods=['PUT'])
@login_required
def update_product(product_id):
    data = request.json
    with get_db() as conn:
        c = conn.cursor()
        c.execute('''UPDATE products SET name=?, price=?, speed=?, features=?, promo=?, target=?, image_url=?, description=?
                     WHERE id=?''',
                  (data['name'], data['price'], data.get('speed', ''),
                   json.dumps(data.get('features', [])),
                   data.get('promo', ''), data.get('target', ''),
                   data.get('image_url', ''), data.get('description', ''),
                   product_id))
    return jsonify({'success': True})

@app.route('/api/products/<int:product_id>', methods=['DELETE'])
@login_required
def delete_product(product_id):
    with get_db() as conn:
        c = conn.cursor()
        c.execute('UPDATE products SET active = 0 WHERE id = ?', (product_id,))
    return jsonify({'success': True})

@app.route('/api/public/products', methods=['GET'])
def public_products():
    with get_db() as conn:
        c = conn.cursor()
        c.execute('SELECT * FROM products WHERE active = 1')
        products = [dict(row) for row in c.fetchall()]
    for p in products:
        try: p['features'] = json.loads(p['features'])
        except: p['features'] = []
    products = [p for p in products if is_sukumba_product_row(p)]
    return jsonify(products)


# ------------------------------------------------------------------
# 8. FAQs
# ------------------------------------------------------------------
@app.route('/api/faqs', methods=['GET'])
@login_required
def get_faqs():
    with get_db() as conn:
        c = conn.cursor()
        c.execute('SELECT * FROM faqs WHERE active = 1 ORDER BY id DESC')
        return jsonify([dict(row) for row in c.fetchall()])

@app.route('/api/faqs', methods=['POST'])
@login_required
def add_faq():
    data = request.json
    if not data or 'question' not in data or 'answer' not in data:
        return jsonify({'success': False, 'error': 'Pertanyaan dan jawaban wajib diisi'}), 400
    with get_db() as conn:
        c = conn.cursor()
        c.execute('INSERT INTO faqs (question, answer, image_url, active) VALUES (?, ?, ?, 1)',
                  (data['question'], data['answer'], data.get('image_url')))
        faq_id = c.lastrowid
    return jsonify({'success': True, 'id': faq_id})

@app.route('/api/faqs/<int:faq_id>', methods=['PUT'])
@login_required
def update_faq(faq_id):
    data = request.json
    with get_db() as conn:
        c = conn.cursor()
        c.execute('UPDATE faqs SET question=?, answer=?, image_url=? WHERE id=?',
                  (data['question'], data['answer'], data.get('image_url'), faq_id))
    return jsonify({'success': True})

@app.route('/api/faqs/<int:faq_id>', methods=['DELETE'])
@login_required
def delete_faq(faq_id):
    with get_db() as conn:
        c = conn.cursor()
        c.execute('UPDATE faqs SET active = 0 WHERE id = ?', (faq_id,))
    return jsonify({'success': True})

@app.route('/api/public/faqs', methods=['GET'])
def public_faqs():
    with get_db() as conn:
        c = conn.cursor()
        c.execute('SELECT * FROM faqs WHERE active = 1')
        return jsonify([dict(row) for row in c.fetchall()])


# ------------------------------------------------------------------
# 9. UPLOAD
# ------------------------------------------------------------------
@app.route('/api/upload', methods=['POST'])
@login_required
def upload_file():
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'No file'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'success': False, 'error': 'No file selected'}), 400
    if file and allowed_file(file.filename):
        filename = f"{int(time.time())}_{secure_filename(file.filename)}"
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(filepath)
        # Set permission
        os.chmod(filepath, 0o644)
        return jsonify({'success': True, 'url': f'/static/uploads/{filename}'})
    return jsonify({'success': False, 'error': 'File type not allowed'}), 400


# ------------------------------------------------------------------
# 10. WHATSAPP PROXY
# ------------------------------------------------------------------

def wa_gateway_request(method, path, json_data=None, timeout=5):
    last_error = None
    for url in WA_GATEWAY_URLS:
        full_url = f"{url.rstrip('/')}/{path.lstrip('/')}"
        try:
            if method == 'get':
                return requests.get(full_url, timeout=timeout)
            if method == 'post':
                return requests.post(full_url, json=json_data, timeout=timeout)
            raise ValueError(f"Unsupported method: {method}")
        except Exception as e:
            logger.warning(f"WA gateway attempt failed for {full_url}: {e}")
            last_error = e
    raise last_error

@app.route('/api/wa/status', methods=['GET'])
@limiter.exempt
@login_required
def wa_status():
    try:
        res = wa_gateway_request('get', '/wa-status', timeout=5)
        return jsonify(res.json())
    except Exception as e:
        logger.error(f"WA status error: {e}")
        return jsonify({'status': 'error', 'message': str(e)})

@app.route('/api/wa/qr', methods=['GET'])
@limiter.exempt
@login_required
def wa_qr():
    try:
        res = wa_gateway_request('get', '/wa-qr', timeout=5)
        return jsonify(res.json())
    except Exception as e:
        logger.error(f"WA QR error: {e}")
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/wa/reconnect', methods=['POST'])
@limiter.limit("20 per minute")
@login_required
def wa_reconnect():
    try:
        res = wa_gateway_request('post', '/wa-reconnect', timeout=5)
        return jsonify(res.json())
    except Exception as e:
        logger.error(f"WA reconnect error: {e}")
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/wa/disconnect', methods=['POST'])
@limiter.limit("20 per minute")
@login_required
def wa_disconnect():
    try:
        res = wa_gateway_request('post', '/wa-disconnect', timeout=5)
        return jsonify(res.json())
    except Exception as e:
        logger.error(f"WA disconnect error: {e}")
        return jsonify({'success': False, 'error': str(e)})


# ------------------------------------------------------------------
# 11. CHAT PROXY
# ------------------------------------------------------------------
@app.route('/api/chat-proxy', methods=['POST'])
@login_required
def chat_proxy():
    try:
        headers = {'X-Internal-Key': INTERNAL_API_KEY} if INTERNAL_API_KEY else {}
        res = requests.post(f'{AI_URL}/ai-chat', json=request.json, headers=headers, timeout=30)
        try:
            payload = res.json()
        except Exception:
            payload = {'error': res.text[:300] or f'AI service HTTP {res.status_code}'}
        if not res.ok:
            return jsonify(payload), res.status_code
        return jsonify(payload)
    except Exception as e:
        logger.error(f"Chat proxy error: {e}")
        return jsonify({'error': str(e)}), 500


# ------------------------------------------------------------------
# 12. ORDERS
# ------------------------------------------------------------------
@app.route('/api/orders', methods=['POST'])
@require_internal_auth
def create_order():
    data = request.json
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with get_db() as conn:
        c = conn.cursor()
        c.execute('''INSERT INTO orders (timestamp, user_number, user_name, phone, address, product, quantity, notes, status, total)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)''',
                  (now, data.get('user_number'), data.get('user_name'),
                   data.get('phone'), data.get('address'), data.get('product'),
                   data.get('quantity'), data.get('notes'), data.get('total', '-')))
        order_id = c.lastrowid
    logger.info(f"Order created: #{order_id}")
    return jsonify({'success': True, 'order_id': order_id})

@app.route('/api/orders', methods=['GET'])
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

@app.route('/api/orders/<int:order_id>', methods=['PUT'])
@login_required
def update_order(order_id):
    data = request.json
    with get_db() as conn:
        c = conn.cursor()
        c.execute('UPDATE orders SET status=? WHERE id=?', (data.get('status'), order_id))
    return jsonify({'success': True})

@app.route('/api/orders/<int:order_id>', methods=['DELETE'])
@login_required
def delete_order(order_id):
    with get_db() as conn:
        c = conn.cursor()
        c.execute('DELETE FROM orders WHERE id=?', (order_id,))
    return jsonify({'success': True})


# ------------------------------------------------------------------
# 13. CONVERSATION HISTORY
# ------------------------------------------------------------------
@app.route('/api/conversation/history/<user_number>', methods=['GET'])
@require_internal_auth
def get_conversation_history(user_number):
    limit = request.args.get('limit', 10, type=int)
    # Sanitasi limit
    limit = min(max(limit, 1), 100)
    variants = wa_number_variants(user_number)
    placeholders = ','.join(['?'] * len(variants))
    with get_db() as conn:
        c = conn.cursor()
        c.execute(f'''SELECT role, content, timestamp FROM conversation_history 
                     WHERE user_number IN ({placeholders}) ORDER BY id DESC LIMIT ?''', (*variants, limit))
        history = list(reversed([dict(row) for row in c.fetchall()]))
    return jsonify(history)

@app.route('/api/conversation/history', methods=['POST'])
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

@app.route('/api/conversation/history/<user_number>', methods=['DELETE'])
@require_internal_auth
def clear_conversation_history(user_number):
    variants = wa_number_variants(user_number)
    placeholders = ','.join(['?'] * len(variants))
    with get_db() as conn:
        c = conn.cursor()
        c.execute(f'DELETE FROM conversation_history WHERE user_number IN ({placeholders})', variants)
    return jsonify({'success': True})

@app.route('/api/customer-profile/<user_number>', methods=['GET'])
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

@app.route('/api/customer-profile/<user_number>', methods=['POST'])
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

@app.route('/api/customer-memory/<user_number>', methods=['DELETE'])
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

    logger.info(f"Customer memory reset: {normalized}")
    return jsonify({
        'success': True,
        'user_number': normalized,
        'history_deleted': history_deleted,
        'profile_deleted': profile_deleted,
    })


# ------------------------------------------------------------------
# 14. ANALYTICS & LOGS
# ------------------------------------------------------------------
@app.route('/api/analytics', methods=['GET'])
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

@app.route('/api/logs', methods=['GET'])
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

@app.route('/api/log-conversation', methods=['POST'])
@require_internal_auth
def log_conversation():
    data = request.json
    with get_db() as conn:
        c = conn.cursor()
        c.execute('''INSERT INTO conversation_logs (timestamp, user_number, user_message, ai_response, kb_context) VALUES (?, ?, ?, ?, ?)''',
                  (data.get('timestamp'), data.get('user_number'),
                   data.get('user_message'), data.get('ai_response'), data.get('kb_context', '')))
    return jsonify({'success': True})


# ------------------------------------------------------------------
# 15. CLOSINGS - CRUD + FILTER + EXPORT XLS
# ------------------------------------------------------------------
@app.route('/api/closings', methods=['GET'])
@login_required
def get_closings():
    status = request.args.get('status', '')
    date   = request.args.get('date', '')
    source = request.args.get('source', '')
    
    query  = 'SELECT * FROM closings WHERE 1=1'
    params = []
    if status:
        query += ' AND status=?';
        params.append(status)
    if date:
        query += ' AND (created_at LIKE ? OR timestamp LIKE ?)'
        params.extend([date+'%', date+'%'])
    if source:
        query += ' AND source=?'
        params.append(source)
    query += ' ORDER BY id DESC'
    
    with get_db() as conn:
        c = conn.cursor()
        c.execute(query, params)
        return jsonify([dict(row) for row in c.fetchall()])

@app.route('/api/closings', methods=['POST'])
@require_internal_auth
def create_closing():
    data = request.json
    now  = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with get_db() as conn:
        c = conn.cursor()
        c.execute('''INSERT INTO closings
            (timestamp, created_at, user_wa, raw_text, nama, alamat, telepon, kode_pos,
             berat, harga_non_cod, nilai_cod, produk, kelurahan, qty,
             instruksi, courier, gudang, status, source)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
            (data.get('timestamp', now), data.get('created_at', now),
             data.get('user_wa', ''), data.get('raw_text', ''),
             data.get('nama', ''), data.get('alamat', ''), data.get('telepon', ''),
             data.get('kode_pos', ''), data.get('berat', '1'),
             data.get('harga_non_cod', ''), data.get('nilai_cod', ''),
             data.get('produk', ''), data.get('kelurahan', ''), data.get('qty', '1'),
             data.get('instruksi', ''), data.get('courier', ''), data.get('gudang', ''),
             data.get('status', 'draft'), data.get('source', 'Manual')))
        closing_id = c.lastrowid
    logger.info(f"Closing created: #{closing_id}")
    return jsonify({'success': True, 'id': closing_id})

@app.route('/api/closings/<int:closing_id>', methods=['PUT'])
@login_required
def update_closing(closing_id):
    data = request.json
    with get_db() as conn:
        c = conn.cursor()
        c.execute('''UPDATE closings SET
            nama=?, alamat=?, telepon=?, kode_pos=?, berat=?,
            harga_non_cod=?, nilai_cod=?, produk=?, kelurahan=?,
            qty=?, instruksi=?, courier=?, gudang=?, status=?
            WHERE id=?''',
            (data.get('nama',''), data.get('alamat',''), data.get('telepon',''),
             data.get('kode_pos',''), data.get('berat','1'),
             data.get('harga_non_cod',''), data.get('nilai_cod',''),
             data.get('produk',''), data.get('kelurahan',''),
             data.get('qty','1'), data.get('instruksi',''),
             data.get('courier',''), data.get('gudang',''),
             data.get('status','draft'), closing_id))
    return jsonify({'success': True})

@app.route('/api/closings/<int:closing_id>', methods=['DELETE'])
@login_required
def delete_closing(closing_id):
    with get_db() as conn:
        c = conn.cursor()
        c.execute('DELETE FROM closings WHERE id=?', (closing_id,))
    return jsonify({'success': True})


# ------------------------------------------------------------------
# 16. EXPORT CLOSINGS KE XLS
# ------------------------------------------------------------------
@app.route('/api/closings/export', methods=['GET'])
@login_required
def export_closings_xls():
    """
    Export closings ke file XLS.
    Query params:
        - status: filter by status (draft, confirmed, dll)
        - date: filter by date (YYYY-MM-DD)
        - source: filter by source (WA, TG, Manual)
    Output: File .xls dengan nama sukumba-closings-YYYY-MM-DD-HHMMSS.xls
    """
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    except ImportError:
        return jsonify({'success': False, 'error': 'Library openpyxl belum terinstall. Jalankan: pip install openpyxl'}), 500
    
    status = request.args.get('status', '')
    date   = request.args.get('date', '')
    source = request.args.get('source', '')
    
    # Build query sama seperti get_closings
    query  = 'SELECT * FROM closings WHERE 1=1'
    params = []
    if status:
        query += ' AND status=?';  params.append(status)
    if date:
        query += ' AND (created_at LIKE ? OR timestamp LIKE ?)'; params.extend([date+'%', date+'%'])
    if source:
        query += ' AND source=?';  params.append(source)
    query += ' ORDER BY id DESC'
    
    with get_db() as conn:
        c = conn.cursor()
        c.execute(query, params)
        rows = c.fetchall()
    
    if not rows:
        return jsonify({'success': False, 'error': 'Tidak ada data untuk di-export'}), 404
    
    # Buat workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Closingan"
    
    # Style header
    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill(start_color="2F5496", end_color="2F5496", fill_type="solid")
    header_align = Alignment(horizontal="center", vertical="center", wrap_text=True)
    thin_border = Border(
        left=Side(style='thin'), right=Side(style='thin'),
        top=Side(style='thin'), bottom=Side(style='thin')
    )
    
    # Header columns
    headers = ['ID', 'Timestamp', 'Created At', 'Source', 'User WA', 'Nama', 'Telepon', 
               'Alamat', 'Kelurahan', 'Kode Pos', 'Produk', 'Qty', 'Berat',
               'Harga Non-COD', 'Nilai COD', 'Courier', 'Gudang', 
               'Instruksi', 'Status']
    
    ws.append(headers)
    
    # Style header row
    for col_num, header in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col_num)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = header_align
        cell.border = thin_border
    
    # Data rows
    for row in rows:
        ws.append([
            row['id'],
            row['timestamp'],
            row['created_at'],
            row['source'],
            row['user_wa'],
            row['nama'],
            row['telepon'],
            row['alamat'],
            row['kelurahan'],
            row['kode_pos'],
            row['produk'],
            row['qty'],
            row['berat'],
            row['harga_non_cod'],
            row['nilai_cod'],
            row['courier'],
            row['gudang'],
            row['instruksi'],
            row['status']
        ])
    
    # Auto-adjust column widths
    for col in ws.columns:
        max_length = 0
        column = col[0].column_letter
        for cell in col:
            try:
                if len(str(cell.value)) > max_length:
                    max_length = len(str(cell.value))
            except: pass
        adjusted_width = min(max_length + 2, 50)
        ws.column_dimensions[column].width = adjusted_width
    
    # Freeze header row
    ws.freeze_panes = 'A2'
    
    # Auto-filter
    ws.auto_filter.ref = ws.dimensions
    
    # Save ke memory
    output = io.BytesIO()
    wb.save(output)
    output.seek(0)
    
    filename = f"sukumba-closings-{datetime.now().strftime('%Y-%m-%d-%H%M%S')}"
    if date: filename += f"-{date}"
    if status: filename += f"-{status}"
    filename += ".xlsx"
    
    logger.info(f"Export XLS: {len(rows)} rows exported")
    return send_file(
        output,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        as_attachment=True,
        download_name=filename
    )


# ------------------------------------------------------------------
# 17. TELEGRAM USERS
# ------------------------------------------------------------------
@app.route('/api/telegram-users', methods=['GET'])
@login_required
def get_telegram_users():
    with get_db() as conn:
        c = conn.cursor()
        c.execute('SELECT * FROM telegram_users ORDER BY id DESC')
        return jsonify([dict(row) for row in c.fetchall()])

@app.route('/api/telegram-users', methods=['POST'])
@login_required
def add_telegram_user():
    data = request.json
    if not data or 'chat_id' not in data or 'name' not in data:
        return jsonify({'success': False, 'error': 'Chat ID dan nama wajib diisi'}), 400
    with get_db() as conn:
        c = conn.cursor()
        try:
            c.execute('INSERT INTO telegram_users (chat_id, name, created_at) VALUES (?, ?, ?)',
                      (data['chat_id'], data['name'], datetime.now().strftime('%Y-%m-%d %H:%M:%S')))
            user_id = c.lastrowid
            return jsonify({'success': True, 'id': user_id})
        except sqlite3.IntegrityError:
            return jsonify({'success': False, 'error': 'Chat ID sudah terdaftar'}), 400

@app.route('/api/telegram-users/<int:user_id>', methods=['DELETE'])
@login_required
def delete_telegram_user(user_id):
    with get_db() as conn:
        c = conn.cursor()
        c.execute('DELETE FROM telegram_users WHERE id=?', (user_id,))
    return jsonify({'success': True})


# ------------------------------------------------------------------
# 18. TELEGRAM WEBHOOK
# ------------------------------------------------------------------
@app.route('/api/telegram-webhook', methods=['POST'])
def telegram_webhook():
    try:
        data    = request.json
        message = data.get('message', {})
        chat_id = str(message.get('chat', {}).get('id', ''))
        text    = message.get('text', '')
        from_info = message.get('from', {})
        from_name = (from_info.get('first_name', '') + ' ' + from_info.get('last_name', '')).strip()

        if not chat_id or not text:
            return jsonify({'ok': True})

        tg_token_db = get_setting('telegram_bot_token') or ''
        tg_token_env = os.getenv('TELEGRAM_BOT_TOKEN', '')
        tg_token = tg_token_env if tg_token_env else tg_token_db

        def tg_reply(msg):
            if tg_token:
                try:
                    requests.post(f'https://api.telegram.org/bot{tg_token}/sendMessage',
                        json={'chat_id': chat_id, 'text': msg, 'parse_mode': 'Markdown'},
                        timeout=5)
                except: pass

        # Cek whitelist
        with get_db() as conn:
            c = conn.cursor()
            c.execute('SELECT * FROM telegram_users WHERE chat_id=?', (chat_id,))
            tg_user = c.fetchone()
        
        if not tg_user:
            tg_reply(f'❌ Akses ditolak.\nChat ID kamu: `{chat_id}`\n\nMinta admin untuk mendaftarkan Chat ID kamu di panel.')
            return jsonify({'ok': True})

        if '#closingan' not in text.lower():
            return jsonify({'ok': True})

        clean_text = text.replace('#closingan', '').replace('#CLOSINGAN', '').strip()
        if not clean_text:
            tg_reply('❌ Teks closingan kosong.')
            return jsonify({'ok': True})

        try:
            parse_res = requests.post('http://172.31.6.3:5000/parse-closing',
                json={'text': clean_text}, timeout=15,
                headers={'X-Internal-Key': INTERNAL_API_KEY})
            parsed = parse_res.json()
            if not parsed.get('success'):
                raise Exception(parsed.get('error', 'Parse gagal'))
            d = parsed['data']
            now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            with get_db() as conn:
                c = conn.cursor()
                c.execute('''INSERT INTO closings
                    (timestamp, created_at, user_wa, raw_text, nama, alamat, telepon,
                     kode_pos, berat, harga_non_cod, nilai_cod, produk, kelurahan,
                     qty, instruksi, courier, gudang, status, source)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                    (now, now, f'TG:{chat_id}:{from_name}', clean_text,
                     d.get('nama',''), d.get('alamat',''), d.get('telepon',''),
                     d.get('kode_pos',''), d.get('berat','1'),
                     d.get('harga_non_cod',''), d.get('nilai_cod',''),
                     d.get('produk',''), d.get('kelurahan',''), d.get('qty','1'),
                     d.get('instruksi',''), d.get('courier',''), d.get('gudang',''),
                     'draft', 'TG'))
                closing_id = c.lastrowid
            val = f"COD: Rp {d.get('nilai_cod')}" if d.get('nilai_cod') else f"TRF: Rp {d.get('harga_non_cod','?')}"
            tg_reply(
                f"✅ *Closingan #{closing_id} tersimpan!*\n\n"
                f"👤 {d.get('nama','?')}\n📱 {d.get('telepon','?')}\n"
                f"📍 {(d.get('alamat','?'))[:50]}...\n"
                f"📦 {d.get('produk','?')} × {d.get('qty','1')}\n"
                f"💰 {val}\n\n_Cek di Admin Panel → tab Closings_"
            )
        except Exception as e:
            logger.error(f"Telegram parse error: {e}")
            tg_reply(f'❌ Gagal parse: {str(e)}')

        return jsonify({'ok': True})
    except Exception as e:
        logger.error(f'Telegram webhook error: {e}')
        return jsonify({'ok': True})


@app.route('/api/telegram-set-webhook', methods=['POST'])
@login_required
def set_telegram_webhook():
    try:
        tg_token_db = get_setting('telegram_bot_token') or ''
        tg_token_env = os.getenv('TELEGRAM_BOT_TOKEN', '')
        tg_token = tg_token_env if tg_token_env else tg_token_db
        if not tg_token:
            return jsonify({'success': False, 'error': 'Token belum diset'})
        base_url = request.json.get('base_url', 'https://admin-cs.tukugawanet.com')
        webhook_url = f'{base_url}/api/telegram-webhook'
        res = requests.post(f'https://api.telegram.org/bot{tg_token}/setWebhook',
                            json={'url': webhook_url}, timeout=10)
        data = res.json()
        return jsonify({'success': data.get('ok', False), 'result': data})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


# ------------------------------------------------------------------
# 19. PARSE MANUAL PROXY
# ------------------------------------------------------------------
@app.route('/api/parse-manual', methods=['POST'])
@login_required
def parse_manual():
    data = request.json
    closings = data.get('closings', [])
    if not closings or not isinstance(closings, list):
        return jsonify({'success': False, 'error': 'Input harus array teks closingan'}), 400
    
    results = []
    errors  = []
    for text in closings:
        try:
            res = requests.post(
                'http://172.31.6.3:5000/parse-closing',
                json={'text': text},
                timeout=20,
                headers={'X-Internal-Key': INTERNAL_API_KEY}
            )
            parsed = res.json()
            if parsed.get('success'):
                results.append(parsed['data'])
            else:
                errors.append(parsed.get('error', 'Parse gagal'))
                results.append(None)
        except Exception as e:
            errors.append(str(e))
            results.append(None)
    # Auto-save ke database closings
    saved_ids = []
    for i, result in enumerate(results):
        if result:
            try:
                now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                raw_text_saved = closings[i][:500] if i < len(closings) else ''
                
                with get_db() as conn:
                    c = conn.cursor()
                    closing_id = None
                    
                    # Cek duplikasi: raw_text persis sama dalam 60 detik terakhir
                    if raw_text_saved:
                        c.execute("""SELECT id FROM closings
                            WHERE raw_text=? AND source='Manual'
                            AND (strftime('%s','now') - strftime('%s', created_at)) <= 60
                            ORDER BY id DESC LIMIT 1""", (raw_text_saved,))
                        dup = c.fetchone()
                        if dup:
                            result['saved'] = False
                            result['id'] = dup[0]
                            result['save_error'] = 'Duplikasi #' + str(dup[0])
                            continue
                    
                    c.execute("""INSERT INTO closings
                        (timestamp, created_at, user_wa, raw_text, nama, alamat, telepon,
                         kode_pos, berat, harga_non_cod, nilai_cod, produk, kelurahan,
                         qty, instruksi, courier, gudang, status, source)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                        now, now, 'Manual-Panel', raw_text_saved,
                        result.get('nama',''), result.get('alamat',''), result.get('telepon',''),
                        result.get('kode_pos',''), result.get('berat','1'),
                        result.get('harga_non_cod',''), result.get('nilai_cod',''),
                        result.get('produk',''), result.get('kelurahan',''), result.get('qty','1'),
                        result.get('instruksi',''), result.get('courier',''), result.get('gudang',''),
                        'draft', 'Manual'
                    ))
                    closing_id = c.lastrowid
                
                saved_ids.append(closing_id)
                result['id'] = closing_id
                result['saved'] = True
            except Exception as e:
                result['saved'] = False
                result['save_error'] = str(e)
    
    return jsonify({'success': True, 'results': results, 'errors': errors, 'saved_ids': saved_ids})



# ------------------------------------------------------------------
# 19b. PARSE BULK PROXY (kirim 1 blok teks, AI detect batas closingan)
# ------------------------------------------------------------------
@app.route('/api/parse-bulk', methods=['POST'])
@login_required
def parse_bulk():
    """
    Kirim seluruh teks (bisa multi-closingan) ke AI.
    AI yang detect & parse semua closingan → auto-save ke DB.
    Tidak perlu split manual di browser.
    """
    data = request.json
    raw_text = data.get('text', '').strip()
    if not raw_text:
        return jsonify({'success': False, 'error': 'Teks kosong'}), 400

    # Kirim ke ai_service /parse-bulk
    try:
        res = requests.post(
            'http://172.31.6.3:5000/parse-bulk',
            json={'text': raw_text},
            timeout=30,
            headers={'X-Internal-Key': INTERNAL_API_KEY}
        )
        parsed = res.json()
        if not parsed.get('success'):
            return jsonify({'success': False, 'error': parsed.get('error', 'Parse gagal')}), 500
    except Exception as e:
        return jsonify({'success': False, 'error': f'AI service error: {str(e)}'}), 500

    results  = parsed.get('results', [])
    saved_ids = []
    errors    = []

    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    for i, result in enumerate(results):
        try:
            with get_db() as conn:
                c = conn.cursor()
                # Dedup: cek nama+telepon+produk dalam 60 detik
                c.execute("""SELECT id FROM closings
                    WHERE nama=? AND telepon=? AND produk=? AND source='Manual'
                    AND (strftime('%s','now') - strftime('%s', created_at)) <= 60
                    ORDER BY id DESC LIMIT 1""",
                    (result.get('nama',''), result.get('telepon',''), result.get('produk','')))
                dup = c.fetchone()
                if dup:
                    errors.append(f"Duplikasi #{dup[0]}: {result.get('nama','')}")
                    continue

                c.execute("""INSERT INTO closings
                    (timestamp, created_at, user_wa, raw_text, nama, alamat, telepon,
                     kode_pos, berat, harga_non_cod, nilai_cod, produk, kelurahan,
                     qty, instruksi, courier, gudang, status, source)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (now, now, 'Manual-Panel', raw_text[:200],
                     result.get('nama',''), result.get('alamat',''), result.get('telepon',''),
                     result.get('kode_pos',''), result.get('berat','1'),
                     result.get('harga_non_cod',''), result.get('nilai_cod',''),
                     result.get('produk',''), result.get('kelurahan',''), result.get('qty','1'),
                     result.get('instruksi',''), result.get('courier',''), result.get('gudang',''),
                     'draft', 'Manual'))
                saved_ids.append(c.lastrowid)
        except Exception as e:
            errors.append(str(e))

    logger.info(f"parse-bulk: {len(saved_ids)} saved, {len(errors)} errors")
    return jsonify({
        'success': True,
        'saved':   len(saved_ids),
        'saved_ids': saved_ids,
        'errors':  errors,
        'total_parsed': len(results)
    })

# ------------------------------------------------------------------
# 20. MAIN
# ------------------------------------------------------------------
if __name__ == '__main__':
    init_db()
    logger.info('Sukumba Admin Panel v2.0 starting on port 5001...')
    # Gunakan waitress untuk production (lebih stabil dari development server)
    try:
        from waitress import serve
        serve(app, host='0.0.0.0', port=5001, threads=8)
    except ImportError:
        logger.warning('waitress tidak terinstall, menggunakan development server. Install: pip install waitress')
        app.run(host='0.0.0.0', port=5001, debug=False)
