"""Environment-backed configuration values for the AI service."""

import os
from dataclasses import dataclass


SERVICE_VERSION = "v6.10-consult-history-slot-recovery"
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@dataclass(frozen=True)
class ServiceConfig:
    base_dir: str
    service_version: str
    default_llm_api_url: str
    admin_api: str
    products_api: str
    faqs_api: str
    cs_templates_api: str
    groq_api_key: str
    llm_api_key: str
    internal_api_key: str
    telegram_bot_token: str
    telegram_chat_id: str
    telegram_api: str


def load_service_config():
    admin_url = os.getenv('ADMIN_URL', 'http://admin-panel-docker:5001')
    groq_api_key = os.getenv('GROQ_API_KEY', '')
    llm_api_key = os.getenv('LLM_API_KEY', os.getenv('OPENROUTER_API_KEY', groq_api_key))
    telegram_bot_token = os.getenv('TELEGRAM_BOT_TOKEN', '')

    return ServiceConfig(
        base_dir=BASE_DIR,
        service_version=SERVICE_VERSION,
        default_llm_api_url=os.getenv(
            'LLM_API_URL',
            os.getenv('GROQ_API_URL', 'https://api.groq.com/openai/v1/chat/completions')
        ),
        admin_api=f"{admin_url}/api/public/settings",
        products_api=f"{admin_url}/api/public/products",
        faqs_api=f"{admin_url}/api/public/faqs",
        cs_templates_api=f"{admin_url}/api/public/cs-templates",
        groq_api_key=groq_api_key,
        llm_api_key=llm_api_key,
        internal_api_key=os.getenv('INTERNAL_API_KEY', ''),
        telegram_bot_token=telegram_bot_token,
        telegram_chat_id=os.getenv('TELEGRAM_CHAT_ID', ''),
        telegram_api=f"https://api.telegram.org/bot{telegram_bot_token}",
    )
