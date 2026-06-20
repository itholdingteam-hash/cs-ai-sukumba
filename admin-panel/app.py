#!/usr/bin/env python3
"""
Sukumba Admin Panel - Refactored Version
Fitur: Security Hardened + Export XLS + Context Manager DB

Deploy:
    1. cp .env /home/tunet/admin-panel/.env
    2. pip install flask python-dotenv flask-limiter openpyxl
    3. python3 app.py
"""

from flask import Flask, render_template, request, jsonify, session, redirect, url_for, Response
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from datetime import datetime
from werkzeug.utils import secure_filename
import os
import time
import logging

# ------------------------------------------------------------------
# 0. ENVIRONMENT SETUP
# ------------------------------------------------------------------
from admin_core.auth import configure_auth, login_required, require_internal_auth
from admin_core.config import load_config
from admin_core.db import configure_database, get_db, init_db
from admin_core.helpers import (
    allowed_file,
    normalize_wa_number,
)
from routes.catalog import catalog_bp
from routes.closings import closings_bp
from routes.integrations import create_integrations_bp
from routes.operations import operations_bp
from routes.parsing import create_parsing_bp
from routes.shipping import configure_rajaongkir, shipping_bp
from routes.telegram import create_telegram_bp

CONFIG = load_config()
BASE_DIR = CONFIG.base_dir
DB_FILE = CONFIG.db_file
SECRET_KEY = CONFIG.secret_key
ADMIN_PASSWORD = CONFIG.admin_password
INTERNAL_API_KEY = CONFIG.internal_api_key
TELEGRAM_BOT_TOKEN = CONFIG.telegram_bot_token
WA_GATEWAY_URL = CONFIG.wa_gateway_url
WA_GATEWAY_URLS = CONFIG.wa_gateway_urls
AI_URL = CONFIG.ai_url
UPLOAD_FOLDER = CONFIG.upload_folder
ALLOWED_EXTENSIONS = CONFIG.allowed_extensions
ALLOWED_UPLOAD_MIMES = {
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/quicktime',
    'video/webm',
}
ALLOWED_SETTING_KEYS = {
    'company_name',
    'company_location',
    'company_hours',
    'company_contact',
    'llm_provider',
    'llm_api_url',
    'llm_api_key',
    'ai_model',
    'ai_temperature',
    'ai_max_tokens',
    'groq_api_key',
    'telegram_bot_token',
    'prompt_greeting',
    'prompt_product',
    'prompt_order',
    'prompt_escalation',
    'wa_safety_guard_enabled',
    'wa_safety_auto_reply_paused',
    'wa_safety_manual_only',
    'wa_safety_min_delay_seconds',
    'wa_safety_max_delay_seconds',
    'wa_safety_daily_auto_limit',
    'wa_safety_append_optout',
    'wa_safety_block_new_outbound',
    'wa_safety_risky_words',
}
SECRET_SETTING_KEYS = {
    'llm_api_key',
    'groq_api_key',
    'telegram_bot_token',
}

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
configure_auth(INTERNAL_API_KEY)
configure_database(DB_FILE, TELEGRAM_BOT_TOKEN, logger)
configure_rajaongkir(CONFIG, logger)
logger.info(f"WA gateway: {WA_GATEWAY_URL}")
logger.info(f"AI service: {AI_URL}")

# ------------------------------------------------------------------
# 2. FLASK APP
# ------------------------------------------------------------------
app = Flask(__name__)
app.secret_key = SECRET_KEY
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024
STATIC_VERSION = str(int(time.time()))

@app.context_processor
def inject_static_version():
    return {'static_version': STATIC_VERSION}

limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    default_limits=["2000 per hour"],
    storage_uri="memory://"
)
app.register_blueprint(catalog_bp)
app.register_blueprint(closings_bp)
app.register_blueprint(operations_bp)

# ------------------------------------------------------------------
# 3. DATABASE LAYER
# ------------------------------------------------------------------
# Database connection and schema bootstrap live in admin_core.db.

# ------------------------------------------------------------------
# 4. HELPERS
# ------------------------------------------------------------------
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


@app.route('/wa-trust')
def wa_trust_page():
    company_name = get_setting('company_name') or 'Sukumba'
    contact = normalize_wa_number(get_setting('company_contact') or '')
    display_contact = '+' + contact if contact else ''
    wa_link = f'https://wa.me/{contact}' if contact else '#'
    return render_template(
        'wa_trust.html',
        company_name=company_name,
        display_contact=display_contact,
        wa_link=wa_link,
    )


@app.route('/sukumba-contact.vcf')
def sukumba_contact_vcf():
    company_name = get_setting('company_name') or 'Sukumba'
    contact = normalize_wa_number(get_setting('company_contact') or '')
    vcf = (
        'BEGIN:VCARD\r\n'
        'VERSION:3.0\r\n'
        f'FN:{company_name} Official\r\n'
        f'ORG:{company_name}\r\n'
        f'TEL;TYPE=CELL,VOICE:+{contact}\r\n'
        'NOTE:Kontak resmi customer service Sukumba.\r\n'
        'END:VCARD\r\n'
    )
    return Response(
        vcf,
        mimetype='text/vcard',
        headers={'Content-Disposition': 'attachment; filename=sukumba-official.vcf'},
    )


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
    for key in SECRET_SETTING_KEYS:
        if settings.get(key):
            settings[key] = ''
            settings[f'{key}_configured'] = True
    return jsonify(settings)

@app.route('/api/settings', methods=['POST'])
@login_required
def update_settings():
    payload = request.get_json(silent=True) or {}
    rejected = []
    for key, value in payload.items():
        if key not in ALLOWED_SETTING_KEYS:
            rejected.append(key)
            continue
        if key in SECRET_SETTING_KEYS and (value is None or str(value).strip() == ''):
            continue
        set_setting(key, value)
    logger.info("Settings updated")
    return jsonify({'success': True, 'rejected': rejected})

@app.route('/api/public/settings', methods=['GET'])
@require_internal_auth
def public_settings():
    with get_db() as conn:
        c = conn.cursor()
        c.execute('SELECT key, value FROM settings')
        settings = {row[0]: row[1] for row in c.fetchall()}
    return jsonify(settings)


app.register_blueprint(create_integrations_bp(CONFIG, limiter, logger))
app.register_blueprint(create_telegram_bp(CONFIG, get_setting, logger))
app.register_blueprint(create_parsing_bp(CONFIG, logger))
app.register_blueprint(shipping_bp)


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
    if file and allowed_file(file.filename, ALLOWED_EXTENSIONS):
        if file.mimetype not in ALLOWED_UPLOAD_MIMES:
            return jsonify({'success': False, 'error': 'File type not allowed'}), 400
        os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
        filename = f"{int(time.time())}_{secure_filename(file.filename)}"
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(filepath)
        try:
            os.chmod(filepath, 0o644)
        except OSError:
            logger.debug("Could not chmod uploaded file", exc_info=True)
        return jsonify({'success': True, 'url': f'/static/uploads/{filename}'})
    return jsonify({'success': False, 'error': 'File type not allowed'}), 400


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
