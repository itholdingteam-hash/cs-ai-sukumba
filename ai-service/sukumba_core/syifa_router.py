"""Fast deterministic template routing for CS Syifa replies."""

import html
import re
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class SyifaRouterDeps:
    is_identity_question: Callable
    is_name_question: Callable
    is_clear_closing: Callable
    build_conversation_state: Callable
    is_package_choice_request: Callable
    is_package_recommendation_request: Callable
    is_product_context_active: Callable
    package_choice_reply: Callable
    package_recommendation_reply: Callable
    order_prefill_for_choice: Callable
    is_product_packaging_question: Callable
    is_dosage_question: Callable
    is_consumption_question: Callable
    is_greeting_message: Callable
    deterministic_order_reply: Callable
    product_context_updates: Callable
    template_order_form: Callable
    template_order_success: Callable
    template_transfer_info: Callable
    template_cod_1_box: Callable
    template_isi_box: Callable
    template_estimasi_pengiriman: Callable
    template_kurir_ongkir: Callable
    template_ongkir_info: Callable
    template_kurir_info: Callable
    template_promo_sukumba: Callable
    template_aturan_minum: Callable
    template_cara_konsumsi: Callable
    template_ask_ever_consumed: Callable
    template_diabetes_warning: Callable
    template_health_risk_warning: Callable
    template_bpom_safe: Callable
    template_halal_info: Callable
    template_komposisi: Callable
    template_testimoni_offer: Callable
    template_known_general_complaint: Callable
    template_ask_complaint_male_vitality: Callable
    template_greeting_syifa: Callable


def route_syifa_template(raw_text, history=None, profile=None, deps=None):
    """Route high-confidence product/order/triage messages to fixed templates."""
    if deps is None:
        raise ValueError("SyifaRouterDeps is required")

    lower = html.unescape(str(raw_text or '')).lower().strip()
    if not lower:
        return None

    if deps.is_identity_question(lower) or deps.is_name_question(lower) or deps.is_clear_closing(lower):
        return None

    if re.search(r'\b(sudah|udh|udah)\b.*\b(tf|transfer|bayar)\b|\bbukti\s+(tf|transfer|pembayaran)\b', lower):
        return (
            deps.template_order_success(),
            'post_order',
            'syifa_order_success_template',
            {
                'active_flow': 'post_order',
                'active_stage': 'completed',
                'last_question_id': 'post_order_complete',
                'pending_slot': 'none',
                'last_offer_type': 'none',
                'state_confidence': 'high',
            }
        )

    state = deps.build_conversation_state(profile, history or [])

    if deps.is_package_recommendation_request(lower):
        return (
            deps.package_recommendation_reply(raw_text, profile, history),
            'product_info',
            'syifa_package_recommendation_template',
            {
                'active_flow': 'product',
                'active_stage': 'recommending_package',
                'last_question_id': 'ask_package_choice',
                'pending_slot': 'package_choice',
                'last_offer_type': 'order',
                'state_confidence': 'high',
            }
        )

    if state.get('pending_slot') == 'payment_method' and re.fullmatch(r'(cod|tf|transfer|bayar\s+di\s+tempat)', lower):
        method = 'COD' if re.search(r'\bcod\b|bayar\s+di\s+tempat', lower) else 'transfer'
        return (
            deps.template_order_form(f"Siap Kak, pembayarannya {method} ya. Boleh lengkapi form order berikut."),
            'order',
            'syifa_payment_method_template',
            {
                'start_order': True,
                'active_flow': 'order',
                'active_stage': 'awaiting_order_form',
                'last_question_id': 'ask_order_form',
                'pending_slot': 'order_form',
                'last_offer_type': 'order_form',
                'state_confidence': 'high',
                'order_prefill': {'payment': method},
            },
        )

    if re.search(r'\b(tf|transfer|rekening(?:nya)?|no\s*rek|nomor\s*rekening|bca|bayar\s+transfer|total\s+tf)\b', lower):
        return (
            deps.template_transfer_info(),
            'payment_transfer',
            'syifa_transfer_template',
            {
                'active_flow': 'order',
                'active_stage': 'payment_transfer',
                'last_question_id': 'ask_payment_time',
                'pending_slot': 'payment_proof',
                'last_offer_type': 'order',
                'state_confidence': 'high',
            }
        )

    if deps.is_package_choice_request(lower) and deps.is_product_context_active(state, history or [], profile):
        starts_order = bool(re.search(r'\b(cod|tf|transfer)\b', lower))
        payment = 'COD' if re.search(r'\bcod\b', lower) else ('TRF' if re.search(r'\b(tf|transfer)\b', lower) else '')
        return (
            deps.package_choice_reply(raw_text),
            'order',
            'syifa_package_choice_template',
            {
                'start_order': starts_order,
                'order_prefill': deps.order_prefill_for_choice(raw_text, payment),
                'active_flow': 'order',
                'active_stage': 'awaiting_order_form',
                'last_question_id': 'ask_order_form',
                'pending_slot': 'order_form',
                'last_offer_type': 'order_form',
                'state_confidence': 'high',
            }
        )

    if re.search(r'\b(cod|bayar\s+di\s+tempat)\b', lower) and re.search(r'\b(1\s*box|satu\s*box)\b', lower):
        return (
            deps.template_cod_1_box(),
            'order_cod',
            'syifa_cod_template',
            {
                'start_order': True,
                'active_flow': 'order',
                'active_stage': 'awaiting_order_form',
                'last_question_id': 'ask_order_form',
                'pending_slot': 'order_form',
                'last_offer_type': 'order_form',
                'state_confidence': 'high',
            }
        )

    if re.search(r'\b(cod|bayar\s+di\s+tempat)\b', lower):
        return (
            deps.template_order_form("Bisa COD Kak. Boleh lengkapi form order berikut ya, pilih paket 1 box atau 2 box di bagian keluhan/catatan."),
            'payment_cod',
            'syifa_cod_info_template',
            {
                'active_flow': 'order',
                'active_stage': 'awaiting_order_form',
                'last_question_id': 'ask_order_form',
                'pending_slot': 'order_form',
                'last_offer_type': 'order_form',
                'state_confidence': 'high',
            }
        )

    if deps.is_product_packaging_question(lower):
        return (
            deps.template_isi_box(),
            'product_info',
            'syifa_packaging_template',
            deps.product_context_updates('high')
        )

    if re.search(r'\b(ongkir(?:nya)?|ongkos\s+kirim|biaya\s+kirim)\b', lower):
        return (
            deps.template_ongkir_info(),
            'product_info',
            'syifa_shipping_cost_template',
            deps.product_context_updates('high')
        )

    if re.search(r'\b(kurir(?:nya)?|ekspedisi(?:nya)?|jasa\s+(?:kirim|pengiriman)|pengiriman\s+(?:apa|pakai\s+apa)|jne|jnt|j&t|sicepat|anteraja)\b', lower):
        return (
            deps.template_kurir_info(),
            'product_info',
            'syifa_courier_template',
            deps.product_context_updates('high')
        )

    if re.search(r'\b(berapa\s+lama|estimasi|kapan.{0,30}sampai|sampai\s+berapa\s+hari|lama\s+pengiriman|pengiriman\s+berapa\s+hari|dikirim|sampainya)\b', lower) and re.search(r'\b(kirim|pengiriman|sampai|paket|barang|pesanan|dikirim)\b', lower):
        return (
            deps.template_estimasi_pengiriman(),
            'product_info',
            'syifa_shipping_estimate_template',
            deps.product_context_updates('high')
        )

    if re.search(r'\b(order|pesan|pesen|beli|mau\s+ambil|ambil\s+\d+|checkout|co)\b', lower):
        return (
            deps.deterministic_order_reply(raw_text, profile, history),
            'order',
            'syifa_order_step_template',
            {
                'start_order': True,
                'active_flow': 'order',
                'active_stage': 'awaiting_order_form',
                'last_question_id': 'ask_order_form',
                'pending_slot': 'order_form',
                'last_offer_type': 'order_form',
                'state_confidence': 'high',
            }
        )

    if re.search(r'\b(harga|promo|berapa\s+harg|paket|diskon|price)\b', lower):
        return (
            deps.template_promo_sukumba(),
            'product_info',
            'syifa_promo_template',
            deps.product_context_updates('high')
        )

    if deps.is_dosage_question(lower):
        return (
            deps.template_aturan_minum(),
            'product_info',
            'syifa_dosage_template',
            deps.product_context_updates('high')
        )

    if deps.is_consumption_question(lower):
        return (
            deps.template_cara_konsumsi(),
            'product_info',
            'syifa_consumption_template',
            deps.product_context_updates('high')
        )

    if re.search(r'\b(pernah\s+konsumsi|sudah\s+pernah|pernah\s+minum)\b', lower):
        return (
            deps.template_ask_ever_consumed(),
            'product_info',
            'syifa_ever_consumed_template',
            deps.product_context_updates('medium')
        )

    if (
        state.get('active_flow') == 'consultation'
        and state.get('pending_slot') in {'risk_factors', 'lifestyle', 'age_duration'}
        and re.search(r'\b(diabetes|gula\s+darah|kencing\s+manis|tensi|hipertensi|darah\s+tinggi|jantung|obat\s+rutin|begadang|tidur|rokok|merokok|stres|stress)\b', lower)
        and not re.search(r'\b(aman|minum|produk|sukumba|bpom|komposisi|aturan|cara\s+konsumsi)\b', lower)
    ):
        return None

    if re.search(r'\b(diabetes|gula|gula\s+darah|kencing\s+manis)\b', lower):
        return (
            deps.template_diabetes_warning(),
            'product_safety',
            'syifa_diabetes_warning_template',
            deps.product_context_updates('high')
        )

    if (
        re.search(r'\b(tensi|hipertensi|darah\s+tinggi|jantung|obat\s+rutin|obat\s+dokter|minum\s+obat)\b', lower)
        and re.search(r'\b(aman|minum|konsumsi|produk|sukumba|bpom|boleh)\b', lower)
    ):
        return (
            deps.template_health_risk_warning(),
            'product_safety',
            'syifa_health_risk_warning_template',
            deps.product_context_updates('high')
        )

    if re.search(r'\b(halal|haram|mui|sertifikat\s+halal|label\s+halal)\b', lower):
        return (
            deps.template_halal_info(),
            'product_safety',
            'syifa_halal_template',
            deps.product_context_updates('high')
        )

    if re.search(r'\b(bpom|aman|legal|izin|terdaftar)\b', lower):
        return (
            deps.template_bpom_safe(),
            'product_safety',
            'syifa_bpom_template',
            deps.product_context_updates('high')
        )

    if re.search(r'\b(komposisi|kandungan|bahan|terbuat\s+dari)\b', lower):
        return (
            deps.template_komposisi(),
            'product_info',
            'syifa_composition_template',
            deps.product_context_updates('high')
        )

    if re.search(r'\b(testimoni|bukti|review|ulasan|hasil)\b', lower):
        return (
            deps.template_testimoni_offer(),
            'product_info',
            'syifa_testimony_template',
            deps.product_context_updates('high')
        )

    if (
        re.search(r'\b(nyeri|sendi|otot|pegal|linu|tulang|badan\s+sakit)\b', lower)
        and not re.search(r'\b\d{1,2}\s*(tahun|th|thn|hari|minggu|bulan|tahun)?\b', lower)
    ):
        return (
            deps.template_known_general_complaint(),
            'male_health',
            'syifa_general_complaint_template',
            {
                'active_flow': 'consultation',
                'active_stage': 'age_duration',
                'last_question_id': 'ask_age_duration',
                'pending_slot': 'age_duration',
                'last_offer_type': 'none',
                'state_confidence': 'high',
            }
        )

    if (
        re.search(
        r'\b(cepat\s+keluar|cepet\s+keluar|ejakulasi|ereksi|kurang\s+keras|gak\s+keras|ga\s+keras|tidak\s+keras|'
        r'burung|mr\s*p|alat\s+vital|loyo|letoy|stamina\s+(saya|aku)?\s*(kurang|turun|drop)|'
        r'kurang\s+stamina|stamina\s+hubungan)\b',
        lower
        )
        and not re.search(r'\b\d{1,2}\s*(tahun|th|thn|hari|minggu|bulan)?\b', lower)
    ):
        return (
            "Saya pahami Kak, vitalitas pria terasa kurang maksimal. Usia Kakak berapa, dan keluhan ini sudah berapa lama?",
            'male_health',
            'syifa_vitality_age_duration_template',
            {
                'active_flow': 'consultation',
                'active_stage': 'age_duration',
                'last_question_id': 'ask_age_duration',
                'pending_slot': 'age_duration',
                'last_offer_type': 'none',
                'state_confidence': 'high',
            }
        )

    if (
        re.search(r'\b(stamina|loyo|kurang\s+bergairah|gairah|vitalitas|lemas|kurang\s+tenaga)\b', lower)
        and not re.search(r'\b\d{1,2}\s*(tahun|th|thn|hari|minggu|bulan)?\b', lower)
    ):
        return (
            deps.template_ask_complaint_male_vitality(),
            'male_health',
            'syifa_vitality_complaint_template',
            {
                'active_flow': 'consultation',
                'active_stage': 'complaint',
                'last_question_id': 'ask_complaint',
                'pending_slot': 'complaint',
                'last_offer_type': 'none',
                'state_confidence': 'high',
            }
        )

    if deps.is_greeting_message(lower):
        return (
            deps.template_greeting_syifa(raw_text),
            'greeting',
            'syifa_greeting_template',
            {
                'active_flow': 'triage',
                'active_stage': 'awaiting_choice',
                'last_question_id': 'choose_product_or_consult',
                'pending_slot': 'conversation_choice',
                'last_offer_type': 'choice',
                'state_confidence': 'high',
            }
        )

    return None
