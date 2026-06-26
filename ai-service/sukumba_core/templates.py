"""Fallback CS Syifa message templates.

Dynamic templates from the admin panel still take precedence in ai_service_v2.py.
This module only stores stable fallback copy so routing code does not have to
own long message bodies.
"""

import re


def greeting(raw_text, greeting_label):
    greeting_label = (greeting_label or "Halo").strip()
    if greeting_label.lower() == "halo":
        opening = "Halo Kak, dengan CS Syifa ya."
    else:
        opening = f"{greeting_label} Kak, dengan CS Syifa ya."

    return (
        f"{opening}\n\n"
        "Kakak mau tanya promo Sukumba, info produk, atau konsultasi keluhan dulu?"
    )


def ask_complaint_general():
    return (
        "Kalau boleh tahu keluhan yang Kakak rasakan lebih ke mana ya?\n\n"
        "Apakah untuk bantu stamina yang mudah drop, badan pegal/linu, atau vitalitas pria? "
        "Boleh sekalian info usia Kakak dan keluhan ini sudah berapa lama, supaya CS Syifa bisa arahkan lebih pas."
    )


def known_general_complaint():
    return (
        "Baik Kak, pegal/linu memang bisa mengganggu aktivitas ya.\n\n"
        "Usia Kakak berapa, dan keluhan pegalnya sudah berapa lama?"
    )


def ask_complaint_male_vitality():
    return (
        "Kalau boleh tahu keluhan yang Kakak rasakan lebih ke stamina mudah drop, badan pegal/linu, atau vitalitas pria ya?\n\n"
        "Boleh info usia Kakak dan keluhan ini sudah berapa lama, supaya CS Syifa bisa bantu arahkan dengan lebih pas."
    )


def promo_sukumba():
    return (
        "SPESIAL HARGA PROMO SUSU SUKUMBA \U0001f970\n\n"
        "\U0001f95b Harga Rp 99.000 >> 1 box SUSU SUKUMBA\n"
        "\U0001f95b Harga Rp 159.000 >> 2 box SUSU SUKUMBA\n\n"
        "Silakan Kakak, ambil promonya sekarang jugaa \U0001f973\n"
        "Mau ambil paket yang mana nih Kak? \U0001f60d"
    )


def cara_konsumsi():
    return (
        "Berikut untuk cara konsumsi SUKUMBA ya Kak \U0001f60a\n\n"
        "- Larutkan sekitar 2-3 sendok makan ke dalam 150-200 ml air hangat.\n"
        "- Aduk hingga rata.\n"
        "- Minum 1-2 kali sehari, pagi dan malam hari.\n"
        "- Hindari menggunakan air yang terlalu panas agar kandungan nutrisinya tetap terjaga."
    )


def aturan_minum():
    return (
        "Berikut untuk aturan minum SUKUMBA ya Kak \U0001f60a\n\n"
        "Pemulihan: 2 x 2 sendok makan per hari, sesudah makan.\n\n"
        "Penjagaan: 1 x 2 sendok makan per hari.\n\n"
        "Jika sedang minum obat dokter, beri jeda 1-2 jam ya Kak."
    )


def minimum_age():
    return "Mulai dari umur 12 tahun, Kak."


def manfaat_sukumba():
    return (
        "Boleh Kak, ini manfaat SUKUMBA untuk kesehatan sendi ya.\n\n"
        "- Membantu mendukung kesehatan tulang dan sendi\n"
        "- Membantu tubuh terasa lebih bugar untuk aktivitas harian\n"
        "- Membantu support pemulihan tubuh setelah lelah beraktivitas\n"
        "- Membantu menjaga stamina dan vitalitas secara natural\n\n"
    )


def side_effects():
    return (
        "Untuk produk kami aman dan sudah BPOM, Kak.\n\n"
        "Secara umum susu kuda aman dan jarang memicu alergi.\n\n"
        "Namun, karena ada kandungan gula alami/laktosa dan karbohidrat, penderita diabetes "
        "atau Kakak yang sedang membatasi asupan kalori disarankan untuk mengatur porsinya ya."
    )


def sukumba_difference():
    return (
        "SUKUMBA beda dari yang lain karena:\n\n"
        "- Teksturnya lebih ringan\n"
        "- Tidak bau prengus\n"
        "- Kombinasi rempahnya berasa"
    )


def ask_ever_consumed():
    return "Btw sebelumnya apakah Kakak sudah pernah konsumsi Susu SUKUMBA, Kak?"


def order_form(intro=None):
    opening = intro or "Baik Kak, untuk order silakan lengkapi datanya ya."
    return (
        f"{opening}\n\n"
        "Nama:\n"
        "Alamat lengkap (nama jalan, No. rumah, patokan):\n"
        "RT/RW:\n"
        "Kelurahan:\n"
        "Kecamatan:\n"
        "Kabupaten/Kota:\n"
        "Provinsi:\n"
        "Usia:\n"
        "Keluhan/sakit yang dirasakan:\n"
        "Paket (1 box/2 box):\n"
        "No. Hp:\n\n"
        "TF/COD:\n\n"
        "Terima kasih."
    )


def transfer_info():
    return (
        "BCA a.n. ARYANNA HASNA KHUMAIRA\n"
        "0463343991\n\n"
        "Kalau sudah transfer, sertakan bukti transaksinya di sini ya Kak.\n"
        "Kira-kira mau TF jam berapa ya Kak?"
    )


def cod_1_box():
    return (
        "Siap Kak, 1 box SUKUMBA COD ya.\n\n"
        "Harga Rp 99.000\n"
        "Ongkir menyesuaikan alamat tujuan\n\n"
        "Totalnya dihitung setelah alamat lengkap, nanti dibayarkan saat paket sampai lewat JNE REG.\n\n"
        + order_form("Boleh lengkapi form order berikut ya, Kak.")
    )


def empathy_reply():
    return (
        "Baik Kak, saya bisa memahami keluhan yang Kakak alami.\n\n"
        "Saya doakan semoga ini bisa menjadi ikhtiar yang baik dan cocok untuk membantu kondisi Kakak yaa\U0001f932"
    )


def order_success():
    return (
        "Terima kasih sudah order, Kak. Pesanan langsung kami proses yaa \U0001f60a\n\n"
        "1. Harap lakukan pembayaran sebelum paket dibuka sesuai peraturan ekspedisi.\n"
        "2. Video saat Kakak buka paket untuk klaim garansi jika toko kami salah kirim produk. Video buka paket wajib ada ya Kak.\n"
        "3. Resi akan dikirim H+3 setelah melakukan pemesanan.\n"
        "4. Orderan tidak bisa dibatalkan karena telah ada akad jual-beli.\n"
        "5. Estimasi sampai 4-7 hari.\n"
        "6. Resi akan dikirim oleh CS Syifa.\n"
        "7. Dapatkan harga lebih murah setelah Kakak menerima paket pertama ini ya.\n\n"
        "Tidak perlu khawatir belanja di toko kami. Kami berjualan sudah dari tahun 2019 dan Alhamdulillah selalu amanah \U0001f495\n\n"
        "Terima kasih Kakak. Sehat selalu dan semoga dilimpahkan rezekinya."
    )


def bpom_safe():
    return (
        "SUKUMBA sudah terdaftar BPOM ya Kak.\n\n"
        "Produk kami sudah terdaftar BPOM RI MD 071182004300360.\n"
        "SUKUMBA dibuat dari bahan pangan/herbal dan dikonsumsi sesuai aturan minum. "
        "Kalau Kakak punya riwayat penyakit atau sedang minum obat dokter, lebih aman konsultasi dulu ke tenaga medis."
    )


def health_risk_warning():
    return (
        "SUKUMBA sudah terdaftar BPOM, Kak. Tapi kalau Kakak punya riwayat tensi tinggi, diabetes, jantung, "
        "atau sedang minum obat rutin dari dokter, sebaiknya lebih hati-hati ya.\n\n"
        "Beri jeda 1-2 jam dari obat dokter, dan kalau kondisi sedang tidak stabil lebih aman konsultasi dulu ke tenaga medis."
    )


def halal_info():
    return (
        "InsyaAllah aman dan nyaman dikonsumsi ya Kak.\n\n"
        "SUKUMBA dibuat dari bahan pangan seperti susu kuda Sumbawa, krimer nabati, padatan susu, dan ekstrak herbal. "
        "Produknya juga sudah terdaftar BPOM RI MD 071182004300360.\n\n"
        "Kalau Kakak ingin lebih yakin, CS Syifa bisa bantu kirimkan foto label kemasan/izin produk yang tersedia. "
        "Kakak mau sekalian saya bantu pilihkan paket promonya?"
    )


def diabetes_warning():
    return (
        "SUKUMBA sudah BPOM, Kak, tapi kalau Kakak punya diabetes sebaiknya tetap lebih hati-hati.\n\n"
        "Karena ada kandungan gula alami/laktosa dan karbohidrat, porsinya perlu diatur dan lebih aman konsultasi dulu ke tenaga medis kalau gula darah sedang tidak stabil atau sedang minum obat rutin \U0001f60a"
    )


def komposisi():
    return (
        "Berikut untuk KOMPOSISI SUKUMBA ya Kak \U0001f60d\n\n"
        "- Susu Kuda Sumbawa\n"
        "- Krimer Nabati\n"
        "- Padatan Susu\n"
        "- Ekstrak Jahe\n"
        "- Ekstrak Sereh\n"
        "- Ekstrak Kayu Manis\n"
        "- Ekstrak Kunyit"
    )


def isi_box(gram):
    gram = str(gram or '').strip()
    if gram:
        gram_text = gram if re.search(r'\b(gr|gram)\b', gram, re.IGNORECASE) else f"{gram} gram"
        return f"Isi 1 box SUKUMBA {gram_text}, Kak. Aturan minumnya 2 x 2 sendok makan per hari sesudah makan untuk pemulihan."
    return (
        "Untuk isi/berat per box SUKUMBA, data gramnya belum tercantum di sistem saya, Kak. "
        "Supaya tidak salah info, saya cekkan dulu ke admin ya."
    )


def estimasi_pengiriman():
    return (
        "Untuk pengiriman biasanya memakai JNE REG ya Kak, estimasi sampai sekitar 4-7 hari kerja setelah paket diproses.\n\n"
        "Kalau Kakak ingin cek ongkir, boleh kirim kecamatan, kabupaten/kota, dan provinsinya dulu ya."
    )


def ongkir_info():
    return (
        "Ongkir menyesuaikan alamat tujuan, jadi supaya tidak salah hitung boleh kirim kecamatan, kabupaten/kota, dan provinsi Kakak dulu ya. "
        "Nanti CS Syifa bantu cek total produk + ongkirnya."
    )


def kurir_info():
    return "Untuk pengiriman kami biasanya memakai JNE REG."


def kurir_ongkir():
    return ongkir_info()


def testimoni_offer():
    return (
        "Boleh Kak, saya kirimkan testimoni customer SUKUMBA ya.\n\n"
        "Kalau Kakak mau, setelah itu saya bantu jelaskan manfaat atau aturan minumnya."
    )


def ongkir_calculated(destination, shipping_cost_label, estimated_days=''):
    """Template ketika ongkir berhasil dihitung dari alamat tujuan."""
    estimasi = f"\nEstimasi sampai: {estimated_days}" if estimated_days else ""
    return (
        f"Ongkir ke {destination} via JNE REG: {shipping_cost_label}{estimasi}\n\n"
        "\U0001f95b 1 box Rp 99.000 + ongkir = total dibayar saat paket sampai\n"
        "\U0001f95b 2 box Rp 159.000 + ongkir = lebih hemat untuk konsumsi rutin\n\n"
        "Mau ambil paket yang mana, Kak? Nanti CS Syifa bantu proses ordernya \U0001f60a"
    )


def ongkir_not_found(destination=''):
    """Template ketika ongkir untuk wilayah tertentu belum tersedia."""
    loc = f" ke {destination}" if destination else ""
    return (
        f"Mohon maaf Kak, tarif ongkir{loc} belum tersedia di sistem CS Syifa.\n\n"
        "Supaya bisa CS Syifa bantu cek manual, boleh kirim data berikut ya:\n"
        "- Kecamatan\n"
        "- Kabupaten/Kota\n"
        "- Provinsi\n\n"
        "Nanti CS Syifa konfirmasi total produk + ongkirnya."
    )
