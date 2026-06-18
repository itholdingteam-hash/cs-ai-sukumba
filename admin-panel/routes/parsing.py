"""Manual and bulk closing parser proxy routes."""

from datetime import datetime

import requests
from flask import Blueprint, jsonify, request

from admin_core.auth import login_required
from admin_core.db import get_db


def create_parsing_bp(config, logger):
    bp = Blueprint('parsing', __name__)
    internal_headers = {'X-Internal-Key': config.internal_api_key} if config.internal_api_key else {}

    @bp.route('/api/parse-manual', methods=['POST'])
    @login_required
    def parse_manual():
        data = request.json
        closings = data.get('closings', [])
        if not closings or not isinstance(closings, list):
            return jsonify({'success': False, 'error': 'Input harus array teks closingan'}), 400

        results = []
        errors = []
        for text in closings:
            try:
                res = requests.post(
                    f'{config.ai_url}/parse-closing',
                    json={'text': text},
                    timeout=20,
                    headers=internal_headers
                )
                parsed = res.json()
                if parsed.get('success'):
                    results.append(parsed['data'])
                else:
                    errors.append(parsed.get('error', 'Parse gagal'))
                    results.append(None)
            except Exception as exc:
                errors.append(str(exc))
                results.append(None)

        saved_ids = []
        for index, result in enumerate(results):
            if not result:
                continue
            try:
                now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                raw_text_saved = closings[index][:500] if index < len(closings) else ''

                with get_db() as conn:
                    c = conn.cursor()
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
            except Exception as exc:
                result['saved'] = False
                result['save_error'] = str(exc)

        return jsonify({'success': True, 'results': results, 'errors': errors, 'saved_ids': saved_ids})

    @bp.route('/api/parse-bulk', methods=['POST'])
    @login_required
    def parse_bulk():
        data = request.json
        raw_text = data.get('text', '').strip()
        if not raw_text:
            return jsonify({'success': False, 'error': 'Teks kosong'}), 400

        try:
            res = requests.post(
                f'{config.ai_url}/parse-bulk',
                json={'text': raw_text},
                timeout=30,
                headers=internal_headers
            )
            parsed = res.json()
            if not parsed.get('success'):
                return jsonify({'success': False, 'error': parsed.get('error', 'Parse gagal')}), 500
        except Exception as exc:
            return jsonify({'success': False, 'error': f'AI service error: {str(exc)}'}), 500

        results = parsed.get('results', [])
        saved_ids = []
        errors = []
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

        for result in results:
            try:
                with get_db() as conn:
                    c = conn.cursor()
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
            except Exception as exc:
                errors.append(str(exc))

        logger.info(f"parse-bulk: {len(saved_ids)} saved, {len(errors)} errors")
        return jsonify({
            'success': True,
            'saved': len(saved_ids),
            'saved_ids': saved_ids,
            'errors': errors,
            'total_parsed': len(results)
        })

    return bp
