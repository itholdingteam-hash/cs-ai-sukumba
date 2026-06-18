"""Regex and keyword groups used by the chat router."""

MALE_HEALTH_PATTERNS = [
    r'\bburung\b', r'\bmr\.?\s*p\b', r'\balat\s+vital\b', r'\bkejantanan\b',
    r'\bkekuatan\s+pria\b', r'\btenaga\s+pria\b', r'\bperforma\s+pria\b',
    r'\bereksi\b', r'\bkurang\s+keras\b', r'\btidak\s+keras\b', r'\bgak\s+keras\b',
    r'\bloyo\b', r'\bletoy\b', r'\blemes\b', r'\bstamina\s+(pria|ranjang|hubungan)\b',
    r'\bvitalitas\b', r'\bgairah\b', r'\blibido\b', r'\bcepat\s+keluar\b',
    r'\bcepet\s+keluar\b', r'\bejakulasi\b', r'\btahan\s+lama\b',
    r'\bhubungan\s+(suami\s+istri|intim)\b', r'\branjang\b',
    r'\bgreng\b', r'\bjoss\b', r'\bjos\b', r'\bperkasa\b',
    r'\bfit\s+lagi\b', r'\bkembali\s+fit\b',
]

GENERAL_HEALTH_PATTERNS = [
    r'\bmual\b', r'\bpusing\b', r'\bsakit\s+kepala\b', r'\bbegadang\b',
    r'\bkurang\s+tidur\b', r'\bsusah\s+tidur\b', r'\btensi\b',
    r'\bhipertensi\b', r'\bdarah\s+tinggi\b', r'\blelah\b', r'\bcapek\b',
    r'\bkurang\s+tenaga\b',
]

MALE_VITALITY_TERMS = [
    'burung', 'mr p', 'alat vital', 'kejantanan', 'kekuatan pria',
    'tenaga pria', 'performa pria', 'ereksi', 'kurang keras',
    'gak keras', 'tidak keras', 'loyo', 'letoy', 'vitalitas', 'gairah',
    'libido', 'cepat keluar', 'cepet keluar', 'ejakulasi', 'tahan lama',
    'ranjang', 'greng', 'joss', 'jos', 'perkasa'
]

SHORT_CONFIRM_WORDS = {'ya', 'iya', 'ok', 'oke', 'baik', 'siap', 'sip', 'boleh', 'lanjut'}
SHORT_REACTION_WORDS = {'oiya', 'oh ya', 'oh', 'ooh', 'serius', 'masa', 'bener', 'kok gitu', 'gimana', 'maksudnya', 'terus'}
CONSULT_QUESTION_IDS = {'ask_complaint', 'ask_age_duration', 'ask_risk_factors', 'ask_lifestyle', 'ask_bp'}

CONSULTATION_PATTERNS = [
    r'\bkonsultasi\b', r'\bconsul\b', r'\bkonsul\b', r'\bkonsult\b', r'\bkosult\b', r'\bmau\s+tanya\b',
    r'\bboleh\s+tanya\b', r'\bmau\s+cerita\b', r'\bcurhat\b',
    r'\bada\s+keluhan\b', r'\bkeluhan\b',
]

ORDER_PATTERNS = [
    r'\bmau\s+(beli|pesan|pesen|order)\b', r'\bjadi\s+(beli|pesan|pesen|order)\b',
    r'\blangsung\s+(beli|pesan|pesen|order|checkout|co)\b',
    r'\bambil\s+\d+\s*(box|botol|pcs)?\b', r'\border\s+sekarang\b',
    r'\bcara\s+(beli|pesan|pesen|order|pemesanan)\b',
    r'\b(beli|pesan|pesen|order|pemesanan)\s+(gimana|bagaimana|gmn|gmna|caranya)\b',
]

RED_FLAG_PATTERNS = [
    r'nyeri\s+dada', r'sakit\s+dada', r'obat\s+jantung', r'nitrat', r'isosorbid',
    r'ereksi[^.?!]{0,40}(4|empat)\s+jam', r'jantung\s+koroner',
    r'stroke', r'pingsan', r'sesak\s+napas', r'nyeri\s+berat',
]
