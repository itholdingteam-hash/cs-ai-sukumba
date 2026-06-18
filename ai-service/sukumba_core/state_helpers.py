"""State inference and update helpers for conversation continuity."""

import html
import re

from .patterns import CONSULT_QUESTION_IDS


def infer_question_id_from_reply(reply):
    text = html.unescape(str(reply or '')).lower()
    if re.search(r'pesanan\s+berhasil\s+diterima|terima\s+kasih\s+telah\s+memesan|order\s+id\s*:\s*#?\d+', text):
        return 'post_order_complete'
    if re.search(r'hallo\s+kak,\s*salam\s+kenal\s+ini\s+dengan\s+cs\s+syifa|kaka\s+bisa\s+otomatis\s+mendapatkan\s+promo|cukup\s+klik\s+iklan\s+1\s+kali', text):
        return 'ask_order_form'
    if re.search(r'bantu\s+pilihkan\s+paket|pilihkan\s+paket|pilih\s+paket|paket\s+yang\s+pas|paket\s+yang\s+cocok', text):
        return 'ask_package_choice'
    if re.search(r'biar\s+saya\s+rekomendasikan\s+tepat|mau\s+pakai\s+sukumba\s+untuk', text):
        return 'ask_product_info'
    if re.search(r'(mau\s+coba|langsung\s+bantu\s+pemesanan|harga/promo)', text):
        return 'ask_product_info'
    if re.search(r'(paketnya|mau\s+ambil|ambil).{0,50}(1\s*box|satu\s*box).{0,50}(2\s*box|dua\s*box)|(1\s*box|satu\s*box).{0,50}(2\s*box|dua\s*box)', text):
        return 'ask_package_choice'
    if re.search(r'(info\s+produk|tanya\s+produk|produk\s+sukumba).{0,60}(konsultasi)|konsultasi.{0,60}(info\s+produk|tanya\s+produk)', text):
        return 'choose_product_or_consult'
    if re.search(r'usia.{0,30}(berapa|keluhan).{0,60}(berapa\s+lama|sejak\s+kapan)|berapa\s+lama.{0,60}usia', text):
        return 'ask_age_duration'
    if re.search(r'(diabetes|gula\s+darah).{0,80}(tensi|hipertensi|darah\s+tinggi|jantung|obat\s+rutin)|obat\s+rutin.{0,80}(dokter|diabetes|tensi|jantung)', text):
        return 'ask_risk_factors'
    if re.search(r'keluhan\s+(ini|tersebut)?.{0,40}(sudah\s+berapa\s+lama|sejak\s+kapan|muncul\s+kapan)|sudah\s+berapa\s+lama.{0,40}keluhan', text):
        return 'ask_complaint'
    if re.search(r'(pola\s+tidur|tidur).{0,80}(rokok|merokok|stres|stress)|rokok.{0,80}(tidur|stres|stress)', text):
        return 'ask_lifestyle'
    if re.search(r'(tensi\s+terakhir|tekanan\s+darah|ukur\s+ulang|cek\s+tensi)', text):
        return 'ask_bp'
    if re.search(r'(keluhan\s+apa|keluhan\s+utama|mau\s+dibantu\s+soal\s+apa|tujuan\s+konsultasi)', text):
        return 'ask_complaint'
    if re.search(r'(mau|boleh).{0,30}(saya\s+)?(jelaskan|terangkan).{0,40}(produk|sukumba|manfaat|aturan|minum|paket)|tertarik\s+tahu\s+lebih\s+lanjut', text):
        return 'ask_product_info'
    if re.search(r'(boleh|minta).{0,30}nama\s+penerima', text):
        return 'ask_order_name'
    if re.search(r'pembayaran(nya)?.{0,40}\b(cod|transfer|tf)\b|\b(cod|transfer|tf)\b.{0,40}pembayaran', text):
        return 'ask_payment_method'
    if re.search(r'(nomor|no\.?|hp|wa).{0,40}(dihubungi|aktif)', text):
        return 'ask_order_phone'
    if re.search(r'alamat\s+lengkap', text):
        return 'ask_order_address'
    return 'none'


def state_from_question_id(question_id):
    if question_id == 'choose_product_or_consult':
        return {'active_flow': 'triage', 'active_stage': 'awaiting_choice', 'pending_slot': 'conversation_choice', 'last_offer_type': 'choice'}
    if question_id in CONSULT_QUESTION_IDS:
        return {'active_flow': 'consultation', 'active_stage': question_id.replace('ask_', ''), 'pending_slot': question_id.replace('ask_', ''), 'last_offer_type': 'none'}
    if question_id == 'ask_product_info':
        return {'active_flow': 'product', 'active_stage': 'awaiting_product_info_confirmation', 'pending_slot': 'product_info_confirmation', 'last_offer_type': 'product_info'}
    if question_id == 'ask_package_choice':
        return {'active_flow': 'order', 'active_stage': 'package_choice', 'pending_slot': 'package_choice', 'last_offer_type': 'order'}
    if question_id == 'ask_order_form':
        return {'active_flow': 'order', 'active_stage': 'awaiting_order_form', 'pending_slot': 'order_form', 'last_offer_type': 'order_form'}
    if question_id.startswith('ask_order_'):
        return {'active_flow': 'order', 'active_stage': question_id.replace('ask_order_', ''), 'pending_slot': question_id.replace('ask_order_', ''), 'last_offer_type': 'order'}
    if question_id == 'ask_payment_method':
        return {'active_flow': 'order', 'active_stage': 'payment_method', 'pending_slot': 'payment_method', 'last_offer_type': 'order'}
    if question_id == 'post_order_complete':
        return {'active_flow': 'post_order', 'active_stage': 'completed', 'pending_slot': 'none', 'last_offer_type': 'none'}
    return {}


def product_context_updates(confidence='high'):
    return {
        'active_flow': 'product',
        'active_stage': 'explaining_product',
        'last_question_id': 'ask_product_info',
        'pending_slot': 'product_info_confirmation',
        'last_offer_type': 'product_info',
        'state_confidence': confidence,
    }


def build_conversation_state(profile, history=None, normalize_profile_fn=None, last_assistant_message_fn=None):
    if normalize_profile_fn:
        profile = normalize_profile_fn(profile)
    elif not isinstance(profile, dict):
        profile = {}

    state = {
        'active_flow': profile.get('active_flow') or ('consultation' if profile.get('last_question_id') in CONSULT_QUESTION_IDS else 'triage'),
        'active_stage': profile.get('active_stage') or profile.get('consultation_stage') or 'idle',
        'last_question_id': profile.get('last_question_id') or 'none',
        'pending_slot': profile.get('pending_slot') or 'none',
        'last_offer_type': profile.get('last_offer_type') or 'none',
        'topic': profile.get('consultation_topic') or 'none',
    }

    if last_assistant_message_fn:
        last_q = infer_question_id_from_reply(last_assistant_message_fn(history or []))
        if last_q != 'none':
            state['last_question_id'] = last_q
            state.update(state_from_question_id(last_q))

    return state


def state_updates_for_reply(reply, intent, agent, raw_text=None, profile_updates=None):
    updates = {}
    qid = infer_question_id_from_reply(reply)
    updates['last_question_id'] = qid
    updates['state_confidence'] = 'high' if qid != 'none' else 'medium'
    updates.update(state_from_question_id(qid))

    if agent == 'test_probe_agent':
        updates.update({
            'active_flow': 'triage',
            'active_stage': 'idle',
            'last_question_id': 'none',
            'pending_slot': 'none',
            'last_offer_type': 'none',
        })
    elif agent in {'greeting_agent', 'identity_agent', 'memory_agent', 'state_clarifier'}:
        updates.update({
            'active_flow': 'triage',
            'active_stage': 'awaiting_choice',
            'last_question_id': 'choose_product_or_consult',
            'pending_slot': 'conversation_choice',
            'last_offer_type': 'choice',
        })
    elif intent == 'male_health' or agent == 'male_health_consultant_agent':
        updates.setdefault('active_flow', 'consultation')
        updates.setdefault('active_stage', (profile_updates or {}).get('consultation_stage', 'collecting_context'))
        updates.setdefault('pending_slot', (profile_updates or {}).get('next_question', 'consultation_context'))
        updates.setdefault('last_offer_type', 'none')
    elif intent == 'product_info' or agent in {'product_agent', 'state_product_followup', 'state_product_reaction', 'state_product_shortcut'}:
        updates.setdefault('active_flow', 'product')
        updates.setdefault('active_stage', 'explaining_product')
        updates.setdefault('pending_slot', 'none')
        updates.setdefault('last_offer_type', 'product_info')
    elif agent in {'state_package_choice', 'syifa_package_choice_template'} and re.search(r'\bCOD atau transfer\b', reply, re.IGNORECASE):
        updates.update({
            'active_flow': 'order',
            'active_stage': 'awaiting_order_form',
            'last_question_id': 'ask_order_form',
            'pending_slot': 'order_form',
            'last_offer_type': 'order_form',
        })
    elif intent == 'order' or agent == 'order_agent':
        updates.setdefault('active_flow', 'order')
        updates.setdefault('active_stage', 'awaiting_order_form')
        updates.setdefault('pending_slot', 'order_form')
        updates.setdefault('last_question_id', 'ask_order_form')
        updates.setdefault('last_offer_type', 'order_form')
    elif intent == 'post_order' or agent == 'post_order_ack_agent':
        updates.update({
            'active_flow': 'post_order',
            'active_stage': 'completed',
            'pending_slot': 'none',
            'last_offer_type': 'none',
            'last_question_id': 'post_order_complete',
        })
    elif intent in {'closing', 'cancel'}:
        updates.update({
            'active_flow': 'idle',
            'active_stage': 'idle',
            'pending_slot': 'none',
            'last_offer_type': 'none',
        })

    if profile_updates:
        if profile_updates.get('consultation_topic'):
            updates['topic'] = profile_updates.get('consultation_topic')
        if profile_updates.get('consultation_stage') and updates.get('active_flow') == 'consultation':
            updates['active_stage'] = profile_updates.get('consultation_stage')
    return updates
