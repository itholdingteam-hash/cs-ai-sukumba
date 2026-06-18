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
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const bodyParser = require('body-parser');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

// ------------------------------------------------------------------
// 0. ENVIRONMENT CONFIG
// ------------------------------------------------------------------
const PORT        = process.env.WA_GATEWAY_PORT || process.env.PORT || 3000;
const ADMIN_URL = (process.env.ADMIN_URL || 'http://admin-panel-docker:5001').replace(/\/$/, '');
const AI_URL = (process.env.AI_URL || 'http://ai-service-docker:5000').replace(/\/$/, '');
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY) || 12;
const ADMIN_WA    = process.env.ADMIN_WA || '';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';
const PROMO_ORDER_FORM_GREETING = `Hallo kak, salam kenal ini dengan CS SYIFA☺️

Kaka bisa otomatis mendapatkan PROMO kami jika melengkapi data dibawah ini😍

Nama : 
Alamat Jalan :
Patokan :
RT :
RW : 
Desa/kelurahan: 
Kecamatan : 
Kab/Kota :
Prov :

No. Hp :
Pembayaran : COD/TRF


✅ Cukup klik iklan 1 kali saja yaa kak, agar tidak terjadi eror/double data`;

const ORDER_FORM_MESSAGE = `Siap Kak, CS Syifa bantu proses pemesanan ya. Boleh lengkapi data berikut:

Nama:
Alamat Jalan:
Patokan:
RT:
RW:
Desa/kelurahan:
Kecamatan:
Kab/Kota:
Provinsi:
No. Hp:
Pembayaran: COD/TRF
Paket: 1 box / 2 box
Keluhan/sakit yang dirasakan:

Nanti setelah formnya lengkap, CS Syifa bantu cek total produk + ongkirnya ya Kak.`;

// Axios defaults
const axiosConfig = {
  timeout: 10000,
  headers: INTERNAL_API_KEY ? { 'X-Internal-Key': INTERNAL_API_KEY } : {}
};

function requireInternalAuth(req, res, next) {
  if (!INTERNAL_API_KEY) return next();
  const key = req.get('X-Internal-Key') || req.get('x-internal-key') || '';
  if (key !== INTERNAL_API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  return next();
}

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
const SESSION_FILE = process.env.ORDER_SESSION_FILE || '/app/data/order_sessions.json';
fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
let orderSessions = {};
try {
  if (fs.existsSync(SESSION_FILE)) {
    orderSessions = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) || {};
  }
} catch (error) {
  log('WARN', `Gagal membaca order session: ${error.message}`);
  orderSessions = {};
}
function persistOrderSessions() {
  try {
    const tempFile = `${SESSION_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(orderSessions, null, 2));
    fs.renameSync(tempFile, SESSION_FILE);
  } catch (error) {
    log('ERROR', `Gagal menyimpan order session: ${error.message}`);
  }
}
function removeOrderSession(key) {
  delete orderSessions[key];
  persistOrderSessions();
}
function setOrderSession(key, value) {
  orderSessions[key] = value;
  persistOrderSessions();
}
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 menit
const AUTH_DIR = process.env.BAILEYS_AUTH_DIR || path.join(__dirname, 'auth_info_baileys');
fs.mkdirSync(AUTH_DIR, { recursive: true });

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
      removeOrderSession(key);
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
  if (digits.length < 8 || digits.length > 15) return '';
  if (digits.startsWith('0')) return '62' + digits.slice(1);
  if (digits.startsWith('8')) return '62' + digits;
  if (digits.startsWith('62')) return digits;
  return digits;
}

function hasUsablePhoneNumber(text) {
  const digits = String(text || '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15;
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

function normalizeFormLabel(label) {
  return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseStructuredOrderForm(text) {
  const fields = {};
  let currentKey = '';
  const labelMap = {
    nama: 'name',
    namapenerima: 'name',
    alamat: 'street',
    alamatjalan: 'street',
    jalan: 'street',
    patokan: 'landmark',
    rt: 'rt',
    rw: 'rw',
    desakelurahan: 'village',
    kelurahan: 'village',
    desa: 'village',
    kecamatan: 'district',
    kabkota: 'city',
    kabupatenkota: 'city',
    kabupaten: 'city',
    kota: 'city',
    prov: 'province',
    provinsi: 'province',
    province: 'province',
    nohp: 'phone',
    nohandphone: 'phone',
    nomorhp: 'phone',
    hp: 'phone',
    wa: 'phone',
    usia: 'age',
    umur: 'age',
    pembayaran: 'payment',
    tfcod: 'payment',
    codtrf: 'payment',
    paket: 'package',
    pilihanpaket: 'package',
    jumlahpaket: 'package',
    produk: 'package',
    keluhan: 'complaint',
    keluhansakit: 'complaint',
    keluhansakityangdirasakan: 'complaint',
    sakit: 'complaint',
  };

  String(text || '').split(/\r?\n/).forEach(rawLine => {
    const line = rawLine.trim();
    if (!line) return;
    const match = line.match(/^([^:]{2,90})\s*:\s*(.*)$/);
    if (match) {
      const normalizedLabel = normalizeFormLabel(match[1]);
      let key = labelMap[normalizedLabel];
      if (!key && normalizedLabel.startsWith('alamatlengkap')) key = 'street';
      if (!key && normalizedLabel === 'rtrw') key = 'rt_rw';
      if (key) {
        currentKey = key;
        fields[key] = match[2].trim();
        if (key === 'rt_rw') {
          const rtRw = fields[key].match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
          if (rtRw) {
            fields.rt = rtRw[1];
            fields.rw = rtRw[2];
          }
        }
      } else {
        currentKey = '';
      }
      return;
    }
    if (currentKey && fields[currentKey]) {
      fields[currentKey] = `${fields[currentKey]} ${line}`.trim();
    }
  });

  const labelCount = Object.values(labelMap).filter((key, index, arr) => arr.indexOf(key) === index && Object.prototype.hasOwnProperty.call(fields, key)).length;
  if (labelCount < 4) return null;
  return fields;
}

function buildOrderPrefill(session) {
  return (session && session.data && session.data.order_prefill) || {};
}

function inferOrderPackage(fields, prefill) {
  const raw = `${prefill.product || ''} ${prefill.quantity || ''} ${fields.package || ''} ${fields.notes || ''}`.toLowerCase();
  if (/\b(2|dua)\s*box\b|\bquantity.?2\b/.test(raw)) return { quantity: '2', price: 'Rp 159.000' };
  return { quantity: prefill.quantity === '2' ? '2' : '1', price: prefill.quantity === '2' ? 'Rp 159.000' : 'Rp 99.000' };
}

function moneyNumber(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  return digits ? parseInt(digits, 10) : 0;
}

function formatRupiah(value) {
  const amount = moneyNumber(value);
  return `Rp ${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

function customerCourierLabel(rate) {
  return (rate && rate.courier) || 'JNE';
}

function customerShippingLine(shipping) {
  if (!shipping) return 'Ongkir: menunggu cek manual admin';
  return `Ongkir ${customerCourierLabel(shipping.rate)}: ${shipping.shipping_cost_label}`;
}

function buildOrderProductAndSubtotal(fields, prefill) {
  const selected = inferOrderPackage(fields, prefill);
  const product = prefill.product || `SUKUMBA ${selected.quantity} box - ${selected.price}`;
  const subtotal = moneyNumber(prefill.subtotal || selected.price);
  return { product, quantity: selected.quantity, subtotal, subtotalLabel: formatRupiah(subtotal) };
}

async function calculateShipping(fields, subtotal, prefill = {}) {
  try {
    const res = await axios.post(`${ADMIN_URL}/api/calculate-shipping`, {
      province: fields.province || '',
      city: fields.city || '',
      district: fields.district || '',
      courier: prefill.courier || 'JNE',
      service: prefill.service || 'REG',
      subtotal,
    }, axiosConfig);
    return res.data && res.data.success ? res.data : null;
  } catch(e) {
    const status = e.response && e.response.status ? ` status=${e.response.status}` : '';
    log('WARN', `Ongkir belum bisa dihitung untuk ${fields.city || '-'} / ${fields.district || '-'}:${status} ${e.message}`);
    return null;
  }
}

function buildOrderAddress(fields) {
  const parts = [];
  if (fields.street) parts.push(fields.street);
  if (fields.landmark) parts.push(`Patokan: ${fields.landmark}`);
  const rtRw = [fields.rt && `RT ${fields.rt}`, fields.rw && `RW ${fields.rw}`].filter(Boolean).join('/');
  if (rtRw) parts.push(rtRw);
  if (fields.village) parts.push(`Desa/Kel: ${fields.village}`);
  if (fields.district) parts.push(`Kec: ${fields.district}`);
  if (fields.city) parts.push(fields.city);
  if (fields.province) parts.push(fields.province);
  return parts.filter(Boolean).join(', ');
}

function validateStructuredOrder(fields) {
  const missing = [];
  if (!fields.name || fields.name.length < 2) missing.push('Nama');
  if (!hasUsablePhoneNumber(fields.phone || '')) missing.push('No. Hp');
  if (!fields.street || fields.street.length < 5) missing.push('Alamat Jalan');
  if (!fields.district) missing.push('Kecamatan');
  if (!fields.city) missing.push('Kab/Kota');
  if (!fields.province) missing.push('Provinsi');
  if (!fields.payment || !/\b(cod|tf|trf|transfer)\b/i.test(fields.payment)) missing.push('Pembayaran COD/TRF');
  return missing;
}

function paymentMode(value) {
  const lower = String(value || '').toLowerCase();
  if (/\b(cod|bayar ditempat|bayar di tempat)\b/i.test(lower)) return 'COD';
  if (/\b(tf|trf|transfer)\b/i.test(lower)) return 'TRF';
  return '';
}

function detectStructuredPackageChoice(text) {
  const lower = String(text || '').toLowerCase();
  if (/\b(2|dua)\s*(box|bok|paket)?\b|\b159\.?000\b|\b159k\b/.test(lower)) {
    return { quantity: '2', price: 'Rp 159.000' };
  }
  if (/\b(1|satu)\s*(box|bok|paket)?\b|\b99\.?000\b|\b99k\b/.test(lower)) {
    return { quantity: '1', price: 'Rp 99.000' };
  }
  return null;
}

function structuredPackagePrompt(fields) {
  const name = fields && fields.name ? ` ${fields.name.trim()}` : '';
  return (
    `Data formnya sudah CS Syifa terima ya Kak${name}.\n\n` +
    'Mau ambil paket yang mana?\n' +
    '1. 1 box SUKUMBA - Rp 99.000\n' +
    '2. 2 box SUKUMBA - Rp 159.000\n\n' +
    'Balas: *1 box* atau *2 box* ya Kak.'
  );
}

async function buildStructuredOrderSummary(session, packageChoice) {
  const fields = session.data.structured_fields;
  const pay = paymentMode(fields.payment);
  const prefill = {
    ...(buildOrderPrefill(session) || {}),
    quantity: packageChoice.quantity,
    product: `SUKUMBA ${packageChoice.quantity} box - ${packageChoice.price}`,
    subtotal: packageChoice.price,
    payment: pay,
  };
  const address = buildOrderAddress(fields);
  const phone = normalizePhoneNumber(fields.phone);
  const pricing = buildOrderProductAndSubtotal(fields, prefill);
  const shipping = await calculateShipping(fields, pricing.subtotal, prefill);
  const total = shipping ? shipping.total_label : `${pricing.subtotalLabel} + ongkir`;
  const shippingLine = customerShippingLine(shipping);
  const notes = [
    `Pembayaran: ${pay}`,
    `Subtotal produk: ${pricing.subtotalLabel}`,
    shippingLine,
    fields.age ? `Usia: ${fields.age}` : '',
    fields.complaint ? `Keluhan: ${fields.complaint}` : '',
  ].filter(Boolean).join('\n');

  return {
    fields,
    pay,
    address,
    phone,
    product: pricing.product,
    quantity: pricing.quantity,
    subtotalLabel: pricing.subtotalLabel,
    shippingLine,
    total,
    notes,
    idempotencyKey: `form-${session.data.sender_number}-${crypto.createHash('sha1').update(session.data.structured_raw_text || '').digest('hex').slice(0, 16)}-${pricing.quantity}`,
  };
}

function structuredOrderConfirmText(summary) {
  return (
    'CS Syifa rangkum dulu ya Kak:\n\n' +
    `Nama: ${summary.fields.name.trim()}\n` +
    `HP: ${summary.phone}\n` +
    `Pembayaran: ${summary.pay}\n` +
    `Produk: ${summary.product}\n` +
    `Subtotal: ${summary.subtotalLabel}\n` +
    `${summary.shippingLine}\n` +
    `Total: ${summary.total}\n\n` +
    'Kalau data sudah benar, balas *konfirmasi* ya Kak. Kalau mau ubah paket, balas *1 box* atau *2 box*.'
  );
}

function structuredOrderReceivedText(summary, orderId, duplicateNote = '') {
  if (summary.pay === 'COD') {
    return (
      'Siap Kak, pesanan COD-nya sudah CS Syifa terima ya.\n\n' +
      `Order ID: #${orderId}\n` +
      `Nama: ${summary.fields.name.trim()}\n` +
      `HP: ${summary.phone}\n` +
      `Produk: ${summary.product}\n` +
      `Subtotal: ${summary.subtotalLabel}\n` +
      `${summary.shippingLine}\n` +
      `Total COD: ${summary.total}\n\n` +
      'Nanti pembayarannya dilakukan saat paket sampai di alamat Kakak.\n' +
      'Mohon pastikan nomor HP aktif ya Kak, supaya kurir mudah menghubungi saat pengantaran.\n\n' +
      `Pesanan segera CS Syifa proses. Terima kasih Kak.${duplicateNote}`
    );
  }

  return (
    'Terima kasih Kak, pesanan sudah CS Syifa terima.\n\n' +
    `Order ID: #${orderId}\n` +
    `Nama: ${summary.fields.name.trim()}\n` +
    `HP: ${summary.phone}\n` +
    `Pembayaran: ${summary.pay}\n` +
    `Produk: ${summary.product}\n` +
    `Subtotal: ${summary.subtotalLabel}\n` +
    `${summary.shippingLine}\n` +
    `Total: ${summary.total}\n\n` +
    `Tim kami akan segera proses pesanan Kakak.${duplicateNote}`
  );
}

async function saveStructuredOrderSummary(summary, senderNumber) {
  const res = await axios.post(`${ADMIN_URL}/api/orders`, {
    timestamp: new Date().toISOString().replace('T',' ').substring(0,19),
    user_number: senderNumber,
    user_name: summary.fields.name.trim(),
    phone: summary.phone,
    address: summary.address,
    product: summary.product,
    quantity: summary.quantity,
    notes: summary.notes,
    total: summary.total,
    source: 'WhatsApp Form',
    idempotency_key: summary.idempotencyKey,
  }, axiosConfig);
  return res.data || {};
}

async function handleStructuredOrderForm(from, text, sock, senderNumber) {
  const fields = parseStructuredOrderForm(text);
  if (!fields) return false;

  const missing = validateStructuredOrder(fields);
  if (missing.length) {
    await sendTextAndRemember(
      sock,
      from,
      senderNumber,
      `Data formnya sudah CS Syifa terima, Kak. Tapi masih ada yang perlu dilengkapi: ${missing.join(', ')}.\n\nBoleh kirim ulang bagian yang kurang ya Kak?`
    );
    return true;
  }

  const session = {
    step: 'structured_package',
    data: {
      structured_fields: fields,
      structured_raw_text: text,
      sender_number: senderNumber,
    },
    lastActivity: Date.now(),
    startedAt: Date.now(),
  };

  const packageChoice = detectStructuredPackageChoice(fields.package || '');
  if (packageChoice) {
    try {
      const summary = await buildStructuredOrderSummary(session, packageChoice);
      session.data.structured_summary = summary;
      session.step = 'structured_confirm';
      setOrderSession(from, session);
      await sendTextAndRemember(sock, from, senderNumber, structuredOrderConfirmText(summary));
      log('INFO', `Structured order form received for ${senderNumber}; package included`);
    } catch(e) {
      log('ERROR', `Structured order initial total error: ${e.message}`);
      setOrderSession(from, session);
      await sendTextAndRemember(sock, from, senderNumber, 'Data formnya sudah CS Syifa terima ya Kak. Paketnya mau ambil *1 box* atau *2 box*?');
    }
    return true;
  }

  setOrderSession(from, session);
  await sendTextAndRemember(sock, from, senderNumber, structuredPackagePrompt(fields));
  log('INFO', `Structured order form received for ${senderNumber}; waiting for package choice`);
  return true;
}

function isDirectCustomerJid(jid) {
  if (!jid || jid === 'status@broadcast') return false;
  if (jid.includes('@g.us') || jid.includes('@newsletter') || jid.includes('@broadcast')) return false;
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
}

function outboundCustomerJid(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw;
  const digits = cleanNumber(raw);
  if (!digits) return '';
  if (digits.startsWith('62') || digits.startsWith('0') || digits.startsWith('8')) {
    return normalizePhoneNumber(digits) + '@s.whatsapp.net';
  }
  return digits + '@lid';
}

async function notifAdminEskalasi(from, userName, userMessage) {
  try {
    if (!ADMIN_WA || !sock || !isReady) return;
    await sock.sendMessage(ADMIN_WA + '@s.whatsapp.net', {
      text: `\u{1F6A8} *ESKALASI CS AI*\n\n\u{1F464} Customer: ${userName}\n\u{1F4F1} Nomor: ${cleanNumber(from)}\n\u{1F4AC} Pesan: "${userMessage.substring(0,200)}"\n\n\u26A0\uFE0F Customer membutuhkan bantuan CS manusia!`
    });
    log('INFO', `Eskalasi notif sent to admin for ${cleanNumber(from)}`);
  } catch(e) { log('ERROR', `Notif eskalasi gagal: ${e.message}`); }
}

function isOperationalComplaint(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower) return false;
  const explicitComplaint = /\b(komplain|complain|kecewa|marah|tidak\s+puas|ga\s+puas|gak\s+puas|nggak\s+puas|buruk|parah|kapok|mengecewakan)\b/i.test(lower);
  const deliveryIssue = /\b(paket|barang|pesanan|order|kiriman)\b.{0,60}\b(belum\s+sampai|tidak\s+sampai|ga\s+sampai|gak\s+sampai|nggak\s+sampai|lama\s+banget|terlambat|telat|nyasar|hilang|tertahan)\b/i.test(lower)
    || /\b(belum\s+sampai|tidak\s+sampai|ga\s+sampai|gak\s+sampai|nggak\s+sampai)\b.{0,60}\b(paket|barang|pesanan|order|kiriman)\b/i.test(lower);
  const itemIssue = /\b(rusak|pecah|bocor|sobek|penyok|cacat|salah\s+kirim|barang\s+salah|kurang|tidak\s+lengkap|ga\s+lengkap|gak\s+lengkap|expired|kadaluarsa|kedaluwarsa)\b/i.test(lower)
    && /\b(paket|barang|produk|pesanan|order|sukumba|box|kemasan)\b/i.test(lower);
  const refundIssue = /\b(refund|retur|return|uang\s+kembali|balikin\s+uang|ganti\s+barang|klaim|garansi)\b/i.test(lower);
  return explicitComplaint || deliveryIssue || itemIssue || refundIssue;
}

function operationalComplaintReply(text) {
  const lower = String(text || '').toLowerCase();
  if (/\b(rusak|pecah|bocor|sobek|penyok|cacat|salah\s+kirim|barang\s+salah|kurang|tidak\s+lengkap|ga\s+lengkap|gak\s+lengkap|expired|kadaluarsa|kedaluwarsa)\b/i.test(lower)) {
    return 'Mohon maaf ya Kak, CS Syifa bantu cek kendalanya. Boleh kirim nomor order/nama penerima, foto produk atau kemasan, dan video unboxing kalau ada? Saya teruskan ke admin agar bisa dicek untuk solusi klaimnya.';
  }
  if (/\b(belum\s+sampai|tidak\s+sampai|ga\s+sampai|gak\s+sampai|nggak\s+sampai|lama\s+banget|terlambat|telat|nyasar|hilang|tertahan|resi|tracking)\b/i.test(lower)) {
    return 'Mohon maaf ya Kak kalau pengirimannya belum nyaman. Boleh kirim nomor order/nama penerima dan nomor resi kalau sudah ada? CS Syifa teruskan ke admin untuk dicek posisi paketnya.';
  }
  if (/\b(refund|retur|return|uang\s+kembali|balikin\s+uang|ganti\s+barang|klaim|garansi)\b/i.test(lower)) {
    return 'Baik Kak, mohon maaf atas kendalanya. Untuk pengajuan retur/refund/klaim, boleh kirim nomor order, nama penerima, alasan kendala, dan foto atau video pendukungnya ya. CS Syifa teruskan ke admin untuk dicek sesuai prosedur.';
  }
  return 'Mohon maaf ya Kak atas kendalanya. Boleh ceritakan detail masalahnya dan kirim nomor order/nama penerima jika ada? CS Syifa teruskan ke admin supaya bisa dibantu cek dan follow up.';
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

function incomingMessageText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.documentMessage?.caption ||
    ''
  ).trim();
}

function hasIncomingMedia(message) {
  return Boolean(
    message?.imageMessage ||
    message?.videoMessage ||
    message?.documentMessage
  );
}

function incomingMediaMimeType(message) {
  return (
    message?.imageMessage?.mimetype ||
    message?.videoMessage?.mimetype ||
    message?.documentMessage?.mimetype ||
    ''
  ).toLowerCase();
}

async function savePaymentProofEvidence(msg, senderNumber, caption) {
  const mimeType = incomingMediaMimeType(msg.message) || 'image/jpeg';
  if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) {
    log('WARN', `Payment proof media ignored, unsupported mime: ${mimeType || '-'}`);
    return null;
  }
  const buffer = await downloadMediaMessage(
    msg,
    'buffer',
    {},
    { logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || 'error' }) }
  );
  if (!buffer || !buffer.length) throw new Error('Media bukti transfer kosong');
  const res = await axios.post(`${ADMIN_URL}/api/payment-proofs`, {
    user_number: senderNumber,
    caption: caption || '',
    mime_type: mimeType,
    media_base64: buffer.toString('base64'),
  }, axiosConfig);
  return res.data || null;
}

function isPaymentProofMessage(text) {
  return /\b(sudah|udh|udah|selesai|berhasil)\b.{0,40}\b(tf|trf|transfer|bayar)\b|\bbukti\s+(tf|trf|transfer|pembayaran)\b|\b(saya|sy|aku)\s+(tf|trf|transfer)\b/i.test(String(text || ''));
}

function isPaymentWaitRequest(text) {
  return /\b(mohon\s+ditunggu|ditunggu\s+(ya|dulu|sebentar)?|tunggu\s+(ya|dulu|sebentar)?|sebentar\s+(ya|dulu)?|bentar\s+(ya|dulu)?|nanti\s+(saya|sy|aku)?\s*(kirim|tf|transfer|bayar)|lagi\s+(tf|transfer|bayar)|sedang\s+(tf|transfer|bayar))\b/i.test(String(text || ''));
}

function assistantAskedPaymentProof(history) {
  return (history || []).slice(-5).some(h =>
    h.role === 'assistant' &&
    /\bbukti\s+(transaksi|transfer|tf|pembayaran)\b|sertakan bukti transaksinya/i.test(h.content || '')
  );
}

function hasRecentPaymentContext(profile, history) {
  if (profile && ['order', 'post_order'].includes(profile.active_flow || '')) return true;
  if (profile && ['payment_transfer', 'payment_proof_received'].includes(profile.active_stage || '')) return true;
  return (history || []).slice(-8).some(h =>
    /\b(bca|0463343991|rekening|transfer|tf|bukti\s+(transfer|tf|pembayaran)|order\s*id|pesanan|total)\b/i.test(h.content || '')
  );
}

function paymentProofReceivedReply() {
  return (
    'Terima kasih Kak, bukti transfernya sudah CS Syifa terima 🙏🏻\n\n' +
    'Nanti pembayaran akan dicek dulu oleh tim kami ya Kak. Setelah tervalidasi, pesanan langsung diproses untuk pengiriman.\n\n' +
    'Mohon pastikan nomor HP aktif, dan resi akan CS Syifa infokan setelah paket diproses.'
  );
}

function paymentProofRequestReply() {
  return (
    'Siap Kak, boleh kirim bukti transfernya di sini ya.\n' +
    'Nanti setelah bukti masuk, CS Syifa bantu cek dan proses pesanannya 🙏🏻'
  );
}

function paymentProofWaitReply() {
  return 'Baik Kak, tidak apa-apa. Silakan transfer dulu, nanti kalau sudah bisa kirim bukti transfernya di sini ya. Saya bantu teruskan untuk pengecekan.';
}

function isThanksMessage(text) {
  return /^(terima\s*kasih|trimakasih|trims|makasih|mksh|thanks|thank\s*you|thx|tks|siap\s+makasih|oke\s+makasih|ok\s+makasih|baik\s+makasih)(\s+kak)?[.!?]*$/i.test(String(text || '').trim());
}

function lastPaymentMethod(profile = {}, history = []) {
  const saved = String(profile.last_payment_method || '').toUpperCase();
  if (saved === 'COD' || saved === 'TRF') return saved;

  const recent = (history || []).slice(-10).reverse();
  for (const item of recent) {
    const content = item.content || '';
    if (/pesanan\s+COD|Total\s+COD|Pembayaran:\s*COD/i.test(content)) return 'COD';
    if (/Pembayaran:\s*(TRF|TF|transfer)|bukti\s+transfer|transfer\s+dulu/i.test(content)) return 'TRF';
  }
  return '';
}

function postOrderThanksReply(method) {
  if (method === 'COD') {
    return (
      'Sama-sama Kak. Pesanan COD Kakak sudah masuk dan akan CS Syifa teruskan untuk diproses.\n\n' +
      'Nanti pembayarannya dilakukan saat paket sampai. Mohon pastikan nomor HP aktif ya Kak, supaya kurir mudah menghubungi saat pengantaran.'
    );
  }
  if (method === 'TRF') {
    return (
      'Sama-sama Kak. Pesanan transfer Kakak sudah masuk ya.\n\n' +
      'Kalau sudah transfer, boleh kirim bukti pembayarannya di sini. Nanti CS Syifa bantu teruskan untuk pengecekan dan proses pengiriman.'
    );
  }
  return 'Sama-sama Kak. Pesanan Kakak sudah CS Syifa teruskan ke tim kami ya. Mohon pastikan nomor HP aktif untuk proses berikutnya.';
}

function isPackageQuestion(text) {
  const lower = String(text || '').toLowerCase();
  if (/\b(mbps|wifi|fiber|internet|modem|paket\s+home)\b/i.test(lower)) return false;
  if (isParcelQuestion(lower)) return false;
  return /\b(paket|harga|promo|price|berapa\s+harg|1\s*box|2\s*box|satu\s*box|dua\s*box)\b/i.test(lower)
    && /\b(harga|promo|price|berapa\s+harg|1\s*box|2\s*box|satu\s*box|dua\s*box|cod|tf|trf|transfer|bayar|ongkir)\b/i.test(lower);
}

function packageAndPaymentReply(text) {
  const lower = String(text || '').toLowerCase();
  const asksCod = /\b(cod|bayar\s+di\s+tempat)\b/i.test(lower);
  const asksTransfer = /\b(tf|trf|transfer|rekening)\b/i.test(lower);

  let intro = 'Untuk paket promo SUKUMBA saat ini:';
  if (asksCod && !asksTransfer) intro = 'Bisa COD Kak. Untuk paket SUKUMBA:';
  if (asksTransfer && !asksCod) intro = 'Bisa transfer Kak. Untuk paket SUKUMBA:';

  return (
    `${intro}\n\n` +
    '1. 1 box SUKUMBA - Rp 99.000\n' +
    '2. 2 box SUKUMBA - Rp 159.000\n\n' +
    'Metode pembayaran bisa COD atau TRF.\n' +
    '- COD: bayar saat paket sampai, total mengikuti harga produk + ongkir.\n' +
    '- TRF: transfer setelah total produk + ongkir dihitung, lalu kirim bukti transfer di chat ini.\n\n' +
    'Kalau mau order, Kakak bisa balas *1 box COD*, *2 box COD*, *1 box TRF*, atau *2 box TRF* ya.'
  );
}

function isParcelQuestion(text) {
  const lower = String(text || '').toLowerCase();
  return /\b(paket|barang|pesanan|order|kiriman)\b/i.test(lower)
    && /\b(saya|ku|kak|ini|nya|barang|paket|pesanan|order|kirim|dikirim|pengiriman|sampai|datang|antar|diantar|resi|tracking|kurir|jne|cod)\b/i.test(lower)
    && !/\b(harga|promo|1\s*box|2\s*box|satu\s*box|dua\s*box|berapa\s+harg|price)\b/i.test(lower);
}

function parcelQuestionReply(method) {
  if (method === 'COD') {
    return (
      'Untuk paket COD Kakak, pesanan sudah CS Syifa teruskan ke tim proses ya.\n\n' +
      'Nanti paket dikirim lewat ekspedisi, dan pembayaran dilakukan saat paket sampai. Mohon pastikan nomor HP aktif supaya kurir mudah menghubungi Kakak.\n\n' +
      'Kalau resi sudah keluar, CS Syifa akan infokan.'
    );
  }
  if (method === 'TRF') {
    return (
      'Baik Kak, CS Syifa bantu cek ya.\n\n' +
      'Untuk pesanan transfer Kakak, setelah pembayaran tervalidasi paket akan segera diproses pengiriman. Kalau resi sudah keluar, CS Syifa akan infokan di chat ini supaya Kakak bisa pantau posisi paketnya.\n\n' +
      'Kalau Kakak ingin dicek lebih cepat, boleh kirim Order ID atau bukti transfernya ya Kak.'
    );
  }
  return (
    'Untuk paket Kakak, CS Syifa bantu cek/proses ke tim kami ya.\n\n' +
    'Mohon pastikan nomor HP aktif. Kalau resi sudah keluar, nanti CS Syifa infokan di chat ini.'
  );
}

function hasAssistantHistory(history) {
  return (history || []).some(h => h.role === 'assistant');
}

function shouldSendPromoOrderGreeting(text, history) {
  if (hasAssistantHistory(history)) return false;
  if (parseStructuredOrderForm(text)) return false;
  return true;
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

function isProductPackagingQuestion(text) {
  const lower = String(text || '').toLowerCase().trim();
  return /\b(isi|netto|berat|gram|gr|berapa\s+gram|sachet|bungkus|takaran)\b|\b(1|satu)\s*box\b.*\b(berapa|isi|gram|gr|netto|berat)\b/i.test(lower);
}

function isShippingEstimateQuestion(text) {
  const lower = String(text || '').toLowerCase().trim();
  return /\b(berapa\s+lama|estimasi|kapan.{0,30}sampai|sampai\s+berapa\s+hari|lama\s+pengiriman|pengiriman\s+berapa\s+hari|dikirim|sampainya)\b/i.test(lower)
    && /\b(kirim|pengiriman|sampai|paket|barang|pesanan|dikirim)\b/i.test(lower);
}

function isShippingCostQuestion(text) {
  return /\b(ongkir(?:nya)?|ongkos\s+kirim|biaya\s+kirim)\b/i.test(String(text || ''));
}

function isCourierQuestion(text) {
  return /\b(kurir(?:nya)?|ekspedisi(?:nya)?|jasa\s+(?:kirim|pengiriman)|pengiriman\s+(?:apa|pakai\s+apa)|jne|jnt|j&t|sicepat|anteraja)\b/i.test(String(text || ''));
}

function shippingCostReply() {
  return 'Ongkir menyesuaikan alamat tujuan, jadi supaya tidak salah hitung boleh kirim kecamatan, kabupaten/kota, dan provinsi Kakak dulu ya. Nanti CS Syifa bantu cek total produk + ongkirnya.';
}

function extractShippingQuery(text) {
  const raw = String(text || '').trim();
  const match = raw.match(/\b(?:ongkir(?:nya)?|ongkos\s+kirim|biaya\s+kirim)\b(?:\s+(?:ke|tujuan|daerah|alamat))?\s+(.+)/i);
  if (!match) return '';
  return match[1]
    .replace(/\b(berapa|brp|ya|kak|dong|cek|tolong|mohon)\b/gi, ' ')
    .replace(/[?!.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function shippingQuoteReply(text) {
  const query = extractShippingQuery(text);
  if (!query || query.length < 4) return '';
  try {
    const res = await axios.post(`${ADMIN_URL}/api/calculate-shipping`, {
      rajaongkir_query: query,
      courier: 'JNE',
      service: 'REG',
      subtotal: 0,
      weight: 500,
    }, axiosConfig);
    const data = res.data || {};
    if (!data.success) return '';
    const rate = data.rate || {};
    const courier = customerCourierLabel(rate);
    const estimate = rate.estimated_days ? ` Estimasi ${rate.estimated_days} hari kerja.` : '';
    return `Ongkir ${courier} ke ${query} sekitar ${data.shipping_cost_label}, Kak.${estimate}\n\nKalau alamat lengkapnya sudah siap, CS Syifa bisa bantu hitungkan total produk + ongkirnya.`;
  } catch (e) {
    log('WARN', `Auto ongkir quote failed: ${e.message}`);
    return '';
  }
}

function courierReply() {
  return 'Untuk pengiriman kami biasanya memakai JNE REG.';
}

function isHalalQuestion(text) {
  return /\b(halal|haram|mui|sertifikat\s+halal|label\s+halal)\b/i.test(String(text || ''));
}

function halalReply() {
  return 'InsyaAllah aman dan nyaman dikonsumsi ya Kak.\n\nSUKUMBA dibuat dari bahan pangan seperti susu kuda Sumbawa, krimer nabati, padatan susu, dan ekstrak herbal. Produknya juga sudah terdaftar BPOM RI MD 071182004300360.\n\nKalau Kakak ingin lebih yakin, CS Syifa bisa bantu kirimkan foto label kemasan/izin produk yang tersedia. Kakak mau sekalian saya bantu pilihkan paket promonya?';
}

function isTestimonialRequest(text) {
  return /\b(testimoni|testimomi|testimonial|review|ulasan|bukti|hasil)\b/i.test(String(text || ''));
}

function productPackagingReply() {
  const gram = String(process.env.SUKUMBA_BOX_CONTENT_GRAM || '200').trim();
  if (gram) {
    const gramText = /\b(gr|gram)\b/i.test(gram) ? gram : `${gram} gram`;
    return `Isi 1 box SUKUMBA ${gramText}, Kak. Aturan minumnya 2 x 2 sendok makan per hari sesudah makan untuk pemulihan.`;
  }
  return 'Untuk isi/berat per box SUKUMBA, data gramnya belum tercantum di sistem saya, Kak. Supaya tidak salah info, saya cekkan dulu ke admin ya.';
}

function isVideoUrl(url) {
  return /\.(mp4|mov|webm)(\?.*)?$/i.test(String(url || ''));
}

function mediaUrl(url) {
  const raw = String(url || '').trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${ADMIN_URL}${raw}`;
}

async function sendCatalogMedia(sock, from, item) {
  const url = mediaUrl(item.url);
  const caption = item.name || 'Testimoni SUKUMBA';
  if (isVideoUrl(item.url)) {
    await sock.sendMessage(from, { video: { url }, caption });
  } else {
    await sock.sendMessage(from, { image: { url }, caption });
  }
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
  return !!(lastAI && /pesanan\s+berhasil\s+diterima|pesanan\s+sudah\s+CS\s+Syifa\s+terima|pesanan\s+COD-nya\s+sudah|terima\s+kasih\s+telah\s+memesan|order\s+id\s*:\s*#?(OID[A-Z0-9]+|\d+)/i.test(lastAI.content || ''));
}

function localSafeFallbackReply(text, history = [], profile = {}) {
  const lower = String(text || '').toLowerCase().trim();
  if (hasPostOrderContext(history, profile) && /^(ok|oke|baik|siap|iya|ya|sip|noted)[.!?]*$/i.test(lower)) {
    return 'Baik Kak, terima kasih. CS Syifa teruskan pesanan Kakak ke tim kami ya.';
  }
  if (isShortProductRequest(lower)) {
    return 'Sukumba adalah susu kuda Sumbawa/herbal untuk membantu stamina, energi, daya tahan tubuh, dan vitalitas, Kak. Diminum 2x sehari sesudah makan. Kakak mau info manfaat, cara minum, atau konsultasi dulu?';
  }
  if (isProductPackagingQuestion(lower)) {
    return productPackagingReply();
  }
  if (isShippingCostQuestion(lower)) {
    return shippingCostReply();
  }
  if (isCourierQuestion(lower)) {
    return courierReply();
  }
  if (isHalalQuestion(lower)) {
    return halalReply();
  }
  if (isShippingEstimateQuestion(lower)) {
    return 'Untuk pengiriman biasanya memakai JNE REG ya Kak, estimasi sampai sekitar 4-7 hari kerja setelah paket diproses.\n\nKalau Kakak ingin cek ongkir, boleh kirim kecamatan, kabupaten/kota, dan provinsinya dulu ya.';
  }
  if (isTestimonialRequest(lower)) {
    return 'Boleh Kak, saya kirimkan testimoni customer SUKUMBA ya.';
  }
  if (isShortPurchaseRequest(lower) && (lastAssistantHasProductContext(history) || (profile && profile.active_flow === 'product') || hasPostOrderContext(history, profile))) {
    return ORDER_FORM_MESSAGE;
  }
  if (/^(halo|hai|hallo|helo|hello|pagi|siang|sore|malam|selamat\s+(pagi|siang|sore|malam))(\s+kak)?[.!?]*$/i.test(lower)) {
    return 'Halo Kak, selamat datang di Sukumba. Bisa saya bantu info produk atau konsultasi dulu?';
  }
  if (/\b(nama\s+kamu\s+siapa|kamu\s+siapa|ini\s+siapa|dengan\s+siapa|admin\s+siapa|cs\s+siapa|bot\s+apa)\b/i.test(lower)) {
    if (/\b(konsultasi|konsul|consult|consul)\b/i.test(lower)) {
      return 'Saya CS Sukumba, Kak. Boleh, keluhannya lebih ke stamina mudah drop, badan pegal/linu, atau vitalitas pria ya?';
    }
    return 'Saya CS Sukumba, Kak. Saya bantu info produk dan konsultasi seputar stamina/kesehatan pria dengan bahasa yang tetap nyaman.';
  }
  if (/\b(jualan|produk|jual\s+apa|menjual|harga|harganya|khasiat|manfaat|kandungan|cara\s+minum|aturan\s+minum|dosis|promo|ongkir|kurir|ekspedisi|cod|sukumba|halal|haram|mui|info\s+produk|isi|netto|berat|gram|gr|sachet|bungkus|box|testimoni|testimonial|review|ulasan|bukti|hasil|pengiriman|kirim|sampai|estimasi)\b/i.test(lower)) {
    if (isProductPackagingQuestion(lower)) {
      return productPackagingReply();
    }
    if (isShippingCostQuestion(lower)) {
      return shippingCostReply();
    }
    if (isCourierQuestion(lower)) {
      return courierReply();
    }
    if (isHalalQuestion(lower)) {
      return halalReply();
    }
    if (isShippingEstimateQuestion(lower)) {
      return 'Untuk pengiriman biasanya memakai JNE REG ya Kak, estimasi sampai sekitar 4-7 hari kerja setelah paket diproses.\n\nKalau Kakak ingin cek ongkir, boleh kirim kecamatan, kabupaten/kota, dan provinsinya dulu ya.';
    }
    if (isTestimonialRequest(lower)) {
      return 'Boleh Kak, saya kirimkan testimoni customer SUKUMBA ya.';
    }
    if (/\b(cara\s+minum|aturan\s+minum|dosis|minum|konsumsi)\b/i.test(lower)) {
      return 'Sukumba diminum 2x sehari sesudah makan, Kak. Bentuknya susu kuda Sumbawa/herbal, sebagai support stamina dan kondisi tubuh.';
    }
    if (/\b(harga|harganya|berapa|promo|ongkir|cod|paket)\b/i.test(lower)) {
      return 'Untuk harga dan promo Sukumba bisa tergantung paket aktif, Kak. Biasanya ada promo seperti gratis ongkir, free konsultasi, atau bonus.';
    }
    return 'Sukumba adalah susu kuda Sumbawa/herbal untuk membantu stamina, energi, daya tahan tubuh, dan vitalitas, Kak. Diminum 2x sehari sesudah makan. Kakak mau info manfaat, cara minum, atau konsultasi dulu?';
  }
  if (/\bcara\s+(beli|pesan|pesen|order|pemesanan)\b|\b(beli|pesan|pesen|order|pemesanan)\s+(gimana|bagaimana|gmn|gmna|caranya)\b/i.test(lower)) {
    return ORDER_FORM_MESSAGE;
  }
  if (/\b(konsultasi|konsul|consult|consul|keluhan|stamina|burung|ereksi|loyo|vitalitas|cepat keluar|ejakulasi)\b/i.test(lower)) {
    if (/\b(burung|ereksi|loyo|vitalitas|cepat keluar|ejakulasi|greng|joss|jos)\b/i.test(lower)) {
      return 'Saya pahami Kak, vitalitas pria terasa kurang maksimal. Usia Kakak berapa, dan keluhan ini sudah berapa lama?';
    }
    return 'Boleh Kak, keluhannya lebih ke stamina mudah drop, badan pegal/linu, atau vitalitas pria ya? Boleh info usia Kakak dan keluhan ini sudah berapa lama supaya CS Syifa bisa arahkan lebih pas.';
  }
  if (isExplicitOrderRequest(lower)) {
    return ORDER_FORM_MESSAGE;
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
    await sock.sendMessage(from, { text: '\u274C Teks closingan kosong.' }); 
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
      text: `\u2705 *Closingan #${closingId} tersimpan!*\n\n\u{1F464} ${d.nama || '?'}\n\u{1F4F1} ${d.telepon || '?'}\n\u{1F4CD} ${(d.alamat || '?').substring(0,50)}...\n\u{1F4E6} ${d.produk || '?'} x ${d.qty || 1}\n\u{1F4B0} ${val}\n\n_Cek di Admin Panel -> tab Closings_`
    });
    log('INFO', `Closingan #${closingId} saved`);
  } catch(e) {
    log('ERROR', `Closingan error: ${e.message}`);
    await sock.sendMessage(from, { text: `\u274C Gagal parse closingan: ${e.message}` });
  }
}

// ------------------------------------------------------------------
// 7. ORDER FLOW
// ------------------------------------------------------------------
async function handleOrderFlow(from, text, sock, senderNumber) {
  const session = orderSessions[from];
  if (!session) return;

  session.lastActivity = Date.now();
  persistOrderSessions();

  const step = session.step;
  let reply = '';

  const cancelWords = ['batal','cancel','gak jadi','ga jadi','tidak jadi'];
  if (cancelWords.some(w => text.toLowerCase().includes(w)) && step !== 'confirm') {
    removeOrderSession(from);
    await sock.sendMessage(from, { text: 'Tidak apa-apa Kak, CS Syifa batalkan dulu ya. Ada yang mau ditanyakan lagi?' });
    return;
  }

  if (step === 'structured_package') {
    const packageChoice = detectStructuredPackageChoice(text);
    if (!packageChoice) {
      reply = 'Paketnya mau ambil yang mana ya Kak?\n\n1. 1 box SUKUMBA - Rp 99.000\n2. 2 box SUKUMBA - Rp 159.000\n\nBalas: *1 box* atau *2 box*.';
    } else {
      try {
        const summary = await buildStructuredOrderSummary(session, packageChoice);
        session.data.structured_summary = summary;
        session.step = 'structured_confirm';
        persistOrderSessions();
        reply = structuredOrderConfirmText(summary);
      } catch(e) {
        log('ERROR', `Structured order total error: ${e.message}`);
        reply = 'Maaf Kak, total pesanan belum berhasil dihitung. Boleh pilih paketnya ulang sebentar lagi ya.';
      }
    }
  } else if (step === 'structured_confirm') {
    const confirmWords = ['konfirmasi','konfrim','confirm','iya','ya','ok','oke','setuju','lanjut'];
    const lower = text.toLowerCase();
    const packageChoice = detectStructuredPackageChoice(text);
    if (packageChoice) {
      try {
        const summary = await buildStructuredOrderSummary(session, packageChoice);
        session.data.structured_summary = summary;
        persistOrderSessions();
        reply = structuredOrderConfirmText(summary);
      } catch(e) {
        log('ERROR', `Structured order retotal error: ${e.message}`);
        reply = 'Maaf Kak, total pesanan belum berhasil dihitung. Boleh pilih paketnya ulang sebentar lagi ya.';
      }
    } else if (confirmWords.some(w => lower.includes(w))) {
      try {
        const summary = session.data.structured_summary;
        if (!summary) throw new Error('Ringkasan order belum tersedia');
        const result = await saveStructuredOrderSummary(summary, senderNumber);
        const orderId = result.order_id;
        const duplicateNote = result.duplicate ? '\n\nData ini sudah pernah masuk sebelumnya, jadi tidak dibuat dobel ya Kak.' : '';
        reply = structuredOrderReceivedText(summary, orderId, duplicateNote);

        try {
          await axios.post(`${AI_URL}/notify-order`, {
            order_id: orderId,
            user_name: summary.fields.name.trim(),
            phone: summary.phone,
            address: summary.address,
            product: summary.product,
            quantity: summary.quantity,
            total: summary.total,
            notes: summary.notes,
            user_wa: senderNumber,
          }, axiosConfig);
        } catch(e) {
          log('WARN', `Order form #${orderId} tersimpan, notifikasi gagal: ${e.message}`);
        }

        await saveHistory(senderNumber, 'system_note', `Order #${orderId}: ${summary.product}`);
        try {
          await saveProfile(senderNumber, {
            active_flow: 'post_order',
            active_stage: 'completed',
            last_question_id: 'post_order_complete',
            pending_slot: 'none',
            last_offer_type: 'none',
            state_confidence: 'high',
            last_order_id: String(orderId),
            last_payment_method: summary.pay,
          }, `Order #${orderId}: ${summary.product}`);
        } catch(e) {}
        removeOrderSession(from);
      } catch(e) {
        log('ERROR', `Structured order save error: ${e.message}`);
        reply = 'Maaf Kak, CS Syifa belum berhasil menyimpan pesanan. Boleh coba ulang sebentar lagi atau hubungi admin langsung.';
      }
    } else {
      reply = 'Kalau data sudah benar, balas *konfirmasi* ya Kak. Kalau mau ubah paket, balas *1 box* atau *2 box*.';
    }
  } else if (step === 'name' || step === 'phone') {
    const escapePattern = /tanya|belum|nanti|dulu|lihat|liat|cari|info|penasaran|mikir|pikir|liat-liat|kapan|berapa|apa|bagaimana|kenapa|dimana|siapa/i;
    if (text.includes('?') || escapePattern.test(text.toLowerCase())) {
      removeOrderSession(from);
      await sock.sendMessage(from, { text: 'Oke Kak, CS Syifa bantu tanya-tanya dulu ya. Ada yang ingin ditanyakan?' });
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
      reply = 'Baik Kak, nama dan nomor HP sudah CS Syifa catat. Alamat pengiriman lengkapnya?';
    } else if (session.data.user_name) {
      session.step = 'phone';
      reply = `Terima kasih, ${session.data.user_name}. Nomor HP yang bisa CS Syifa hubungi?`;
    } else if (isAlreadyProvidedReply(text) && session.data.user_name) {
      session.step = 'phone';
      reply = 'Baik Kak. Nomor HP yang bisa CS Syifa hubungi?';
    } else {
      reply = 'Boleh tulis nama penerimanya dulu ya Kak?';
    }
  } else if (step === 'phone') {
    const phoneClean = normalizePhoneNumber(text);
    if (phoneClean) {
      session.data.phone = phoneClean;
      session.step = 'address';
      reply = 'Baik Kak, nomor HP sudah CS Syifa catat. Alamat pengiriman lengkapnya?';
    } else if (isAlreadyProvidedReply(text) && session.data.phone) {
      session.step = 'address';
      reply = 'Baik Kak. Alamat pengiriman lengkapnya?';
    } else {
      reply = 'Nomor HP-nya belum kebaca, Kak. Boleh kirim ulang angkanya?';
    }
  } else if (step === 'address') {
    session.data.address = text;
    session.step = 'product';
    try {
      const res = await axios.get(`${ADMIN_URL}/api/public/products`, axiosConfig);
      session.data.productList = res.data;
      let list = 'Baik Kak, pilih produk yang mau CS Syifa proses ya:\n';
      res.data.forEach((p,i) => { list += `${i+1}. ${p.name} - ${p.price}\n`; });
      reply = list + '\nKetik angka atau nama produk:';
    } catch(e) {
      reply = 'Produk apa yang ingin CS Syifa proses, Kak?';
    }
  } else if (step === 'product') {
    if (!session.data.productList) {
      try {
        const r = await axios.get(`${ADMIN_URL}/api/public/products`, axiosConfig);
        session.data.productList = r.data;
      } catch(e) {}
    }
    const qtyFromText = parseQuantity(text);
    if (qtyFromText && session.data.productList?.length === 1) {
      const p = session.data.productList[0];
      session.data.product = `${p.name} - ${p.price}`;
      session.data.quantity = qtyFromText.toString();
      session.step = 'notes';
      reply = `Baik Kak, ${qtyFromText} ${p.name} CS Syifa catat. Ada catatan tambahan? (ketik "tidak" jika tidak ada)`;
    } else {
      const num = parseInt(text);
      if (num && session.data.productList?.[num-1]) {
        const p = session.data.productList[num-1];
        session.data.product = `${p.name} - ${p.price}`;
        session.step = 'quantity';
        reply = 'Berapa jumlah yang ingin dipesan, Kak?';
      } else {
        const match = session.data.productList?.find(p => p.name.toLowerCase().includes(text.toLowerCase()) && text.length > 2);
        if (match) {
          session.data.product = `${match.name} - ${match.price}`;
          session.step = 'quantity';
          reply = 'Berapa jumlah yang ingin dipesan, Kak?';
        } else {
          let list = 'Produknya belum CS Syifa temukan, Kak.\n\nPilih produk berikut ya:\n';
          session.data.productList?.forEach((p,i) => { list += `${i+1}. ${p.name} - ${p.price}\n`; });
          reply = list + '\nKetik angka atau nama produk:';
        }
      }
    }
  } else if (step === 'quantity') {
    const qty = parseQuantity(text);
    if (!qty || qty < 1 || qty > 100) {
      reply = 'Jumlahnya belum valid, Kak. Boleh kirim angka 1-100 ya.';
    } else {
      session.data.quantity = qty.toString();
      session.step = 'notes';
      reply = 'Baik Kak, ada catatan tambahan? (ketik "tidak" jika tidak ada)';
    }
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
    reply = `CS Syifa rangkum pesanannya ya Kak:\n\nNama: ${d.user_name}\nHP: ${d.phone}\nAlamat: ${d.address}\nProduk: ${d.product}\nJumlah: ${d.quantity}\nTotal: ${total}\nCatatan: ${d.notes || '-'}\n\nKetik *"konfirmasi"* kalau data sudah benar, atau *"batal"* kalau ingin dibatalkan.`;
  } else if (step === 'confirm') {
    const confirmWords = ['konfirmasi','konfrim','confirm','iya','ya','ok','oke','setuju','lanjut'];
    const cancelWords  = ['batal','cancel','gak jadi','ga jadi'];
    if (confirmWords.some(w => text.toLowerCase().includes(w))) {
      try {
        const d = session.data;
        const res = await axios.post(`${ADMIN_URL}/api/orders`, {
          timestamp: new Date().toISOString().replace('T',' ').substring(0,19),
          user_number: cleanNumber(from),
          user_name: d.user_name,
          phone: d.phone,
          address: d.address,
          product: d.product,
          quantity: d.quantity || '-',
          notes: d.notes,
          total: d.total || '-',
          source: 'WhatsApp',
          idempotency_key: `${cleanNumber(from)}-${session.startedAt || session.lastActivity}`
        }, axiosConfig);
        const orderId = res.data.order_id;
        reply = `Pesanan berhasil CS Syifa terima ya Kak.\n\nOrder ID: #${orderId}\nTim kami akan segera menghubungi Kakak untuk proses berikutnya.\n\nTerima kasih sudah memesan.`;
        try {
          await axios.post(`${AI_URL}/notify-order`, {
            order_id: orderId,
            user_name: d.user_name,
            phone: d.phone,
            address: d.address,
            product: d.product,
            quantity: d.quantity,
            total: d.total,
            notes: d.notes,
            user_wa: cleanNumber(from)
          }, axiosConfig);
        } catch(e) {
          log('WARN', `Order #${orderId} tersimpan, notifikasi gagal: ${e.message}`);
        }
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
        reply = 'Maaf Kak, CS Syifa belum berhasil menyimpan pesanan. Boleh coba ulang sebentar lagi atau hubungi admin langsung.';
      }
      removeOrderSession(from);
    } else if (cancelWords.some(w => text.toLowerCase().includes(w))) {
      removeOrderSession(from);
      reply = 'Tidak apa-apa Kak, pesanan CS Syifa batalkan dulu ya. Ada yang mau ditanyakan lagi?';
    } else {
      reply = 'Ketik *"konfirmasi"* kalau data sudah benar, atau *"batal"* kalau ingin dibatalkan ya Kak.';
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

function findRelevantContext(text, products, faqs, testimonials) {
  const lowerText = text.toLowerCase();
  products = (products || []).filter(isSukumbaProduct);
  faqs = faqs || [];
  testimonials = testimonials || [];
  if (isTestimonialRequest(lowerText)) {
    return { products: [], faqs: [], testimonials: testimonials.slice(0, 12) };
  }
  const words = lowerText.split(/\s+/).filter(w => w.length > 3);
  if (/jualan|produk|jual|ada apa|apa saja|katalog|daftar|menu|menjual/i.test(lowerText)) 
    return { products, faqs: faqs.slice(0,3), testimonials: [] };
  
  let rp = products.map(p => ({ ...p, score: words.filter(w => `${p.name} ${p.speed||''} ${p.price} ${(p.features||[]).join(' ')}`.toLowerCase().includes(w)).length })).filter(p=>p.score>0).sort((a,b)=>b.score-a.score).slice(0,3);
  let rf = faqs.map(f => ({ ...f, score: words.filter(w => `${f.question} ${f.answer}`.toLowerCase().includes(w)).length })).filter(f=>f.score>0).sort((a,b)=>b.score-a.score).slice(0,3);
  
  if (!rp.length && !rf.length) return { products: [], faqs: [], testimonials: [] };
  return { products: rp, faqs: rf, testimonials: [] };
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
  
  currentSock.ev.on('creds.update', async (...args) => {
    if (generation !== connectionGeneration || sock !== currentSock) return;
    try {
      await saveCredsFn(...args);
    } catch(e) {
      log('ERROR', `Failed to save WA credentials: ${e.message}`);
    }
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
    const text = incomingMessageText(msg.message);
    const hasMedia = hasIncomingMedia(msg.message);
    if (!text && !hasMedia) return;
    
    const historyText = text || '[media dari customer]';
    log('INFO', `\u{1F4E8} Dari ${senderNumber}: ${historyText.substring(0,80)}`);

    // CEK #closingan
    if (text.toLowerCase().includes('#closingan')) {
      await handleClosingan(from, text, senderNumber);
      return;
    }

    await saveHistory(senderNumber, 'user', historyText);

    let dbHistory = [];
    let profile = {};
    try {
      dbHistory = await getHistory(senderNumber);
      profile = await getProfile(senderNumber);
    } catch(e) {}

    if (hasMedia && (isPaymentProofMessage(text) || profile.pending_slot === 'payment_proof' || assistantAskedPaymentProof(dbHistory) || hasRecentPaymentContext(profile, dbHistory))) {
      try {
        const savedProof = await savePaymentProofEvidence(msg, senderNumber, text);
        if (savedProof && savedProof.proof_id) {
          await saveHistory(senderNumber, 'system_note', `Bukti transfer #${savedProof.proof_id} tersimpan untuk finance.`);
        }
      } catch(e) {
        log('ERROR', `Gagal menyimpan bukti transfer ${senderNumber}: ${e.message}`);
        await saveHistory(senderNumber, 'system_note', `Bukti transfer diterima, tetapi file belum berhasil disimpan: ${e.message}`);
      }
      await sendTextAndRemember(sock, from, senderNumber, paymentProofReceivedReply());
      await saveProfile(senderNumber, {
        active_flow: 'post_order',
        active_stage: 'payment_proof_received',
        last_question_id: 'payment_proof_received',
        pending_slot: 'none',
        last_offer_type: 'none',
        state_confidence: 'high',
      }, 'Customer mengirim bukti transfer.');
      return;
    }

    if (!hasMedia && isPaymentWaitRequest(text) && (profile.pending_slot === 'payment_proof' || assistantAskedPaymentProof(dbHistory) || hasRecentPaymentContext(profile, dbHistory))) {
      await sendTextAndRemember(sock, from, senderNumber, paymentProofWaitReply());
      await saveProfile(senderNumber, {
        active_flow: 'order',
        active_stage: 'payment_transfer',
        last_question_id: 'ask_payment_proof',
        pending_slot: 'payment_proof',
        last_offer_type: 'order',
        state_confidence: 'high',
      }, 'Customer meminta ditunggu sebelum mengirim bukti transfer.');
      return;
    }

    if (!hasMedia && isPaymentProofMessage(text) && (profile.pending_slot === 'payment_proof' || assistantAskedPaymentProof(dbHistory))) {
      await sendTextAndRemember(sock, from, senderNumber, paymentProofRequestReply());
      return;
    }

    if (hasMedia && !text) return;

    if (!hasMedia && isThanksMessage(text) && hasPostOrderContext(dbHistory, profile)) {
      await sendTextAndRemember(sock, from, senderNumber, postOrderThanksReply(lastPaymentMethod(profile, dbHistory)));
      return;
    }

    try {
      if (await handleStructuredOrderForm(from, text, sock, senderNumber)) {
        return;
      }
    } catch(e) {
      log('ERROR', `Structured order form error: ${e.message}`);
      await sendTextAndRemember(sock, from, senderNumber, 'Maaf Kak, data formnya belum berhasil CS Syifa simpan. Boleh cek lagi formatnya atau kirim ulang sebentar lagi ya.');
      return;
    }

    if (isShippingCostQuestion(text)) {
      const quote = await shippingQuoteReply(text);
      if (quote) {
        await sendTextAndRemember(sock, from, senderNumber, quote);
        return;
      }
    }

    if (isOperationalComplaint(text)) {
      await sendTextAndRemember(sock, from, senderNumber, operationalComplaintReply(text));
      await saveProfile(senderNumber, {
        active_flow: 'escalation',
        active_stage: 'complaint',
        last_question_id: 'ask_complaint_detail',
        pending_slot: 'complaint_detail',
        last_offer_type: 'none',
        state_confidence: 'high',
      }, 'Customer menyampaikan komplain/kendala operasional dan perlu follow up admin.');
      await notifAdminEskalasi(from, userName, text);
      return;
    }
    
    if (orderSessions[from]) { 
      await handleOrderFlow(from, text, sock, senderNumber); 
      return; 
    }

    if (!hasMedia && isParcelQuestion(text) && hasPostOrderContext(dbHistory, profile)) {
      await sendTextAndRemember(sock, from, senderNumber, parcelQuestionReply(lastPaymentMethod(profile, dbHistory)));
      return;
    }

    if (!hasMedia && isPackageQuestion(text)) {
      await sendTextAndRemember(sock, from, senderNumber, packageAndPaymentReply(text));
      await saveProfile(senderNumber, {
        active_flow: 'product',
        active_stage: 'explaining_package',
        last_question_id: 'ask_package_choice',
        pending_slot: 'package_choice',
        last_offer_type: 'order',
        state_confidence: 'high',
      }, 'Customer menanyakan paket dan metode pembayaran COD/TRF.');
      return;
    }
    
    try {
      const intent = null; // v3: routing utama pindah ke /ai-chat supaya tidak double AI call.

      if (shouldSendPromoOrderGreeting(text, dbHistory)) {
        await sendTextAndRemember(sock, from, senderNumber, ORDER_FORM_MESSAGE);
        await saveProfile(senderNumber, {
          active_flow: 'order',
          active_stage: 'awaiting_order_form',
          last_question_id: 'ask_order_form',
          pending_slot: 'order_form',
          last_offer_type: 'order_form',
          state_confidence: 'high',
        }, 'CS Syifa mengirim format data promo/order otomatis.');
        return;
      }
      
      // Cek context: kalau tidak ada history produk/order dan pesan pendek -> jangan auto-order
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
        await sendTextAndRemember(sock, from, senderNumber, ORDER_FORM_MESSAGE);
        await saveProfile(senderNumber, {
          active_flow: 'order',
          active_stage: 'awaiting_order_form',
          last_question_id: 'ask_order_form',
          pending_slot: 'order_form',
          last_offer_type: 'order_form',
          state_confidence: 'high',
        }, 'CS Syifa mengirim form order lengkap.');
        return;
      }

      let companyInfo = { name:'Sukumba', location:'Sumbawa, NTB', hours:'Senin-Sabtu 08:00-17:00' };
      let products = [], faqs = [], testimonials = [];
      try {
        const [sRes,pRes,fRes,tRes] = await Promise.all([
          axios.get(`${ADMIN_URL}/api/public/settings`, axiosConfig),
          axios.get(`${ADMIN_URL}/api/public/products`, axiosConfig),
          axios.get(`${ADMIN_URL}/api/public/faqs`, axiosConfig),
          axios.get(`${ADMIN_URL}/api/public/testimonials`, axiosConfig)
        ]);
        const s = sRes.data;
        companyInfo = { name:s.company_name||'Sukumba', location:s.company_location||'Sumbawa, NTB', hours:s.company_hours||'Senin-Sabtu 08:00-17:00' };
        products = pRes.data; faqs = fRes.data; testimonials = tRes.data;
      } catch(e) {}
      
      const { products: rp, faqs: rf, testimonials: rt } = findRelevantContext(text, products, faqs, testimonials);
      
      let knowledgeContext = '';
      if (rp.length) { knowledgeContext += 'PRODUK RELEVAN:\n'; rp.forEach(p => { knowledgeContext += `- [ID:${p.id}] ${p.name}: ${p.price}\n  Fitur: ${(p.features||[]).join(', ')}\n`; }); }
      if (rf.length) { knowledgeContext += '\nFAQ RELEVAN:\n'; rf.forEach(f => { knowledgeContext += `- Q: ${f.question}\n  A: ${f.answer}\n`; }); }
      
      let orderContext = '';
      try {
        const oRes = await axios.get(`${ADMIN_URL}/api/orders`, axiosConfig);
        const userOrders = oRes.data.filter(o => o.user_number?.replace(/\D/g,'') === senderNumber.replace(/\D/g,''));
        if (userOrders.length) { 
          orderContext = '\nRIWAYAT PESANAN:\n'; 
          userOrders.slice(0,3).forEach(o => { orderContext += `- Order #${o.public_order_id || o.id}: ${o.product}, Status:${o.status}\n`; }); 
        }
      } catch(e) {}
      
      const photoCatalog = [];
      rp.forEach(p => { if (p.image_url) photoCatalog.push({type:'product',id:p.id,name:p.name,url:p.image_url}); });
      rf.forEach(f => { if (f.image_url) photoCatalog.push({type:'faq',id:f.id,name:f.question,url:f.image_url,answer:f.answer || ''}); });
      rt.forEach(t => { if (t.media_url) photoCatalog.push({type:'testimonial',id:t.id,name:t.title,url:t.media_url,answer:t.caption || ''}); });
      
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
      const photoRegex = /\[PHOTO:(product|faq|testimonial):(\d+)\]/gi;
      let match;
      while ((match = photoRegex.exec(aiReply)) !== null) photoSignals.push({type:match[1],id:parseInt(match[2])});
      aiReply = aiReply.replace(/\[PHOTO:(product|faq|testimonial):\d+\]/gi,'').trim();
      if (isTestimonialRequest(text) && photoSignals.length === 0) {
        const testimonialLimit = Math.max(1, Math.min(parseInt(process.env.TESTIMONIAL_MEDIA_LIMIT || '3', 10) || 3, 10));
        photoCatalog
          .filter(item => item.type === 'testimonial')
          .slice(0, testimonialLimit)
          .forEach(item => photoSignals.push({ type: item.type, id: item.id }));
        log('INFO', `Testimonial request detected. Media queued: ${photoSignals.length}/${photoCatalog.length}`);
      }
      
      await saveHistory(senderNumber, 'assistant', aiReply);
      await sock.sendMessage(from, { text: aiReply });

      if (aiMeta.start_order) {
        if (!/nama\s*:|alamat\s+jalan\s*:|pembayaran\s*:\s*cod\/trf/i.test(aiReply)) {
          await sendTextAndRemember(sock, from, senderNumber, ORDER_FORM_MESSAGE);
        }
        await saveProfile(senderNumber, {
          active_flow: 'order',
          active_stage: 'awaiting_order_form',
          last_question_id: 'ask_order_form',
          pending_slot: 'order_form',
          last_offer_type: 'order_form',
          state_confidence: 'high',
        }, 'CS Syifa mengirim form order lengkap.');
        log('INFO', `Order form requested by AI meta for ${senderNumber}`);
      }
      
      for (const signal of photoSignals) {
        const item = photoCatalog.find(p => p.type===signal.type&&p.id===signal.id);
        if (item) { 
          try { 
            log('INFO', `Sending media ${item.type}:${item.id} ${item.url}`);
            await sendCatalogMedia(sock, from, item); 
          } catch(e) {
            log('ERROR', `Failed sending media ${item.type}:${item.id}: ${e.message}`);
          } 
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
app.post('/send-message', requireInternalAuth, async (req,res) => {
  const {to,message} = req.body;
  if(!sock||!isReady) return res.status(503).json({error:'WA not ready'});
  const jid = outboundCustomerJid(to);
  if (!jid) return res.status(400).json({success:false,error:'Invalid recipient'});
  try {
    await sock.sendMessage(jid, { text: message });
    return res.json({success:true,to:jid});
  } catch(e) {
    log('ERROR', `Send message failed to ${jid}: ${e.message || e}`);
    return res.status(500).json({success:false,error:e.message || String(e)});
  }
});

app.get('/wa-status', requireInternalAuth, (req,res) => res.json({
  status: waStatus,
  detail: waStatusDetail,
  updatedAt: waStatusUpdatedAt,
  isReady,
  hasQR: lastQR !== null,
  hasSocket: !!sock,
  reconnecting: !!reconnectTimer,
  lastDisconnectCode
}));

app.get('/wa-qr', requireInternalAuth, (req,res) => { 
  if(!lastQR) return res.json({success:false}); 
  res.json({success:true,qr:lastQR}); 
});

app.post('/wa-disconnect', requireInternalAuth, async (req,res) => { 
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

app.post('/wa-reconnect', requireInternalAuth, async (req,res) => {
  try {
    connectionGeneration++;
    clearConnectionTimers();
    stopCurrentSocket();
    lastQR = null;
    isReady = false;
    lastDisconnectCode = null;
    setWAStatus('connecting', 'manual_reconnect_keep_auth');
    setTimeout(connectToWhatsApp,800);
    res.json({success:true,status:waStatus,detail:waStatusDetail});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.post('/wa-reset-session', requireInternalAuth, async (req,res) => {
  try {
    connectionGeneration++;
    clearConnectionTimers();
    stopCurrentSocket();
    resetAuthDir();
    lastQR = null;
    isReady = false;
    lastDisconnectCode = null;
    setWAStatus('connecting', 'manual_reset_auth');
    setTimeout(connectToWhatsApp,800);
    res.json({success:true,status:waStatus,detail:waStatusDetail});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

// Health check
app.get('/health', (req,res) => res.json({
  status:'ok',
  version:'v2.7-persistent-wa-session',
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

