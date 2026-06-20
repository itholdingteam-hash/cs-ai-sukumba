// ================================================================
// STATE
// ================================================================
var chatHistory = [];
var qrInterval = null;
var waStatusLoading = false;
var waStatusBackoffUntil = 0;

var pageTitles = {
  whatsapp: ["WhatsApp","Kelola koneksi WhatsApp"],
  products: ["Produk","Basis pengetahuan produk untuk CS AI"],
  faqs:     ["FAQ","Jawaban cepat untuk pertanyaan pelanggan"],
  testimonials: ["Testimoni","Kelola foto dan video bukti customer"],
  "cs-templates": ["Template CS","Kelola template pesan cepat (canned responses)"],
  test:     ["Uji AI","Simulasikan percakapan dengan agen AI"],
  prompt:   ["Prompt Agen","Atur perilaku setiap agen AI"],
  orders:   ["Pesanan","Kelola pesanan pelanggan"],
  finance:  ["Pembayaran","Validasi bukti pembayaran customer"],
  shipping: ["Ongkir","Kelola biaya kirim per wilayah"],
  logs:     ["Analitik","Statistik dan riwayat percakapan"],
  "system-ai": ["Sistem AI","Memory, learning, skill, review, scoring, handoff, dan training inbox"],
  settings: ["Pengaturan","Konfigurasi sistem dan integrasi"]
};
