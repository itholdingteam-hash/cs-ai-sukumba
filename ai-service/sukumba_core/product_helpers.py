"""Product-related text classifiers."""

import html
import re


def normalize_text(raw_text):
    return html.unescape(str(raw_text or '')).lower().strip()


def is_product_question(raw_text):
    lower = normalize_text(raw_text)
    return bool(re.search(
        r'\b(jualan|produk|jual\s+apa|menjual|harga|harganya|khasiat(nya)?|manfaat(nya)?|fungsi(nya)?|kegunaan(nya)?|kandungan|cara\s+minum|aturan\s+minum|dosis|promo|ongkir|cod|sukumba|isi|netto|berat|gram|gr|sachet|bungkus|box)\b',
        lower
    ))


def is_product_packaging_question(raw_text):
    lower = normalize_text(raw_text)
    return bool(re.search(
        r'\b(isi|netto|berat|gram|gr|berapa\s+gram|sachet|bungkus|takaran)\b|\b(1|satu)\s*box\b.*\b(berapa|isi|gram|gr|netto|berat)\b',
        lower
    ))


def is_consumption_question(raw_text):
    lower = normalize_text(raw_text)
    return bool(re.search(
        r'\b(cara\s+(minum|konsumsi|pakai|seduh)(nya)?|'
        r'(minum|konsumsi|pakai|seduh)(nya)?\s+(gimana|bagaimana|gmn|gmna|caranya|cara|bagaimananya)|'
        r'cara\s+penyajian|penyajian(nya)?|sajikan|diseduh|'
        r'berapa\s+(sendok|takaran)|takaran(nya)?)\b',
        lower
    ))


def is_dosage_question(raw_text):
    lower = normalize_text(raw_text)
    return bool(re.search(
        r'\b(aturan\s+(minum|pakai|konsumsi)(nya)?|'
        r'dosis(nya)?|'
        r'(minum|konsumsi)(nya)?\s+(berapa\s+kali|sehari\s+berapa|berapa\s+hari|kapan)|'
        r'berapa\s+kali\s+(minum|konsumsi)|'
        r'kapan\s+(minum|konsumsi)(nya)?)\b',
        lower
    ))
