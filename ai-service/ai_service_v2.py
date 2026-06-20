#!/usr/bin/env python3
"""
Sukumba AI Service v2 - Refactored
Fitur: Multi-Agent AI + Input Sanitasi + Secure Credentials

Deploy:
    1. cp .env /home/tunet/ai-service/.env
    2. pip install flask python-dotenv requests
    3. python3 ai_service_v2.py
"""

from flask import Flask, request, jsonify
from functools import wraps
import requests
import json
import os
import re
import logging
import html
import sys

# ------------------------------------------------------------------
# 0. ENVIRONMENT SETUP
# ------------------------------------------------------------------
from dotenv import load_dotenv
load_dotenv()

from sukumba_core.config import load_service_config
from sukumba_core import consultation_helpers
from sukumba_core.deterministic_replies import ProductReplyDeps
from sukumba_core import deterministic_replies
from sukumba_core import order_helpers
from sukumba_core import product_helpers
from sukumba_core import state_helpers
from sukumba_core.patterns import (
    CONSULT_QUESTION_IDS,
    CONSULTATION_PATTERNS,
    GENERAL_HEALTH_PATTERNS,
    MALE_HEALTH_PATTERNS,
    MALE_VITALITY_TERMS,
    ORDER_PATTERNS,
    RED_FLAG_PATTERNS,
    SHORT_CONFIRM_WORDS,
    SHORT_REACTION_WORDS,
)
from sukumba_core.persona import SUKUMBA_PERSONA_CONTRACT as CORE_PERSONA_CONTRACT
from sukumba_core.security import sanitize_input as sanitize_customer_input
from sukumba_core.state_helpers import (
    infer_question_id_from_reply,
    product_context_updates,
    state_from_question_id,
    state_updates_for_reply,
)
from sukumba_core.state_router import StateRouterDeps, route_state_precheck
from sukumba_core.syifa_router import SyifaRouterDeps, route_syifa_template
from sukumba_core.template_service import TemplateService, greeting_label_for_message
from sukumba_core.template_store import DynamicTemplateStore

CONFIG = load_service_config()
BASE_DIR = CONFIG.base_dir
SERVICE_VERSION = CONFIG.service_version

SUKUMBA_PERSONA_CONTRACT = CORE_PERSONA_CONTRACT
CS_TONE_GUIDE = SUKUMBA_PERSONA_CONTRACT

DEFAULT_LLM_API_URL = CONFIG.default_llm_api_url
ADMIN_API = CONFIG.admin_api
PRODUCTS_API = CONFIG.products_api
FAQS_API = CONFIG.faqs_api
CS_TEMPLATES_API = CONFIG.cs_templates_api

GROQ_API_KEY = CONFIG.groq_api_key
LLM_API_KEY = CONFIG.llm_api_key
INTERNAL_API_KEY = CONFIG.internal_api_key

TELEGRAM_BOT_TOKEN = CONFIG.telegram_bot_token
TELEGRAM_CHAT_ID = CONFIG.telegram_chat_id
TELEGRAM_API = CONFIG.telegram_api

# ------------------------------------------------------------------
# 1. LOGGING
# ------------------------------------------------------------------
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler(os.path.join(BASE_DIR, 'ai_service.log'), encoding='utf-8'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

def log_preview(value, limit=80):
    text = str(value or '')[:limit]
    return text.encode('ascii', errors='backslashreplace').decode('ascii')

dynamic_templates = DynamicTemplateStore(
    CS_TEMPLATES_API,
    internal_api_key=INTERNAL_API_KEY,
    logger=logger,
)
template_service = TemplateService(dynamic_templates)

# ------------------------------------------------------------------
# 2. FLASK APP
# ------------------------------------------------------------------
app = Flask(__name__)

# ------------------------------------------------------------------
# 3. SECURITY HELPERS
# ------------------------------------------------------------------
def sanitize_input(text):
    """
    Sanitasi input user sebelum dikirim ke LLM.
    - Escape HTML entities
    - Deteksi prompt injection patterns
    - Truncate jika terlalu panjang
    """
    return sanitize_customer_input(text, logger=logger)

def has_pattern(text, patterns):
    lower = html.unescape(str(text or '')).lower()
    return any(re.search(pattern, lower, re.IGNORECASE) for pattern in patterns)

def has_male_health_signal(text):
    return has_pattern(text, MALE_HEALTH_PATTERNS)

def has_general_health_signal(text):
    return has_pattern(text, GENERAL_HEALTH_PATTERNS)

def is_consultation_request(text):
    return has_pattern(text, CONSULTATION_PATTERNS)

def is_open_question_request(text):
    lower = html.unescape(str(text or '')).lower().strip()
    lower = re.sub(r'[.!?]+$', '', lower)
    lower = re.sub(r'\b(kak|kakak|min|admin|cs|ya|yah|dulu|dl|aja|dong|nih|sih)\b', ' ', lower)
    lower = re.sub(r'\s+', ' ', lower).strip()
    if not re.fullmatch(r'(mau|mo|boleh|izin|ijin)?\s*(tanya|nanya|bertanya)', lower):
        return False
    return not (
        is_product_question(text)
        or is_explicit_order_request(text)
        or has_male_health_signal(text)
        or has_general_health_signal(text)
        or re.search(r'\b(harga|promo|paket|ongkir|cod|transfer|bpom|halal|komposisi|aturan|minum|cara|manfaat|khasiat|produk|keluhan|stamina|vitalitas|ereksi|pusing|mual|tensi)\b', html.unescape(str(text or '')).lower())
    )

def open_question_reply():
    return "Boleh Kak, mau tanya soal apa dulu? Bisa tentang produk Sukumba, manfaat, aturan minum, harga, atau konsultasi keluhan."

def is_explicit_order_request(text):
    lower = html.unescape(str(text or '')).lower().strip()
    return (
        re.search(r'(\bmau\b|\bmo\b|\bingin\b|\bpengen\b|\bjadi\b|\blanjut\b|\bgas\b)\s+(beli|pesan|pesen|order)\b', lower)
        or re.search(r'\blangsung\s+(beli|pesan|pesen|order|checkout|co)\b', lower)
        or re.search(r'\b(ya|iya|ok|oke|baik|siap)\s+(beli|pesan|pesen|order)\b', lower)
        or re.search(r'\b(order|pesan|beli)\s+sekarang\b', lower)
        or re.search(r'\bcara\s+(beli|pesan|pesen|order|pemesanan)\b', lower)
        or re.search(r'\b(beli|pesan|pesen|order|pemesanan)\s+(gimana|bagaimana|gmn|gmna|caranya)\b', lower)
        or re.search(r'\bambil\s+\d+\s*(box|botol|pcs)?\b', lower)
        or re.search(r'\b(cod|transfer|tf)\b.*\b(bisa|mau|order|pesan|beli)\b', lower)
    )

def is_offer_acceptance(text, history):
    lower = html.unescape(str(text or '')).lower().strip()
    lower = re.sub(r'[.!?]+$', '', lower)
    lower = re.sub(r'\b(kak|ya|yah)\b', '', lower)
    lower = re.sub(r'\s+', ' ', lower).strip()
    accepted = (
        lower in ['ok coba', 'oke coba', 'iya coba', 'ya coba', 'boleh coba', 'saya coba', 'coba', 'coba dulu', 'boleh', 'ok', 'oke', 'ya', 'iya', 'lanjut', 'siap', 'ya beli', 'iya beli', 'ok beli', 'oke beli']
        or re.search(r'\b(coba|boleh|ok|oke|iya|ya)\b.*\b(sukumba|produk|paket|beli|pesan|order)\b', lower)
    )
    if not accepted:
        return False
    for h in reversed(history[-8:]):
        if h.get('role') == 'assistant' and re.search(
            r'mau\s+saya\s+bantu\s+(order|pesan|pemesanan)|saya\s+bantu\s+(order|pesan|pemesanan)|bisa\s+bantu\s+proses|lanjut\s+(order|pesan)|proses\s+(order|pesanan|pemesanan)|boleh\s+nama\s+penerima|siap.*(mencoba|membeli|beli)|mau\s+(order|pesan|beli)|ingin\s+(order|pesan|beli|memesan)|bantu\s+pilihkan\s+paket|pilihkan\s+paket|paket\s+yang\s+pas',
            h.get('content', ''), re.IGNORECASE
        ):
            return True
    return False

def is_product_info_acceptance(text, history):
    lower = html.unescape(str(text or '')).lower().strip()
    lower = re.sub(r'[.!?]+$', '', lower)
    if lower not in {'ya', 'iya', 'ok', 'oke', 'boleh', 'lanjut'} and not is_product_positive_reaction(lower):
        return False
    last = last_assistant_message(history)
    if last_assistant_has_product_context(history) and is_product_positive_reaction(lower):
        return True
    if re.search(r'mau\s+saya\s+bantu\s+(order|pesan|pemesanan)|bisa\s+bantu\s+proses|siap.*(mencoba|membeli|beli)|boleh\s+nama\s+penerima', last, re.IGNORECASE):
        return False
    if re.search(r'(mau|boleh)\s+(saya\s+)?(jelaskan|terangkan).{0,30}(produk|sukumba|manfaat|aturan|minum|paket)|tertarik\s+tahu\s+lebih\s+lanjut', last, re.IGNORECASE):
        return True
    return False

def has_male_health_consultation_context(history, profile):
    profile = normalize_profile(profile)
    if profile.get('active_flow') == 'consultation':
        return True
    if profile.get('conversation_mode') == 'consultation' and profile.get('last_question_id') in CONSULT_QUESTION_IDS:
        return True
    if profile.get('consultation_topic') and profile.get('last_question_id') in CONSULT_QUESTION_IDS:
        return True
    for h in history[-8:]:
        if h.get('role') == 'assistant' and re.search(
            r'vitalitas|ereksi|stamina hubungan|keluhan|usia kak|diabetes|tensi|jantung|pola tidur|rokok|stres',
            h.get('content', ''), re.IGNORECASE
        ):
            return True
    return False

def detect_red_flags(text):
    lower = html.unescape(str(text or '')).lower()
    found = []
    for pattern in RED_FLAG_PATTERNS:
        if re.search(pattern, lower, re.IGNORECASE):
            found.append(pattern)
    return found

def extract_blood_pressure(text):
    match = re.search(r'\b(\d{2,3})\s*/\s*(\d{2,3})\b', html.unescape(str(text or '')))
    if not match:
        return None
    try:
        systolic = int(match.group(1))
        diastolic = int(match.group(2))
    except Exception:
        return None
    if 70 <= systolic <= 260 and 40 <= diastolic <= 160:
        return systolic, diastolic
    return None

def is_consultation_context_continuation(raw_text, profile=None, history=None):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    lower = re.sub(r'[.!?]+$', '', lower)
    if not lower or is_test_probe(lower):
        return False
    if (
        is_consultation_request(lower)
        or has_male_health_signal(lower)
        or has_general_health_signal(lower)
        or extract_blood_pressure(lower)
    ):
        return True
    if is_short_acknowledgement(lower) or is_followup_reaction(lower):
        return True
    if re.search(r'\b(gmn|gmna|gimana|bagaimana|solusi|saran|mengatasi|atasinya|cara\s+mengatasi|kira\s*kira)\b', lower):
        return True

    profile = normalize_profile(profile)
    question_id = profile.get('last_question_id') or infer_question_id_from_reply(last_assistant_message(history or []))
    if question_id not in CONSULT_QUESTION_IDS:
        return False

    return bool(re.search(
        r'\b(\d{2}\s*(tahun|th|thn)?|\d{1,2}\s*(hari|minggu|bulan|tahun|thn|th)|'
        r'ya|iya|tidak|nggak|ngga|gak|ga|belum|sudah|pernah|ada|'
        r'aman|normal|'
        r'tensi|hipertensi|darah\s+tinggi|diabetes|gula\s+darah|jantung|'
        r'rokok|merokok|begadang|tidur|stres|stress|capek|lelah|loyo)\b',
        lower,
        re.IGNORECASE
    ))

def format_blood_pressure_reply(bp):
    systolic, diastolic = bp
    if systolic >= 180 or diastolic >= 120:
        return (
            f"Tensi {systolic}/{diastolic} termasuk sangat tinggi, Kak. "
            "Kalau ada nyeri dada, sesak, lemas sebelah, bingung, atau sakit kepala berat, sebaiknya segera periksa ke IGD/tenaga medis."
        )
    if systolic >= 140 or diastolic >= 90:
        return (
            f"Tensi {systolic}/{diastolic} termasuk tinggi, Kak. "
            "Coba istirahat dulu 5-10 menit lalu ukur ulang; kalau tetap tinggi atau ada pusing berat/nyeri dada/sesak, lebih aman periksa ke tenaga medis."
        )
    return f"Tensi {systolic}/{diastolic} masih perlu dilihat bersama gejalanya, Kak. Keluhan pusing/mualnya muncul sejak kapan?"

def is_operational_complaint(text):
    lower = html.unescape(str(text or '')).lower().strip()
    if not lower:
        return False
    explicit_complaint = re.search(
        r'\b(komplain|complain|kecewa|marah|tidak\s+puas|ga\s+puas|gak\s+puas|nggak\s+puas|buruk|parah|kapok|mengecewakan)\b',
        lower,
    )
    delivery_issue = (
        re.search(
            r'\b(paket|barang|pesanan|order|kiriman)\b.{0,60}\b(belum\s+sampai|tidak\s+sampai|ga\s+sampai|gak\s+sampai|nggak\s+sampai|lama\s+banget|terlambat|telat|nyasar|hilang|tertahan)\b',
            lower,
        )
        or re.search(
            r'\b(belum\s+sampai|tidak\s+sampai|ga\s+sampai|gak\s+sampai|nggak\s+sampai)\b.{0,60}\b(paket|barang|pesanan|order|kiriman)\b',
            lower,
        )
    )
    resi_issue = (
        re.search(
            r'\b(resi|tracking)\b.{0,60}\b(tidak\s+bergerak|ga\s+bergerak|gak\s+bergerak|nggak\s+bergerak|belum\s+update|tidak\s+update|ga\s+update|gak\s+update|tertahan|lama|nyasar|hilang)\b',
            lower,
        )
        or re.search(
            r'\b(tidak\s+bergerak|ga\s+bergerak|gak\s+bergerak|nggak\s+bergerak|belum\s+update|tidak\s+update|ga\s+update|gak\s+update|tertahan)\b.{0,60}\b(resi|tracking)\b',
            lower,
        )
    )
    item_issue = re.search(
        r'\b(rusak|pecah|bocor|sobek|penyok|cacat|salah\s+kirim|barang\s+salah|kurang|tidak\s+lengkap|ga\s+lengkap|gak\s+lengkap|expired|kadaluarsa|kedaluwarsa)\b',
        lower,
    ) and re.search(r'\b(paket|barang|produk|pesanan|order|sukumba|box|kemasan)\b', lower)
    refund_issue = re.search(r'\b(refund|retur|return|uang\s+kembali|balikin\s+uang|ganti\s+barang|klaim|garansi)\b', lower)
    return bool(explicit_complaint or delivery_issue or resi_issue or item_issue or refund_issue)

def operational_complaint_reply(text):
    lower = html.unescape(str(text or '')).lower()
    if re.search(
        r'\b(rusak|pecah|bocor|sobek|penyok|cacat|salah\s+kirim|barang\s+salah|kurang|tidak\s+lengkap|ga\s+lengkap|gak\s+lengkap|expired|kadaluarsa|kedaluwarsa)\b',
        lower,
    ):
        return (
            "Mohon maaf ya Kak, CS Syifa bantu cek kendalanya. "
            "Boleh kirim nomor order/nama penerima, foto produk atau kemasan, dan video unboxing kalau ada? "
            "Saya teruskan ke admin agar bisa dicek untuk solusi klaimnya."
        )
    if re.search(r'\b(belum\s+sampai|tidak\s+sampai|ga\s+sampai|gak\s+sampai|nggak\s+sampai|lama\s+banget|terlambat|telat|nyasar|hilang|tertahan|resi|tracking)\b', lower):
        return (
            "Mohon maaf ya Kak kalau pengirimannya belum nyaman. "
            "Boleh kirim nomor order/nama penerima dan nomor resi kalau sudah ada? "
            "CS Syifa teruskan ke admin untuk dicek posisi paketnya."
        )
    if re.search(r'\b(refund|retur|return|uang\s+kembali|balikin\s+uang|ganti\s+barang|klaim|garansi)\b', lower):
        return (
            "Baik Kak, mohon maaf atas kendalanya. "
            "Untuk pengajuan retur/refund/klaim, boleh kirim nomor order, nama penerima, alasan kendala, "
            "dan foto atau video pendukungnya ya. CS Syifa teruskan ke admin untuk dicek sesuai prosedur."
        )
    return (
        "Mohon maaf ya Kak atas kendalanya. "
        "Boleh ceritakan detail masalahnya dan kirim nomor order/nama penerima jika ada? "
        "CS Syifa teruskan ke admin supaya bisa dibantu cek dan follow up."
    )

def is_technical_issue(text):
    lower = html.unescape(str(text or '')).lower().strip()
    if not lower:
        return False
    technical_context = re.search(
        r'\b(wa|whatsapp|chat|pesan|message|nomor|bot|ai|cs\s*ai|sistem|server|gateway|aplikasi|dashboard)\b',
        lower,
    )
    technical_problem = re.search(
        r'\b(disconnect|disconnected|terputus|putus|logout|keluar|error|eror|gangguan|kendala|trouble|bermasalah|'
        r'tidak\s+bisa|nggak\s+bisa|gak\s+bisa|ga\s+bisa|tidak\s+masuk|belum\s+masuk|tidak\s+terkirim|gagal\s+kirim|'
        r'pending|delay|lambat|lemot|loading|offline|down)\b',
        lower,
    )
    return bool(technical_context and technical_problem)

def technical_issue_reply():
    return (
        "Mohon maaf ya Kak, sepertinya sedang ada kendala teknis pada sistem chat kami. "
        "CS Syifa bantu teruskan ke admin untuk dicek.\n\n"
        "Kalau pesan Kakak belum terbalas atau sempat gagal terkirim, boleh kirim ulang sebentar lagi ya. "
        "Kalau urgent, tuliskan kebutuhan Kakak di chat ini agar admin bisa follow up manual."
    )

def local_intent_hint(msg):
    lower = html.unescape(str(msg or '')).lower().strip()
    if not lower:
        return None
    if is_open_question_request(lower):
        return 'conversation'
    if any(x in lower for x in ['batal', 'cancel', 'gak jadi', 'ga jadi', 'tidak jadi']):
        return 'cancel'
    if is_technical_issue(lower):
        return 'technical_issue'
    if is_operational_complaint(lower):
        return 'complaint'
    if any(x in lower for x in ['admin', 'cs manusia', 'orangnya', 'customer service']):
        return 'escalation'
    if is_consultation_request(lower):
        return 'male_health'
    if has_male_health_signal(lower):
        return 'male_health'
    if any(x in lower for x in ['resi', 'tracking', 'status pesanan', 'pesanan saya']):
        return 'order_status'
    if has_pattern(lower, ORDER_PATTERNS):
        return 'order'
    if is_greeting_message(lower):
        return 'greeting'
    return None

def normalize_profile(profile):
    if isinstance(profile, dict) and isinstance(profile.get('profile'), dict):
        merged = dict(profile.get('profile') or {})
        if profile.get('summary'):
            merged['summary'] = profile.get('summary')
        return merged
    return profile if isinstance(profile, dict) else {}

def profile_to_prompt(profile):
    profile = normalize_profile(profile)
    if not profile:
        return "Belum ada konteks permanent."
    labels = {
        'summary': 'Ringkasan percakapan permanent',
        'name': 'Nama customer',
        'age': 'Usia',
        'customer_context': 'Konteks customer',
        'complaint': 'Keluhan utama',
        'complaint_detail': 'Detail keluhan',
        'duration': 'Durasi',
        'diabetes': 'Diabetes/gula darah',
        'hypertension': 'Tensi/hipertensi',
        'heart_issue': 'Riwayat jantung',
        'medication': 'Obat rutin',
        'sleep': 'Pola tidur',
        'smoking': 'Rokok',
        'stress': 'Stres',
        'lifestyle': 'Gaya hidup',
        'red_flags': 'Red flag',
        'last_offer': 'Penawaran terakhir',
        'objection': 'Keberatan',
        'order_readiness': 'Kesiapan order',
        'conversation_mode': 'Mode percakapan aktif',
        'consultation_topic': 'Topik konsultasi aktif',
        'consultation_stage': 'Tahap konsultasi',
        'consultation_goal': 'Tujuan customer',
        'next_question': 'Pertanyaan berikutnya',
        'asked_questions': 'Yang sudah ditanyakan',
        'active_flow': 'Flow aktif',
        'active_stage': 'Stage aktif',
        'last_question_id': 'Pertanyaan terakhir',
        'pending_slot': 'Slot yang sedang diminta',
        'last_offer_type': 'Jenis penawaran terakhir',
        'state_confidence': 'Confidence state',
    }
    lines = []
    for key, label in labels.items():
        value = profile.get(key)
        if value not in (None, '', [], {}):
            lines.append(f"- {label}: {value}")
    return '\n'.join(lines) if lines else "Belum ada konteks permanent."

def clean_person_name(name):
    name = re.sub(r'[^a-zA-Z\s.\'-]', '', str(name or '')).strip()
    name = re.sub(r'\s+', ' ', name)
    if not name or len(name) > 40:
        return ''
    blocked = {'kamu', 'anda', 'saya', 'aku', 'gue', 'gua', 'nama', 'siapa'}
    parts = [p for p in name.split() if p.lower() not in blocked]
    if not parts:
        return ''
    return ' '.join(p[:1].upper() + p[1:].lower() for p in parts)

def extract_name_from_text(raw_text):
    text = html.unescape(str(raw_text or '')).strip()
    patterns = [
        r'\b(?:nama\s+(?:saya|sy|aku|ak|ku)|namaku|aku\s+namanya|saya\s+namanya)\s+([a-zA-Z][a-zA-Z\s.\'-]{1,40})',
        r'\b(?:panggil\s+(?:saya|aku|ak)|dipanggil)\s+([a-zA-Z][a-zA-Z\s.\'-]{1,40})',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return clean_person_name(match.group(1))
    return ''

def is_name_question(raw_text):
    lower = html.unescape(str(raw_text or '')).lower()
    return bool(re.search(r'\b(nama\s+(saya|sy|aku|ak|ku)|namaku|ingat\s+nama|nama\s+gue|nama\s+gua)\b', lower)) and (
        '?' in lower or any(x in lower for x in ['siapa', 'ingat', 'masih'])
    )

def is_identity_question(raw_text):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    return bool(re.search(
        r'\b(nama\s+kamu\s+siapa|kamu\s+siapa|ini\s+siapa|dengan\s+siapa|admin\s+siapa|cs\s+siapa|bot\s+apa)\b',
        lower,
        re.IGNORECASE
    ))

def is_identity_plus_consultation(raw_text):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    return is_identity_question(lower) and (
        is_consultation_request(lower)
        or has_male_health_signal(lower)
        or has_general_health_signal(lower)
        or re.search(r'\b(konsultasi|konsul|consult|consul)\s*(dulu|dl|aja)?\b', lower)
    )

def is_short_acknowledgement(raw_text):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    lower = re.sub(r'[.!?]+$', '', lower)
    return lower in {'ok', 'oke', 'baik', 'siap', 'sip', 'iya', 'ya', 'oh', 'ooh', 'noted'}

def is_test_probe(raw_text):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    lower = re.sub(r'[.!?]+$', '', lower)
    lower = re.sub(r'\s+', ' ', lower)
    return bool(re.fullmatch(
        r'(test|tes|testing|ping|cek|cek ai|cek bot|cek sistem|tes ai|tes bot|test ai|test bot|uji coba)',
        lower
    ))

def is_greeting_message(raw_text):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    lower = re.sub(r'[.!?]+$', '', lower)
    lower = re.sub(r'\s+', ' ', lower)
    if not lower:
        return False
    has_greeting = bool(re.search(
        r'\b(halo|hai|hallo|helo|hello|permisi|pagi|siang|sore|malam|selamat\s+(pagi|siang|sore|malam)|semangat\s+pagi)\b',
        lower
    ))
    if not has_greeting:
        return False
    return not bool(re.search(
        r'\b(konsultasi|konsul|produk|jualan|harga|promo|pesan|order|beli|keluhan|burung|ereksi|loyo|stamina|tensi|pusing|mual)\b',
        lower
    ))

def is_likely_name_answer(raw_text):
    text = html.unescape(str(raw_text or '')).strip()
    if not text or len(text) > 40 or '?' in text:
        return False
    lower = text.lower()
    if re.search(r'\b(halo|hai|jualan|produk|konsultasi|stamina|ereksi|burung|loyo|harga|order|pesan|beli|admin|sendiri|saya\s+sendiri|aku\s+sendiri)\b', lower):
        return False
    if not re.fullmatch(r"[a-zA-Z][a-zA-Z\s.'-]{1,40}", text):
        return False
    words = text.split()
    return 1 <= len(words) <= 3

def assistant_asked_name(history):
    last_ai = last_assistant_message(history).lower()
    return bool(re.search(
        r'(boleh.*nama|sebutkan\s+nama|beritahu.*nama|nama\s+kakak|nama\s+kamu|siapa\s+namanya)',
        last_ai,
        re.IGNORECASE
    ))

def is_followup_reaction(raw_text):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    lower = re.sub(r'[.!?]+$', '', lower)
    return bool(re.search(r'\b(oiya|oh ya|serius|masa|bener|kok gitu|kenapa|gimana|gmn|gmna|bagaimana|maksudnya|lanjut|terus|solusi|saran)\b|cara\s+mengatasi', lower))

def is_clear_closing(raw_text):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    return bool(re.search(r'\b(terima\s*kasih|makasih|thanks|sama-?sama|bye|dadah|sampai\s+jumpa)\b', lower))

def is_product_question(raw_text):
    return product_helpers.is_product_question(raw_text)

def is_product_packaging_question(raw_text):
    return product_helpers.is_product_packaging_question(raw_text)

def is_consumption_question(raw_text):
    return product_helpers.is_consumption_question(raw_text)

def is_dosage_question(raw_text):
    return product_helpers.is_dosage_question(raw_text)

def has_male_vitality_signal(raw_text):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    if not lower:
        return False
    if re.search(r'\bstamina\s+(pria|ranjang|hubungan)\b', lower):
        return True
    return any(term in lower for term in MALE_VITALITY_TERMS)

def has_male_vitality_goal(raw_text):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    return bool(re.search(
        r'\b(greng|joss|jos|perkasa|prima|normal\s+lagi|fit\s+lagi|kembali\s+fit|kuat\s+lagi|mantap\s+lagi|lebih\s+lama|jadi\s+lama)\b|hubungan.{0,24}\blama\b',
        lower
    ))

def is_broad_male_vitality_phrase(raw_text):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    broad = re.search(r'\b(kekuatan\s+pria|tenaga\s+pria|performa\s+pria|stamina\s+(hubungan|pria|ranjang)|vitalitas|hubungan\s+badan)\b', lower)
    specific = re.search(r'\b(ereksi|burung|loyo|letoy|kurang\s+keras|gak\s+keras|tidak\s+keras|cepat\s+keluar|cepet\s+keluar|ejakulasi)\b', lower)
    return bool(broad and not specific)

def has_general_stamina_signal(raw_text):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    return bool(re.search(r'\b(stamina|kurang\s+tenaga|capek|lelah|lemes|drop|mudah\s+cape?k)\b', lower))

def is_solution_request(raw_text):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    return bool(re.search(r'\b(gmn|gmna|gimana|bagaimana|solusi|saran|mengatasi|atasinya|cara\s+mengatasi|kira\s*kira)\b', lower))

def compact_user_text(raw_text):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    lower = re.sub(r'[.!?]+$', '', lower)
    lower = re.sub(r'\s+', ' ', lower)
    return lower

def is_short_product_request(raw_text):
    lower = compact_user_text(raw_text)
    return lower in {'info', 'info deh', 'info dong', 'info kak', 'produk', 'produk kak', 'info produk', 'tanya produk', 'jelasin', 'jelaskan'}

def is_short_purchase_request(raw_text):
    lower = compact_user_text(raw_text)
    return lower in {
        'pesan', 'pesen', 'order', 'beli',
        'mau pesan', 'mau pesen', 'mau order', 'mau beli',
        'langsung beli', 'langsung pesan', 'langsung pesen', 'langsung order',
        'lanjut pesan', 'lanjut pesen', 'lanjut order', 'gas', 'gas beli',
        'coba', 'mau coba', 'boleh coba'
    }

def detect_package_choice(raw_text):
    return order_helpers.detect_package_choice(raw_text)

def order_prefill_for_choice(raw_text, payment=''):
    return order_helpers.order_prefill_for_choice(raw_text, payment)

def is_package_choice_request(raw_text):
    return order_helpers.is_package_choice_request(raw_text)

def is_package_recommendation_request(raw_text):
    return order_helpers.is_package_recommendation_request(raw_text)

def package_recommendation_reply(raw_text, profile=None, history=None):
    return order_helpers.package_recommendation_reply(raw_text, profile, history)

def package_choice_reply(raw_text, default_payment=''):
    return order_helpers.package_choice_reply(raw_text, template_order_form, default_payment)

def last_assistant_has_product_context(history):
    last_ai = last_assistant_message(history)
    return bool(re.search(r'sukumba|susu\s+kuda|info\s+manfaat|cara\s+minum|vitalitas|stamina|produk', last_ai, re.IGNORECASE))

def is_product_context_active(state, history=None, profile=None):
    profile = normalize_profile(profile)
    if state.get('active_flow') == 'product' or state.get('last_offer_type') == 'product_info':
        return True
    if profile.get('active_flow') == 'product' or profile.get('last_offer_type') == 'product_info':
        return True
    return last_assistant_has_product_context(history or [])

def is_product_positive_reaction(raw_text):
    lower = compact_user_text(raw_text)
    if lower in {
        'mantap', 'mantab', 'mantap ya', 'mantab ya', 'menarik', 'menarik ya',
        'bagus', 'bagus ya', 'oke', 'ok', 'sip', 'siap', 'boleh', 'lanjut',
        'wah bagus', 'keren', 'top', 'jos', 'joss', 'cocok', 'kayaknya cocok',
        'sepertinya cocok', 'boleh juga', 'oke juga', 'bagus juga'
    }:
        return True
    return bool(re.search(
        r'\b(mantap|mantab|menarik|bagus|keren|top|boleh\s+juga|oke\s+juga|cocok|wah)\b',
        lower,
        re.IGNORECASE
    ))

def build_conversation_state(profile, history=None):
    return state_helpers.build_conversation_state(
        profile,
        history,
        normalize_profile_fn=normalize_profile,
        last_assistant_message_fn=last_assistant_message,
    )

def is_short_contextual_reply(raw_text):
    lower = compact_user_text(raw_text)
    return lower in SHORT_CONFIRM_WORDS or lower in SHORT_REACTION_WORDS or is_short_acknowledgement(lower) or is_followup_reaction(lower)

def triage_choice_reply():
    return "Boleh Kak. Mau info produk Sukumba atau konsultasi dulu?"

def product_reaction_reply():
    return (
        "Iya Kak, Sukumba memang diarahkan untuk support stamina dan vitalitas secara natural. "
        "Kalau Kakak mau coba, saya bisa bantu pilihkan paket yang pas atau langsung bantu pemesanan."
    )


# ------------------------------------------------------------------
# 3B. TEMPLATE RESPON CS SYIFA - SUKUMBA (DYNAMIC & FALLBACK)
# ------------------------------------------------------------------

def get_dynamic_template(title_key, default_text):
    return template_service.dynamic(title_key, default_text)


def template_greeting_syifa(raw_text=''):
    return template_service.greeting_syifa(raw_text)


def template_ask_complaint_general():
    return template_service.ask_complaint_general()


def template_known_general_complaint():
    return template_service.known_general_complaint()


def template_ask_complaint_male_vitality():
    return template_service.ask_complaint_male_vitality()


def template_promo_sukumba():
    return template_service.promo_sukumba()


def template_cara_konsumsi():
    return template_service.cara_konsumsi()


def template_aturan_minum():
    return template_service.aturan_minum()


def template_ask_ever_consumed():
    return template_service.ask_ever_consumed()


def template_order_form(intro=None):
    return template_service.order_form(intro)


def template_transfer_info():
    return template_service.transfer_info()


def template_cod_1_box():
    return template_service.cod_1_box()


def template_empathy_reply():
    return template_service.empathy_reply()


def template_order_success():
    return template_service.order_success()


def template_bpom_safe():
    return template_service.bpom_safe()


def template_halal_info():
    return template_service.halal_info()


def template_diabetes_warning():
    return template_service.diabetes_warning()


def template_health_risk_warning():
    return template_service.health_risk_warning()


def template_komposisi():
    return template_service.komposisi()


def template_isi_box():
    return template_service.isi_box()


def template_estimasi_pengiriman():
    return template_service.estimasi_pengiriman()


def template_kurir_ongkir():
    return template_service.kurir_ongkir()


def template_ongkir_info():
    return template_service.ongkir_info()


def template_kurir_info():
    return template_service.kurir_info()


def template_testimoni_offer():
    return template_service.testimoni_offer()


def syifa_template_router(raw_text, history=None, profile=None):
    """Router template cepat agar jawaban penting tetap konsisten seperti CS Syifa."""
    deps = SyifaRouterDeps(
        is_identity_question=is_identity_question,
        is_name_question=is_name_question,
        is_clear_closing=is_clear_closing,
        build_conversation_state=build_conversation_state,
        is_package_choice_request=is_package_choice_request,
        is_package_recommendation_request=is_package_recommendation_request,
        is_product_context_active=is_product_context_active,
        package_choice_reply=package_choice_reply,
        package_recommendation_reply=package_recommendation_reply,
        order_prefill_for_choice=order_prefill_for_choice,
        is_product_packaging_question=is_product_packaging_question,
        is_dosage_question=is_dosage_question,
        is_consumption_question=is_consumption_question,
        is_greeting_message=is_greeting_message,
        deterministic_order_reply=deterministic_order_reply,
        product_context_updates=product_context_updates,
        template_order_form=template_order_form,
        template_order_success=template_order_success,
        template_transfer_info=template_transfer_info,
        template_cod_1_box=template_cod_1_box,
        template_isi_box=template_isi_box,
        template_estimasi_pengiriman=template_estimasi_pengiriman,
        template_kurir_ongkir=template_kurir_ongkir,
        template_ongkir_info=template_ongkir_info,
        template_kurir_info=template_kurir_info,
        template_promo_sukumba=template_promo_sukumba,
        template_aturan_minum=template_aturan_minum,
        template_cara_konsumsi=template_cara_konsumsi,
        template_ask_ever_consumed=template_ask_ever_consumed,
        template_diabetes_warning=template_diabetes_warning,
        template_health_risk_warning=template_health_risk_warning,
        template_bpom_safe=template_bpom_safe,
        template_halal_info=template_halal_info,
        template_komposisi=template_komposisi,
        template_testimoni_offer=template_testimoni_offer,
        template_known_general_complaint=template_known_general_complaint,
        template_ask_complaint_male_vitality=template_ask_complaint_male_vitality,
        template_greeting_syifa=template_greeting_syifa,
    )
    return route_syifa_template(raw_text, history, profile, deps)

def state_engine_precheck(msg, history, cfg, profile=None, knowledge_context=''):
    deps = StateRouterDeps(
        compact_user_text=compact_user_text,
        build_conversation_state=build_conversation_state,
        is_identity_question=is_identity_question,
        is_name_question=is_name_question,
        is_clear_closing=is_clear_closing,
        is_short_product_request=is_short_product_request,
        deterministic_product_reply=deterministic_product_reply,
        product_context_updates=product_context_updates,
        is_short_purchase_request=is_short_purchase_request,
        last_assistant_has_product_context=last_assistant_has_product_context,
        deterministic_order_reply=deterministic_order_reply,
        template_order_form=template_order_form,
        is_package_choice_request=is_package_choice_request,
        is_package_recommendation_request=is_package_recommendation_request,
        package_recommendation_reply=package_recommendation_reply,
        package_choice_reply=package_choice_reply,
        order_prefill_for_choice=order_prefill_for_choice,
        is_product_context_active=is_product_context_active,
        is_explicit_order_request=is_explicit_order_request,
        is_product_question=is_product_question,
        is_product_positive_reaction=is_product_positive_reaction,
        is_short_contextual_reply=is_short_contextual_reply,
        product_reaction_reply=product_reaction_reply,
        is_consultation_request=is_consultation_request,
        has_male_health_signal=has_male_health_signal,
        has_general_health_signal=has_general_health_signal,
        triage_choice_reply=triage_choice_reply,
        is_followup_reaction=is_followup_reaction,
    )
    return route_state_precheck(msg, history, cfg, profile, knowledge_context, deps)

def last_assistant_message(history):
    for h in reversed(history or []):
        if h.get('role') == 'assistant':
            return str(h.get('content') or '')
    return ''

def text_has_any_value(profile, keys):
    profile = normalize_profile(profile)
    return consultation_helpers.text_has_any_value(profile, keys)

def male_vitality_context(profile, history=None):
    profile = normalize_profile(profile)
    return consultation_helpers.male_vitality_context(profile, history, has_male_vitality_signal)

def consultation_topic_from_context(raw_text, profile=None, history=None):
    profile = normalize_profile(profile)
    return consultation_helpers.consultation_topic_from_context(
        raw_text,
        profile,
        history,
        has_male_vitality_signal_fn=has_male_vitality_signal,
        has_male_vitality_goal_fn=has_male_vitality_goal,
        has_general_stamina_signal_fn=has_general_stamina_signal,
        has_general_health_signal_fn=has_general_health_signal,
    )

def risk_factor_status(profile):
    profile = normalize_profile(profile)
    return consultation_helpers.risk_factor_status(profile)

def has_risk_factor_answer(profile):
    return consultation_helpers.has_risk_factor_answer(normalize_profile(profile))

def has_lifestyle_answer(profile):
    return consultation_helpers.has_lifestyle_answer(normalize_profile(profile))

def male_consult_next_step(profile):
    profile = normalize_profile(profile)
    return consultation_helpers.male_consult_next_step(profile)

def normalize_duration_unit(unit):
    return consultation_helpers.normalize_duration_unit(unit)

def extract_duration_value(raw_text):
    return consultation_helpers.extract_duration_value(raw_text)

def extract_age_duration_slots(raw_text, profile=None):
    profile = normalize_profile(profile)
    return consultation_helpers.extract_age_duration_slots(raw_text, profile, extract_blood_pressure)

def is_negative_risk_answer(raw_text):
    return consultation_helpers.is_negative_risk_answer(raw_text)

def extract_risk_factor_slots(raw_text):
    return consultation_helpers.extract_risk_factor_slots(raw_text)

def extract_lifestyle_slots(raw_text):
    return consultation_helpers.extract_lifestyle_slots(raw_text)

def extract_state_slot_updates(raw_text, profile=None, history=None, intent='conversation'):
    profile = normalize_profile(profile)
    return consultation_helpers.extract_state_slot_updates(
        raw_text,
        profile,
        history,
        build_conversation_state_fn=build_conversation_state,
        extract_blood_pressure_fn=extract_blood_pressure,
    )

def recover_consultation_slots_from_history(history, profile=None):
    return consultation_helpers.recover_consultation_slots_from_history(
        history,
        normalize_profile(profile),
        infer_question_id_from_reply_fn=infer_question_id_from_reply,
        consultation_topic_from_context_fn=consultation_topic_from_context,
        has_male_health_signal_fn=has_male_health_signal,
        has_male_vitality_goal_fn=has_male_vitality_goal,
        extract_blood_pressure_fn=extract_blood_pressure,
    )

def merge_transient_profile(profile, raw_text, intent='male_health', history=None):
    return consultation_helpers.merge_transient_profile(
        normalize_profile(profile),
        raw_text,
        intent,
        history,
        extract_memory_updates_fn=extract_memory_updates,
        build_conversation_state_fn=build_conversation_state,
        infer_question_id_from_reply_fn=infer_question_id_from_reply,
        consultation_topic_from_context_fn=consultation_topic_from_context,
        has_male_health_signal_fn=has_male_health_signal,
        has_male_vitality_goal_fn=has_male_vitality_goal,
        extract_blood_pressure_fn=extract_blood_pressure,
    )

def enrich_consultation_state(profile, updates, raw_text, intent):
    deps = consultation_helpers.ConsultationStateDeps(
        is_consultation_request=is_consultation_request,
        has_male_health_signal=has_male_health_signal,
        has_general_health_signal=has_general_health_signal,
        is_consultation_context_continuation=is_consultation_context_continuation,
        consultation_topic_from_context=consultation_topic_from_context,
        has_male_vitality_goal=has_male_vitality_goal,
    )
    return consultation_helpers.enrich_consultation_state(
        normalize_profile(profile),
        updates,
        raw_text,
        intent,
        deps,
    )


def deterministic_intent(msg, history=None, profile=None):
    lower = html.unescape(str(msg or '')).lower().strip()
    history = history or []
    profile = normalize_profile(profile)

    if not lower:
        return 'general', 100
    if is_test_probe(lower):
        return 'conversation', 99
    if assistant_asked_name(history) and is_likely_name_answer(msg):
        return 'name_capture', 100
    if is_identity_question(lower):
        return 'identity', 100
    if is_name_question(lower):
        return 'memory_lookup', 100
    if is_open_question_request(lower):
        return 'conversation', 99
    if any(x in lower for x in ['batal', 'cancel', 'gak jadi', 'ga jadi', 'tidak jadi']):
        return 'cancel', 96
    if is_technical_issue(lower):
        return 'technical_issue', 98
    if is_operational_complaint(lower):
        return 'complaint', 97
    if any(x in lower for x in ['admin', 'cs manusia', 'orangnya', 'customer service']):
        return 'escalation', 94
    if any(x in lower for x in ['resi', 'tracking', 'status pesanan', 'pesanan saya', 'order saya', 'cek pesanan']):
        return 'order_status', 94
    if is_product_info_acceptance(lower, history):
        return 'product_info', 92
    if is_explicit_order_request(lower) or is_offer_acceptance(lower, history):
        return 'order', 95
    if is_consultation_request(lower) or has_male_health_signal(lower) or has_general_health_signal(lower):
        return 'male_health', 96
    if has_male_health_consultation_context(history, profile) and (is_short_acknowledgement(lower) or is_followup_reaction(lower)):
        return 'male_health', 90
    if is_product_question(lower):
        return 'product_info', 90
    if is_clear_closing(lower):
        return 'closing', 92
    if is_greeting_message(lower):
        return 'greeting', 90
    if has_male_health_consultation_context(history, profile) and is_consultation_context_continuation(lower, profile, history):
        return 'male_health', 84
    if is_short_acknowledgement(lower) or is_followup_reaction(lower):
        return 'conversation', 88
    return 'conversation', 70

def should_write_summary(intent, profile_updates):
    if profile_updates:
        return True
    return intent in {'male_health', 'order', 'order_status', 'complaint', 'escalation', 'technical_issue'}

def infer_yes_no(lower, positive_terms):
    return consultation_helpers.infer_yes_no(lower, positive_terms)

def extract_memory_updates(raw_text, intent):
    text = html.unescape(str(raw_text or ''))
    lower = text.lower()
    updates = {}
    name = extract_name_from_text(text)
    if name:
        updates['name'] = name

    if intent == 'male_health' or has_male_health_signal(lower) or has_general_health_signal(lower) or is_consultation_request(lower):
        if any(x in lower for x in ['istri', 'suami saya', 'suamiku']):
            updates['customer_context'] = 'pasangan bertanya untuk suami'
        else:
            updates['customer_context'] = 'customer pria langsung atau belum diketahui'

        complaints = []
        if any(x in lower for x in ['burung', 'ereksi', 'kurang keras', 'gak keras', 'tidak keras', 'loyo', 'letoy', 'greng', 'joss', 'jos', 'perkasa']):
            complaints.append('ereksi/vitalitas kurang maksimal')
        if any(x in lower for x in ['cepat keluar', 'cepet keluar', 'ejakulasi dini']):
            complaints.append('ejakulasi cepat')
        if any(x in lower for x in ['gairah', 'libido']):
            complaints.append('gairah/libido turun')
        if any(x in lower for x in ['stamina', 'capek', 'lemes', 'lelah', 'kurang tenaga']):
            complaints.append('stamina mudah drop')
        if any(x in lower for x in ['mual', 'pusing', 'sakit kepala']):
            complaints.append('mual/pusing')
        if any(x in lower for x in ['begadang', 'kurang tidur', 'susah tidur']):
            complaints.append('pola tidur kurang baik')
        if complaints:
            updates['complaint'] = ', '.join(dict.fromkeys(complaints))
            updates['complaint_detail'] = text[:300]
        if has_male_vitality_goal(lower):
            updates['consultation_goal'] = 'ingin stamina/vitalitas lebih prima'

    age = re.search(r'\b(?:umur|usia|usia\s+saya|saya)\s*(\d{2})\s*(?:tahun|th|thn)?\b', lower)
    if not age:
        age = re.search(r'\b(\d{2})\s*(?:tahun|th|thn)\b', lower)
    if age:
        try:
            age_val = int(age.group(1))
            if 18 <= age_val <= 80:
                updates['age'] = str(age_val)
        except Exception:
            pass

    duration = extract_duration_value(lower)
    if duration:
        updates['duration'] = duration

    diabetes = infer_yes_no(lower, ['diabetes', 'gula darah', 'kencing manis'])
    if diabetes: updates['diabetes'] = diabetes
    hypertension = infer_yes_no(lower, ['hipertensi', 'darah tinggi', 'tensi'])
    if hypertension: updates['hypertension'] = hypertension
    heart = infer_yes_no(lower, ['jantung', 'nitrat', 'isosorbid'])
    if heart: updates['heart_issue'] = heart

    if any(x in lower for x in ['obat rutin', 'minum obat', 'obat dokter']):
        updates['medication'] = text[:160]
    if any(x in lower for x in ['begadang', 'kurang tidur', 'tidur']):
        updates['sleep'] = text[:160]
    smoking = infer_yes_no(lower, ['rokok', 'merokok', 'perokok'])
    if smoking: updates['smoking'] = smoking
    if any(x in lower for x in ['stres', 'stress', 'banyak pikiran', 'tekanan kerja']):
        updates['stress'] = text[:160]

    red_flags = detect_red_flags(lower)
    if red_flags:
        updates['red_flags'] = ', '.join(red_flags)
    if has_pattern(lower, ORDER_PATTERNS):
        updates['order_readiness'] = 'mulai berminat order'

    return updates

def get_memory_summary(profile):
    profile = normalize_profile(profile)
    summary = str(profile.get('summary', '') or '').strip()
    return summary[:1600]

def fallback_memory_summary(existing_summary, user_msg, assistant_reply, profile_updates, intent):
    existing_summary = str(existing_summary or '').strip()
    facts = []
    for key, value in (profile_updates or {}).items():
        if value not in (None, '', [], {}):
            facts.append(f"{key}: {value}")

    latest = f"Update terakhir ({intent}): "
    if facts:
        latest += '; '.join(facts[:8])
    else:
        latest += f"Customer: {str(user_msg or '')[:180]} | CS: {str(assistant_reply or '')[:180]}"

    if existing_summary:
        summary = f"{existing_summary}\n{latest}"
    else:
        summary = latest
    return summary[-1400:].strip()

def update_memory_summary(existing_summary, user_msg, assistant_reply, profile_updates, intent, agent, cfg):
    # v3: summary dibuat deterministik supaya 1 chat tidak memanggil LLM berkali-kali.
    return fallback_memory_summary(existing_summary, user_msg, assistant_reply, profile_updates, intent)

def require_internal_auth(f):
    """Cek X-Internal-Key header."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        key = request.headers.get('X-Internal-Key', '')
        if INTERNAL_API_KEY and key != INTERNAL_API_KEY:
            if request.remote_addr not in ('127.0.0.1', '::1', '172.31.6.3'):
                return jsonify({'error': 'Unauthorized'}), 401
        return f(*args, **kwargs)
    return wrapper

# ------------------------------------------------------------------
# 4. TELEGRAM NOTIFICATION
# ------------------------------------------------------------------
def send_telegram(text):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    try:
        requests.post(f"{TELEGRAM_API}/sendMessage",
            json={'chat_id': TELEGRAM_CHAT_ID, 'text': text[:4096], 'parse_mode': 'HTML'},
            timeout=10)
    except Exception as e:
        logger.error(f"Telegram error: {e}")

# ------------------------------------------------------------------
# 5. SETTINGS & PRODUCT INFO
# ------------------------------------------------------------------
def get_settings():
    headers = {'X-Internal-Key': INTERNAL_API_KEY} if INTERNAL_API_KEY else {}
    try:
        cfg = requests.get(ADMIN_API, timeout=5, headers=headers).json()
        return {
            'name':              cfg.get('company_name', 'Sukumba'),
            'location':          cfg.get('company_location', 'Sumbawa, NTB'),
            'hours':             cfg.get('company_hours', 'Senin-Sabtu 08:00-17:00'),
            'llm_provider':      cfg.get('llm_provider', 'groq'),
            'llm_api_url':       cfg.get('llm_api_url') or DEFAULT_LLM_API_URL,
            'llm_api_key':       cfg.get('llm_api_key') or cfg.get('groq_api_key') or LLM_API_KEY,
            'ai_model':          cfg.get('ai_model', 'llama-3.1-8b-instant'),
            'groq_api_key':      cfg.get('llm_api_key') or cfg.get('groq_api_key') or LLM_API_KEY,
            'temperature':       float(cfg.get('ai_temperature', 0.7)),
            'max_tokens':        int(cfg.get('ai_max_tokens', 600)),
            'knowledge':         cfg.get('knowledge_context', ''),
            'prompt_greeting':   cfg.get('prompt_greeting', ''),
            'prompt_product':    cfg.get('prompt_product', ''),
            'prompt_order':      cfg.get('prompt_order', ''),
            'prompt_escalation': cfg.get('prompt_escalation', ''),
        }
    except Exception as e:
        logger.warning(f"Cannot fetch settings from admin panel: {e}. Using defaults.")
        return {
            'name': 'Sukumba', 'location': 'Sumbawa, NTB',
            'hours': 'Senin-Sabtu 08:00-17:00',
            'llm_provider': 'groq',
            'llm_api_url': DEFAULT_LLM_API_URL,
            'llm_api_key': LLM_API_KEY,
            'ai_model': 'llama-3.1-8b-instant',
            'groq_api_key': LLM_API_KEY,
            'temperature': 0.7, 'max_tokens': 600, 'knowledge': '',
            'prompt_greeting': '', 'prompt_product': '',
            'prompt_order': '', 'prompt_escalation': '',
        }

def get_product_info():
    headers = {'X-Internal-Key': INTERNAL_API_KEY} if INTERNAL_API_KEY else {}
    try:
        products = requests.get(PRODUCTS_API, timeout=5, headers=headers).json()
        faqs     = requests.get(FAQS_API, timeout=5, headers=headers).json()
        products = [p for p in products if is_sukumba_product(p)]
        lines = ["PRODUK TERSEDIA:"]
        for p in products:
            lines.append(f"- {p['name']} | Harga: {p['price']}")
            features = ', '.join(p.get('features', []))
            if features: lines.append(f"  Manfaat: {features}")
        if faqs:
            lines.append("\nFAQ:")
            for f in faqs:
                lines.append(f"- Q: {f['question']}\n  A: {f['answer']}")
        return '\n'.join(lines)
    except Exception as e:
        logger.warning(f"Cannot fetch products: {e}")
        return "Produk: SUKUMBA - Susu Kuda Sumbawa Premium | Harga: Rp 299.000"

def is_sukumba_product(product):
    text = ' '.join([
        str(product.get('name', '')),
        str(product.get('price', '')),
        str(product.get('speed', '')),
        ' '.join(product.get('features', []) if isinstance(product.get('features'), list) else []),
        str(product.get('description', '')),
        str(product.get('target', '')),
    ]).lower()
    if re.search(r'\b(mbps|wifi|fiber|internet|modem|instalasi|berlangganan|paket home)\b', text):
        return False
    return bool(re.search(r'\b(sukumba|susu|kuda|sumbawa|herbal|stamina|vitalitas)\b', text))

def guard_reply(reply, intent='general'):
    text = html.unescape(str(reply or '')).strip()
    bad = [
        r'\[nama\s*(perusahaan|brand|bisnis|anda|toko)[^\]]*\]',
        r'\bnama\s+perusahaan\s*/\s*brand\b',
        r'\bassistant virtual\b',
        r'\basisten virtual\b',
        r'\bproduct specialist\b',
        r'\bkami tidak menjual produk secara langsung\b',
        r'\btim dukungan pelanggan\b',
        r'\bkebutuhan bisnis atau pribadi\b',
        r'\bstamina\s+kamu\s+kurang\s+mantap\b',
        r'\bkamu\s+(kan\s+)?bilang\s+stamina\b',
        r'\bberapa\s+total\s+yang\s+perlu\s+(kamu|anda|kakak)\s+bayar\b',
        r'\bberikan\s+data\s+berikut\b',
        r'\bnama\s+penerima,\s*nomor\s*hp,\s*alamat\s+lengkap\b',
        r'\b(mengurangi|meredakan|menyembuhkan)\s+(gejala\s+)?mual\b',
        r'\b(mengurangi|meredakan|menyembuhkan)\s+(gejala\s+)?pusing\b',
        r'\bknowledge base\b',
    ]
    if not text or any(re.search(pattern, text, re.IGNORECASE) for pattern in bad):
        if intent == 'identity':
            return "Saya CS Sukumba, Kak. Saya bantu info produk dan konsultasi seputar stamina/kesehatan pria dengan bahasa yang tetap nyaman."
        if intent == 'greeting':
            return template_greeting_syifa()
        if intent == 'closing':
            return "Siap Kak, terima kasih. Kalau butuh bantuan lagi, tinggal chat saja."
        return "Siap Kak. Mau lanjut tanya produk Sukumba atau konsultasi dulu?"
    text = re.sub(r'\b[Kk]amu\b', 'Kakak', text)
    text = re.sub(r'\bAnda\b', 'Kakak', text)
    text = re.sub(r'[ \t]+\n', '\n', text)
    return text

def clean_panel_prompt(prompt):
    text = str(prompt or '')
    text = re.sub(r'\bProduct Specialist\b', 'CS', text, flags=re.IGNORECASE)
    text = re.sub(r'\bassistant virtual\b|\basisten virtual\b|\bbot\b', 'CS Sukumba', text, flags=re.IGNORECASE)
    text = re.sub(r'tutup\s+dengan\s+ajakan\s+order\.?', 'jangan memaksa order', text, flags=re.IGNORECASE)
    text = re.sub(r'\bpersuasif\b', 'natural', text, flags=re.IGNORECASE)
    text = text.replace('[Nama Perusahaan/Brand]', 'Sukumba')
    return text.strip()

def deterministic_safe_reply(raw_text, intent='conversation', profile=None, history=None):
    if intent == 'technical_issue' or is_technical_issue(raw_text):
        return technical_issue_reply()
    if intent == 'male_health':
        consult_reply = deterministic_male_consult_reply(raw_text, history, profile)
        if consult_reply:
            return consult_reply
    if intent == 'product_info':
        return deterministic_product_reply(raw_text, profile, history)
    lower = html.unescape(str(raw_text or '')).lower().strip()
    if is_test_probe(lower):
        return "Siap Kak, AI CS Sukumba aktif. Mau cek info produk atau konsultasi dulu?"
    if is_short_acknowledgement(lower):
        return "Siap Kak. Mau lanjut info produk Sukumba atau konsultasi dulu?"
    if is_followup_reaction(lower):
        return "Iya Kak. Mau saya jelaskan bagian mana, atau Kakak mau konsultasi dulu?"
    bp = extract_blood_pressure(lower)
    if bp:
        return format_blood_pressure_reply(bp)
    if re.search(r'\b(mual|pusing|sakit\s+kepala)\b', lower):
        return "Saya pahami Kak. Untuk mual dan pusing, coba cek tensi, cukup minum, makan teratur, dan istirahat dulu; kalau berat atau berulang, lebih aman periksa ke tenaga medis."
    if re.search(r'\b(begadang|kurang\s+tidur|susah\s+tidur)\b', lower):
        return "Begadang bisa bikin badan drop, pusing, dan tidak enak badan, Kak. Fokus dulu istirahat dan makan teratur, nanti kita lihat keluhan yang paling mengganggu."
    if intent == 'product_info':
        return "Sukumba berupa susu kuda Sumbawa/herbal, Kak. Aturan minumnya 2x sehari sesudah makan."
    if intent == 'order':
        return deterministic_order_reply(raw_text, profile, history)
    return "Siap Kak. Bisa ceritakan sedikit lagi keluhannya atau tujuan konsultasinya, biar saya arahkan pelan-pelan."

def deterministic_order_reply(raw_text, profile=None, history=None):
    return deterministic_replies.deterministic_order_reply(raw_text, template_order_form, profile, history)

def deterministic_product_reply(raw_text, profile=None, history=None):
    deps = ProductReplyDeps(
        is_product_packaging_question=is_product_packaging_question,
        is_dosage_question=is_dosage_question,
        is_consumption_question=is_consumption_question,
        template_estimasi_pengiriman=template_estimasi_pengiriman,
        template_isi_box=template_isi_box,
        template_aturan_minum=template_aturan_minum,
        template_cara_konsumsi=template_cara_konsumsi,
        template_promo_sukumba=template_promo_sukumba,
        template_kurir_ongkir=template_kurir_ongkir,
        template_ongkir_info=template_ongkir_info,
        template_kurir_info=template_kurir_info,
        template_halal_info=template_halal_info,
    )
    return deterministic_replies.deterministic_product_reply(raw_text, deps, profile, history)

def consultation_need_context(raw_text, profile=None, history=None):
    haystack = ' '.join([
        str(raw_text or ''),
        str((profile or {}).get('complaint', '') if isinstance(profile, dict) else ''),
        str((profile or {}).get('complaint_detail', '') if isinstance(profile, dict) else ''),
        str((profile or {}).get('consultation_goal', '') if isinstance(profile, dict) else ''),
        str((profile or {}).get('consultation_topic', '') if isinstance(profile, dict) else ''),
        str((profile or {}).get('summary', '') if isinstance(profile, dict) else ''),
        ' '.join(str(item.get('content', '')) for item in (history or [])[-6:] if isinstance(item, dict)),
    ]).lower()
    if re.search(r'\b(pegal|linu|nyeri\s+sendi|nyeri\s+otot|sendi|otot|badan\s+sakit)\b', haystack):
        return 'pegal/linu'
    if re.search(r'\b(vitalitas|ereksi|gairah|libido|cepat\s+keluar|ejakulasi|stamina\s+(pria|hubungan|ranjang))\b', haystack):
        return 'vitalitas'
    if re.search(r'\b(stamina|kurang\s+tenaga|loyo|letoy|lemas|capek|lelah|mudah\s+drop|drop)\b', haystack):
        return 'stamina'
    return ''

def general_sukumba_consult_reply(current, need):
    age = current.get('age')
    duration = current.get('duration')
    need_label = need or 'keluhan'
    if not age or not duration:
        return f"Baik Kak, untuk keluhan {need_label} saya bantu arahkan ya. Usia Kakak berapa, dan keluhannya sudah berapa lama?"
    support = {
        'pegal/linu': 'support stamina dan pemulihan tubuh',
        'stamina': 'support stamina dan kondisi tubuh lebih prima',
        'vitalitas': 'support stamina dan vitalitas pria',
    }.get(need, 'support stamina, pegal/linu, dan vitalitas')
    return (
        f"Siap Kak, usia {age} dan keluhan {need_label} sudah {duration} ya.\n\n"
        "Arah awalnya tetap jaga istirahat, makan teratur, cukup minum, dan pantau kondisi tubuh. "
        f"Sukumba bisa dibantu sebagai {support}, diminum 2x sehari sesudah makan. "
        "Kalau Kakak mau mulai, saya bisa bantu pilihkan paket yang pas."
    )

def deterministic_male_consult_reply(raw_text, history=None, profile=None):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    history = history or []
    if is_open_question_request(raw_text):
        return open_question_reply()
    current = merge_transient_profile(profile, raw_text, 'male_health', history)
    topic = consultation_topic_from_context(raw_text, current, history)
    state = build_conversation_state(current, history)

    bp = extract_blood_pressure(raw_text)
    if bp:
        return format_blood_pressure_reply(bp)

    need = consultation_need_context(raw_text, current, history)
    if need in {'pegal/linu', 'stamina'}:
        return general_sukumba_consult_reply(current, need)

    if is_short_contextual_reply(raw_text) and state.get('active_flow') == 'consultation':
        question_id = state.get('last_question_id')
        if question_id == 'ask_complaint':
            return "Siap Kak. Keluhan atau tujuan konsultasinya apa dulu?"
        if question_id == 'ask_age_duration':
            return "Siap Kak. Usia Kakak berapa dan keluhan ini sudah berapa lama?"
        if question_id == 'ask_risk_factors':
            if is_solution_request(raw_text):
                return (
                    "Bisa Kak, arahnya mulai dari tidur cukup, kelola stres, makan teratur, dan cek faktor medis dulu. "
                    "Ada riwayat diabetes, tensi tinggi, jantung, atau obat rutin dari dokter?"
                )
            return "Siap Kak. Ada riwayat diabetes, tensi tinggi, jantung, atau obat rutin dari dokter?"
        if question_id == 'ask_lifestyle':
            return "Siap Kak. Pola tidur, rokok, dan stresnya gimana akhir-akhir ini?"
        if question_id == 'ask_bp':
            return "Siap Kak. Tensi terakhir berapa, dan keluhannya muncul sejak kapan?"

    if is_consultation_request(raw_text) and not has_male_health_signal(raw_text) and not has_general_health_signal(raw_text):
        return (
            "Boleh banget Kak. Ceritain aja pelan-pelan, lagi ada keluhan apa atau mau dibantu soal apa? "
            "Nanti saya arahin dari kondisinya dulu."
        )

    if re.search(r'\b(mual|pusing|sakit\s+kepala)\b', lower):
        return (
            "Saya pahami Kak. Kalau mual dan pusing sering muncul, apalagi ada riwayat tensi atau sering begadang, "
            "lebih aman cek tekanan darah dan pola makannya dulu. Biasanya keluhan muncul kapan, dan tensi terakhir berapa?"
        )

    if re.search(r'\b(begadang|kurang\s+tidur|susah\s+tidur)\b', lower) and male_vitality_context(current, history):
        return (
            "Baik Kak, diabetes dan sering begadang bisa ikut memengaruhi stamina dan vitalitas. "
            "Pola tidur Kakak biasanya berapa jam, merokok atau tidak, dan akhir-akhir ini banyak stres?"
        )

    if re.search(r'\b(begadang|kurang\s+tidur|susah\s+tidur)\b', lower):
        return (
            "Begadang memang bisa bikin badan drop, pusing, dan tidak enak badan, Kak. "
            "Untuk sekarang fokus ke keluhan yang paling terasa dulu ya: pusing/mualnya masih sering muncul?"
        )

    if topic == 'stamina_general' and not male_vitality_context(current, history):
        return (
            "Kurang tenaga bisa terkait tidur, makan, stres, aktivitas, atau tensi, Kak. "
            "Keluhan ini sudah berapa lama dan ada keluhan lain seperti pusing atau mual?"
        )

    if topic == 'male_vitality':
        if not current.get('age') or not current.get('duration'):
            if is_broad_male_vitality_phrase(raw_text):
                return (
                    "Siap Kak, kita bahas stamina/vitalitas pria ya. "
                    "Usia Kakak berapa dan keluhan atau tujuan ini sudah terasa berapa lama?"
                )
            if has_male_vitality_goal(raw_text):
                return (
                    "Bisa Kak, arahnya kita bantu supaya stamina dan vitalitas lebih prima. "
                    "Sebelum saya arahkan, usia Kakak berapa dan keluhan ini sudah berapa lama?"
                )
            return "Saya pahami Kak, vitalitas/ereksi terasa kurang maksimal. Usia Kakak berapa, dan keluhan ini sudah berapa lama?"

        if not has_risk_factor_answer(current):
            age = current.get('age')
            duration = current.get('duration')
            intro = "Siap Kak"
            details = []
            if age:
                details.append(f"usia {age}")
            if duration:
                details.append(f"keluhan sudah {duration}")
            if details:
                intro += ", " + " dan ".join(details) + " ya"
            if is_solution_request(raw_text):
                return (
                    f"{intro}. Untuk arahnya biasanya mulai dari tidur, stres, pola makan, dan cek faktor medis dulu; "
                    "ada riwayat diabetes, tensi tinggi, jantung, atau obat rutin dari dokter?"
                )
            return f"{intro}. Ada riwayat diabetes, tensi tinggi, jantung, atau obat rutin dari dokter?"

        if not has_lifestyle_answer(current):
            return (
                "Saya pahami Kak. Biar arahnya lebih pas, pola tidur Kakak gimana, merokok atau tidak, dan akhir-akhir ini banyak stres?"
            )

        duration = current.get('duration')
        duration_text = f"yang sudah {duration}" if duration else "yang Kakak rasakan"
        return (
            f"Baik Kak. Untuk keluhan {duration_text}, arahnya jaga tidur, kelola stres, makan teratur, dan tetap pantau kondisi tubuh. "
            "Sukumba bisa dibantu sebagai support stamina dan vitalitas, diminum 2x sehari sesudah makan; kalau Kakak mau mulai, saya bisa bantu pilihkan paket yang pas."
        )

    if is_short_acknowledgement(raw_text) and has_male_health_consultation_context(history, current):
        stage, next_question = male_consult_next_step(current)
        if stage == 'age_duration':
            return "Siap Kak. Usia Kakak berapa dan keluhan ini sudah berapa lama?"
        if stage == 'risk_factors':
            return "Siap Kak. Ada riwayat diabetes, tensi tinggi, jantung, atau obat rutin dari dokter?"
        if stage == 'lifestyle':
            return "Siap Kak. Pola tidur, rokok, dan stresnya gimana akhir-akhir ini?"
        return "Siap Kak. Saya bantu arahkan pelan-pelan sesuai kondisi Kakak."

    return ''

# ------------------------------------------------------------------
# 6. GROQ API CALL
# ------------------------------------------------------------------
def call_groq(messages, cfg, max_tokens=None):
    api_key = cfg.get('llm_api_key') or cfg.get('groq_api_key', '')
    if not api_key:
        raise Exception("LLM API key tidak tersedia")
    
    api_url = cfg.get('llm_api_url') or DEFAULT_LLM_API_URL
    provider = str(cfg.get('llm_provider') or '').lower()
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
    }
    if 'openrouter.ai' in api_url or provider == 'openrouter':
        headers['HTTP-Referer'] = 'https://sukumba.com'
        headers['X-OpenRouter-Title'] = 'Sukumba CS AI'

    res = requests.post(api_url,
        headers=headers,
        json={'model': cfg['ai_model'], 'messages': messages,
              'temperature': cfg['temperature'], 'max_tokens': max_tokens or cfg['max_tokens']},
        timeout=30)
    result = res.json()
    if 'choices' not in result:
        error_msg = result.get('error', {}).get('message', str(result))
        logger.error(f"LLM error: {error_msg}")
        raise Exception(f"LLM error: {error_msg}")
    return result['choices'][0]['message']['content']

# ------------------------------------------------------------------
# 7. AGENT FUNCTIONS
# ------------------------------------------------------------------
def intent_agent(msg, history, cfg):
    intent, confidence = deterministic_intent(msg, history)
    return {"intent": intent, "confidence": confidence}

def greeting_agent(msg, cfg):
    lower = html.unescape(str(msg or '')).lower()
    if 'semangat pagi' in lower:
        return "Halo Kak, semangat pagi juga. Bisa saya bantu info produk atau konsultasi dulu?"
    greeting = greeting_label_for_message(msg)
    return f"{greeting} Kak, dengan CS Syifa ya. Kakak mau tanya promo Sukumba atau konsultasi keluhannya dulu?"

def closing_agent(msg, cfg):
    return "Siap Kak, terima kasih. Kalau butuh bantuan lagi, tinggal chat saja."

def cancel_agent(msg, cfg):
    return "Tidak apa-apa Kak. Kalau mau tanya-tanya dulu atau konsultasi, saya bantu pelan-pelan."

def male_health_consultant_agent(msg, history, cfg, profile=None, knowledge_context=''):
    lower = html.unescape(str(msg or '')).lower().strip()
    profile = normalize_profile(profile)

    deterministic_reply = deterministic_male_consult_reply(msg, history, profile)
    if deterministic_reply:
        return deterministic_reply

    bp = extract_blood_pressure(msg)
    if bp:
        return deterministic_safe_reply(msg, 'male_health', profile, history)

    if is_consultation_request(msg) and not has_male_health_signal(msg):
        return (
            "Boleh banget Kak. Ceritain aja pelan-pelan, lagi ada keluhan apa atau mau dibantu soal apa? "
            "Nanti saya arahin dari kondisinya dulu."
        )

    if re.search(r'\b(mual|pusing|sakit\s+kepala)\b', lower):
        return (
            "Saya pahami Kak. Kalau mual dan pusing sering muncul, apalagi ada riwayat tensi atau sering begadang, "
            "lebih aman cek tekanan darah dan pola makannya dulu. Biasanya keluhan muncul kapan, dan tensi terakhir berapa?"
        )

    if re.search(r'\b(begadang|kurang\s+tidur|susah\s+tidur)\b', lower) and has_male_health_consultation_context(history, profile):
        return (
            "Baik Kak, sering begadang bisa ikut memengaruhi stamina dan vitalitas. "
            "Pola tidur Kakak biasanya berapa jam, merokok atau tidak, dan akhir-akhir ini banyak stres?"
        )

    if re.search(r'\b(begadang|kurang\s+tidur|susah\s+tidur)\b', lower):
        return (
            "Begadang memang bisa bikin badan drop, pusing, dan gampang tidak enak badan, Kak. "
            "Untuk sekarang fokusnya mual/pusing dulu ya, sambil pelan-pelan perbaiki tidur dan makan teratur."
        )

    has_known_complaint = bool(profile.get('complaint') or profile.get('complaint_detail')) or has_male_health_signal(msg)
    if not has_known_complaint and (is_short_acknowledgement(msg) or re.search(r'\b(tensi|hipertensi|darah tinggi|diabetes|gula darah|jantung|rokok|merokok|tidak|nggak|gak|ga)\b', lower)):
        return "Siap Kak. Supaya saya arahin tepat, keluhan utama yang ingin dibantu apa dan sudah berapa lama?"

    if has_male_health_signal(msg) and not profile.get('duration'):
        return "Saya pahami Kak, vitalitas/ereksi terasa kurang maksimal. Usia Kakak berapa, dan keluhan ini sudah berapa lama?"

    product_info = get_product_info()
    profile_context = profile_to_prompt(profile)
    red_flags = detect_red_flags(msg)
    red_flag_note = ''
    if red_flags:
        red_flag_note = "\nCustomer menyebut red flag. Sarankan cek dokter/tenaga medis dan tawarkan sambungkan ke CS manusia."

    system = f"""{CS_TONE_GUIDE}
Kamu adalah "CS Herbal Pria" untuk {cfg['name']}, produk susu kuda Sumbawa/herbal stamina.
Tugas utama: konsultasi kesehatan pria dengan sopan, natural, dan baru arahkan ke penjualan setelah konteks cukup.

Gaya bahasa:
- Panggil customer "Kak".
- Pahami slang customer seperti "burung loyo", "letoy", "kurang greng"; jangan ikut terlalu vulgar.
- Setelah memahami slang, gunakan bahasa elegan: ereksi, vitalitas pria, stamina hubungan, gairah, ejakulasi cepat.
- Jangan pernah bilang "aku catat", "saya catat", atau memberi tahu ada memory permanent.
- Jawaban singkat, hangat, tidak menggurui. Maksimal 3 kalimat.
- Kalau customer hanya bilang "kesehatan pria" atau "stamina pria", jangan langsung asumsi masalah ereksi. Tanyakan dulu bagian yang ingin dibantu.
- Kalau keluhan customer mual, pusing, begadang, tensi, atau keluhan umum, jangan geser paksa ke ereksi/vitalitas.
- Jangan klaim Sukumba mengurangi/menyembuhkan mual, pusing, hipertensi, diabetes, atau penyakit tertentu.

Flow konsultasi natural:
- Tanya maksimal 1-2 hal per balasan.
- Prioritas data: usia, keluhan utama, durasi, diabetes/tensi/jantung/obat rutin, pola tidur, rokok, stres.
- Ikuti fakta customer apa adanya. Jika customer bilang 1 minggu, jangan ubah menjadi bulanan/tahunan; jika durasi belum disebut, jangan menebak durasi.
- Jangan menyebut keluhan baru yang belum customer sebut. Gunakan keluhan utama dan durasi dari konteks customer.
- Kalau data belum cukup, jangan langsung jualan keras.
- Kalau konteks sudah cukup, berikan edukasi ringan lalu rekomendasi direct.
- Jangan tanya data order satu per satu. Kalau customer siap order, kirim form order lengkap dan minta customer mengisinya.

Aturan klaim:
- Jangan overclaim. Hindari kata: menyembuhkan, pasti sembuh, dijamin keras, obat kuat, impoten sembuh total.
- Boleh gunakan: membantu stamina, energi, vitalitas, pemulihan tubuh, dan kondisi tubuh lebih prima.
- Aturan konsumsi resmi: 2x sehari sesudah makan.
- Jika customer siap order, jangan kumpulkan semua data sekaligus. Order flow terstruktur akan meminta data satu per satu.
- Untuk promo seperti gratis ongkir, free konsultasi, dan bonus produk lain, sampaikan bahwa CS manusia bisa bantu cek detail promo aktif.

Red flag medis:
- Jika ada nyeri dada, riwayat jantung berat, obat nitrat/isosorbid, sesak, pingsan, stroke, nyeri berat, atau ereksi lebih dari 4 jam, sarankan cek dokter dan tawarkan disambungkan ke CS manusia.

Konteks customer yang sudah diketahui:
{profile_context}

Informasi produk:
{product_info}

Konteks tambahan:
{knowledge_context[:1800]}
{red_flag_note}"""

    messages = [{'role': 'system', 'content': system}]
    for h in history[-8:]:
        if h.get('role') in ['user', 'assistant']:
            messages.append({'role': h['role'], 'content': h['content']})
    messages.append({'role': 'user', 'content': msg})
    return call_groq(messages, cfg)

def product_agent(msg, history, cfg):
    deterministic_reply = deterministic_product_reply(msg, None, history)
    if deterministic_reply:
        return deterministic_reply

    product_info = get_product_info()
    base = clean_panel_prompt(cfg.get('prompt_product')) or f"Kamu CS {cfg['name']}. Jawab pertanyaan produk dengan informatif, hangat, dan tidak memaksa order. Maksimal 3 kalimat."
    system = f"""{SUKUMBA_PERSONA_CONTRACT}
{base}

Aturan produk:
- Jawab hanya sesuai pertanyaan customer.
- Jangan menutup semua jawaban dengan ajakan order. Ajakan order hanya kalau customer bertanya harga/cara pesan atau sudah tampak minat beli.
- Kalau customer cuma bertanya ringan, akhiri dengan pertanyaan konsultatif yang natural.
- Jangan minta nama/HP/alamat satu per satu di Product Agent. Kalau customer sudah ingin order, kirim form order lengkap.
- Kalau customer bertanya halal, jawab meyakinkan sesuai data: bahan pangan/herbal dan BPOM RI MD 071182004300360. Jangan mengarang nomor sertifikat halal/MUI jika tidak tersedia; tawarkan kirim foto label kemasan/izin produk yang tersedia.

{product_info}

Toko: {cfg['name']} | {cfg['location']} | {cfg['hours']}
{cfg['knowledge']}"""
    messages = [{'role':'system','content':system}]
    for h in history[-5:]:
        if h['role'] in ['user','assistant']: messages.append({'role':h['role'],'content':h['content']})
    messages.append({'role':'user','content':msg})
    try:
        return call_groq(messages, cfg)
    except Exception as e:
        logger.error(f"Product Agent LLM fallback: {e}")
        return deterministic_product_reply(msg, None, history)

def order_agent(msg, history, cfg, profile=None):
    return deterministic_order_reply(msg, profile, history)

def escalation_agent(msg, history, cfg):
    base = clean_panel_prompt(cfg.get('prompt_escalation')) or "Kamu Customer Care. Tangani komplain dengan empati. Minta maaf, kumpulkan detail masalah, informasikan tim akan follow up. Maksimal 3 kalimat."
    system = f"{CS_TONE_GUIDE}\n{base}\nJam: {cfg['hours']}."
    messages = [{'role':'system','content':system}]
    for h in history[-5:]:
        if h['role'] in ['user','assistant']: messages.append({'role':h['role'],'content':h['content']})
    messages.append({'role':'user','content':msg})
    return call_groq(messages, cfg)

def conversation_agent(msg, history, cfg, profile=None, knowledge_context=''):
    profile_context = profile_to_prompt(profile)
    last_ai = last_assistant_message(history)
    system = f"""{SUKUMBA_PERSONA_CONTRACT}
Tugasmu menanggapi pesan lanjutan atau pesan ambigu dalam chat WhatsApp.

Aturan:
- Jangan greeting ulang kecuali customer benar-benar baru mulai salam.
- Kalau customer bereaksi seperti "oiya?", "serius?", "masa sih?", tanggapi konteks jawaban CS sebelumnya.
- Kalau tidak jelas, tanya 1 pertanyaan ringan untuk mengarahkan: info produk atau konsultasi.
- Jangan pitching produk kalau customer belum bertanya produk atau belum konsultasi.
- Jangan menebak keluhan seperti stamina drop, ereksi, atau cepat keluar kalau customer belum menyebutnya.
- Jangan menyebut internal agent, routing, atau memory.

Konteks customer:
{profile_context}

Balasan CS sebelumnya:
{last_ai[:500]}

Konteks tambahan jika relevan:
{knowledge_context[:800]}"""
    messages = [{'role':'system','content':system}]
    for h in history[-8:]:
        if h.get('role') in ['user','assistant']:
            messages.append({'role':h['role'],'content':h['content']})
    messages.append({'role':'user','content':msg})
    return call_groq(messages, cfg, max_tokens=260)

def orchestrator(msg, history, cfg, profile=None, knowledge_context=''):
    if is_open_question_request(msg):
        return (
            open_question_reply(),
            'conversation',
            'open_question_clarifier',
            {
                'profile_updates': {
                    'active_flow': 'triage',
                    'active_stage': 'awaiting_question_topic',
                    'last_question_id': 'choose_question_topic',
                    'pending_slot': 'question_topic',
                    'last_offer_type': 'choice',
                    'state_confidence': 'high',
                }
            },
        )

    if is_technical_issue(msg):
        return (
            technical_issue_reply(),
            'technical_issue',
            'technical_issue_agent',
            {
                'profile_updates': {
                    'active_flow': 'human_handoff',
                    'active_stage': 'technical_issue_review',
                    'last_question_id': 'technical_issue_detail',
                    'pending_slot': 'admin_review',
                    'state_confidence': 'high',
                },
                'needs_handoff': True,
            },
        )

    if is_operational_complaint(msg):
        return (
            operational_complaint_reply(msg),
            'complaint',
            'operational_complaint_agent',
            {
                'profile_updates': {
                    'active_flow': 'human_handoff',
                    'active_stage': 'complaint_review',
                    'last_question_id': 'complaint_detail',
                    'pending_slot': 'admin_review',
                    'state_confidence': 'high',
                }
            },
        )

    syifa_template = syifa_template_router(msg, history, profile)
    if syifa_template:
        reply, intent, agent, profile_updates = syifa_template
        logger.info(f"Syifa Template Router: {intent} | Agent: {agent}")
        meta = {}
        if isinstance(profile_updates, dict):
            profile_updates = dict(profile_updates)
            if profile_updates.pop('start_order', False):
                meta['start_order'] = True
            if 'order_prefill' in profile_updates:
                meta['order_prefill'] = profile_updates.pop('order_prefill')
            meta['profile_updates'] = profile_updates
        else:
            meta['profile_updates'] = {}
        return reply, intent, agent, meta

    state_result = state_engine_precheck(msg, history, cfg, profile, knowledge_context)
    if state_result:
        reply, intent, agent, meta = state_result
        logger.info(f"State Engine: {intent} | Agent: {agent}")
        return reply, intent, agent, meta

    routed_intent, routed_confidence = deterministic_intent(msg, history, profile)
    intent_result = {"intent": routed_intent, "confidence": routed_confidence}
    intent = intent_result.get('intent', 'general')
    confidence = intent_result.get('confidence', 0)
    if intent == 'conversation' and is_test_probe(msg):
        return deterministic_safe_reply(msg, intent, profile, history), intent, 'test_probe_agent', {}
    if intent == 'conversation' and (is_short_acknowledgement(msg) or is_followup_reaction(msg)):
        return deterministic_safe_reply(msg, intent, profile, history), intent, 'deterministic_ack_agent', {}
    if intent == 'order' and has_male_health_consultation_context(history, profile) and not (is_explicit_order_request(msg) or is_offer_acceptance(msg, history)):
        logger.info("Order intent held: continuing male_health consultation")
        intent = 'male_health'
    logger.info(f"Intent: {intent} ({confidence}%) | Agent: START")
    
    if intent == 'name_capture':
        name = clean_person_name(msg)
        if name:
            return (
                f"Siap {name}, senang kenal ya. Mau lanjut tanya produk Sukumba atau konsultasi dulu?",
                intent,
                'memory_agent',
                {'profile_updates': {'name': name}}
            )
        return "Siap Kak. Mau lanjut tanya produk Sukumba atau konsultasi dulu?", intent, 'conversation_agent', {}
    elif intent == 'identity':
        return "Saya CS Sukumba, Kak. Saya bantu info produk dan konsultasi seputar stamina/kesehatan pria dengan bahasa yang tetap nyaman.", intent, 'identity_agent', {}
    elif intent == 'memory_lookup':
        profile = normalize_profile(profile)
        known_name = profile.get('name')
        if known_name:
            return f"Ingat Kak, nama Kakak {known_name}. Ada yang mau dibantu lagi?", intent, 'memory_agent', {}
        return "Belum tahu Kak. Boleh sebutkan nama Kakak dulu?", intent, 'memory_agent', {}
    elif intent == 'greeting':
        logger.info("greeting_agent")
        return greeting_agent(msg, cfg), intent, 'greeting_agent', {}
    elif intent == 'closing':
        logger.info("closing_agent")
        return closing_agent(msg, cfg), intent, 'closing_agent', {}
    elif intent == 'cancel':
        logger.info("cancel_agent")
        return cancel_agent(msg, cfg), intent, 'cancel_agent', {}
    elif intent == 'male_health':
        logger.info("male_health_consultant_agent")
        return male_health_consultant_agent(msg, history, cfg, profile, knowledge_context), intent, 'male_health_consultant_agent', {}
    elif intent == 'order':
        logger.info("order_agent")
        order_meta = {'start_order': True}
        return order_agent(msg, history, cfg, profile), intent, 'order_agent', order_meta
    elif intent == 'post_order':
        logger.info("post_order_ack_agent")
        return "Siap Kak, terima kasih. Tim kami akan segera menghubungi untuk pesanan Kakak.", intent, 'post_order_ack_agent', {}
    elif intent == 'technical_issue':
        logger.info("technical_issue_agent")
        return technical_issue_reply(), intent, 'technical_issue_agent', {'needs_handoff': True}
    elif intent == 'complaint':
        logger.info("operational_complaint_agent")
        return operational_complaint_reply(msg), intent, 'operational_complaint_agent', {}
    elif intent in ['order_status','escalation']:
        logger.info("escalation_agent")
        return escalation_agent(msg, history, cfg), intent, 'escalation_agent', {}
    elif intent == 'product_info':
        logger.info("product_agent_deterministic_first")
        return product_agent(msg, history, cfg), intent, 'product_agent', {}
    else:
        last_ai = last_assistant_message(history).lower()
        if is_followup_reaction(msg):
            if 'cs sukumba' in last_ai or 'saya cs' in last_ai:
                return "Iya Kak, saya CS Sukumba. Silakan, mau tanya produk atau konsultasi dulu?", 'conversation', 'conversation_agent', {}
            return "Iya Kak. Mau saya jelaskan bagian mana, atau Kakak mau konsultasi dulu?", 'conversation', 'conversation_agent', {}
        if is_short_acknowledgement(msg):
            return "Siap Kak. Mau lanjut tanya produk Sukumba atau konsultasi dulu?", 'conversation', 'ack_agent', {}
        logger.info("conversation_agent")
        return conversation_agent(msg, history, cfg, profile, knowledge_context), intent, 'conversation_agent', {}

# ------------------------------------------------------------------
# 8. ENDPOINTS
# ------------------------------------------------------------------
@app.route('/ai-chat', methods=['POST'])
@require_internal_auth
def ai_chat():
    try:
        data = request.json
        raw_content = data.get('content', '')
        
        # Sanitasi input
        content = sanitize_input(raw_content)
        history = data.get('history', [])
        profile = normalize_profile(data.get('profile', {}))
        knowledge_context = str(data.get('knowledgeContext', '') or '')[:2500]
        
        logger.info(f"AI Chat: {log_preview(content)}")
        cfg = get_settings()
        early_profile_updates = extract_memory_updates(raw_content, 'general')
        early_profile_updates.update(extract_state_slot_updates(raw_content, profile, history, 'general'))
        early_profile_updates = enrich_consultation_state(profile, early_profile_updates, raw_content, 'general')
        known_name = early_profile_updates.get('name') or profile.get('name')
        existing_summary = get_memory_summary(profile)

        if is_identity_plus_consultation(raw_content):
            reply = (
                "Saya CS Sukumba, Kak. Boleh, ceritain pelan-pelan dulu keluhan atau tujuan konsultasinya apa?"
            )
            consult_updates = extract_memory_updates(raw_content, 'male_health')
            consult_updates = enrich_consultation_state(profile, consult_updates, raw_content, 'male_health')
            consult_updates.update({
                'active_flow': 'consultation',
                'active_stage': 'complaint',
                'last_question_id': 'ask_complaint',
                'pending_slot': 'complaint',
                'last_offer_type': 'none',
                'state_confidence': 'high',
            })
            early_profile_updates.update(consult_updates)
            memory_summary = existing_summary
            if should_write_summary('male_health', early_profile_updates):
                memory_summary = update_memory_summary(existing_summary, raw_content, reply, early_profile_updates, 'male_health', 'identity_consultation_agent', cfg)
            return jsonify({
                'choices': [{'message': {'role':'assistant','content':reply}}],
                '_meta': {
                    'intent': 'male_health',
                    'agent': 'identity_consultation_agent',
                    'profile_updates': early_profile_updates,
                    'summary': memory_summary,
                    'needs_handoff': False
                }
            })

        if is_identity_question(raw_content):
            reply = 'Saya CS Sukumba, Kak. Saya bantu info produk dan konsultasi seputar stamina/kesehatan pria dengan bahasa yang tetap nyaman.'
            early_profile_updates.update(state_updates_for_reply(reply, 'identity', 'identity_agent', raw_content, early_profile_updates))
            return jsonify({
                'choices': [{'message': {'role':'assistant','content':reply}}],
                '_meta': {
                    'intent': 'identity',
                    'agent': 'identity_agent',
                    'profile_updates': early_profile_updates,
                    'needs_handoff': False
                }
            })

        if is_name_question(raw_content):
            if known_name:
                reply = f"Ingat Kak, nama Kakak {known_name}. Ada yang mau dibantu lagi?"
            else:
                reply = "Belum tahu Kak. Boleh sebutkan nama Kakak dulu?"
            early_profile_updates.update(state_updates_for_reply(reply, 'memory_lookup', 'memory_agent', raw_content, early_profile_updates))
            return jsonify({
                'choices': [{'message': {'role':'assistant','content':reply}}],
                '_meta': {
                    'intent': 'memory_lookup',
                    'agent': 'memory_agent',
                    'profile_updates': early_profile_updates,
                    'needs_handoff': False
                }
            })
        
        reply, intent, agent, extra_meta = orchestrator(content, history, cfg, profile, knowledge_context)
        extra_meta = extra_meta or {}
        extra_profile_updates = extra_meta.pop('profile_updates', {})
        reply = guard_reply(reply, intent)
        profile_updates = extract_memory_updates(raw_content, intent)
        profile_updates.update(extract_state_slot_updates(raw_content, profile, history, intent))
        if isinstance(extra_profile_updates, dict):
            profile_updates.update(extra_profile_updates)
        profile_updates = enrich_consultation_state(profile, profile_updates, raw_content, intent)
        profile_updates.update(state_updates_for_reply(reply, intent, agent, raw_content, profile_updates))
        memory_summary = existing_summary
        if should_write_summary(intent, profile_updates):
            memory_summary = update_memory_summary(existing_summary, raw_content, reply, profile_updates, intent, agent, cfg)
        needs_handoff = bool(profile_updates.get('red_flags')) or intent in ['complaint', 'escalation', 'technical_issue']
        logger.info(f"Reply: {log_preview(reply)}")
        
        meta = {
            'intent': intent,
            'agent': agent,
            'profile_updates': profile_updates,
            'summary': memory_summary,
            'needs_handoff': needs_handoff
        }
        meta.update(extra_meta or {})
        return jsonify({
            'choices': [{'message': {'role':'assistant','content':reply}}],
            '_meta': meta
        })
    except Exception as e:
        logger.error(f"AI Chat error: {e}")
        fallback_intent, _ = deterministic_intent(raw_content, history, profile)
        fallback_reply = deterministic_safe_reply(raw_content, fallback_intent, profile, history)
        return jsonify({
            'choices': [{'message': {'role':'assistant','content': fallback_reply}}],
            '_meta': {
                'intent': fallback_intent,
                'agent': 'deterministic_fallback',
                'llm_error': True,
                'needs_handoff': fallback_intent == 'technical_issue',
            }
        })

@app.route('/detect-intent', methods=['POST'])
@require_internal_auth
def detect_intent():
    try:
        data = request.json
        msg = sanitize_input(data.get('message', ''))
        history = data.get('history', [])
        cfg = get_settings()
        result = intent_agent(msg, history, cfg)
        logger.info(f"detect-intent: {result}")
        return jsonify(result)
    except Exception as e:
        logger.error(f"detect-intent error: {e}")
        return jsonify({"intent":"general","confidence":0})

@app.route('/parse-closing', methods=['POST'])
@require_internal_auth
def parse_closing():
    """Parse satu closingan WA → return structured JSON"""
    try:
        data = request.json
        raw_text = sanitize_input(data.get('text', ''))
        
        if not raw_text or len(raw_text) < 5:
            return jsonify({'success': False, 'error': 'Teks terlalu pendek'}), 400
        
        cfg = get_settings()
        
        if not cfg.get('llm_api_key'):
            return jsonify({'success': False, 'error': 'LLM API key tidak tersedia'}), 503
        
        system = """Kamu adalah parser closingan WA untuk sistem e-commerce Indonesia.
Parse teks closingan dan return JSON object (bukan array).

Fields yang harus diextract:
- nama: nama penerima
- alamat: alamat lengkap (gabung jalan+RT+RW+desa+kecamatan+kab/kota+provinsi jadi 1 string)
- telepon: nomor HP format Indonesia sebagai STRING (mulai 0, contoh: "081234567890", BUKAN integer)
- kode_pos: kode pos jika ada, kosong jika tidak
- kelurahan: nama kelurahan/desa saja
- produk: nama produk
- qty: jumlah (angka saja, default "1")
- pembayaran: "COD" atau "TRF"
- total: total harga (angka saja tanpa Rp/titik/koma)
- courier: kurir jika disebutkan (kosong jika tidak)
- gudang: gudang/kota pengirim jika ada (kosong jika tidak)
- instruksi: instruksi pengiriman jika ada (kosong jika tidak)

Return HANYA JSON object, tidak ada teks lain."""

        messages = [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': raw_text}
        ]
        
        raw = call_groq(messages, cfg, max_tokens=500)
        raw = raw.strip().replace('```json','').replace('```','').strip()
        # Extract hanya JSON object (hapus teks penjelasan AI)
        json_start = raw.find('{')
        json_end = raw.rfind('}') + 1
        if json_start >= 0 and json_end > json_start:
            raw = raw[json_start:json_end]
        parsed = json.loads(raw)
        cod = parsed.get('pembayaran', '').upper() == 'COD'
        
        # Fix phone leading zero - AI sering return integer
        telepon = str(parsed.get('telepon', '') or '')
        telepon = telepon.replace('+62', '0').replace(' ', '').replace('-', '')
        if telepon.startswith('62') and len(telepon) > 10:
            telepon = '0' + telepon[2:]
        if telepon and not telepon.startswith('0'):
            telepon = '0' + telepon
        
        # Fix qty & total jadi string
        qty   = str(parsed.get('qty', '1') or '1')
        total = str(parsed.get('total', '') or '')
        
        # Sanitasi output
        nama = html.unescape(str(parsed.get('nama','')))
        alamat = html.unescape(str(parsed.get('alamat','')))
        
        return jsonify({
            'success': True,
            'data': {
                'nama':          nama,
                'alamat':        alamat,
                'telepon':       telepon,
                'kode_pos':      str(parsed.get('kode_pos','') or ''),
                'berat':         '1',
                'harga_non_cod': '' if cod else total,
                'nilai_cod':     total if cod else '',
                'produk':        html.unescape(str(parsed.get('produk',''))),
                'kelurahan':     html.unescape(str(parsed.get('kelurahan',''))),
                'qty':           qty,
                'instruksi':     html.unescape(str(parsed.get('instruksi',''))),
                'courier':       str(parsed.get('courier','')),
                'gudang':        str(parsed.get('gudang','')),
            }
        })
    except json.JSONDecodeError as e:
        logger.error(f"parse-closing JSON error: {e} | Raw: {raw[:200]}")
        return jsonify({'success': False, 'error': f'AI mengembalikan format yang tidak valid: {str(e)}'}), 500
    except Exception as e:
        logger.error(f"parse-closing error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/notify-order', methods=['POST'])
@require_internal_auth
def notify_order():
    try:
        d = request.json
        msg = (
            f"🛒 <b>ORDER BARU #{d.get('order_id','-')}</b>\n\n"
            f"👤 Nama: {d.get('user_name','-')}\n"
            f"📱 WA: {d.get('user_wa','-')}\n"
            f"📞 HP: {d.get('phone','-')}\n"
            f"📍 Alamat: {d.get('address','-')}\n"
            f"📦 Produk: {d.get('product','-')}\n"
            f"🔢 Jumlah: {d.get('quantity','-')}\n"
            f"💰 Total: {d.get('total','-')}\n"
            f"📝 Catatan: {d.get('notes','-') or '-'}\n\n"
            f"⏳ Menunggu approval untuk dikirim ke Mengantar."
        )
        send_telegram(msg)
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"notify-order error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/parse-bulk', methods=['POST'])
@require_internal_auth
def parse_bulk():
    """Parse banyak closingan dari 1 blok teks -> return JSON array"""
    try:
        data = request.json
        raw_text = data.get('text', '')
        if not raw_text or len(raw_text) < 5:
            return jsonify({'success': False, 'error': 'Teks kosong'}), 400

        cfg = get_settings()
        if not cfg.get('llm_api_key'):
            return jsonify({'success': False, 'error': 'LLM API key tidak tersedia'}), 503

        system = """Kamu parser closingan WA untuk e-commerce Indonesia.
Dari teks yang diberikan, identifikasi dan parse SEMUA closingan yang ada.
Satu closingan bisa multi-paragraf — jangan pecah berdasarkan baris kosong.
Kenali batas closingan dari pola konten (nama baru, nomor baru, dll).

Return JSON array. Setiap closingan = 1 object dengan fields:
- nama: nama penerima
- alamat: alamat lengkap (gabung jalan+RT+RW+desa+kecamatan+kab/kota+provinsi)
- telepon: nomor HP STRING format Indonesia (mulai 0)
- kode_pos: kode pos jika ada
- kelurahan: kelurahan/desa saja
- produk: nama produk
- qty: jumlah (angka, default "1")
- pembayaran: "COD" atau "TRF"
- total: total harga (angka saja, tanpa Rp/titik/koma)
- courier: kurir jika ada
- gudang: gudang/kota pengirim jika ada
- instruksi: instruksi pengiriman jika ada

Jika hanya 1 closingan, return array dengan 1 element.
Return HANYA JSON array, tidak ada teks lain."""

        messages = [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': raw_text[:4000]}
        ]

        raw = call_groq(messages, cfg, max_tokens=3000)
        raw = raw.strip().replace('```json','').replace('```','').strip()
        match = re.search(r'\[[\s\S]*\]', raw)
        if not match:
            return jsonify({'success': False, 'error': 'AI tidak return JSON valid'}), 500

        parsed_list = json.loads(match.group())
        results = []
        for p in parsed_list:
            cod = p.get('pembayaran','').upper() == 'COD'
            telepon = str(p.get('telepon','') or '')
            telepon = telepon.replace('+62','0').replace(' ','').replace('-','')
            if telepon.startswith('62') and len(telepon) > 10:
                telepon = '0' + telepon[2:]
            if telepon and not telepon.startswith('0'):
                telepon = '0' + telepon
            total = str(p.get('total','') or '')
            results.append({
                'nama':          html.unescape(str(p.get('nama',''))),
                'alamat':        html.unescape(str(p.get('alamat',''))),
                'telepon':       telepon,
                'kode_pos':      str(p.get('kode_pos','') or ''),
                'berat':         '1',
                'harga_non_cod': '' if cod else total,
                'nilai_cod':     total if cod else '',
                'produk':        html.unescape(str(p.get('produk',''))),
                'kelurahan':     html.unescape(str(p.get('kelurahan',''))),
                'qty':           str(p.get('qty','1') or '1'),
                'instruksi':     html.unescape(str(p.get('instruksi',''))),
                'courier':       str(p.get('courier','')),
                'gudang':        str(p.get('gudang','')),
            })

        return jsonify({'success': True, 'results': results, 'count': len(results)})

    except json.JSONDecodeError as e:
        logger.error(f"parse-bulk JSON error: {e}")
        return jsonify({'success': False, 'error': f'Format tidak valid: {str(e)}'}), 500
    except Exception as e:
        logger.error(f"parse-bulk error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/health', methods=['GET'])
def health():
    cfg = get_settings()
    return jsonify({
        'status': 'ok',
        'version': SERVICE_VERSION,
        'consultation_opening': SERVICE_VERSION,
        'llm_provider': cfg.get('llm_provider'),
        'llm_api_url': cfg.get('llm_api_url'),
        'ai_model': cfg.get('ai_model'),
        'active_file': os.path.basename(__file__),
    })

# ------------------------------------------------------------------
# 9. MAIN
# ------------------------------------------------------------------
if __name__ == '__main__':
    logger.info(f'Sukumba AI Service {SERVICE_VERSION} starting on port 5000...')
    try:
        from waitress import serve
        serve(app, host='0.0.0.0', port=5000, threads=6)
    except ImportError:
        logger.warning('waitress tidak terinstall, menggunakan development server')
        app.run(host='0.0.0.0', port=5000, debug=False)
