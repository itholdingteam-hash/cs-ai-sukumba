"""RajaOngkir integration helpers."""

import requests


class RajaOngkirError(Exception):
    """Raised when RajaOngkir cannot return a usable shipping rate."""


def _as_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _first_cost_option(options, service=''):
    if not options:
        return None
    service_key = str(service or '').strip().lower()
    if service_key:
        for option in options:
            if str(option.get('service') or option.get('code') or '').strip().lower() == service_key:
                return option
    return options[0]


class RajaOngkirClient:
    def __init__(self, config, logger=None):
        self.api_key = config.rajaongkir_api_key
        self.base_url = config.rajaongkir_base_url.rstrip('/')
        self.mode = config.rajaongkir_mode
        self.origin_id = config.rajaongkir_origin_id
        self.default_weight = config.rajaongkir_default_weight
        self.default_courier = config.rajaongkir_default_courier
        self.logger = logger

    @property
    def enabled(self):
        return bool(self.api_key and self.origin_id)

    def _headers(self):
        return {
            'key': self.api_key,
            'Accept': 'application/json',
        }

    def search_destinations(self, query, limit=10):
        if not self.api_key:
            raise RajaOngkirError('RAJAONGKIR_API_KEY belum diisi')
        query = str(query or '').strip()
        if not query:
            return []

        if self.mode == 'classic':
            return []

        response = requests.get(
            f'{self.base_url}/destination/domestic-destination',
            headers=self._headers(),
            params={'search': query, 'limit': limit, 'offset': 0},
            timeout=15,
        )
        payload = self._json_response(response)
        raw_items = payload.get('data') or payload.get('results') or []
        return [self._normalize_destination(item) for item in raw_items]

    def calculate(self, destination_id, weight=None, courier=None, service=''):
        if not self.enabled:
            raise RajaOngkirError('Konfigurasi RajaOngkir belum lengkap')
        destination_id = str(destination_id or '').strip()
        if not destination_id:
            raise RajaOngkirError('Destination ID RajaOngkir belum tersedia')
        weight = _as_int(weight, self.default_weight) or self.default_weight
        courier = (courier or self.default_courier or 'jne').strip().lower()

        if self.mode == 'classic':
            options = self._calculate_classic(destination_id, weight, courier)
        else:
            options = self._calculate_komerce(destination_id, weight, courier)

        selected = _first_cost_option(options, service)
        if not selected:
            raise RajaOngkirError('Tarif RajaOngkir tidak ditemukan untuk tujuan tersebut')
        return selected

    def _calculate_komerce(self, destination_id, weight, courier):
        response = requests.post(
            f'{self.base_url}/calculate/domestic-cost',
            headers=self._headers(),
            data={
                'origin': self.origin_id,
                'destination': destination_id,
                'weight': weight,
                'courier': courier,
                'filter': 'lowest',
            },
            timeout=20,
        )
        payload = self._json_response(response)
        raw_items = payload.get('data') or payload.get('results') or []
        return [self._normalize_cost(item, courier) for item in raw_items]

    def _calculate_classic(self, destination_id, weight, courier):
        response = requests.post(
            f'{self.base_url}/cost',
            headers=self._headers(),
            data={
                'origin': self.origin_id,
                'destination': destination_id,
                'weight': weight,
                'courier': courier,
            },
            timeout=20,
        )
        payload = self._json_response(response)
        results = ((payload.get('rajaongkir') or {}).get('results') or [])
        options = []
        for courier_result in results:
            courier_code = courier_result.get('code') or courier
            for item in courier_result.get('costs') or []:
                cost = (item.get('cost') or [{}])[0]
                options.append(self._normalize_cost({
                    'name': courier_result.get('name') or courier_code,
                    'code': courier_code,
                    'service': item.get('service'),
                    'description': item.get('description'),
                    'cost': cost.get('value'),
                    'etd': cost.get('etd'),
                }, courier_code))
        return options

    def _json_response(self, response):
        try:
            payload = response.json()
        except ValueError as exc:
            raise RajaOngkirError('Response RajaOngkir tidak valid') from exc
        if response.status_code >= 400:
            meta = payload.get('meta') or {}
            message = (
                payload.get('message')
                or payload.get('error')
                or meta.get('message')
                or ((payload.get('rajaongkir') or {}).get('status') or {}).get('description')
                or f'RajaOngkir HTTP {response.status_code}'
            )
            raise RajaOngkirError(message)
        meta = payload.get('meta') or {}
        if str(meta.get('status') or '').lower() == 'error':
            raise RajaOngkirError(meta.get('message') or 'RajaOngkir mengembalikan error')
        return payload

    def _normalize_destination(self, item):
        return {
            'id': str(item.get('id') or item.get('destination_id') or item.get('city_id') or ''),
            'label': item.get('label') or item.get('subdistrict_name') or item.get('district_name') or item.get('city_name') or '',
            'province': item.get('province_name') or item.get('province') or '',
            'city': item.get('city_name') or item.get('city') or item.get('regency_name') or '',
            'district': item.get('district_name') or item.get('subdistrict_name') or '',
            'type': item.get('type') or '',
            'postal_code': item.get('zip_code') or item.get('postal_code') or '',
            'raw': item,
        }

    def _normalize_cost(self, item, courier):
        cost = _as_int(item.get('cost') or item.get('value') or item.get('price'))
        return {
            'courier': (item.get('code') or courier or '').upper(),
            'courier_name': item.get('name') or '',
            'service': item.get('service') or item.get('description') or '',
            'description': item.get('description') or '',
            'cost': cost,
            'etd': str(item.get('etd') or item.get('duration') or '').replace('HARI', '').strip(),
            'raw': item,
        }
