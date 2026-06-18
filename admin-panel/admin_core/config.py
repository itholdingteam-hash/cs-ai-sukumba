"""Environment-backed configuration for the admin panel."""

import os
from dataclasses import dataclass

from dotenv import load_dotenv


DEFAULT_WA_GATEWAY_URL = 'http://127.0.0.1:3000'
PLACEHOLDER_VALUES = {
    '',
    'isi_api_key_kamu',
    'isi_id_asal_pengiriman',
    'api_key_asli_dari_komerce',
    'id_lokasi_asal_asli',
    'your-api-key',
    'your-api-key-here',
    'ganti_dengan_api_key',
}


@dataclass(frozen=True)
class AdminConfig:
    base_dir: str
    db_file: str
    secret_key: str
    admin_password: str
    internal_api_key: str
    telegram_bot_token: str
    wa_gateway_url: str
    wa_gateway_urls: list[str]
    ai_url: str
    upload_folder: str
    allowed_extensions: set[str]
    rajaongkir_api_key: str
    rajaongkir_base_url: str
    rajaongkir_mode: str
    rajaongkir_origin_id: str
    rajaongkir_default_weight: int
    rajaongkir_default_courier: str


def _clean_env_value(*names, default=''):
    for name in names:
        candidate = os.getenv(name)
        value = str(candidate or '').strip()
        if value and value.lower() not in PLACEHOLDER_VALUES:
            return value
    value = str(default or '').strip()
    return '' if value.lower() in PLACEHOLDER_VALUES else value


def _clean_env_int(*names, default):
    value = default
    for name in names:
        candidate = os.getenv(name)
        if candidate not in (None, ''):
            value = candidate
            break
    try:
        return int(value or default)
    except (TypeError, ValueError):
        return default


def load_config():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    load_dotenv(os.path.join(base_dir, '.env'))

    wa_gateway_url = os.getenv('WA_GATEWAY_URL', DEFAULT_WA_GATEWAY_URL).rstrip('/')
    wa_gateway_urls = [wa_gateway_url]
    if wa_gateway_url != DEFAULT_WA_GATEWAY_URL:
        wa_gateway_urls.append(DEFAULT_WA_GATEWAY_URL)

    return AdminConfig(
        base_dir=base_dir,
        db_file=os.getenv('DB_PATH', os.path.join(base_dir, 'admin_panel.db')),
        secret_key=os.getenv('SECRET_KEY', os.urandom(32)),
        admin_password=os.getenv('ADMIN_PASSWORD', 'ganti-password-default!'),
        internal_api_key=os.getenv('INTERNAL_API_KEY', ''),
        telegram_bot_token=os.getenv('TELEGRAM_BOT_TOKEN', ''),
        wa_gateway_url=wa_gateway_url,
        wa_gateway_urls=wa_gateway_urls,
        ai_url=os.getenv('AI_URL', 'http://127.0.0.1:5000').rstrip('/'),
        upload_folder=os.path.join(base_dir, 'static', 'uploads'),
        allowed_extensions={'png', 'jpg', 'jpeg', 'gif', 'mp4', 'mov', 'webp'},
        rajaongkir_api_key=_clean_env_value('RAJAONGKIR_API_KEY', 'KOMERCE_API_KEY'),
        rajaongkir_base_url=_clean_env_value(
            'RAJAONGKIR_BASE_URL',
            'KOMERCE_BASE_URL',
            default='https://rajaongkir.komerce.id/api/v1',
        ).rstrip('/'),
        rajaongkir_mode=_clean_env_value('RAJAONGKIR_MODE', 'KOMERCE_MODE', default='komerce').lower(),
        rajaongkir_origin_id=_clean_env_value('RAJAONGKIR_ORIGIN_ID', 'KOMERCE_ORIGIN_ID'),
        rajaongkir_default_weight=_clean_env_int(
            'RAJAONGKIR_DEFAULT_WEIGHT',
            'KOMERCE_DEFAULT_WEIGHT',
            default=500,
        ),
        rajaongkir_default_courier=_clean_env_value(
            'RAJAONGKIR_DEFAULT_COURIER',
            'KOMERCE_DEFAULT_COURIER',
            default='jne',
        ).lower(),
    )
