"""Telegram user management and closingan webhook routes."""

from datetime import datetime
import os
import sqlite3

import requests
from flask import Blueprint, jsonify, request

from admin_core.auth import login_required
from admin_core.db import get_db


def create_telegram_bp(config, get_setting, logger):
    bp = Blueprint('telegram', __name__)
    internal_headers = {'X-Internal-Key': config.internal_api_key} if config.internal_api_key else {}

    def telegram_token():
        token_db = get_setting('telegram_bot_token') or ''
        token_env = os.getenv('TELEGRAM_BOT_TOKEN', '')
        return token_env if token_env else token_db

    @bp.route('/api/telegram-users', methods=['GET'])
    @login_required
    def get_telegram_users():
        with get_db() as conn:
            c = conn.cursor()
            c.execute('SELECT * FROM telegram_users ORDER BY id DESC')
            return jsonify([dict(row) for row in c.fetchall()])

    @bp.route('/api/telegram-users', methods=['POST'])
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

    @bp.route('/api/telegram-users/<int:user_id>', methods=['DELETE'])
    @login_required
    def delete_telegram_user(user_id):
        with get_db() as conn:
            c = conn.cursor()
            c.execute('DELETE FROM telegram_users WHERE id=?', (user_id,))
        return jsonify({'success': True})

    @bp.route('/api/telegram-webhook', methods=['POST'])
    def telegram_webhook():
        try:
            data = request.json
            message = data.get('message', {})
            chat_id = str(message.get('chat', {}).get('id', ''))
            text = message.get('text', '')
            from_info = message.get('from', {})
            from_name = (from_info.get('first_name', '') + ' ' + from_info.get('last_name', '')).strip()

            if not chat_id or not text:
                return jsonify({'ok': True})

            tg_token = telegram_token()

            def tg_reply(msg):
                if tg_token:
                    try:
                        requests.post(
                            f'https://api.telegram.org/bot{tg_token}/sendMessage',
                            json={'chat_id': chat_id, 'text': msg, 'parse_mode': 'Markdown'},
                            timeout=5
                        )
                    except Exception:
                        pass

            with get_db() as conn:
                c = conn.cursor()
                c.execute('SELECT * FROM telegram_users WHERE chat_id=?', (chat_id,))
                tg_user = c.fetchone()

            if not tg_user:
                tg_reply(f'\u274C Akses ditolak.\nChat ID kamu: `{chat_id}`\n\nMinta admin untuk mendaftarkan Chat ID kamu di panel.')
                return jsonify({'ok': True})

            if '#closingan' not in text.lower():
                return jsonify({'ok': True})

            clean_text = text.replace('#closingan', '').replace('#CLOSINGAN', '').strip()
            if not clean_text:
                tg_reply('\u274C Teks closingan kosong.')
                return jsonify({'ok': True})

            try:
                parse_res = requests.post(
                    f'{config.ai_url}/parse-closing',
                    json={'text': clean_text},
                    timeout=15,
                    headers=internal_headers
                )
                parsed = parse_res.json()
                if not parsed.get('success'):
                    raise Exception(parsed.get('error', 'Parse gagal'))
                data = parsed['data']
                now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                with get_db() as conn:
                    c = conn.cursor()
                    c.execute('''INSERT INTO closings
                        (timestamp, created_at, user_wa, raw_text, nama, alamat, telepon,
                         kode_pos, berat, harga_non_cod, nilai_cod, produk, kelurahan,
                         qty, instruksi, courier, gudang, status, source)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                        (now, now, f'TG:{chat_id}:{from_name}', clean_text,
                         data.get('nama',''), data.get('alamat',''), data.get('telepon',''),
                         data.get('kode_pos',''), data.get('berat','1'),
                         data.get('harga_non_cod',''), data.get('nilai_cod',''),
                         data.get('produk',''), data.get('kelurahan',''), data.get('qty','1'),
                         data.get('instruksi',''), data.get('courier',''), data.get('gudang',''),
                         'draft', 'TG'))
                    closing_id = c.lastrowid
                val = f"COD: Rp {data.get('nilai_cod')}" if data.get('nilai_cod') else f"TRF: Rp {data.get('harga_non_cod','?')}"
                tg_reply(
                    f"\u2705 *Closingan #{closing_id} tersimpan!*\n\n"
                    f"\U0001F464 {data.get('nama','?')}\n\U0001F4F1 {data.get('telepon','?')}\n"
                    f"\U0001F4CD {(data.get('alamat','?'))[:50]}...\n"
                    f"\U0001F4E6 {data.get('produk','?')} x {data.get('qty','1')}\n"
                    f"\U0001F4B0 {val}\n\n_Cek di Admin Panel -> tab Closings_"
                )
            except Exception as exc:
                logger.error(f"Telegram parse error: {exc}")
                tg_reply(f'\u274C Gagal parse: {str(exc)}')

            return jsonify({'ok': True})
        except Exception as exc:
            logger.error(f'Telegram webhook error: {exc}')
            return jsonify({'ok': True})

    @bp.route('/api/telegram-set-webhook', methods=['POST'])
    @login_required
    def set_telegram_webhook():
        try:
            tg_token = telegram_token()
            if not tg_token:
                return jsonify({'success': False, 'error': 'Token belum diset'})
            base_url = request.json.get('base_url', 'https://admin-cs.tukugawanet.com')
            webhook_url = f'{base_url}/api/telegram-webhook'
            res = requests.post(
                f'https://api.telegram.org/bot{tg_token}/setWebhook',
                json={'url': webhook_url},
                timeout=10
            )
            data = res.json()
            return jsonify({'success': data.get('ok', False), 'result': data})
        except Exception as exc:
            return jsonify({'success': False, 'error': str(exc)})

    return bp
