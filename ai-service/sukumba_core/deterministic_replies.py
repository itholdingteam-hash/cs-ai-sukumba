"""Deterministic fallback replies that do not require the LLM."""

import html
import re
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class ProductReplyDeps:
    is_product_packaging_question: Callable
    is_dosage_question: Callable
    is_consumption_question: Callable
    template_estimasi_pengiriman: Callable
    template_isi_box: Callable
    template_aturan_minum: Callable
    template_cara_konsumsi: Callable
    template_promo_sukumba: Callable
    template_kurir_ongkir: Callable
    template_ongkir_info: Callable
    template_kurir_info: Callable
    template_halal_info: Callable


def deterministic_order_reply(raw_text, order_form_renderer, profile=None, history=None):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    if re.search(r'\bcara\s+(beli|pesan|pesen|order|pemesanan)\b|\b(beli|pesan|pesen|order|pemesanan)\s+(gimana|bagaimana|gmn|gmna|caranya)\b', lower):
        return order_form_renderer("Bisa Kak, CS Syifa bantu pemesanan ya. Boleh lengkapi form berikut.")
    if re.search(r'\b(mau|mo|ingin|pengen|jadi|lanjut|gas|langsung)\s+(pesan|pesen|order|beli)\b|\b(order|pesan|pesen|beli)\s+sekarang\b', lower):
        return order_form_renderer("Siap Kak, CS Syifa bantu proses ordernya ya. Boleh lengkapi data berikut.")
    return order_form_renderer("Baik Kak, CS Syifa bantu pemesanan ya. Boleh lengkapi data berikut.")


def deterministic_product_reply(raw_text, deps, profile=None, history=None):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    if re.search(r'\b(ongkir(?:nya)?|ongkos\s+kirim|biaya\s+kirim)\b', lower):
        return deps.template_ongkir_info()
    if re.search(r'\b(kurir(?:nya)?|ekspedisi(?:nya)?|jasa\s+(?:kirim|pengiriman)|pengiriman\s+(?:apa|pakai\s+apa)|jne|jnt|j&t|sicepat|anteraja)\b', lower):
        return deps.template_kurir_info()
    if re.search(r'\b(halal|haram|mui|sertifikat\s+halal|label\s+halal)\b', lower):
        return deps.template_halal_info()
    if re.search(r'\b(berapa\s+lama|estimasi|kapan.{0,30}sampai|sampai\s+berapa\s+hari|lama\s+pengiriman|pengiriman\s+berapa\s+hari|dikirim|sampainya)\b', lower) and re.search(r'\b(kirim|pengiriman|sampai|paket|barang|pesanan|dikirim)\b', lower):
        return deps.template_estimasi_pengiriman()
    if deps.is_product_packaging_question(lower):
        return deps.template_isi_box()
    if deps.is_dosage_question(lower):
        return deps.template_aturan_minum()
    if deps.is_consumption_question(lower):
        return deps.template_cara_konsumsi()
    if re.search(r'\b(harga|harganya|berapa|promo|ongkir|cod|paket)\b', lower):
        return deps.template_promo_sukumba()
    if re.search(r'\b(manfaat(nya)?|khasiat(nya)?|buat\s+apa|fungsi(nya)?|kegunaan(nya)?)\b', lower):
        return "Sukumba ini susu kuda Sumbawa herbal, Kak. Biasanya dibantu untuk stamina, badan pegal, dan vitalitas. Kalau boleh tahu, Kakak mau pakai untuk keluhan apa?"
    if re.search(r'\b(bentuk|berupa|pil|kapsul|cair|susu)\b', lower):
        return "Sukumba bentuknya susu bubuk, Kak, bukan pil atau kapsul. Diseduh pakai air hangat lalu diminum sesudah makan."
    return (
        "Sukumba ini susu kuda Sumbawa herbal, Kak. "
        "Biasanya customer pakai untuk bantu stamina, badan pegal, dan vitalitas. "
        "Kakak mau tanya harga, cara minum, atau konsultasi keluhannya dulu?"
    )
