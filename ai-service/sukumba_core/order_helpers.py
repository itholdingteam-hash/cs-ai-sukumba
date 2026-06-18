"""Small order/package helpers shared by routing code."""

import html
import re


def compact_text(raw_text):
    text = html.unescape(str(raw_text or '')).lower().strip()
    text = re.sub(r'\s+', ' ', text)
    return re.sub(r'[.!?]+$', '', text)


def detect_package_choice(raw_text):
    lower = compact_text(raw_text)
    if re.search(r'\b(2|dua)\s*(box|bok|paket)?\b|\b159\b', lower):
        return '2 box', 'Rp 159.000'
    if re.search(r'\b(1|satu)\s*(box|bok|paket)?\b|\b99\b|\byang\s+satu\b|\bsatu\s+aja\b', lower):
        return '1 box', 'Rp 99.000'
    return None, None


def order_prefill_for_choice(raw_text, payment=''):
    package, price = detect_package_choice(raw_text)
    if not package:
        return {}

    quantity = '2' if package == '2 box' else '1'
    payment = (payment or '').upper()
    return {
        'product': f'SUKUMBA {package} - {price}',
        'quantity': quantity,
        'payment': payment,
        'subtotal': price,
    }


def is_package_choice_request(raw_text):
    package, _ = detect_package_choice(raw_text)
    if not package:
        return False

    lower = compact_text(raw_text)
    return bool(re.search(r'\b(yang|ambil|mau|pilih|pesan|order|paket|box|bok|aja|saja|cod|tf|transfer)\b', lower))


def is_package_recommendation_request(raw_text):
    lower = compact_text(raw_text)
    return bool(re.search(
        r'\b('
        r'pilih(?:kan)?\s+paket(?:nya)?|pilihan\s+paket|rekomendasi\s+paket(?:nya)?|'
        r'rekomendasikan\s+paket|saran\s+paket(?:nya)?|'
        r'rekomendasi.{0,30}(ambil|diambil|pilih|dibeli|pesan)|'
        r'(sebaiknya|bagusnya|mending|baiknya).{0,30}(ambil|pilih|pesan|beli)|'
        r'(yang\s+)?bisa\s+diambil|'
        r'paket(?:nya)?\s+(yang\s+)?(pas|cocok|bagus|recommended|rekomendasi)|'
        r'bagusnya\s+(ambil|pilih)\s+(yang\s+)?mana|'
        r'enaknya\s+(ambil|pilih)\s+(yang\s+)?mana|'
        r'ambil\s+paket\s+(yang\s+)?mana|'
        r'diarah(?:kan|in)\s+(ke\s+)?(pilihan\s+)?paket'
        r')\b',
        lower
    ))


def _context_text(profile=None, history=None, raw_text=''):
    parts = [str(raw_text or '')]
    if isinstance(profile, dict):
        for key in (
            'summary', 'complaint', 'consultation_topic', 'consultation_goal',
            'duration', 'diabetes', 'hypertension', 'heart_issue', 'medication',
        ):
            value = profile.get(key)
            if value:
                parts.append(str(value))
    for item in history or []:
        if isinstance(item, dict):
            content = item.get('content')
            if content:
                parts.append(str(content))
    return compact_text(' '.join(parts))


def package_recommendation_reply(raw_text, profile=None, history=None):
    context = _context_text(profile, history, raw_text)
    profile = profile if isinstance(profile, dict) else {}
    risk_values = [
        str(profile.get('diabetes') or '').lower(),
        str(profile.get('hypertension') or '').lower(),
        str(profile.get('heart_issue') or '').lower(),
        str(profile.get('medication') or '').lower(),
    ]
    has_positive_risk = any(value and not re.search(r'\b(tidak|tdk|gak|ga|nggak|ngga|belum|normal|aman)\b', value) for value in risk_values)
    has_unknown_risk_context = (
        not any(risk_values)
        and re.search(r'\b(diabetes|gula\s+darah|tensi|hipertensi|darah\s+tinggi|jantung|obat\s+rutin|obat\s+dokter)\b', context)
    )
    has_risk = has_positive_risk or has_unknown_risk_context
    has_clear_need = re.search(
        r'\b(stamina|vitalitas|loyo|kurang\s+tenaga|pegal|linu|nyeri|capek|lelah|pemulihan|program|keluhan)\b',
        context,
    )
    duration_text = str(profile.get('duration') or '').lower()
    if not duration_text:
        match = re.search(r'\b(\d{1,2})\s*(hari|harian|minggu|mingguan|bulan|bulanan|tahun|tahunan|thn|th)\b', context)
        if match:
            unit = match.group(2)
            duration_text = f"{match.group(1)} {unit}"
    has_short_duration = re.search(r'\b\d{1,2}\s*hari', duration_text)
    has_longer_duration = re.search(r'\b\d{1,2}\s*(minggu|bulan|tahun|thn|th)', duration_text)
    has_strong_program_need = re.search(
        r'\b(vitalitas|loyo|kurang\s+tenaga|pemulihan|program|sudah\s+lama|minggu|bulan|tahun|rutin)\b',
        context,
    ) or has_longer_duration

    if has_risk:
        return (
            "Kalau ada riwayat tensi, diabetes, jantung, atau obat rutin, saya sarankan mulai lebih hati-hati ya Kak.\n\n"
            "Untuk awal bisa ambil 1 box dulu sambil lihat kecocokan tubuh, dan kalau kondisi sedang tidak stabil lebih aman konsultasi tenaga medis dulu."
        )

    if has_strong_program_need:
        return (
            "Kalau untuk program stamina/pemulihan, saya lebih rekomendasikan 2 box, Kak.\n\n"
            "Harganya Rp 159.000, lebih hemat daripada ambil satuan dan stoknya lebih cukup untuk konsumsi rutin. "
            "Kalau Kakak mau coba ringan dulu, 1 box Rp 99.000 juga bisa. Mau saya bantu proses yang 2 box atau coba 1 box dulu?"
        )

    if has_short_duration and has_clear_need:
        return (
            "Kalau keluhannya masih hitungan hari, bisa mulai dari 1 box dulu ya Kak untuk lihat kecocokan tubuh.\n\n"
            "1 box Rp 99.000. Kalau Kakak mau stok lebih hemat untuk konsumsi rutin, 2 box Rp 159.000 juga bisa. "
            "Mau saya bantu proses yang 1 box atau 2 box?"
        )

    if has_clear_need:
        return (
            "Kalau melihat kebutuhan Kakak, paling pas mulai dari 2 box supaya pemakaiannya lebih rutin dan lebih hemat.\n\n"
            "Tapi kalau Kakak baru mau coba dulu, 1 box juga aman untuk awal. Mau saya bantu proses yang 1 box atau 2 box?"
        )

    return (
        "Biar saya rekomendasikan tepat, Kakak mau pakai Sukumba untuk stamina/vitalitas, badan pegal-capek, atau sekadar penjagaan tubuh?\n\n"
        "Patokannya: 1 box cocok untuk coba dulu, 2 box lebih hemat untuk pemakaian rutin."
    )


def package_choice_reply(raw_text, order_form_renderer, default_payment=''):
    package, price = detect_package_choice(raw_text)
    if not package:
        return order_form_renderer("Siap Kak, CS Syifa bantu pemesanan ya. Boleh lengkapi form berikut, termasuk pilihan paket 1 box atau 2 box di bagian keluhan/catatan.")

    lower = compact_text(raw_text)
    payment = default_payment.lower()
    if re.search(r'\b(cod|bayar\s+di\s+tempat)\b', lower) or payment == 'cod':
        return (
            f"Siap Kak, {package} COD ya.\n\n"
            f"Untuk {package} harganya {price}. "
            "Total COD nanti dihitung setelah alamat lengkap karena ongkir menyesuaikan wilayah.\n\n"
            + order_form_renderer("Boleh lengkapi form order berikut ya, Kak.")
        )

    if re.search(r'\b(tf|transfer)\b', lower) or payment in {'tf', 'transfer'}:
        return f"Siap Kak, {package} transfer ya.\n\n{order_form_renderer('Boleh lengkapi form order berikut ya, Kak.')}"

    return (
        f"Siap Kak, ambil {package} ya.\n\n"
        + order_form_renderer("Boleh lengkapi form order berikut ya, Kak. Di bagian pembayaran tinggal isi COD atau TRF.")
    )
