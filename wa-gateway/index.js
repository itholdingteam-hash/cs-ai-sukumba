/**
 * Sukumba WA Gateway - Refactored
 * Fitur: Secure + Session Cleanup + Env Vars
 * 
 * Deploy:
 *   1. cp .env /home/tunet/wa-gateway/.env
 *   2. npm install dotenv axios
 *   3. node index.js
 */

require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const bodyParser = require('body-parser');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// ------------------------------------------------------------------
// 0. ENVIRONMENT CONFIG
// ------------------------------------------------------------------
const PORT        = process.env.WA_GATEWAY_PORT || 3000;
const ADMIN_URL   = process.env.ADMIN_URL    || 'http://172.31.6.3:5001';
const AI_URL      = process.env.AI_URL       || 'http://172.31.6.3:5000';
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY) || 12;
const ADMIN_WA    = process.env.ADMIN_WA     || '6281770680481';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

// Axios defaults
const axiosConfig = {
  timeout: 10000,
  headers: INTERNAL_API_KEY ? { 'X-Internal-Key': INTERNAL_API_KEY } : {}
};

// ------------------------------------------------------------------
// 1. LOGGING
// ------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const LOG_FILE = path.join(__dirname, 'wa-gateway.log');

function log(level, message) {
  const timestamp = new Date().toISOString().replace('T',' ').substring(0,19);
  const line = `[${timestamp}] [${level}] ${message}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch(e) {}
}

function summarizeBaileysError(err) {
  if (!err) return 'no_error_payload';
  const output = err.output || {};
  const payload = output.payload || {};
  const parts = [
    `name=${err.name || '-'}`,
    `message=${err.message || '-'}`,
    `statusCode=${output.statusCode || err.statusCode || '-'}`,
    `payloadStatus=${payload.statusCode || '-'}`,
    `payloadError=${payload.error || '-'}`,
    `payloadMessage=${payload.message || '-'}`
  ];
  if (err.data) {
    try { parts.push(`data=${JSON.stringify(err.data).substring(0,300)}`); } catch(e) {}
  }
  if (err.stack) parts.push(`stack=${String(err.stack).split('\n')[0]}`);
  return parts.join(' | ');
}

// ------------------------------------------------------------------
// 2. STATE
// ------------------------------------------------------------------
let sock, isReady = false, lastQR = null, waStatus = 'disconnected';
let waStatusDetail = '';
let waStatusUpdatedAt = new Date().toISOString();
let lastDisconnectCode = null;
let connectionGeneration = 0;
let reconnectTimer = null;
let readyTimer = null;
let lastQRLogAt = 0;
const orderSessions = {};
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 menit
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

function setWAStatus(status, detail = '') {
  waStatus = status;
  waStatusDetail = detail;
  waStatusUpdatedAt = new Date().toISOString();
}

function clearConnectionTimers() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (readyTimer) {
    clearTimeout(readyTimer);
    readyTimer = null;
  }
}

function stopCurrentSocket() {
  const oldSock = sock;
  sock = null;
  isReady = false;
  if (!oldSock) return;
  try { oldSock.ev?.removeAllListeners?.('messages.upsert'); } catch(e) {}
  try { oldSock.ev?.removeAllListeners?.('connection.update'); } catch(e) {}
  try { oldSock.ev?.removeAllListeners?.('creds.update'); } catch(e) {}
  try { oldSock.ws?.close?.(); } catch(e) {}
  try { oldSock.end?.(); } catch(e) {}
}

function resetAuthDir() {
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    for (const entry of fs.readdirSync(AUTH_DIR)) {
      fs.rmSync(path.join(AUTH_DIR, entry), { recursive: true, force: true });
    }
    log('INFO', 'WA auth dir cleared');
  } catch(e) {
    log('ERROR', `Failed to reset WA auth dir: ${e.message}`);
  }
}

function scheduleReconnect(delayMs = 5000) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToWhatsApp();
  }, delayMs);
}

// ------------------------------------------------------------------
// 3. SESSION CLEANUP
// ------------------------------------------------------------------
function cleanupSessions() {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, val] of Object.entries(orderSessions)) {
    if (now - (val.lastActivity || 0) > SESSION_TTL_MS) {
      delete orderSessions[key];
      cleaned++;
    }
  }
  if (cleaned > 0) log('INFO', `Cleaned ${cleaned} expired sessions`);
}

// Jalankan cleanup setiap 5 menit
setInterval(cleanupSessions, 5 * 60 * 1000);

// ------------------------------------------------------------------
// 4. HELPERS
// ------------------------------------------------------------------
function cleanNumber(jid) {
  return jid.replace('@s.whatsapp.net','').replace('@lid','');
}

function normalizePhoneNumber(text) {
  const digits = (text || '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return '';
  if (digits.startsWith('0')) return '62' + digits.slice(1);
  if (digits.startsWith('8')) return '62' + digits;
  if (digits.startsWith('62')) return digits;
  return digits;
}

function parseOrderIdentity(text) {
  const raw = (text || '').trim();
  const phone = normalizePhoneNumber(raw);
  let name = raw
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '')
    .replace(/\b(nama|penerima|hp|wa|nomor|no)\b/gi, '')
    .replace(/[,:;-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/\b(saya|aku)\s+sendiri\b|\bsendiri\s*(aja)?\b/i.test(name)) name = '';
  if (!/^[a-zA-Z\s.'-]{2,40}$/.test(name)) name = '';
  if (/^(kak|saya|aku|nama|penerima)$/i.test(name)) name = '';
  return { name, phone };
}

function cleanDisplayName(name) {
  let cleaned = String(name || '')
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-zA-Z\s.'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length < 2 || cleaned.length > 40) return '';
  if (/^(kak|admin|customer|user|wa)$/i.test(cleaned)) return '';
  return cleaned.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function isAlreadyProvidedReply(text) {
  return /\b(udah|sudah|tadi|kan tadi|sudah juga|udah juga)\b/i.test(text || '');
}

function isSelfRecipientReply(text) {
  return /\b(saya|aku)\s+sendiri\b|\bsendiri\s*(aja)?\b/i.test(text || '');
}

function parseQuantity(text) {
  const match = String(text || '').match(/\b(\d{1,3})\b/);
  if (!match) return 0;
  const qty = parseInt(match[1], 10);
  return qty >= 1 && qty <= 100 ? qty : 0;
}

function isDirectCustomerJid(jid) {
  if (!jid || jid === 'status@broadcast') return false;
  if (jid.includes('@g.us') || jid.includes('@newsletter') || jid.includes('@broadcast')) return false;
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
}

async function notifAdminEskalasi(from, userName, userMessage) {
  try {
    if (!sock || !isReady) return;
    await sock.sendMessage(ADMIN_WA + '@s.whatsapp.net', {
      text: `🚨 *ESKALASI CS AI*\n\n👤 Customer: ${userName}\n📱 Nomor: ${cleanNumber(from)}\n💬 Pesan: "${userMessage.substring(0,200)}"\n\n⚠️ Customer membutuhkan bantuan CS manusia!`
    });
    log('INFO', `Eskalasi notif sent to admin for ${cleanNumber(from)}`);
  } catch(e) { log('ERROR', `Notif eskalasi gagal: ${e.message}`); }
}

async function getHistory(userNumber) {
  try {
    const res = await axios.get(`${ADMIN_URL}/api/conversation/history/${userNumber}?limit=${MAX_HISTORY}`, axiosConfig);
    return res.data;
  } catch(e) { return []; }
}

async function saveHistory(userNumber, role, content) {
  try {
    await axios.post(`${ADMIN_URL}/api/conversation/history`, {
      user_number: userNumber, role, content,
      timestamp: new Date().toISOString().replace('T',' ').substring(0,19)
    }, axiosConfig);
  } catch(e) {}
}

async function sendTextAndRemember(sock, from, senderNumber, text) {
  await sock.sendMessage(from, { text });
  await saveHistory(senderNumber, 'assistant', text);
}

async function getProfile(userNumber) {
  try {
    const res = await axios.get(`${ADMIN_URL}/api/customer-profile/${userNumber}`, axiosConfig);
    const data = res.data || {};
    return { ...(data.profile || {}), summary: data.summary || '', updated_at: data.updated_at || '' };
  } catch(e) { return {}; }
}

async function saveProfile(userNumber, profileUpdates, summary) {
  const hasUpdates = profileUpdates && Object.keys(profileUpdates).length > 0;
  const hasSummary = typeof summary === 'string' && summary.trim().length > 0;
  if (!hasUpdates && !hasSummary) return;
  try {
    const payload = {};
    if (hasUpdates) payload.profile_updates = profileUpdates;
    if (hasSummary) payload.summary = summary;
    await axios.post(`${ADMIN_URL}/api/customer-profile/${userNumber}`, payload, axiosConfig);
  } catch(e) {}
}

// ------------------------------------------------------------------
// 5. INTENT DETECTION
// ------------------------------------------------------------------
const ORDER_KEYWORDS = ['mau beli','mau pesan','mau pesen','mau order','ingin beli','ingin pesan','pengen beli','pengen pesan','saya beli','saya pesan','aku pesan','aku beli','ak mau','pesan sekarang','beli sekarang','order sekarang','pesan dong','beli dong','order dong','pesan deh','beli deh','mo beli','mo pesan','mo pesen','mo order','gas pesan','gas beli','tertarik beli','mau cobain','cara beli','cara pesan','cara pesen','cara order','cara pemesanan','langsung beli','langsung pesan','langsung pesen','langsung order','langsung checkout','langsung co'];
const ORDER_STATUS_KEYWORDS = ['nomor resi','resi','status pesanan','pesanan saya','order saya','cek pesanan','sudah pesan','udah pesan','tracking'];
const CANCEL_KEYWORDS = ['gak jadi','ga jadi','tidak jadi','batalkan','cancel'];
const MALE_HEALTH_KEYWORDS = ['burung','mr p','alat vital','ereksi','kurang keras','gak keras','ga keras','tidak keras','loyo','letoy','stamina pria','stamina ranjang','vitalitas','gairah','libido','cepat keluar','cepet keluar','ejakulasi','tahan lama','hubungan suami istri','hubungan intim','ranjang'];

function hasMaleHealthContext(text) {
  const lower = text.toLowerCase();
  return MALE_HEALTH_KEYWORDS.some(kw => lower.includes(kw));
}

function isExplicitOrderRequest(text) {
  const lower = text.toLowerCase().trim();
  return /(\bmau\b|\bmo\b|\bingin\b|\bpengen\b|\bjadi\b|\blanjut\b|\bgas\b)\s+(beli|pesan|pesen|order)\b/i.test(lower)
    || /\blangsung\s+(beli|pesan|pesen|order|checkout|co)\b/i.test(lower)
    || /\b(order|pesan|beli)\s+sekarang\b/i.test(lower)
    || /\bcara\s+(beli|pesan|pesen|order|pemesanan)\b/i.test(lower)
    || /\b(beli|pesan|pesen|order|pemesanan)\s+(gimana|bagaimana|gmn|gmna|caranya)\b/i.test(lower)
    || /\bambil\s+\d+\s*(box|botol|pcs)?\b/i.test(lower)
    || /\b(cod|transfer|tf)\b.*\b(bisa|mau|order|pesan|beli)\b/i.test(lower);
}

function isShortProductRequest(text) {
  const lower = String(text || '').toLowerCase().trim().replace(/[.!?]+$/g, '');
  return ['info','info deh','info dong','info kak','produk','produk kak','info produk','tanya produk','jelasin','jelaskan'].includes(lower);
}

function isShortPurchaseRequest(text) {
  const lower = String(text || '').toLowerCase().trim().replace(/[.!?]+$/g, '');
  return ['pesan','pesen','order','beli','mau pesan','mau pesen','mau order','mau beli','lanjut pesan','lanjut order'].includes(lower);
}

function lastAssistantHasProductContext(history = []) {
  const lastAI = [...history].reverse().find(h => h.role === 'assistant');
  return !!(lastAI && /sukumba|susu\s+kuda|info\s+manfaat|cara\s+minum|vitalitas|stamina|produk/i.test(lastAI.content || ''));
}

function hasPostOrderContext(history = [], profile = {}) {
  if (profile && profile.active_flow === 'post_order') return true;
  const lastAI = [...history].reverse().find(h => h.role === 'assistant');
  return !!(lastAI && /pesanan\s+berhasil\s+diterima|terima\s+kasih\s+telah\s+memesan|order\s+id\s*:\s*#?\d+/i.test(lastAI.content || ''));
}

function localSafeFallbackReply(text, history = [], profile = {}) {
  const lower = String(text || '').toLowerCase().trim();
  if (hasPostOrderContext(history, profile) && /^(ok|oke|baik|siap|iya|ya|sip|noted)[.!?]*$/i.test(lower)) {
    return 'Siap Kak, terima kasih. Tim kami akan segera menghubungi untuk pesanan Kakak.';
  }
  if (isShortProductRequest(lower)) {
    return 'Sukumba adalah susu kuda Sumbawa/herbal untuk membantu stamina, energi, daya tahan tubuh, dan vitalitas, Kak. Diminum 2x sehari sesudah makan. Kakak mau info manfaat, cara minum, atau konsultasi dulu?';
  }
  if (isShortPurchaseRequest(lower) && (lastAssistantHasProductContext(history) || (profile && profile.active_flow === 'product') || hasPostOrderContext(history, profile))) {
    return 'Bisa Kak. Kalau mau beli Sukumba, saya bantu pemesanan pelan-pelan. Boleh nama penerima dulu?';
  }
  if (/^(halo|hai|hallo|helo|hello|pagi|siang|sore|malam|selamat\s+(pagi|siang|sore|malam))(\s+kak)?[.!?]*$/i.test(lower)) {
    return 'Halo Kak, selamat datang di Sukumba. Bisa saya bantu info produk atau konsultasi dulu?';
  }
  if (/\b(nama\s+kamu\s+siapa|kamu\s+siapa|ini\s+siapa|dengan\s+siapa|admin\s+siapa|cs\s+siapa|bot\s+apa)\b/i.test(lower)) {
    if (/\b(konsultasi|konsul|consult|consul)\b/i.test(lower)) {
      return 'Saya CS Sukumba, Kak. Boleh, ceritain pelan-pelan dulu keluhan atau tujuan konsultasinya apa?';
    }
    return 'Saya CS Sukumba, Kak. Saya bantu info produk dan konsultasi seputar stamina/kesehatan pria dengan bahasa yang tetap nyaman.';
  }
  if (/\b(jualan|produk|jual\s+apa|menjual|harga|harganya|khasiat|manfaat|kandungan|cara\s+minum|aturan\s+minum|dosis|promo|ongkir|cod|sukumba|info\s+produk)\b/i.test(lower)) {
    if (/\b(cara\s+minum|aturan\s+minum|dosis|minum|konsumsi)\b/i.test(lower)) {
      return 'Sukumba diminum 2x sehari sesudah makan, Kak. Bentuknya susu kuda Sumbawa/herbal, sebagai support stamina dan kondisi tubuh.';
    }
    if (/\b(harga|harganya|berapa|promo|ongkir|cod|paket)\b/i.test(lower)) {
      return 'Untuk harga dan promo Sukumba bisa tergantung paket aktif, Kak. Biasanya ada promo seperti gratis ongkir, free konsultasi, atau bonus.';
    }
    return 'Sukumba adalah susu kuda Sumbawa/herbal untuk membantu stamina, energi, daya tahan tubuh, dan vitalitas, Kak. Diminum 2x sehari sesudah makan. Kakak mau info manfaat, cara minum, atau konsultasi dulu?';
  }
  if (/\bcara\s+(beli|pesan|pesen|order|pemesanan)\b|\b(beli|pesan|pesen|order|pemesanan)\s+(gimana|bagaimana|gmn|gmna|caranya)\b/i.test(lower)) {
    return 'Bisa Kak. Kalau mau beli Sukumba, saya bantu pemesanan pelan-pelan. Boleh nama penerima dulu?';
  }
  if (/\b(konsultasi|konsul|consult|consul|keluhan|stamina|burung|ereksi|loyo|vitalitas|cepat keluar|ejakulasi)\b/i.test(lower)) {
    if (/\b(burung|ereksi|loyo|vitalitas|cepat keluar|ejakulasi|greng|joss|jos)\b/i.test(lower)) {
      return 'Saya pahami Kak, vitalitas pria terasa kurang maksimal. Usia Kakak berapa, dan keluhan ini sudah berapa lama?';
    }
    return 'Boleh Kak, ceritain pelan-pelan dulu keluhan atau tujuan konsultasinya apa? Nanti saya arahkan dari kondisinya.';
  }
  if (isExplicitOrderRequest(lower)) {
    return profile && profile.name
      ? `Siap ${profile.name}, saya bantu pemesanan. Boleh nomor HP yang bisa dihubungi?`
      : 'Siap Kak, saya bantu pemesanan. Boleh nama penerima dulu?';
  }
  return 'Maaf Kak, koneksi sistem sedang kurang stabil. Tapi saya tetap bantu: mau info produk Sukumba atau konsultasi dulu?';
}

function isOfferAcceptance(text, history) {
  const lower = text.toLowerCase().trim().replace(/[.!?]+$/g, '');
  const accepted = ['ok coba','oke coba','iya coba','ya coba','boleh coba','saya coba','coba kak','coba dulu','boleh','ok','oke','ya','iya'].includes(lower)
    || /\b(coba|boleh|ok|oke|iya|ya)\b.*\b(sukumba|produk|paket)\b/i.test(lower);
  if (!accepted) return false;
  const lastAI = [...history].reverse().find(h => h.role === 'assistant');
  return !!(lastAI && /ingin mencoba|mau mencoba|coba sukumba|mencoba sukumba|mulai dari|paket|program|order|pesan|produk kami/i.test(lastAI.content || ''));
}

function hasMaleHealthConsultationContext(history, profile) {
  if (profile && profile.active_flow === 'consultation') return true;
  if (profile && profile.conversation_mode === 'consultation' && /^ask_(complaint|age_duration|risk_factors|lifestyle|bp)$/.test(profile.last_question_id || '')) return true;
  if (profile && (profile.complaint || profile.complaint_detail || profile.duration)) return true;
  if (profile && /vitalitas|ereksi|stamina pria|stamina hubungan|keluhan|diabetes|tensi|jantung|rokok|stres|konsultasi/i.test(profile.summary || '')) return true;
  return history.slice(-8).some(h =>
    h.role === 'assistant' &&
    /vitalitas|ereksi|stamina hubungan|keluhan|usia kak|diabetes|tensi|jantung|pola tidur|rokok|stres|konsultasi/i.test(h.content || '')
  );
}

function shouldStartOrderFlow(text, history, profile) {
  const lastAI = [...history].reverse().find(h => h.role === 'assistant');
  const aiAskedOrderData = lastAI && /nama lengkap|nama penerima|nomor hp|alamat lengkap|data order|data pesanan/i.test(lastAI.content || '');
  if (isOfferAcceptance(text, history)) return true;
  if (aiAskedOrderData && isExplicitOrderRequest(text)) return true;
  if (hasMaleHealthConsultationContext(history, profile)) return isExplicitOrderRequest(text);
  return isExplicitOrderRequest(text);
}

function detectByKeyword(text, history) {
  const lower = text.toLowerCase().trim();
  if (CANCEL_KEYWORDS.some(kw => lower.includes(kw))) return 'cancel';
  if (ORDER_STATUS_KEYWORDS.some(kw => lower.includes(kw))) return 'order_status';
  if (isExplicitOrderRequest(text)) return 'order';
  if (isOfferAcceptance(text, history)) return 'order';
  if (ORDER_KEYWORDS.some(kw => lower.includes(kw)) && !hasMaleHealthContext(lower)) return 'order';
  const shortAffirm = ['boleh','boleh deh','gas beli','gas pesen','gas order','yuk beli','yuk pesen','yuk order','mau beli','mau pesen','mau order','mo beli','mo pesen','mo order','pesen dong','beli dong','order dong','pesan dong','setuju beli','setuju pesan','deal beli','deal','lanjut pesan','lanjut order','iya beli','iya pesen','iya order','oke beli','oke pesen','oke order','ok beli','ok pesen','ok order'];
  const isAffirm = shortAffirm.some(kw => lower === kw || lower === kw+'!' || lower === kw+'.');
  if (isAffirm && history.length > 0) {
    const lastAI = [...history].reverse().find(h => h.role === 'assistant');
    if (lastAI && /mau pesan|mau beli|mau order|ketik.*pesan|ingin memesan|tertarik.*beli|pesan.*sekarang/i.test(lastAI.content)) return 'order';
  }
  return null;
}

async function detectByAI(text, history) {
  try {
    const res = await axios.post(`${AI_URL}/detect-intent`, { message: text, history }, { ...axiosConfig, timeout: 8000 });
    return res.data.intent || 'general';
  } catch(e) { return 'general'; }
}

async function detectIntent(text, history) {
  const kw = detectByKeyword(text, history);
  if (kw) { log('INFO', `Keyword intent: ${kw}`); return kw; }
  const ai = await detectByAI(text, history);
  log('INFO', `AI intent: ${ai}`);
  return ai;
}

// ------------------------------------------------------------------
// 6. CLOSINGAN HANDLER
// ------------------------------------------------------------------
async function handleClosingan(from, text, senderNumber) {
  const cleanText = text.replace(/#closingan/gi, '').trim();
  if (!cleanText) { 
    await sock.sendMessage(from, { text: '❌ Teks closingan kosong.' }); 
    return; 
  }
  log('INFO', `Closingan dari ${senderNumber}`);
  
  try {
    const parseRes = await axios.post(`${AI_URL}/parse-closing`, { text: cleanText }, { ...axiosConfig, timeout: 15000 });
    if (!parseRes.data.success) throw new Error(parseRes.data.error);
    const d = parseRes.data.data;
    const now = new Date().toISOString().replace('T',' ').substring(0,19);
    
    const saveRes = await axios.post(`${ADMIN_URL}/api/closings`, {
      timestamp: now, created_at: now,
      user_wa: senderNumber, raw_text: cleanText,
      ...d, status: 'draft', source: 'WA'
    }, axiosConfig);
    
    const closingId = saveRes.data.id;
    const val = d.nilai_cod ? `COD: Rp ${d.nilai_cod}` : `TRF: Rp ${d.harga_non_cod || '?'}`;
    
    await sock.sendMessage(from, {
      text: `✅ *Closingan #${closingId} tersimpan!*\n\n👤 ${d.nama || '?'}\n📱 ${d.telepon || '?'}\n📍 ${(d.alamat || '?').substring(0,50)}...\n📦 ${d.produk || '?'} × ${d.qty || 1}\n💰 ${val}\n\n_Cek di Admin Panel → tab Closings_`
    });
    log('INFO', `Closingan #${closingId} saved`);
  } catch(e) {
    log('ERROR', `Closingan error: ${e.message}`);
    await sock.sendMessage(from, { text: `❌ Gagal parse closingan: ${e.message}` });
  }
}

// ------------------------------------------------------------------
// 7. ORDER FLOW
// ------------------------------------------------------------------
async function handleOrderFlow(from, text, sock, senderNumber) {
  const session = orderSessions[from];
  if (!session) return;
  
  // Update last activity
  session.lastActivity = Date.now();
  const step = session.step;
  let reply = '';
  
  const cancelWords = ['batal','cancel','gak jadi','ga jadi','tidak jadi'];
  if (cancelWords.some(w => text.toLowerCase().includes(w)) && step !== 'confirm') {
    delete orderSessions[from];
    await sock.sendMessage(from, { text: 'Tidak apa-apa, pesanan dibatalkan. Ada yang bisa kami bantu lagi? 😊' });
    return;
  }
  
  // Escape hatch: kalau input terlihat seperti pertanyaan/bukan nama
  if (step === 'name' || step === 'phone') {
    const escapePattern = /tanya|belum|nanti|dulu|lihat|liat|cari|info|penasaran|mikir|pikir|liat-liat|kapan|berapa|apa|bagaimana|kenapa|dimana|siapa/i;
    if (text.includes('?') || escapePattern.test(text.toLowerCase())) {
      delete orderSessions[from];
      await sock.sendMessage(from, { text: 'Oke, silakan tanya-tanya dulu ya! 😊 Ada yang ingin ditanyakan?' });
      return;
    }
  }

  if (step === 'name') {
    const parsed = parseOrderIdentity(text);
    if (parsed.name) session.data.user_name = parsed.name;
    if (parsed.phone) session.data.phone = parsed.phone;
    if (!session.data.user_name && isSelfRecipientReply(text)) {
      const displayName = cleanDisplayName(session.data.display_name);
      if (displayName) session.data.user_name = displayName;
    }
    if (session.data.user_name && session.data.phone) {
      session.step = 'address';
      reply = 'Siap Kak, nama dan nomor HP sudah masuk. Alamat pengiriman lengkapnya?';
    } else if (session.data.user_name) {
      session.step = 'phone';
      reply = `Terima kasih, ${session.data.user_name}. Nomor HP yang bisa dihubungi?`;
    } else if (isAlreadyProvidedReply(text) && session.data.user_name) {
      session.step = 'phone';
      reply = 'Siap Kak. Nomor HP yang bisa dihubungi?';
    } else {
      reply = 'Boleh tulis nama penerimanya dulu, Kak?';
    }
  } else if (step === 'phone') {
    const phoneClean = normalizePhoneNumber(text);
    if (phoneClean) {
      session.data.phone = phoneClean;
      session.step = 'address';
      reply = 'Siap Kak. Alamat pengiriman lengkapnya?';
    } else if (isAlreadyProvidedReply(text) && session.data.phone) {
      session.step = 'address';
      reply = 'Siap Kak. Alamat pengiriman lengkapnya?';
    } else {
      reply = 'Nomor HP belum kebaca, Kak. Boleh kirim ulang angkanya?';
    }
  } else if (step === 'address') {
    session.data.address = text; session.step = 'product';
    try {
      const res = await axios.get(`${ADMIN_URL}/api/public/products`, axiosConfig);
      session.data.productList = res.data;
      let list = '📦 Pilih produk:\n';
      res.data.forEach((p,i) => { list += `${i+1}. ${p.name} - ${p.price}\n`; });
      reply = list + '\nKetik angka atau nama produk:';
    } catch(e) { reply = 'Produk apa yang ingin dipesan?'; }
  } else if (step === 'product') {
    if (!session.data.productList) { 
      try { const r = await axios.get(`${ADMIN_URL}/api/public/products`, axiosConfig); session.data.productList = r.data; } catch(e) {} 
    }
    const qtyFromText = parseQuantity(text);
    if (qtyFromText && session.data.productList?.length === 1) {
      const p = session.data.productList[0];
      session.data.product = `${p.name} - ${p.price}`;
      session.data.quantity = qtyFromText.toString();
      session.step = 'notes';
      reply = `Siap Kak, ${qtyFromText} ${p.name}. Ada catatan tambahan? (ketik "tidak" jika tidak ada)`;
    } else {
    const num = parseInt(text);
    if (num && session.data.productList?.[num-1]) {
      const p = session.data.productList[num-1]; session.data.product = `${p.name} - ${p.price}`; session.step = 'quantity'; reply = 'Berapa jumlah yang ingin dipesan?';
    } else {
      const match = session.data.productList?.find(p => p.name.toLowerCase().includes(text.toLowerCase()) && text.length > 2);
      if (match) { session.data.product = `${match.name} - ${match.price}`; session.step = 'quantity'; reply = 'Berapa jumlah yang ingin dipesan?'; }
      else { 
        let list = '❌ Produk tidak ditemukan.\n\n📦 Pilih produk:\n'; 
        session.data.productList?.forEach((p,i) => { list += `${i+1}. ${p.name} - ${p.price}\n`; }); 
        reply = list + '\nKetik angka atau nama produk:'; 
      }
    }
    }
  } else if (step === 'quantity') {
    const qty = parseQuantity(text);
    if (!qty || qty < 1 || qty > 100) { reply = 'Masukkan jumlah yang valid (1-100) 🔢'; }
    else { session.data.quantity = qty.toString(); session.step = 'notes'; reply = 'Ada catatan tambahan? (ketik "tidak" jika tidak ada)'; }
  } else if (step === 'notes') {
    session.data.notes = text.toLowerCase() === 'tidak' ? '' : text;
    session.step = 'confirm';
    const d = session.data;
    let total = '-';
    try { 
      const pm = d.product.match(/[\d.]+/g); 
      if (pm) { 
        const price = parseInt(pm[pm.length-1].replace(/\./g,'')); 
        total = `Rp ${(price*parseInt(d.quantity)).toLocaleString('id-ID')}`; 
      } 
    } catch(e) {}
    session.data.total = total;
    reply = `📋 *Ringkasan Pesanan:*\n\n👤 Nama: ${d.user_name}\n📱 HP: ${d.phone}\n📍 Alamat: ${d.address}\n📦 Produk: ${d.product}\n🔢 Jumlah: ${d.quantity}\n💰 Total: ${total}\n📝 Catatan: ${d.notes || '-'}\n\nKetik *"konfirmasi"* atau *"batal"*`;
  } else if (step === 'confirm') {
    const confirmWords = ['konfirmasi','konfrim','confirm','iya','ya','ok','oke','setuju','lanjut'];
    const cancelWords  = ['batal','cancel','gak jadi','ga jadi'];
    if (confirmWords.some(w => text.toLowerCase().includes(w))) {
      try {
        const d = session.data;
        const res = await axios.post(`${ADMIN_URL}/api/orders`, {
          timestamp: new Date().toISOString().replace('T',' ').substring(0,19),
          user_number: cleanNumber(from),
          user_name: d.user_name, phone: d.phone, address: d.address,
          product: d.product, quantity: d.quantity||'-', notes: d.notes, total: d.total||'-'
        }, axiosConfig);
        const orderId = res.data.order_id;
        reply = `✅ *Pesanan berhasil diterima!*\n\nOrder ID: #${orderId}\nTim kami akan segera menghubungi Anda.\n\nTerima kasih telah memesan! 🎁`;
        try { 
          await axios.post(`${AI_URL}/notify-order`, { 
            order_id: orderId, user_name: d.user_name, phone: d.phone, 
            address: d.address, product: d.product, quantity: d.quantity, 
            total: d.total, notes: d.notes, user_wa: cleanNumber(from) 
          }, axiosConfig); 
        } catch(e) {}
        await saveHistory(senderNumber, 'system_note', `Order #${orderId}: ${d.product}`);
        try {
          await saveProfile(senderNumber, {
            active_flow: 'post_order',
            active_stage: 'completed',
            last_question_id: 'post_order_complete',
            pending_slot: 'none',
            last_offer_type: 'none',
            state_confidence: 'high',
            last_order_id: String(orderId)
          }, `Order #${orderId}: ${d.product}`);
        } catch(e) {}
        log('INFO', `Order #${orderId} confirmed`);
      } catch(e) { 
        log('ERROR', `Order save error: ${e.message}`);
        reply = '❌ Gagal menyimpan pesanan. Silakan hubungi kami langsung.'; 
      }
      delete orderSessions[from];
    } else if (cancelWords.some(w => text.toLowerCase().includes(w))) {
      delete orderSessions[from]; 
      reply = 'Tidak apa-apa, pesanan dibatalkan. Ada yang bisa kami bantu? 😊';
    } else { 
      reply = 'Ketik *"konfirmasi"* atau *"batal"*'; 
    }
  }
  await sendTextAndRemember(sock, from, senderNumber, reply);
}

// ------------------------------------------------------------------
// 8. CONTEXT MATCHING
// ------------------------------------------------------------------
function isSukumbaProduct(p) {
  const features = Array.isArray(p.features) ? p.features.join(' ') : '';
  const haystack = `${p.name || ''} ${p.price || ''} ${p.speed || ''} ${features} ${p.description || ''} ${p.target || ''}`.toLowerCase();
  if (/\b(mbps|wifi|fiber|internet|modem|instalasi|berlangganan|paket home)\b/i.test(haystack)) return false;
  return /\b(sukumba|susu|kuda|sumbawa|herbal|stamina|vitalitas)\b/i.test(haystack);
}

function findRelevantContext(text, products, faqs) {
  const lowerText = text.toLowerCase();
  products = (products || []).filter(isSukumbaProduct);
  const words = lowerText.split(/\s+/).filter(w => w.length > 3);
  if (/jualan|produk|jual|ada apa|apa saja|katalog|daftar|menu|menjual/i.test(lowerText)) 
    return { products, faqs: faqs.slice(0,3) };
  
  let rp = products.map(p => ({ ...p, score: words.filter(w => `${p.name} ${p.speed||''} ${p.price} ${(p.features||[]).join(' ')}`.toLowerCase().includes(w)).length })).filter(p=>p.score>0).sort((a,b)=>b.score-a.score).slice(0,3);
  let rf = faqs.map(f => ({ ...f, score: words.filter(w => `${f.question} ${f.answer}`.toLowerCase().includes(w)).length })).filter(f=>f.score>0).sort((a,b)=>b.score-a.score).slice(0,3);
  
  if (!rp.length && !rf.length) return { products: [], faqs: [] };
  return { products: rp, faqs: rf };
}

// ------------------------------------------------------------------
// 9. WHATSAPP CONNECTION
// ------------------------------------------------------------------
async function connectToWhatsApp() {
  const generation = ++connectionGeneration;
  clearConnectionTimers();
  lastQR = null;
  isReady = false;
  setWAStatus('connecting', 'starting_socket');

  let currentSock;
  let saveCredsFn;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    saveCredsFn = saveCreds;
    const { version } = await fetchLatestBaileysVersion();
    currentSock = makeWASocket({ 
      version, 
      auth: state, 
      logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || 'error' }),
      browser: ['Sukumba CS AI', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      defaultQueryTimeoutMs: 60000,
      qrTimeout: 120000,
      keepAliveIntervalMs: 30000, 
      connectTimeoutMs: 60000 
    });
    sock = currentSock;
  } catch(e) {
    log('ERROR', `Failed to start WA socket: ${e.message}`);
    setWAStatus('disconnected', `start_failed:${e.message}`);
    scheduleReconnect(5000);
    return;
  }
  
  currentSock.ev.on('creds.update', (...args) => {
    if (generation !== connectionGeneration || sock !== currentSock) return;
    saveCredsFn(...args);
  });

  currentSock.ev.on('messages.upsert', async ({ messages }) => {
    if (generation !== connectionGeneration || sock !== currentSock) return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    
    const from = msg.key.remoteJid;
    if (!isDirectCustomerJid(from)) {
      log('INFO', `Skip non-customer chat: ${from}`);
      return;
    }
    const senderNumber = cleanNumber(from);
    const userName = msg.pushName || senderNumber;
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    if (!text) return;
    
    log('INFO', `📨 Dari ${senderNumber}: ${text.substring(0,80)}`);

    // CEK #closingan
    if (text.toLowerCase().includes('#closingan')) {
      await handleClosingan(from, text, senderNumber);
      return;
    }

    await saveHistory(senderNumber, 'user', text);
    
    if (orderSessions[from]) { 
      await handleOrderFlow(from, text, sock, senderNumber); 
      return; 
    }
    
    let dbHistory = [];
    let profile = {};
    try {
      dbHistory = await getHistory(senderNumber);
      profile = await getProfile(senderNumber);
      const intent = null; // v3: routing utama pindah ke /ai-chat supaya tidak double AI call.
      
      // Cek context: kalau tidak ada history produk/order dan pesan pendek → jangan auto-order
      const hasProductContext = dbHistory.slice(-5).some(h =>
        h.role === 'assistant' && 
        /mau\s+(beli|pesan|order)|harganya|berapa\s+harga|caranya\s+(pesan|beli|order)|order\s+sekarang|pilih\s+produk|nomor\s+berapa/i.test(h.content)
      );
      const isShortConfirm = ['ya','iya','ok','oke'].includes(text.toLowerCase().trim());
      
      const canStartOrder = shouldStartOrderFlow(text, dbHistory, profile);
      
      if (intent === 'order' && !canStartOrder) {
        log('INFO', 'Order intent held for consultation context');
        // Lewat ke AI normal agar Konsultan Pria lanjut konsultasi, bukan langsung minta data order.
      } else if (intent === 'order' && isShortConfirm && !hasProductContext) {
        log('INFO', 'Context check: shortConfirm=' + isShortConfirm + ', hasProductContext=' + hasProductContext + ', historyCount=' + dbHistory.length);
        // Lewat ke AI normal untuk context-aware response
      } else if (intent === 'order') {
        orderSessions[from] = { step: 'name', data: {}, lastActivity: Date.now() };
        await sock.sendMessage(from, { text: '🛒 Siap membantu pemesanan!\n\nBoleh saya tahu nama lengkap Anda?' });
        return;
      }

      let companyInfo = { name:'Sukumba', location:'Sumbawa, NTB', hours:'Senin-Sabtu 08:00-17:00' };
      let products = [], faqs = [];
      try {
        const [sRes,pRes,fRes] = await Promise.all([
          axios.get(`${ADMIN_URL}/api/public/settings`, axiosConfig),
          axios.get(`${ADMIN_URL}/api/public/products`, axiosConfig),
          axios.get(`${ADMIN_URL}/api/public/faqs`, axiosConfig)
        ]);
        const s = sRes.data;
        companyInfo = { name:s.company_name||'Sukumba', location:s.company_location||'Sumbawa, NTB', hours:s.company_hours||'Senin-Sabtu 08:00-17:00' };
        products = pRes.data; faqs = fRes.data;
      } catch(e) {}
      
      const { products: rp, faqs: rf } = findRelevantContext(text, products, faqs);
      
      let knowledgeContext = '';
      if (rp.length) { knowledgeContext += 'PRODUK RELEVAN:\n'; rp.forEach(p => { knowledgeContext += `- [ID:${p.id}] ${p.name}: ${p.price}\n  Fitur: ${(p.features||[]).join(', ')}\n`; }); }
      if (rf.length) { knowledgeContext += '\nFAQ RELEVAN:\n'; rf.forEach(f => { knowledgeContext += `- Q: ${f.question}\n  A: ${f.answer}\n`; }); }
      
      let orderContext = '';
      try {
        const oRes = await axios.get(`${ADMIN_URL}/api/orders`, axiosConfig);
        const userOrders = oRes.data.filter(o => o.user_number?.replace(/\D/g,'') === senderNumber.replace(/\D/g,''));
        if (userOrders.length) { 
          orderContext = '\nRIWAYAT PESANAN:\n'; 
          userOrders.slice(0,3).forEach(o => { orderContext += `- Order #${o.id}: ${o.product}, Status:${o.status}\n`; }); 
        }
      } catch(e) {}
      
      const photoCatalog = [];
      rp.forEach(p => { if (p.image_url) photoCatalog.push({type:'product',id:p.id,name:p.name,url:p.image_url}); });
      rf.forEach(f => { if (f.image_url) photoCatalog.push({type:'faq',id:f.id,name:f.question,url:f.image_url}); });
      
      const response = await axios.post(`${AI_URL}/ai-chat`, { 
        content: text, 
        history: dbHistory.slice(0,-1), 
        profile,
        userNumber: senderNumber,
        knowledgeContext: knowledgeContext+orderContext, 
        companyInfo, 
        photoCatalog 
      }, axiosConfig);
      
      let aiReply = response.data.choices[0].message.content;
      const aiMeta = response.data._meta || {};
      await saveProfile(senderNumber, aiMeta.profile_updates, aiMeta.summary);
      
      if (aiMeta.needs_handoff || aiMeta.intent === 'escalation' || aiMeta.intent === 'complaint') 
        await notifAdminEskalasi(from, userName, text);
      
      aiReply = aiReply.replace(/diskon\s+\d+%/gi,'').replace(/promo\s+diskon[^.!?\n]*/gi,'').replace(/knowledge base/gi,'').replace(/klik FAQ/gi,'tanyakan langsung').trim();
      
      const photoSignals = [];
      const photoRegex = /\[PHOTO:(product|faq):(\d+)\]/gi;
      let match;
      while ((match = photoRegex.exec(aiReply)) !== null) photoSignals.push({type:match[1],id:parseInt(match[2])});
      aiReply = aiReply.replace(/\[PHOTO:(product|faq):\d+\]/gi,'').trim();
      
      await saveHistory(senderNumber, 'assistant', aiReply);
      await sock.sendMessage(from, { text: aiReply });

      if (aiMeta.start_order) {
        const prefill = aiMeta.order_prefill || {};
        const data = {};
        if (userName && userName !== senderNumber) data.display_name = userName;
        if (prefill.phone) data.phone = normalizePhoneNumber(String(prefill.phone));
        const step = data.phone ? 'address' : 'name';
        orderSessions[from] = { step, data, lastActivity: Date.now() };
        log('INFO', `Order session started by AI meta for ${senderNumber}`);
      }
      
      for (const signal of photoSignals) {
        const item = photoCatalog.find(p => p.type===signal.type&&p.id===signal.id);
        if (item) { 
          try { 
            await sock.sendMessage(from, {image:{url:`${ADMIN_URL}${item.url}`},caption:`📸 ${item.name}`}); 
          } catch(e) {} 
        }
      }
      
      try { 
        await axios.post(`${ADMIN_URL}/api/log-conversation`, { 
          timestamp: new Date().toISOString().replace('T',' ').substring(0,19), 
          user_number: senderNumber+(msg.pushName?` (${msg.pushName})`:''), 
          user_message:text, ai_response:aiReply, 
          kb_context:knowledgeContext.substring(0,300) 
        }, axiosConfig); 
      } catch(e) {}
      
    } catch(err) {
      log('ERROR', `Error processing message: ${err.message}`);
      const fallbackReply = localSafeFallbackReply(text, dbHistory || [], profile || {});
      await saveHistory(senderNumber, 'assistant', fallbackReply);
      await sock.sendMessage(from, { text: fallbackReply });
    }
  });

  currentSock.ev.on('connection.update', (update) => {
    if (generation !== connectionGeneration || sock !== currentSock) {
      log('INFO', 'Ignoring stale WA connection event');
      return;
    }
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      lastQR = qr;
      isReady = false;
      setWAStatus('waiting_scan', 'qr_ready');
      const now = Date.now();
      if (now - lastQRLogAt > 30000) {
        lastQRLogAt = now;
        log('INFO', 'QR ready in admin panel');
      }
    }
    if (connection==='open') { 
      log('INFO', 'WhatsApp Connected!'); 
      lastQR = null;
      setWAStatus('connected', 'socket_open_waiting_ready');
      if (readyTimer) clearTimeout(readyTimer);
      readyTimer = setTimeout(() => {
        if (generation !== connectionGeneration || sock !== currentSock) return;
        isReady = true;
        setWAStatus('connected', 'ready');
      }, 5000); 
    }
    if (connection==='close') { 
      isReady = false;
      lastQR = null;
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
      const reason = lastDisconnect?.error?.output?.statusCode;
      const errorDetail = summarizeBaileysError(lastDisconnect?.error);
      lastDisconnectCode = reason || null;
      setWAStatus('disconnected', `closed:${reason || 'unknown'}:${lastDisconnect?.error?.message || '-'}`);
      log('WARN', `Connection close detail: ${errorDetail}`);
      if(reason === DisconnectReason.loggedOut) {
        log('WARN', 'Connection logged out, resetting auth and waiting for QR');
        resetAuthDir();
        scheduleReconnect(3000);
      } else {
        log('WARN', `Connection closed (${reason || 'unknown'}), reconnecting in 5s...`);
        scheduleReconnect(5000); 
      }
    }
  });
}

// ------------------------------------------------------------------
// 10. HTTP ENDPOINTS
// ------------------------------------------------------------------
app.post('/send-message', (req,res) => {
  const {to,message} = req.body;
  if(!sock||!isReady) return res.status(503).json({error:'WA not ready'});
  res.json({success:true});
  setTimeout(()=>{
    sock.sendMessage(to.includes('@s.whatsapp.net')?to:to+'@s.whatsapp.net',{text:message}).catch(e=>log('ERROR', e));
  },100);
});

app.get('/wa-status', (req,res) => res.json({
  status: waStatus,
  detail: waStatusDetail,
  updatedAt: waStatusUpdatedAt,
  isReady,
  hasQR: lastQR !== null,
  hasSocket: !!sock,
  reconnecting: !!reconnectTimer,
  lastDisconnectCode
}));

app.get('/wa-qr', (req,res) => { 
  if(!lastQR) return res.json({success:false}); 
  res.json({success:true,qr:lastQR}); 
});

app.post('/wa-disconnect', async (req,res) => { 
  try{
    connectionGeneration++;
    clearConnectionTimers();
    const oldSock = sock;
    stopCurrentSocket();
    lastQR = null;
    setWAStatus('disconnected', 'manual_disconnect');
    if(oldSock) {
      try { await oldSock.logout(); } catch(e) {}
    }
    res.json({success:true,status:waStatus,detail:waStatusDetail});
  }
  catch(e){res.status(500).json({success:false,error:e.message});} 
});

app.post('/wa-reconnect', async (req,res) => {
  try {
    connectionGeneration++;
    clearConnectionTimers();
    stopCurrentSocket();
    resetAuthDir();
    lastQR = null;
    isReady = false;
    lastDisconnectCode = null;
    setWAStatus('connecting', 'manual_reconnect_reset_auth');
    setTimeout(connectToWhatsApp,800);
    res.json({success:true,status:waStatus,detail:waStatusDetail});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

// Health check
app.get('/health', (req,res) => res.json({
  status:'ok',
  version:'v2.6-save-creds-scope-fix',
  waStatus,
  waStatusDetail,
  isReady,
  hasQR:lastQR!==null,
  reconnecting:!!reconnectTimer,
  lastDisconnectCode
}));

// ------------------------------------------------------------------
// 11. START SERVER
// ------------------------------------------------------------------
app.listen(PORT, () => { 
  log('INFO', `WA Gateway v2.6-save-creds-scope-fix on port ${PORT}`);
  connectToWhatsApp(); 
});
