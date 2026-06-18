"""Catalog and template routes for products, FAQs, testimonials, and CS copy."""

from datetime import datetime
import json

from flask import Blueprint, current_app, jsonify, request

from admin_core.auth import login_required, require_internal_auth
from admin_core.db import get_db
from admin_core.helpers import is_sukumba_product_row, normalize_media_type


catalog_bp = Blueprint('catalog', __name__)


def _json_payload():
    return request.get_json(silent=True) or {}


def _clean_text(value, max_length=2000):
    text = str(value or '').strip()
    return text[:max_length]


def _clean_features(value):
    if isinstance(value, str):
        value = value.splitlines()
    if not isinstance(value, list):
        return []
    features = []
    for item in value:
        text = _clean_text(item, 300)
        if text:
            features.append(text)
    return features[:20]


def _clean_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _success_or_not_found(cursor, message='Data tidak ditemukan'):
    if cursor.rowcount <= 0:
        return jsonify({'success': False, 'error': message}), 404
    return jsonify({'success': True})


@catalog_bp.route('/api/products', methods=['GET'])
@login_required
def get_products():
    with get_db() as conn:
        c = conn.cursor()
        c.execute('SELECT * FROM products WHERE active = 1 ORDER BY id DESC')
        products = [dict(row) for row in c.fetchall()]
    for product in products:
        try:
            product['features'] = json.loads(product['features'])
        except Exception:
            product['features'] = []
    return jsonify(products)


@catalog_bp.route('/api/products', methods=['POST'])
@login_required
def add_product():
    data = _json_payload()
    name = _clean_text(data.get('name'), 150)
    price = _clean_text(data.get('price'), 80)
    features = _clean_features(data.get('features', []))
    if not name or not price:
        return jsonify({'success': False, 'error': 'Nama dan harga wajib diisi'}), 400
    with get_db() as conn:
        c = conn.cursor()
        c.execute('''INSERT INTO products (name, price, speed, features, promo, target, image_url, description, active)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)''',
                  (name, price, _clean_text(data.get('speed'), 80),
                   json.dumps(features),
                   _clean_text(data.get('promo'), 500),
                   _clean_text(data.get('target'), 500),
                   _clean_text(data.get('image_url'), 500),
                   _clean_text(data.get('description'), 2000)))
        product_id = c.lastrowid
    current_app.logger.info(f"Product added: #{product_id}")
    return jsonify({'success': True, 'id': product_id})


@catalog_bp.route('/api/products/<int:product_id>', methods=['PUT'])
@login_required
def update_product(product_id):
    data = _json_payload()
    name = _clean_text(data.get('name'), 150)
    price = _clean_text(data.get('price'), 80)
    features = _clean_features(data.get('features', []))
    if not name or not price:
        return jsonify({'success': False, 'error': 'Nama dan harga wajib diisi'}), 400
    with get_db() as conn:
        c = conn.cursor()
        c.execute('''UPDATE products SET name=?, price=?, speed=?, features=?, promo=?, target=?, image_url=?, description=?
                     WHERE id=?''',
                  (name, price, _clean_text(data.get('speed'), 80),
                   json.dumps(features),
                   _clean_text(data.get('promo'), 500),
                   _clean_text(data.get('target'), 500),
                   _clean_text(data.get('image_url'), 500),
                   _clean_text(data.get('description'), 2000),
                   product_id))
        return _success_or_not_found(c, 'Produk tidak ditemukan')


@catalog_bp.route('/api/products/<int:product_id>', methods=['DELETE'])
@login_required
def delete_product(product_id):
    with get_db() as conn:
        c = conn.cursor()
        c.execute('UPDATE products SET active = 0 WHERE id = ?', (product_id,))
        return _success_or_not_found(c, 'Produk tidak ditemukan')


@catalog_bp.route('/api/public/products', methods=['GET'])
def public_products():
    with get_db() as conn:
        c = conn.cursor()
        c.execute('SELECT * FROM products WHERE active = 1')
        products = [dict(row) for row in c.fetchall()]
    for product in products:
        try:
            product['features'] = json.loads(product['features'])
        except Exception:
            product['features'] = []
    products = [product for product in products if is_sukumba_product_row(product)]
    return jsonify(products)


@catalog_bp.route('/api/faqs', methods=['GET'])
@login_required
def get_faqs():
    with get_db() as conn:
        c = conn.cursor()
        c.execute('SELECT * FROM faqs WHERE active = 1 ORDER BY id DESC')
        return jsonify([dict(row) for row in c.fetchall()])


@catalog_bp.route('/api/faqs', methods=['POST'])
@login_required
def add_faq():
    data = _json_payload()
    question = _clean_text(data.get('question'), 500)
    answer = _clean_text(data.get('answer'), 3000)
    if not question or not answer:
        return jsonify({'success': False, 'error': 'Pertanyaan dan jawaban wajib diisi'}), 400
    with get_db() as conn:
        c = conn.cursor()
        c.execute('INSERT INTO faqs (question, answer, image_url, active) VALUES (?, ?, ?, 1)',
                  (question, answer, _clean_text(data.get('image_url'), 500)))
        faq_id = c.lastrowid
    return jsonify({'success': True, 'id': faq_id})


@catalog_bp.route('/api/faqs/<int:faq_id>', methods=['PUT'])
@login_required
def update_faq(faq_id):
    data = _json_payload()
    question = _clean_text(data.get('question'), 500)
    answer = _clean_text(data.get('answer'), 3000)
    if not question or not answer:
        return jsonify({'success': False, 'error': 'Pertanyaan dan jawaban wajib diisi'}), 400
    with get_db() as conn:
        c = conn.cursor()
        c.execute('UPDATE faqs SET question=?, answer=?, image_url=? WHERE id=?',
                  (question, answer, _clean_text(data.get('image_url'), 500), faq_id))
        return _success_or_not_found(c, 'FAQ tidak ditemukan')


@catalog_bp.route('/api/faqs/<int:faq_id>', methods=['DELETE'])
@login_required
def delete_faq(faq_id):
    with get_db() as conn:
        c = conn.cursor()
        c.execute('UPDATE faqs SET active = 0 WHERE id = ?', (faq_id,))
        return _success_or_not_found(c, 'FAQ tidak ditemukan')


@catalog_bp.route('/api/public/faqs', methods=['GET'])
def public_faqs():
    with get_db() as conn:
        c = conn.cursor()
        c.execute('SELECT * FROM faqs WHERE active = 1')
        return jsonify([dict(row) for row in c.fetchall()])


@catalog_bp.route('/api/testimonials', methods=['GET'])
@login_required
def get_testimonials():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT id, title, caption, media_url, media_type, sort_order, active,
                   COALESCE(created_at, '') AS created_at,
                   COALESCE(updated_at, '') AS updated_at
            FROM testimonials
            WHERE active = 1
            ORDER BY sort_order ASC, id DESC
        """).fetchall()
    return jsonify([dict(row) for row in rows])


@catalog_bp.route('/api/testimonials', methods=['POST'])
@login_required
def add_testimonial():
    data = _json_payload()
    title = _clean_text(data.get('title'), 150)
    media_url = _clean_text(data.get('media_url'), 500)
    caption = _clean_text(data.get('caption'), 2000)
    sort_order = _clean_int(data.get('sort_order'), 0)
    if not title:
        return jsonify({'success': False, 'error': 'Judul testimoni wajib diisi'}), 400
    if not media_url:
        return jsonify({'success': False, 'error': 'Foto/video testimoni wajib diisi'}), 400
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO testimonials
                (title, caption, media_url, media_type, sort_order, active, created_at, updated_at)
            VALUES
                (?, ?, ?, ?, ?, 1, ?, ?)
        """, (title, caption, media_url, normalize_media_type(media_url), sort_order, now, now))
        testimonial_id = cur.lastrowid
    return jsonify({'success': True, 'id': testimonial_id})


@catalog_bp.route('/api/testimonials/<int:testimonial_id>', methods=['PUT'])
@login_required
def update_testimonial(testimonial_id):
    data = _json_payload()
    title = _clean_text(data.get('title'), 150)
    media_url = _clean_text(data.get('media_url'), 500)
    caption = _clean_text(data.get('caption'), 2000)
    sort_order = _clean_int(data.get('sort_order'), 0)
    if not title:
        return jsonify({'success': False, 'error': 'Judul testimoni wajib diisi'}), 400
    if not media_url:
        return jsonify({'success': False, 'error': 'Foto/video testimoni wajib diisi'}), 400
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE testimonials
            SET title = ?, caption = ?, media_url = ?, media_type = ?,
                sort_order = ?, updated_at = ?
            WHERE id = ?
        """, (title, caption, media_url, normalize_media_type(media_url), sort_order, now, testimonial_id))
        return _success_or_not_found(cur, 'Testimoni tidak ditemukan')


@catalog_bp.route('/api/testimonials/<int:testimonial_id>', methods=['DELETE'])
@login_required
def delete_testimonial(testimonial_id):
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with get_db() as conn:
        cursor = conn.execute(
            'UPDATE testimonials SET active = 0, updated_at = ? WHERE id = ?',
            (now, testimonial_id)
        )
        return _success_or_not_found(cursor, 'Testimoni tidak ditemukan')


@catalog_bp.route('/api/public/testimonials', methods=['GET'])
def public_testimonials():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT id, title, caption, media_url, media_type, sort_order
            FROM testimonials
            WHERE active = 1
            ORDER BY sort_order ASC, id DESC
        """).fetchall()
    return jsonify([dict(row) for row in rows])


@catalog_bp.route("/api/cs-templates", methods=["GET"])
@login_required
def get_cs_templates():
    try:
        with get_db() as conn:
            rows = conn.execute("""
                SELECT
                    id,
                    title,
                    content,
                    COALESCE(active, 1) AS active,
                    COALESCE(created_at, '') AS created_at,
                    COALESCE(updated_at, '') AS updated_at
                FROM cs_templates
                WHERE COALESCE(active, 1) = 1
                ORDER BY id DESC
            """).fetchall()

        return jsonify([dict(row) for row in rows])

    except Exception as exc:
        current_app.logger.exception("Gagal mengambil CS templates")
        return jsonify({
            "success": False,
            "message": "Gagal mengambil data CS Template",
            "error": str(exc)
        }), 500


@catalog_bp.route("/api/public/cs-templates", methods=["GET"])
@require_internal_auth
def public_cs_templates():
    try:
        with get_db() as conn:
            rows = conn.execute("""
                SELECT
                    id,
                    title,
                    content,
                    COALESCE(active, 1) AS active,
                    COALESCE(created_at, '') AS created_at,
                    COALESCE(updated_at, '') AS updated_at
                FROM cs_templates
                WHERE COALESCE(active, 1) = 1
                ORDER BY id DESC
            """).fetchall()

        return jsonify([dict(row) for row in rows])

    except Exception as exc:
        current_app.logger.exception("Gagal mengambil public CS templates")
        return jsonify({
            "success": False,
            "message": "Gagal mengambil data public CS Template",
            "error": str(exc)
        }), 500


@catalog_bp.route("/api/cs-templates", methods=["POST"])
@login_required
def create_cs_template():
    try:
        payload = request.get_json(silent=True) or {}
        title = (payload.get("title") or "").strip()
        content = (payload.get("content") or "").strip()

        if not title:
            return jsonify({"success": False, "message": "Judul/Topik wajib diisi"}), 400
        if not content:
            return jsonify({"success": False, "message": "Isi Template wajib diisi"}), 400

        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO cs_templates
                    (title, content, active, created_at, updated_at)
                VALUES
                    (?, ?, 1, ?, ?)
            """, (title, content, now, now))
            new_id = cursor.lastrowid

        return jsonify({
            "success": True,
            "message": "CS Template berhasil disimpan.",
            "id": new_id
        })

    except Exception as exc:
        current_app.logger.exception("Gagal menyimpan CS template")
        return jsonify({
            "success": False,
            "message": "Gagal menyimpan CS Template",
            "error": str(exc)
        }), 500


@catalog_bp.route("/api/cs-templates/<int:template_id>", methods=["PUT"])
@login_required
def update_cs_template(template_id):
    try:
        payload = request.get_json(silent=True) or {}
        title = (payload.get("title") or "").strip()
        content = (payload.get("content") or "").strip()

        if not title:
            return jsonify({"success": False, "message": "Judul/Topik wajib diisi"}), 400
        if not content:
            return jsonify({"success": False, "message": "Isi Template wajib diisi"}), 400

        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        with get_db() as conn:
            cursor = conn.cursor()
            existing = cursor.execute("""
                SELECT id FROM cs_templates WHERE id = ?
            """, (template_id,)).fetchone()

            if not existing:
                return jsonify({"success": False, "message": "CS Template tidak ditemukan"}), 404

            cursor.execute("""
                UPDATE cs_templates
                SET title = ?, content = ?, active = 1, updated_at = ?
                WHERE id = ?
            """, (title, content, now, template_id))

        return jsonify({"success": True, "message": "CS Template berhasil diperbarui."})

    except Exception as exc:
        current_app.logger.exception("Gagal update CS template")
        return jsonify({
            "success": False,
            "message": "Gagal update CS Template",
            "error": str(exc)
        }), 500


@catalog_bp.route("/api/cs-templates/<int:template_id>", methods=["DELETE"])
@login_required
def delete_cs_template(template_id):
    try:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        with get_db() as conn:
            cursor = conn.cursor()
            existing = cursor.execute("""
                SELECT id FROM cs_templates WHERE id = ?
            """, (template_id,)).fetchone()

            if not existing:
                return jsonify({"success": False, "message": "CS Template tidak ditemukan"}), 404

            cursor.execute("""
                UPDATE cs_templates
                SET active = 0, updated_at = ?
                WHERE id = ?
            """, (now, template_id))

        return jsonify({"success": True, "message": "CS Template berhasil dihapus."})

    except Exception as exc:
        current_app.logger.exception("Gagal hapus CS template")
        return jsonify({
            "success": False,
            "message": "Gagal hapus CS Template",
            "error": str(exc)
        }), 500
