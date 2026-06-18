"""Shipping rate management and total calculation routes."""

from datetime import datetime

from flask import Blueprint, current_app, jsonify, request

from admin_core.auth import login_required, require_internal_auth
from admin_core.db import get_db
from admin_core.helpers import format_rupiah, normalize_location, parse_money
from admin_core.rajaongkir import RajaOngkirClient, RajaOngkirError


shipping_bp = Blueprint('shipping', __name__)
_rajaongkir = None


def configure_rajaongkir(config, logger=None):
    global _rajaongkir
    _rajaongkir = RajaOngkirClient(config, logger)


def row_to_shipping_rate(row):
    data = dict(row)
    data['shipping_cost_label'] = format_rupiah(data.get('shipping_cost'))
    return data


def _json_payload():
    return request.get_json(silent=True) or {}


def _clean_text(value, max_length=500):
    return str(value or '').strip()[:max_length]


def _find_rajaongkir_destination(payload):
    destination_id = _clean_text(
        payload.get('rajaongkir_destination_id')
        or payload.get('destination_id')
        or payload.get('destination')
    )
    destination = None
    if destination_id:
        return destination_id, destination
    if not _rajaongkir or not _rajaongkir.api_key:
        return '', None

    query = _clean_text(
        payload.get('rajaongkir_query')
        or ', '.join([part for part in [
            payload.get('district'),
            payload.get('city'),
            payload.get('province'),
        ] if part])
    )
    if not query:
        return '', None

    destinations = _rajaongkir.search_destinations(query, limit=5)
    destination = destinations[0] if destinations else None
    return (destination or {}).get('id', ''), destination


def _rajaongkir_rate_payload(option, payload, destination=None):
    courier = option.get('courier') or _clean_text(payload.get('courier')) or 'JNE'
    service = option.get('service') or _clean_text(payload.get('service')) or 'REG'
    estimated_days = option.get('etd') or ''
    return {
        'province': _clean_text(payload.get('province') or (destination or {}).get('province')),
        'city': _clean_text(payload.get('city') or (destination or {}).get('city')),
        'district': _clean_text(payload.get('district') or (destination or {}).get('district')),
        'courier': courier.upper(),
        'service': service.upper(),
        'shipping_cost': int(option.get('cost') or 0),
        'estimated_days': estimated_days,
        'notes': 'RajaOngkir',
        'source': 'rajaongkir',
    }


def _upsert_shipping_rate(rate_payload, overwrite=False):
    province = rate_payload['province']
    city = rate_payload['city']
    district = rate_payload['district']
    courier = rate_payload['courier']
    service = rate_payload['service']
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with get_db() as conn:
        existing = _find_existing_rate(conn, province, city, district, courier, service)
        if existing and not overwrite:
            return existing['id'], False
        if existing:
            conn.execute("""
                UPDATE shipping_rates
                SET shipping_cost = ?, estimated_days = ?, notes = ?, updated_at = ?
                WHERE id = ?
            """, (
                rate_payload['shipping_cost'],
                rate_payload['estimated_days'],
                rate_payload['notes'],
                now,
                existing['id'],
            ))
            return existing['id'], True
        cursor = conn.execute("""
            INSERT INTO shipping_rates
                (province, city, district, courier, service, shipping_cost,
                 estimated_days, notes, active, created_at, updated_at)
            VALUES
                (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        """, (
            province,
            city,
            district,
            courier,
            service,
            rate_payload['shipping_cost'],
            rate_payload['estimated_days'],
            rate_payload['notes'],
            now,
            now,
        ))
        return cursor.lastrowid, True


def _calculate_rajaongkir(payload):
    if not _rajaongkir or not _rajaongkir.enabled:
        return None
    destination_id, destination = _find_rajaongkir_destination(payload)
    if not destination_id:
        return None
    option = _rajaongkir.calculate(
        destination_id=destination_id,
        weight=payload.get('weight') or payload.get('weight_grams'),
        courier=payload.get('courier'),
        service=payload.get('service'),
    )
    return _rajaongkir_rate_payload(option, payload, destination)


def find_shipping_rate(province='', city='', district='', courier='', service=''):
    province_key = normalize_location(province)
    city_key = normalize_location(city)
    district_key = normalize_location(district)
    courier_key = normalize_location(courier)
    service_key = normalize_location(service)

    with get_db() as conn:
        rows = conn.execute("""
            SELECT *
            FROM shipping_rates
            WHERE active = 1
            ORDER BY
                CASE WHEN COALESCE(district, '') != '' THEN 0 ELSE 1 END,
                CASE WHEN COALESCE(province, '') != '' THEN 0 ELSE 1 END,
                id DESC
        """).fetchall()

    candidates = []
    for row in rows:
        row_province = normalize_location(row['province'])
        row_city = normalize_location(row['city'])
        row_district = normalize_location(row['district'])
        row_courier = normalize_location(row['courier'])
        row_service = normalize_location(row['service'])

        if row_city and city_key and row_city != city_key:
            continue
        if row_province and province_key and row_province != province_key:
            continue
        if row_district and district_key and row_district != district_key:
            continue
        if row_district and not district_key:
            continue
        if courier_key and row_courier and row_courier != courier_key:
            continue
        if service_key and row_service and row_service != service_key:
            continue
        candidates.append(row)

    if not candidates:
        return None
    return candidates[0]


@shipping_bp.route('/api/shipping-rates', methods=['GET'])
@login_required
def get_shipping_rates():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT *
            FROM shipping_rates
            WHERE active = 1
            ORDER BY province ASC, city ASC, district ASC, courier ASC, service ASC, id DESC
        """).fetchall()
    return jsonify([row_to_shipping_rate(row) for row in rows])


@shipping_bp.route('/api/shipping-rates', methods=['POST'])
@login_required
def create_shipping_rate():
    payload = _json_payload()
    city = (payload.get('city') or '').strip()
    shipping_cost = parse_money(payload.get('shipping_cost'))
    if not city:
        return jsonify({'success': False, 'error': 'Kab/Kota wajib diisi'}), 400
    if shipping_cost <= 0:
        return jsonify({'success': False, 'error': 'Ongkir wajib lebih dari 0'}), 400

    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO shipping_rates
                (province, city, district, courier, service, shipping_cost,
                 estimated_days, notes, active, created_at, updated_at)
            VALUES
                (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        """, (
            (payload.get('province') or '').strip(),
            city,
            (payload.get('district') or '').strip(),
            (payload.get('courier') or 'JNE').strip(),
            (payload.get('service') or 'REG').strip(),
            shipping_cost,
            (payload.get('estimated_days') or '').strip(),
            (payload.get('notes') or '').strip(),
            now,
            now,
        ))
        rate_id = cur.lastrowid
    return jsonify({'success': True, 'id': rate_id})


def _split_districts(raw_value):
    items = []
    for part in str(raw_value or '').replace(';', '\n').replace(',', '\n').splitlines():
        district = part.strip()
        if district and district.lower() not in {item.lower() for item in items}:
            items.append(district)
    return items


def _find_existing_rate(conn, province, city, district, courier, service):
    return conn.execute("""
        SELECT id
        FROM shipping_rates
        WHERE active = 1
          AND LOWER(TRIM(COALESCE(province, ''))) = LOWER(TRIM(?))
          AND LOWER(TRIM(city)) = LOWER(TRIM(?))
          AND LOWER(TRIM(COALESCE(district, ''))) = LOWER(TRIM(?))
          AND LOWER(TRIM(COALESCE(courier, ''))) = LOWER(TRIM(?))
          AND LOWER(TRIM(COALESCE(service, ''))) = LOWER(TRIM(?))
        LIMIT 1
    """, (province, city, district, courier, service)).fetchone()


@shipping_bp.route('/api/shipping-rates/bulk-generate', methods=['POST'])
@login_required
def bulk_generate_shipping_rates():
    payload = _json_payload()
    province = (payload.get('province') or '').strip()
    city = (payload.get('city') or '').strip()
    districts = _split_districts(payload.get('districts'))
    courier = (payload.get('courier') or 'JNE').strip()
    service = (payload.get('service') or 'REG').strip()
    estimated_days = (payload.get('estimated_days') or '').strip()
    notes = (payload.get('notes') or '').strip()
    overwrite = bool(payload.get('overwrite'))
    shipping_cost = parse_money(payload.get('shipping_cost'))

    if not city:
        return jsonify({'success': False, 'error': 'Kab/Kota wajib diisi'}), 400
    if not districts:
        return jsonify({'success': False, 'error': 'Daftar kecamatan wajib diisi'}), 400
    if shipping_cost <= 0:
        return jsonify({'success': False, 'error': 'Ongkir wajib lebih dari 0'}), 400

    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    created = []
    updated = []
    skipped = []
    with get_db() as conn:
        for district in districts:
            existing = _find_existing_rate(conn, province, city, district, courier, service)
            if existing and not overwrite:
                skipped.append(district)
                continue
            if existing:
                conn.execute("""
                    UPDATE shipping_rates
                    SET shipping_cost = ?, estimated_days = ?, notes = ?, updated_at = ?
                    WHERE id = ?
                """, (shipping_cost, estimated_days, notes, now, existing['id']))
                updated.append(district)
                continue

            conn.execute("""
                INSERT INTO shipping_rates
                    (province, city, district, courier, service, shipping_cost,
                     estimated_days, notes, active, created_at, updated_at)
                VALUES
                    (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            """, (
                province,
                city,
                district,
                courier,
                service,
                shipping_cost,
                estimated_days,
                notes,
                now,
                now,
            ))
            created.append(district)

    return jsonify({
        'success': True,
        'created': created,
        'updated': updated,
        'skipped': skipped,
        'created_count': len(created),
        'updated_count': len(updated),
        'skipped_count': len(skipped),
    })


@shipping_bp.route('/api/shipping-rates/<int:rate_id>', methods=['PUT'])
@login_required
def update_shipping_rate(rate_id):
    payload = _json_payload()
    city = (payload.get('city') or '').strip()
    shipping_cost = parse_money(payload.get('shipping_cost'))
    if not city:
        return jsonify({'success': False, 'error': 'Kab/Kota wajib diisi'}), 400
    if shipping_cost <= 0:
        return jsonify({'success': False, 'error': 'Ongkir wajib lebih dari 0'}), 400

    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with get_db() as conn:
        conn.execute("""
            UPDATE shipping_rates
            SET province = ?, city = ?, district = ?, courier = ?, service = ?,
                shipping_cost = ?, estimated_days = ?, notes = ?, updated_at = ?
            WHERE id = ?
        """, (
            (payload.get('province') or '').strip(),
            city,
            (payload.get('district') or '').strip(),
            (payload.get('courier') or 'JNE').strip(),
            (payload.get('service') or 'REG').strip(),
            shipping_cost,
            (payload.get('estimated_days') or '').strip(),
            (payload.get('notes') or '').strip(),
            now,
            rate_id,
        ))
    return jsonify({'success': True})


@shipping_bp.route('/api/shipping-rates/<int:rate_id>', methods=['DELETE'])
@login_required
def delete_shipping_rate(rate_id):
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with get_db() as conn:
        conn.execute('UPDATE shipping_rates SET active = 0, updated_at = ? WHERE id = ?', (now, rate_id))
    return jsonify({'success': True})


@shipping_bp.route('/api/rajaongkir/status', methods=['GET'])
@login_required
def rajaongkir_status():
    missing = []
    if not (_rajaongkir and _rajaongkir.api_key):
        missing.append('RAJAONGKIR_API_KEY')
    if not (_rajaongkir and _rajaongkir.origin_id):
        missing.append('RAJAONGKIR_ORIGIN_ID')
    return jsonify({
        'enabled': bool(_rajaongkir and _rajaongkir.enabled),
        'api_key_configured': bool(_rajaongkir and _rajaongkir.api_key),
        'origin_configured': bool(_rajaongkir and _rajaongkir.origin_id),
        'missing': missing,
        'mode': _rajaongkir.mode if _rajaongkir else '',
        'base_url': _rajaongkir.base_url if _rajaongkir else '',
        'default_courier': (_rajaongkir.default_courier if _rajaongkir else 'jne').upper(),
        'default_weight': _rajaongkir.default_weight if _rajaongkir else 0,
    })


@shipping_bp.route('/api/rajaongkir/destinations', methods=['GET'])
@login_required
def rajaongkir_destinations():
    if not _rajaongkir or not _rajaongkir.api_key:
        return jsonify({'success': False, 'error': 'RAJAONGKIR_API_KEY belum diisi'}), 400
    query = _clean_text(request.args.get('q'))
    if not query:
        return jsonify({'success': False, 'error': 'Query tujuan wajib diisi'}), 400
    try:
        return jsonify({'success': True, 'destinations': _rajaongkir.search_destinations(query)})
    except RajaOngkirError as exc:
        return jsonify({'success': False, 'error': str(exc)}), 502


@shipping_bp.route('/api/rajaongkir/test', methods=['GET'])
@login_required
def rajaongkir_test():
    query = _clean_text(request.args.get('q') or 'Baturraden Banyumas')
    subtotal = parse_money(request.args.get('subtotal') or '99000')
    status = rajaongkir_status().get_json()
    result = {
        'success': False,
        'status': status,
        'query': query,
        'destinations': [],
        'calculation': None,
    }
    if not _rajaongkir or not _rajaongkir.api_key:
        result['error'] = 'RAJAONGKIR_API_KEY belum diisi nilai asli'
        return jsonify(result), 400

    try:
        destinations = _rajaongkir.search_destinations(query, limit=5)
        result['destinations'] = destinations
        if not destinations:
            result['error'] = 'Destination tidak ditemukan dari query test'
            return jsonify(result), 404

        result['success'] = True
        if not _rajaongkir.origin_id:
            result['next_step'] = 'Pilih salah satu destinations[].id untuk RAJAONGKIR_ORIGIN_ID jika itu lokasi asal, lalu restart admin-panel.'
            return jsonify(result)

        destination = destinations[0]
        option = _rajaongkir.calculate(
            destination_id=destination['id'],
            weight=request.args.get('weight') or _rajaongkir.default_weight,
            courier=request.args.get('courier') or _rajaongkir.default_courier,
            service=request.args.get('service') or 'REG',
        )
        rate_payload = _rajaongkir_rate_payload(
            option,
            {
                'province': destination.get('province'),
                'city': destination.get('city'),
                'district': destination.get('district'),
                'courier': request.args.get('courier') or _rajaongkir.default_courier,
                'service': request.args.get('service') or 'REG',
            },
            destination,
        )
        shipping_cost = rate_payload['shipping_cost']
        result['calculation'] = {
            'source': 'rajaongkir',
            'rate': {
                **rate_payload,
                'shipping_cost_label': format_rupiah(shipping_cost),
            },
            'subtotal': subtotal,
            'subtotal_label': format_rupiah(subtotal),
            'total': subtotal + shipping_cost,
            'total_label': format_rupiah(subtotal + shipping_cost),
        }
        return jsonify(result)
    except RajaOngkirError as exc:
        result['error'] = str(exc)
        current_app.logger.warning(f'RajaOngkir test failed: {exc}')
        return jsonify(result), 502


@shipping_bp.route('/api/shipping-rates/rajaongkir-sync', methods=['POST'])
@login_required
def sync_shipping_rate_from_rajaongkir():
    payload = _json_payload()
    if not _rajaongkir or not _rajaongkir.enabled:
        return jsonify({'success': False, 'error': 'Konfigurasi RajaOngkir belum lengkap'}), 400
    try:
        rate_payload = _calculate_rajaongkir(payload)
        if not rate_payload or rate_payload['shipping_cost'] <= 0:
            return jsonify({'success': False, 'error': 'Tarif RajaOngkir tidak ditemukan'}), 404
        if not rate_payload['city']:
            rate_payload['city'] = _clean_text(payload.get('city'))
        if not rate_payload['city']:
            return jsonify({'success': False, 'error': 'Kab/Kota wajib diisi'}), 400
        rate_id, changed = _upsert_shipping_rate(rate_payload, overwrite=bool(payload.get('overwrite', True)))
        rate_payload['shipping_cost_label'] = format_rupiah(rate_payload['shipping_cost'])
        return jsonify({
            'success': True,
            'id': rate_id,
            'changed': changed,
            'rate': rate_payload,
        })
    except RajaOngkirError as exc:
        current_app.logger.warning(f'RajaOngkir sync failed: {exc}')
        return jsonify({'success': False, 'error': str(exc)}), 502


@shipping_bp.route('/api/calculate-shipping', methods=['POST'])
@require_internal_auth
def calculate_shipping():
    payload = _json_payload()
    subtotal = parse_money(payload.get('subtotal') or payload.get('product_total') or payload.get('price'))
    try:
        rajaongkir_rate = _calculate_rajaongkir(payload)
        if rajaongkir_rate and rajaongkir_rate['shipping_cost'] > 0:
            shipping_cost = rajaongkir_rate['shipping_cost']
            total = subtotal + shipping_cost
            return jsonify({
                'success': True,
                'source': 'rajaongkir',
                'rate': {
                    **rajaongkir_rate,
                    'shipping_cost_label': format_rupiah(shipping_cost),
                },
                'subtotal': subtotal,
                'subtotal_label': format_rupiah(subtotal),
                'shipping_cost': shipping_cost,
                'shipping_cost_label': format_rupiah(shipping_cost),
                'total': total,
                'total_label': format_rupiah(total),
            })
    except RajaOngkirError as exc:
        current_app.logger.warning(f'RajaOngkir calculate fallback: {exc}')

    rate = find_shipping_rate(
        province=payload.get('province'),
        city=payload.get('city'),
        district=payload.get('district'),
        courier=payload.get('courier'),
        service=payload.get('service'),
    )
    if not rate:
        return jsonify({
            'success': False,
            'error': 'Ongkir untuk wilayah ini belum tersedia',
            'subtotal': subtotal,
            'subtotal_label': format_rupiah(subtotal),
        }), 404

    shipping_cost = int(rate['shipping_cost'])
    total = subtotal + shipping_cost
    return jsonify({
        'success': True,
        'rate': row_to_shipping_rate(rate),
        'subtotal': subtotal,
        'subtotal_label': format_rupiah(subtotal),
        'shipping_cost': shipping_cost,
        'shipping_cost_label': format_rupiah(shipping_cost),
        'total': total,
        'total_label': format_rupiah(total),
    })
