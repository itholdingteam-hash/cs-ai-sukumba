"""Runtime template service for dynamic and fallback CS Syifa copy."""

import html
import os
import re
from datetime import datetime, timezone, timedelta

from . import templates as fallback_templates


def looks_like_unsafe_diabetes_template(text):
    lower = html.unescape(str(text or '')).lower()
    return (
        'diabetes' in lower
        and 'untuk produk kami aman' in lower
        and 'lebih hati-hati' not in lower
    )


def looks_like_unsafe_bpom_template(text):
    lower = html.unescape(str(text or '')).lower()
    return (
        'dijamin aman' in lower
        or 'aman dikonsumsi jangka panjang' in lower
    )


def looks_like_legacy_transfer_template(text):
    lower = html.unescape(str(text or '')).lower()
    return 'total tf' in lower or re.search(r'\bharga\s*:', lower)


def jakarta_now():
    return datetime.now(timezone(timedelta(hours=7)))


def greeting_label_for_message(raw_text):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    if re.search(r'\b(selamat\s+)?pagi\b|semangat\s+pagi', lower):
        return 'Pagi'
    if re.search(r'\b(selamat\s+)?siang\b', lower):
        return 'Siang'
    if re.search(r'\b(selamat\s+)?sore\b', lower):
        return 'Sore'
    if re.search(r'\b(selamat\s+)?malam\b', lower):
        return 'Malam'
    if re.search(r'\b(halo|hai|hallo|helo|hello)\b', lower):
        return 'Halo'

    hour = jakarta_now().hour
    if 4 <= hour < 11:
        return 'Pagi'
    if 11 <= hour < 15:
        return 'Siang'
    if 15 <= hour < 18:
        return 'Sore'
    return 'Malam'


class TemplateService:
    def __init__(self, dynamic_templates, box_content_gram=None):
        self.dynamic_templates = dynamic_templates
        self.box_content_gram = box_content_gram or os.getenv('SUKUMBA_BOX_CONTENT_GRAM', '200')

    def dynamic(self, title_key, default_text=None):
        return self.dynamic_templates.get(title_key, default_text)

    def _dynamic_or_fallback(self, title_key, fallback_factory):
        return self.dynamic(title_key, None) or fallback_factory()

    def greeting_syifa(self, raw_text=''):
        dyn = self.dynamic('Greeting', None)
        if dyn:
            return dyn
        return fallback_templates.greeting(raw_text, greeting_label_for_message(raw_text))

    def ask_complaint_general(self):
        return self._dynamic_or_fallback('Tanya Keluhan', fallback_templates.ask_complaint_general)

    def known_general_complaint(self):
        return self._dynamic_or_fallback('Keluhan Umum Lanjutan', fallback_templates.known_general_complaint)

    def ask_complaint_male_vitality(self):
        return self._dynamic_or_fallback('Keluhan Vitalitas', fallback_templates.ask_complaint_male_vitality)

    def promo_sukumba(self):
        return self._dynamic_or_fallback('Promo', fallback_templates.promo_sukumba)

    def cara_konsumsi(self):
        return self._dynamic_or_fallback('Cara Konsumsi', fallback_templates.cara_konsumsi)

    def aturan_minum(self):
        return self._dynamic_or_fallback('Aturan Minum', fallback_templates.aturan_minum)

    def ask_ever_consumed(self):
        return self._dynamic_or_fallback('Pernah Konsumsi', fallback_templates.ask_ever_consumed)

    def order_form(self, intro=None):
        dyn = self.dynamic('Order Form', None)
        if dyn and intro is None:
            return dyn
        return fallback_templates.order_form(intro)

    def transfer_info(self):
        dyn = self.dynamic('Transfer Info', None)
        if dyn and not looks_like_legacy_transfer_template(dyn):
            return dyn
        return fallback_templates.transfer_info()

    def cod_1_box(self):
        dyn = self.dynamic('COD 1 Box', None)
        if dyn and re.search(r'\b(nama|alamat|data)\b', dyn, re.IGNORECASE):
            return dyn
        return fallback_templates.cod_1_box()

    def empathy_reply(self):
        return self._dynamic_or_fallback('Empati', fallback_templates.empathy_reply)

    def order_success(self):
        return self._dynamic_or_fallback('Order Sukses', fallback_templates.order_success)

    def bpom_safe(self):
        dyn = self.dynamic('Info BPOM', None)
        if dyn and not looks_like_unsafe_bpom_template(dyn):
            return dyn
        return fallback_templates.bpom_safe()

    def health_risk_warning(self):
        return fallback_templates.health_risk_warning()

    def halal_info(self):
        return self._dynamic_or_fallback('Info Halal', fallback_templates.halal_info)

    def diabetes_warning(self):
        dyn = self.dynamic('Warning Diabetes', None)
        if dyn and not looks_like_unsafe_diabetes_template(dyn):
            return dyn
        return fallback_templates.diabetes_warning()

    def komposisi(self):
        return self._dynamic_or_fallback('Komposisi', fallback_templates.komposisi)

    def isi_box(self):
        return self.dynamic('Isi Box', None) or fallback_templates.isi_box(self.box_content_gram)

    def estimasi_pengiriman(self):
        return self._dynamic_or_fallback('Estimasi Pengiriman', fallback_templates.estimasi_pengiriman)

    def kurir_ongkir(self):
        return self._dynamic_or_fallback('Kurir dan Ongkir', fallback_templates.kurir_ongkir)

    def ongkir_info(self):
        return self._dynamic_or_fallback('Info Ongkir', fallback_templates.ongkir_info)

    def kurir_info(self):
        return self._dynamic_or_fallback('Info Kurir', fallback_templates.kurir_info)

    def testimoni_offer(self):
        return self._dynamic_or_fallback('Tawaran Testimoni', fallback_templates.testimoni_offer)
