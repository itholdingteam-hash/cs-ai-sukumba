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
function isNoisySignalLog(args) {
  const first = args && args[0];
  return typeof first === 'string' && (
    first.startsWith('Closing session:') ||
    first.startsWith('Closing open session in favor of incoming prekey bundle')
  );
}
for (const method of ['log', 'info', 'warn', 'error']) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    if (isNoisySignalLog(args)) return;
    original(...args);
  };
};
for (const stream of [process.stdout, process.stderr]) {
  const originalWrite = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    if (
      text.startsWith('Closing session:') ||
      text.startsWith('Closing open session in favor of incoming prekey bundle') ||
      /^\s+(_chains|registrationId|currentRatchet|indexInfo|pendingPreKey|ephemeralKeyPair|pubKey|privKey|lastRemoteEphemeralKey|previousCounter|rootKey|baseKey|baseKeyType|closed|used|created|remoteIdentityKey|signedKeyId|preKeyId):/.test(text) ||
      /^\s*[{}],?\s*$/.test(text) ||
      /^\s+['"]?[A-Za-z0-9+/=]{20,}['"]?: \{ chainKey:/.test(text)
    ) {
      if (typeof callback === 'function') callback();
      return true;
    }
    return originalWrite(chunk, encoding, callback);
  };
}
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const bodyParser = require('body-parser');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const crypto = require('crypto');
const os = require('os');

const app = express();
app.use(bodyParser.json());

// ------------------------------------------------------------------
// 0. ENVIRONMENT CONFIG
// ------------------------------------------------------------------
const PORT = process.env.WA_GATEWAY_PORT || process.env.PORT || 3000;
const ADMIN_URL = (process.env.ADMIN_URL || 'http://admin-panel-docker:5001').replace(/\/$/, '');
const AI_URL = (process.env.AI_URL || 'http://ai-service-docker:5000').replace(/\/$/, '');
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY) || 12;
const ADMIN_WA = process.env.ADMIN_WA || '';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

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
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${timestamp}] [${level}] ${message}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { }
}

function envInt(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function envBool(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
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
    try { parts.push(`data=${JSON.stringify(err.data).substring(0, 300)}`); } catch (e) { }
  }
  if (err.stack) parts.push(`stack=${String(err.stack).split('\n')[0]}`);
  return parts.join(' | ');
}

function baileysErrorData(err) {
  if (!err) return {};
  if (err.data && typeof err.data === 'object') return err.data;
  return {};
}

function baileysLogoutKind(err) {
  const data = baileysErrorData(err);
  const reasonNode = data.reasonNode || {};
  const fullErrorNode = data.fullErrorNode || {};
  const nodeText = JSON.stringify({ reasonNode, fullErrorNode, data }).toLowerCase();
  if (nodeText.includes('device_removed')) return 'device_removed';
  if (nodeText.includes('conflict')) return 'conflict';
  return 'logged_out';
}

function logoutAdvice(kind) {
  if (kind === 'device_removed') {
    return 'WhatsApp removed this linked device. This usually happens when the same number is scanned on another gateway/browser, or someone removed it from Linked Devices.';
  }
  if (kind === 'conflict') {
    return 'WhatsApp reported a linked-device conflict. Make sure only one WA gateway instance is running for this number.';
  }
  return 'WhatsApp marked this session as logged out and a new QR scan is required.';
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
const debounceRegistry = new Map();
const replyJidRegistry = new Map();
function defaultDataDir() {
  if (path.basename(__dirname) === 'app') return path.join(__dirname, 'data');
  return path.resolve(__dirname, '..', 'data');
}

function resolveRuntimePath(rawPath, fallbackPath) {
  const value = String(rawPath || '').trim();
  if (!value) return fallbackPath;
  if (process.platform === 'win32' && /^\/app(\/|$)/.test(value)) {
    return path.resolve(__dirname, '..', value.replace(/^\/app\/?/, ''));
  }
  if (path.isAbsolute(value)) return value;
  return path.resolve(__dirname, value);
}

const DATA_DIR = resolveRuntimePath(process.env.DATA_DIR, defaultDataDir());
fs.mkdirSync(DATA_DIR, { recursive: true });

const SESSION_FILE = resolveRuntimePath(process.env.ORDER_SESSION_FILE, path.join(DATA_DIR, 'order_sessions.json'));
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
const AUTH_DIR = resolveRuntimePath(process.env.BAILEYS_AUTH_DIR, path.join(DATA_DIR, 'auth_info_baileys'));
fs.mkdirSync(AUTH_DIR, { recursive: true });
const AUTH_LOCK_FILE = path.join(AUTH_DIR, '.gateway.lock');
const AUTH_LOCK_STALE_MS = Math.max(60000, envInt('WA_AUTH_LOCK_STALE_MS', 180000));
let authLockFd = null;
let authLockTimer = null;

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
  try { oldSock.ev?.removeAllListeners?.('messages.upsert'); } catch (e) { }
  try { oldSock.ev?.removeAllListeners?.('connection.update'); } catch (e) { }
  try { oldSock.ev?.removeAllListeners?.('creds.update'); } catch (e) { }
  try { oldSock.ws?.close?.(); } catch (e) { }
  try { oldSock.end?.(); } catch (e) { }
}

function authDirStats() {
  try {
    const entries = fs.readdirSync(AUTH_DIR).filter(entry => entry !== path.basename(AUTH_LOCK_FILE));
    return {
      path: AUTH_DIR,
      files: entries.length,
      hasCreds: fs.existsSync(path.join(AUTH_DIR, 'creds.json'))
    };
  } catch (e) {
    return { path: AUTH_DIR, files: 0, hasCreds: false, error: e.message };
  }
}

function acquireAuthLock() {
  const now = new Date();
  const payload = JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    startedAt: now.toISOString(),
    authDir: AUTH_DIR
  }, null, 2);

  try {
    if (fs.existsSync(AUTH_LOCK_FILE)) {
      const stats = fs.statSync(AUTH_LOCK_FILE);
      const ageMs = Date.now() - stats.mtimeMs;
      if (ageMs < AUTH_LOCK_STALE_MS) {
        const existing = fs.readFileSync(AUTH_LOCK_FILE, 'utf8').replace(/\s+/g, ' ').trim();
        throw new Error(`Active WA gateway lock found (${Math.round(ageMs / 1000)}s old): ${existing}`);
      }
      log('WARN', `Removing stale WA gateway lock (${Math.round(ageMs / 1000)}s old)`);
      fs.rmSync(AUTH_LOCK_FILE, { force: true });
    }

    authLockFd = fs.openSync(AUTH_LOCK_FILE, 'wx');
    fs.writeFileSync(authLockFd, payload);
    authLockTimer = setInterval(() => {
      try {
        const heartbeat = new Date();
        fs.utimesSync(AUTH_LOCK_FILE, heartbeat, heartbeat);
      } catch (e) {
        log('WARN', `WA gateway lock heartbeat failed: ${e.message}`);
      }
    }, 15000);
    if (authLockTimer.unref) authLockTimer.unref();
    log('INFO', `WA auth lock acquired at ${AUTH_LOCK_FILE}`);
  } catch (e) {
    log('ERROR', `Cannot start WA gateway safely: ${e.message}`);
    log('ERROR', 'Stop the other WA gateway instance, or wait for the lock to expire if the previous process crashed.');
    process.exit(1);
  }
}

function releaseAuthLock() {
  if (authLockTimer) {
    clearInterval(authLockTimer);
    authLockTimer = null;
  }
  if (authLockFd !== null) {
    try { fs.closeSync(authLockFd); } catch (e) { }
    authLockFd = null;
  }
  try { fs.rmSync(AUTH_LOCK_FILE, { force: true }); } catch (e) { }
}

function resetAuthDir(reason = 'manual') {
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    for (const entry of fs.readdirSync(AUTH_DIR)) {
      if (entry === path.basename(AUTH_LOCK_FILE)) continue;
      fs.rmSync(path.join(AUTH_DIR, entry), { recursive: true, force: true });
    }
    log('INFO', `WA auth dir cleared (${reason})`);
  } catch (e) {
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
  return String(jid || '').replace('@s.whatsapp.net', '').replace('@lid', '');
}

function lidUserFromJid(jid) {
  const raw = String(jid || '');
  if (!raw.endsWith('@lid')) return '';
  return raw.split('@')[0].split(':')[0];
}

function phoneFromMappedLid(jid) {
  const lidUser = lidUserFromJid(jid);
  if (!lidUser) return '';
  try {
    const mappingFile = path.join(AUTH_DIR, `lid-mapping-${lidUser}_reverse.json`);
    if (!fs.existsSync(mappingFile)) return '';
    return normalizePhoneNumber(JSON.parse(fs.readFileSync(mappingFile, 'utf8')));
  } catch (e) {
    log('WARN', `Gagal baca LID mapping untuk ${jid}: ${e.message}`);
    return '';
  }
}

function numberFromPhoneJid(jid) {
  const raw = String(jid || '');
  if (!raw.endsWith('@s.whatsapp.net')) return '';
  return normalizePhoneNumber(cleanNumber(raw));
}

function resolveSenderNumber(msg) {
  const key = msg?.key || {};
  const candidates = [
    key.senderPn,
    key.participantPn,
    msg?.senderPn,
    msg?.participantPn,
    key.remoteJid,
    key.participant,
    msg?.participant
  ];
  for (const jid of candidates) {
    const phone = numberFromPhoneJid(jid);
    if (phone) return phone;
  }
  const mappedPhone = phoneFromMappedLid(key.remoteJid);
  if (mappedPhone) return mappedPhone;
  return cleanNumber(key.remoteJid || '');
}

function normalizeJidCandidate(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'status@broadcast') return '';
  if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@lid')) return raw;
  const digits = raw.replace(/\D/g, '');
  const looksLikePhone = digits.startsWith('62') || digits.startsWith('0') || digits.startsWith('8');
  const phone = looksLikePhone ? normalizePhoneNumber(raw) : '';
  if (phone) return `${phone}@s.whatsapp.net`;
  if (/^\d{10,20}$/.test(raw)) return `${raw}@lid`;
  return '';
}

function uniqueJids(values) {
  const seen = new Set();
  const jids = [];
  for (const value of values) {
    const jid = normalizeJidCandidate(value);
    if (!jid || seen.has(jid)) continue;
    seen.add(jid);
    jids.push(jid);
  }
  return jids;
}

function replyJidsFromMessage(msg, senderNumber) {
  const key = msg?.key || {};
  const mappedPhone = phoneFromMappedLid(key.remoteJid);
  return uniqueJids([
    mappedPhone,
    senderNumber,
    key.remoteJid,
    key.senderPn,
    key.participantPn,
    key.participant,
    msg?.senderPn,
    msg?.participantPn,
    msg?.participant
  ]);
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
    provinsi: 'province',
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

function buildOrderProductAndTotal(fields, prefill, pay) {
  const selected = inferOrderPackage(fields, prefill);
  const product = prefill.product || `SUKUMBA ${selected.quantity} box - ${selected.price}`;
  let total = prefill.total || selected.price;
  if (pay === 'COD') total = selected.quantity === '2' ? 'Rp 169.000' : 'Rp 109.000';
  if (pay === 'TRF') total = selected.quantity === '2' ? 'Rp 169.001' : 'Rp 109.001';
  return { product, quantity: selected.quantity, total };
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
  if (!normalizePhoneNumber(fields.phone || '')) missing.push('No. Hp');
  if (!fields.street || fields.street.length < 5) missing.push('Alamat Jalan');
  if (!fields.district) missing.push('Kecamatan');
  if (!fields.city) missing.push('Kab/Kota');
  if (!fields.province) missing.push('Provinsi');
  if (!fields.payment || !/\b(cod|trf|transfer)\b/i.test(fields.payment)) missing.push('Pembayaran COD/TRF');
  return missing;
}

function paymentMode(value) {
  const lower = String(value || '').toLowerCase();
  if (/\b(cod|bayar ditempat|bayar di tempat)\b/i.test(lower)) return 'COD';
  if (/\b(tf|trf|transfer)\b/i.test(lower)) return 'TRF';
  return '';
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

  const pay = paymentMode(fields.payment);
  const prefill = buildOrderPrefill(orderSessions[from]);
  if (!prefill.payment) prefill.payment = pay;
  const address = buildOrderAddress(fields);
  const phone = normalizePhoneNumber(fields.phone);
  const { product, quantity, total } = buildOrderProductAndTotal(fields, prefill, pay);
  const notes = [
    `Pembayaran: ${pay}`,
    fields.age ? `Usia: ${fields.age}` : '',
    fields.complaint ? `Keluhan: ${fields.complaint}` : '',
  ].filter(Boolean).join('\n');
  const idempotencyKey = `form-${senderNumber}-${crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)}`;

  const res = await axios.post(`${ADMIN_URL}/api/orders`, {
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
    user_number: senderNumber,
    user_name: fields.name.trim(),
    phone,
    address,
    product,
    quantity,
    notes,
    total,
    source: 'WhatsApp Form',
    idempotency_key: idempotencyKey,
  }, axiosConfig);

  removeOrderSession(from);
  const orderId = res.data.order_id;
  const duplicateNote = res.data.duplicate ? '\n\nData ini sudah pernah masuk sebelumnya, jadi tidak dibuat dobel ya Kak.' : '';
  await sendTextAndRemember(
    sock,
    from,
    senderNumber,
    `Terima kasih Kak, data pesanan sudah CS Syifa terima.\n\nOrder ID: #${orderId}\nNama: ${fields.name.trim()}\nHP: ${phone}\nPembayaran: ${pay}\nProduk: ${product}\nTotal: ${total}\n\nTim kami akan segera proses pesanan Kakak.${duplicateNote}`
  );

  try {
    await axios.post(`${AI_URL}/notify-order`, {
      order_id: orderId,
      user_name: fields.name.trim(),
      phone,
      address,
      product,
      quantity,
      total,
      notes,
      user_wa: senderNumber,
    }, axiosConfig);
  } catch (e) {
    log('WARN', `Order form #${orderId} tersimpan, notifikasi gagal: ${e.message}`);
  }

  log('INFO', `Structured order form saved as #${orderId} for ${senderNumber}`);
  return true;
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
      text: `ðŸš¨ *ESKALASI CS AI*\n\nðŸ‘¤ Customer: ${userName}\nðŸ“± Nomor: ${cleanNumber(from)}\nðŸ’¬ Pesan: "${userMessage.substring(0, 200)}"\n\nâš ï¸ Customer membutuhkan bantuan CS manusia!`
    });
    log('INFO', `Eskalasi notif sent to admin for ${cleanNumber(from)}`);
  } catch (e) { log('ERROR', `Notif eskalasi gagal: ${e.message}`); }
}

async function getHistory(userNumber) {
  try {
    const res = await axios.get(`${ADMIN_URL}/api/conversation/history/${userNumber}?limit=${MAX_HISTORY}`, axiosConfig);
    return res.data;
  } catch (e) { return []; }
}

async function saveHistory(userNumber, role, content) {
  try {
    await axios.post(`${ADMIN_URL}/api/conversation/history`, {
      user_number: userNumber, role, content,
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19)
    }, axiosConfig);
  } catch (e) { }
}

async function sendMessageWithDelay(sock, from, message, options = {}) {
  if (!sock) return;

  const isCustomer = isDirectCustomerJid(from);
  const adminJid = ADMIN_WA + '@s.whatsapp.net';
  const skipDelay = options.skipDelay === true;
  const altJids = Array.isArray(options.altJids) ? options.altJids : [];
  const { skipDelay: _skipDelay, altJids: _altJids, ...sendOptions } = options;

  if (isCustomer && from !== adminJid && !skipDelay) {
    try {
      await sock.sendPresenceUpdate('composing', from);
    } catch (e) {
      log('WARN', `Gagal mengirim status typing untuk ${from}: ${e.message}`);
    }

    const minDelay = Math.max(0, envInt('DELAY_MIN_MS', 5000));
    const maxDelay = Math.max(0, envInt('DELAY_MAX_MS', 12000));
    const upperDelay = Math.max(minDelay, maxDelay);
    const delayMs = upperDelay === 0 ? 0 : Math.floor(Math.random() * (upperDelay - minDelay + 1)) + minDelay;

    if (delayMs > 0) {
      log('INFO', `Menunda balasan ke ${cleanNumber(from)} selama ${delayMs}ms dengan status mengetik...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    try {
      await sock.sendPresenceUpdate('paused', from);
    } catch (e) { }
  }

  const sendTimeoutMs = Math.max(1000, envInt('WA_SEND_TIMEOUT_MS', 15000));
  const candidates = uniqueJids([
    ...(replyJidRegistry.get(from) || []),
    ...altJids,
    from
  ]);
  const sendAllReplyJids = envBool('WA_SEND_ALL_REPLY_JIDS', false) && candidates.length > 1;
  let lastError = null;
  let firstResult = null;
  let sentCount = 0;

  for (const jid of candidates) {
    try {
      const result = await Promise.race([
        sock.sendMessage(jid, message, sendOptions),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`send timeout ${sendTimeoutMs}ms`)), sendTimeoutMs))
      ]);
      log('INFO', `Balasan terkirim ke ${cleanNumber(jid)} via ${jid.endsWith('@lid') ? 'lid' : 'phone'}${result?.key?.id ? ` id=${result.key.id}` : ''}`);
      firstResult = firstResult || result;
      sentCount++;
      if (!sendAllReplyJids) return result;
    } catch (e) {
      lastError = e;
      log('WARN', `Gagal kirim balasan ke ${jid}: ${summarizeBaileysError(e)}`);
    }
  }

  if (sentCount > 0) {
    log('INFO', `Balasan dikirim ke ${sentCount}/${candidates.length} kandidat JID`);
    return firstResult;
  }

  throw lastError || new Error('Tidak ada JID tujuan valid untuk kirim balasan');
}

async function sendTextAndRemember(sock, from, senderNumber, text) {
  await sendMessageWithDelay(sock, from, { text });
  await saveHistory(senderNumber, 'assistant', text);
}

async function getProfile(userNumber) {
  try {
    const res = await axios.get(`${ADMIN_URL}/api/customer-profile/${userNumber}`, axiosConfig);
    const data = res.data || {};
    return { ...(data.profile || {}), summary: data.summary || '', updated_at: data.updated_at || '' };
  } catch (e) { return {}; }
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
  } catch (e) { }
}

async function getActiveHandoff(userNumber) {
  try {
    const res = await axios.get(`${ADMIN_URL}/api/ai-system/human-handoff/status/${userNumber}`, axiosConfig);
    return res.data && res.data.paused ? res.data.ticket || { status: 'in_progress' } : null;
  } catch (e) {
    log('WARN', `Gagal cek handoff ${userNumber}: ${e.message}`);
    return null;
  }
}

async function getAiSystemContext() {
  try {
    const res = await axios.get(`${ADMIN_URL}/api/ai-system/knowledge-context`, axiosConfig);
    return String((res.data && res.data.context) || '').trim();
  } catch (e) {
    log('WARN', `Gagal ambil Sistem AI context: ${e.message}`);
    return '';
  }
}

// ------------------------------------------------------------------
// 5. INTENT DETECTION
// ------------------------------------------------------------------
const ORDER_KEYWORDS = ['mau beli', 'mau pesan', 'mau pesen', 'mau order', 'ingin beli', 'ingin pesan', 'pengen beli', 'pengen pesan', 'saya beli', 'saya pesan', 'aku pesan', 'aku beli', 'ak mau', 'pesan sekarang', 'beli sekarang', 'order sekarang', 'pesan dong', 'beli dong', 'order dong', 'pesan deh', 'beli deh', 'mo beli', 'mo pesan', 'mo pesen', 'mo order', 'gas pesan', 'gas beli', 'tertarik beli', 'mau cobain', 'cara beli', 'cara pesan', 'cara pesen', 'cara order', 'cara pemesanan', 'langsung beli', 'langsung pesan', 'langsung pesen', 'langsung order', 'langsung checkout', 'langsung co'];
const ORDER_STATUS_KEYWORDS = ['nomor resi', 'resi', 'status pesanan', 'pesanan saya', 'order saya', 'cek pesanan', 'sudah pesan', 'udah pesan', 'tracking'];
const CANCEL_KEYWORDS = ['gak jadi', 'ga jadi', 'tidak jadi', 'batalkan', 'cancel'];
const MALE_HEALTH_KEYWORDS = ['burung', 'mr p', 'alat vital', 'ereksi', 'kurang keras', 'gak keras', 'ga keras', 'tidak keras', 'loyo', 'letoy', 'stamina pria', 'stamina ranjang', 'vitalitas', 'gairah', 'libido', 'cepat keluar', 'cepet keluar', 'ejakulasi', 'tahan lama', 'hubungan suami istri', 'hubungan intim', 'ranjang'];

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
  return ['info', 'info deh', 'info dong', 'info kak', 'produk', 'produk kak', 'info produk', 'tanya produk', 'jelasin', 'jelaskan'].includes(lower);
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
    await sendMessageWithDelay(sock, from, { video: { url }, caption });
  } else {
    await sendMessageWithDelay(sock, from, { image: { url }, caption });
  }
}

function isShortPurchaseRequest(text) {
  const lower = String(text || '').toLowerCase().trim().replace(/[.!?]+$/g, '');
  return ['pesan', 'pesen', 'order', 'beli', 'mau pesan', 'mau pesen', 'mau order', 'mau beli', 'lanjut pesan', 'lanjut order'].includes(lower);
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
    return 'Baik Kak, terima kasih. CS Syifa teruskan pesanan Kakak ke tim kami ya.';
  }
  if (isShortProductRequest(lower)) {
    return 'Sukumba adalah susu kuda Sumbawa/herbal untuk membantu stamina, energi, daya tahan tubuh, dan vitalitas, Kak. Diminum 2x sehari sesudah makan. Kakak mau info manfaat, cara minum, atau konsultasi dulu?';
  }
  if (isProductPackagingQuestion(lower)) {
    return productPackagingReply();
  }
  if (isShippingEstimateQuestion(lower)) {
    return 'Estimasi sampai 4-7 hari';
  }
  if (isTestimonialRequest(lower)) {
    return 'Boleh Kak, saya kirimkan testimoni customer SUKUMBA ya.';
  }
  if (isShortPurchaseRequest(lower) && (lastAssistantHasProductContext(history) || (profile && profile.active_flow === 'product') || hasPostOrderContext(history, profile))) {
    return 'Bisa Kak, CS Syifa bantu pemesanan pelan-pelan ya. Boleh nama penerima dulu?';
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
  if (/\b(jualan|produk|jual\s+apa|menjual|harga|harganya|khasiat|manfaat|kandungan|cara\s+minum|aturan\s+minum|dosis|promo|ongkir|cod|sukumba|info\s+produk|isi|netto|berat|gram|gr|sachet|bungkus|box|testimoni|testimonial|review|ulasan|bukti|hasil|pengiriman|kirim|sampai|estimasi)\b/i.test(lower)) {
    if (isProductPackagingQuestion(lower)) {
      return productPackagingReply();
    }
    if (isShippingEstimateQuestion(lower)) {
      return 'Estimasi sampai 4-7 hari';
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
    return 'Bisa Kak, CS Syifa bantu pemesanan pelan-pelan ya. Boleh nama penerima dulu?';
  }
  if (/\b(konsultasi|konsul|consult|consul|keluhan|stamina|burung|ereksi|loyo|vitalitas|cepat keluar|ejakulasi)\b/i.test(lower)) {
    if (/\b(burung|ereksi|loyo|vitalitas|cepat keluar|ejakulasi|greng|joss|jos)\b/i.test(lower)) {
      return 'Saya pahami Kak, vitalitas pria terasa kurang maksimal. Usia Kakak berapa, dan keluhan ini sudah berapa lama?';
    }
    return 'Boleh Kak, ceritain pelan-pelan dulu keluhan atau tujuan konsultasinya apa? Nanti saya arahkan dari kondisinya.';
  }
  if (isExplicitOrderRequest(lower)) {
    return profile && profile.name
      ? `Baik ${profile.name}, CS Syifa bantu pemesanan ya. Boleh nomor HP yang bisa dihubungi?`
      : 'Baik Kak, CS Syifa bantu pemesanan ya. Boleh nama penerima dulu?';
  }
  return 'Maaf Kak, koneksi sistem sedang kurang stabil. Tapi saya tetap bantu: mau info produk Sukumba atau konsultasi dulu?';
}

function isOfferAcceptance(text, history) {
  const lower = text.toLowerCase().trim().replace(/[.!?]+$/g, '');
  const accepted = ['ok coba', 'oke coba', 'iya coba', 'ya coba', 'boleh coba', 'saya coba', 'coba kak', 'coba dulu', 'boleh', 'ok', 'oke', 'ya', 'iya'].includes(lower)
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
  const shortAffirm = ['boleh', 'boleh deh', 'gas beli', 'gas pesen', 'gas order', 'yuk beli', 'yuk pesen', 'yuk order', 'mau beli', 'mau pesen', 'mau order', 'mo beli', 'mo pesen', 'mo order', 'pesen dong', 'beli dong', 'order dong', 'pesan dong', 'setuju beli', 'setuju pesan', 'deal beli', 'deal', 'lanjut pesan', 'lanjut order', 'iya beli', 'iya pesen', 'iya order', 'oke beli', 'oke pesen', 'oke order', 'ok beli', 'ok pesen', 'ok order'];
  const isAffirm = shortAffirm.some(kw => lower === kw || lower === kw + '!' || lower === kw + '.');
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
  } catch (e) { return 'general'; }
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
    await sock.sendMessage(from, { text: 'âŒ Teks closingan kosong.' });
    return;
  }
  log('INFO', `Closingan dari ${senderNumber}`);

  try {
    const parseRes = await axios.post(`${AI_URL}/parse-closing`, { text: cleanText }, { ...axiosConfig, timeout: 15000 });
    if (!parseRes.data.success) throw new Error(parseRes.data.error);
    const d = parseRes.data.data;
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    const saveRes = await axios.post(`${ADMIN_URL}/api/closings`, {
      timestamp: now, created_at: now,
      user_wa: senderNumber, raw_text: cleanText,
      ...d, status: 'draft', source: 'WA'
    }, axiosConfig);

    const closingId = saveRes.data.id;
    const val = d.nilai_cod ? `COD: Rp ${d.nilai_cod}` : `TRF: Rp ${d.harga_non_cod || '?'}`;

    await sock.sendMessage(from, {
      text: `âœ… *Closingan #${closingId} tersimpan!*\n\nðŸ‘¤ ${d.nama || '?'}\nðŸ“± ${d.telepon || '?'}\nðŸ“ ${(d.alamat || '?').substring(0, 50)}...\nðŸ“¦ ${d.produk || '?'} Ã— ${d.qty || 1}\nðŸ’° ${val}\n\n_Cek di Admin Panel â†’ tab Closings_`
    });
    log('INFO', `Closingan #${closingId} saved`);
  } catch (e) {
    log('ERROR', `Closingan error: ${e.message}`);
    await sock.sendMessage(from, { text: `âŒ Gagal parse closingan: ${e.message}` });
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

  const cancelWords = ['batal', 'cancel', 'gak jadi', 'ga jadi', 'tidak jadi'];
  if (cancelWords.some(w => text.toLowerCase().includes(w)) && step !== 'confirm') {
    removeOrderSession(from);
    await sendMessageWithDelay(sock, from, { text: 'Tidak apa-apa Kak, CS Syifa batalkan dulu ya. Ada yang mau ditanyakan lagi?' });
    return;
  }

  if (step === 'name' || step === 'phone') {
    const escapePattern = /tanya|belum|nanti|dulu|lihat|liat|cari|info|penasaran|mikir|pikir|liat-liat|kapan|berapa|apa|bagaimana|kenapa|dimana|siapa/i;
    if (text.includes('?') || escapePattern.test(text.toLowerCase())) {
      removeOrderSession(from);
      await sendMessageWithDelay(sock, from, { text: 'Oke Kak, CS Syifa bantu tanya-tanya dulu ya. Ada yang ingin ditanyakan?' });
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
      res.data.forEach((p, i) => { list += `${i + 1}. ${p.name} - ${p.price}\n`; });
      reply = list + '\nKetik angka atau nama produk:';
    } catch (e) {
      reply = 'Produk apa yang ingin CS Syifa proses, Kak?';
    }
  } else if (step === 'product') {
    if (!session.data.productList) {
      try {
        const r = await axios.get(`${ADMIN_URL}/api/public/products`, axiosConfig);
        session.data.productList = r.data;
      } catch (e) { }
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
      if (num && session.data.productList?.[num - 1]) {
        const p = session.data.productList[num - 1];
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
          session.data.productList?.forEach((p, i) => { list += `${i + 1}. ${p.name} - ${p.price}\n`; });
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
        const price = parseInt(pm[pm.length - 1].replace(/\./g, ''));
        total = `Rp ${(price * parseInt(d.quantity)).toLocaleString('id-ID')}`;
      }
    } catch (e) { }
    session.data.total = total;
    reply = `CS Syifa rangkum pesanannya ya Kak:\n\nNama: ${d.user_name}\nHP: ${d.phone}\nAlamat: ${d.address}\nProduk: ${d.product}\nJumlah: ${d.quantity}\nTotal: ${total}\nCatatan: ${d.notes || '-'}\n\nKetik *"konfirmasi"* kalau data sudah benar, atau *"batal"* kalau ingin dibatalkan.`;
  } else if (step === 'confirm') {
    const confirmWords = ['konfirmasi', 'konfrim', 'confirm', 'iya', 'ya', 'ok', 'oke', 'setuju', 'lanjut'];
    const cancelWords = ['batal', 'cancel', 'gak jadi', 'ga jadi'];
    if (confirmWords.some(w => text.toLowerCase().includes(w))) {
      try {
        const d = session.data;
        const res = await axios.post(`${ADMIN_URL}/api/orders`, {
          timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
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
        } catch (e) {
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
        } catch (e) { }
        log('INFO', `Order #${orderId} confirmed`);
      } catch (e) {
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
    return { products, faqs: faqs.slice(0, 3), testimonials: [] };

  let rp = products.map(p => ({ ...p, score: words.filter(w => `${p.name} ${p.speed || ''} ${p.price} ${(p.features || []).join(' ')}`.toLowerCase().includes(w)).length })).filter(p => p.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  let rf = faqs.map(f => ({ ...f, score: words.filter(w => `${f.question} ${f.answer}`.toLowerCase().includes(w)).length })).filter(f => f.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);

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
  } catch (e) {
    log('ERROR', `Failed to start WA socket: ${e.message}`);
    setWAStatus('disconnected', `start_failed:${e.message}`);
    scheduleReconnect(5000);
    return;
  }

  currentSock.ev.on('creds.update', (...args) => {
    if (generation !== connectionGeneration || sock !== currentSock) return;
    Promise.resolve(saveCredsFn(...args)).catch((e) => {
      log('ERROR', `Failed to save WA credentials: ${e.message}`);
    });
  });

  async function processIncomingMessage(activeSock, from, text, msg, senderNumber, userName) {
    await saveHistory(senderNumber, 'user', text);

    const activeHandoff = await getActiveHandoff(senderNumber);
    if (activeHandoff) {
      log('INFO', `AI paused for ${senderNumber}; active handoff #${activeHandoff.id || '-'}`);
      return;
    }

    try {
      if (await handleStructuredOrderForm(from, text, activeSock, senderNumber)) {
        return;
      }
    } catch (e) {
      log('ERROR', `Structured order form error: ${e.message}`);
      await sendTextAndRemember(activeSock, from, senderNumber, 'Maaf Kak, data formnya belum berhasil CS Syifa simpan. Boleh cek lagi formatnya atau kirim ulang sebentar lagi ya.');
      return;
    }

    if (orderSessions[from]) {
      await handleOrderFlow(from, text, activeSock, senderNumber);
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
      const isShortConfirm = ['ya', 'iya', 'ok', 'oke'].includes(text.toLowerCase().trim());

      const canStartOrder = shouldStartOrderFlow(text, dbHistory, profile);

      if (intent === 'order' && !canStartOrder) {
        log('INFO', 'Order intent held for consultation context');
        // Lewat ke AI normal agar Konsultan Pria lanjut konsultasi, bukan langsung minta data order.
      } else if (intent === 'order' && isShortConfirm && !hasProductContext) {
        log('INFO', 'Context check: shortConfirm=' + isShortConfirm + ', hasProductContext=' + hasProductContext + ', historyCount=' + dbHistory.length);
        // Lewat ke AI normal untuk context-aware response
      } else if (intent === 'order') {
        setOrderSession(from, { step: 'name', data: {}, lastActivity: Date.now(), startedAt: Date.now() });
        await sendMessageWithDelay(activeSock, from, { text: 'Baik Kak, CS Syifa bantu pemesanan ya. Boleh nama penerima dulu?' });
        return;
      }

      let companyInfo = { name: 'Sukumba', location: 'Sumbawa, NTB', hours: 'Senin-Sabtu 08:00-17:00' };
      let products = [], faqs = [], testimonials = [];
      try {
        const [sRes, pRes, fRes, tRes, aiSystemRes] = await Promise.all([
          axios.get(`${ADMIN_URL}/api/public/settings`, axiosConfig),
          axios.get(`${ADMIN_URL}/api/public/products`, axiosConfig),
          axios.get(`${ADMIN_URL}/api/public/faqs`, axiosConfig),
          axios.get(`${ADMIN_URL}/api/public/testimonials`, axiosConfig),
          getAiSystemContext()
        ]);
        const s = sRes.data;
        companyInfo = { name: s.company_name || 'Sukumba', location: s.company_location || 'Sumbawa, NTB', hours: s.company_hours || 'Senin-Sabtu 08:00-17:00' };
        products = pRes.data; faqs = fRes.data; testimonials = tRes.data;
        if (aiSystemRes) companyInfo.aiSystemContext = aiSystemRes;
      } catch (e) { }

      const { products: rp, faqs: rf, testimonials: rt } = findRelevantContext(text, products, faqs, testimonials);

      let knowledgeContext = '';
      if (rp.length) { knowledgeContext += 'PRODUK RELEVAN:\n'; rp.forEach(p => { knowledgeContext += `- [ID:${p.id}] ${p.name}: ${p.price}\n  Fitur: ${(p.features || []).join(', ')}\n`; }); }
      if (rf.length) { knowledgeContext += '\nFAQ RELEVAN:\n'; rf.forEach(f => { knowledgeContext += `- Q: ${f.question}\n  A: ${f.answer}\n`; }); }
      if (companyInfo.aiSystemContext) knowledgeContext += '\n\nSISTEM AI AKTIF:\n' + companyInfo.aiSystemContext + '\n';

      let orderContext = '';
      try {
        const oRes = await axios.get(`${ADMIN_URL}/api/orders`, axiosConfig);
        const userOrders = oRes.data.filter(o => o.user_number?.replace(/\D/g, '') === senderNumber.replace(/\D/g, ''));
        if (userOrders.length) {
          orderContext = '\nRIWAYAT PESANAN:\n';
          userOrders.slice(0, 3).forEach(o => { orderContext += `- Order #${o.id}: ${o.product}, Status:${o.status}\n`; });
        }
      } catch (e) { }

      const photoCatalog = [];
      rp.forEach(p => { if (p.image_url) photoCatalog.push({ type: 'product', id: p.id, name: p.name, url: p.image_url }); });
      rf.forEach(f => { if (f.image_url) photoCatalog.push({ type: 'faq', id: f.id, name: f.question, url: f.image_url, answer: f.answer || '' }); });
      rt.forEach(t => { if (t.media_url) photoCatalog.push({ type: 'testimonial', id: t.id, name: t.title, url: t.media_url, answer: t.caption || '' }); });

      const response = await axios.post(`${AI_URL}/ai-chat`, {
        content: text,
        history: dbHistory.slice(0, -1),
        profile,
        userNumber: senderNumber,
        knowledgeContext: knowledgeContext + orderContext,
        companyInfo,
        photoCatalog
      }, axiosConfig);

      let aiReply = response.data.choices[0].message.content;
      const aiMeta = response.data._meta || {};
      await saveProfile(senderNumber, aiMeta.profile_updates, aiMeta.summary);

      if (aiMeta.needs_handoff || aiMeta.intent === 'escalation' || aiMeta.intent === 'complaint')
        await notifAdminEskalasi(from, userName, text);

      aiReply = aiReply.replace(/diskon\s+\d+%/gi, '').replace(/promo\s+diskon[^.!?\n]*/gi, '').replace(/knowledge base/gi, '').replace(/klik FAQ/gi, 'tanyakan langsung').trim();

      const photoSignals = [];
      const photoRegex = /\[PHOTO:(product|faq|testimonial):(\d+)\]/gi;
      let match;
      while ((match = photoRegex.exec(aiReply)) !== null) photoSignals.push({ type: match[1], id: parseInt(match[2]) });
      aiReply = aiReply.replace(/\[PHOTO:(product|faq|testimonial):\d+\]/gi, '').trim();
      if (isTestimonialRequest(text) && photoSignals.length === 0) {
        const testimonialLimit = Math.max(1, Math.min(parseInt(process.env.TESTIMONIAL_MEDIA_LIMIT || '3', 10) || 3, 10));
        photoCatalog
          .filter(item => item.type === 'testimonial')
          .slice(0, testimonialLimit)
          .forEach(item => photoSignals.push({ type: item.type, id: item.id }));
        log('INFO', `Testimonial request detected. Media queued: ${photoSignals.length}/${photoCatalog.length}`);
      }

      await saveHistory(senderNumber, 'assistant', aiReply);
      await sendMessageWithDelay(activeSock, from, { text: aiReply });

      if (aiMeta.start_order) {
        const prefill = aiMeta.order_prefill || {};
        const data = {};
        if (Object.keys(prefill).length) data.order_prefill = prefill;
        if (userName && userName !== senderNumber) data.display_name = userName;
        if (prefill.phone) data.phone = normalizePhoneNumber(String(prefill.phone));
        const step = data.phone ? 'address' : 'name';
        setOrderSession(from, { step, data, lastActivity: Date.now(), startedAt: Date.now() });
        log('INFO', `Order session started by AI meta for ${senderNumber}`);
      }

      for (const signal of photoSignals) {
        const item = photoCatalog.find(p => p.type === signal.type && p.id === signal.id);
        if (item) {
          try {
            log('INFO', `Sending media ${item.type}:${item.id} ${item.url}`);
            await sendCatalogMedia(activeSock, from, item);
          } catch (e) {
            log('ERROR', `Failed sending media ${item.type}:${item.id}: ${e.message}`);
          }
        }
      }

      try {
        await axios.post(`${ADMIN_URL}/api/log-conversation`, {
          timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
          user_number: senderNumber,
          user_message: text, ai_response: aiReply,
          kb_context: knowledgeContext.substring(0, 300)
        }, axiosConfig);
      } catch (e) { }

    } catch (err) {
      log('ERROR', `Error processing message: ${err.message}`);
      const fallbackReply = localSafeFallbackReply(text, dbHistory || [], profile || {});
      await saveHistory(senderNumber, 'assistant', fallbackReply);
      await sendMessageWithDelay(activeSock, from, { text: fallbackReply });
    }
  }

  currentSock.ev.on('messages.upsert', async ({ messages }) => {
    if (generation !== connectionGeneration || sock !== currentSock) return;
    const msg = messages[0];
    if (!msg.message) return;
    if (msg.key.fromMe) {
      log('INFO', `Skip outgoing/fromMe message: ${msg.key.remoteJid || '-'}`);
      return;
    }

    const from = msg.key.remoteJid;
    if (!isDirectCustomerJid(from)) {
      log('INFO', `Skip non-customer chat: ${from}`);
      return;
    }
    const senderNumber = resolveSenderNumber(msg);
    const userName = msg.pushName || senderNumber;
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    if (!text) return;
    const replyJids = replyJidsFromMessage(msg, senderNumber);
    replyJidRegistry.set(from, replyJids);

    log('INFO', `📩 Dari ${senderNumber}: ${text.substring(0, 80)} | from=${from} | replyJids=${replyJids.join(',')}`);

    // CEK #closingan - Langsung eksekusi tanpa debounce agar admin command cepat direspon
    if (text.toLowerCase().includes('#closingan')) {
      await handleClosingan(from, text, senderNumber);
      return;
    }

    // Ambil registrasi debounce untuk nomor ini
    let registry = debounceRegistry.get(from);
    if (registry) {
      clearTimeout(registry.timer);
      registry.texts.push(text);
      registry.msg = msg; // Update data pengirim ke yang terbaru
      registry.userName = userName;
    } else {
      registry = {
        texts: [text],
        msg,
        senderNumber,
        userName,
        timer: null
      };
      debounceRegistry.set(from, registry);
    }

    const debounceTime = Math.max(0, envInt('DEBOUNCE_TIME_MS', 3000));

    registry.timer = setTimeout(async () => {
      debounceRegistry.delete(from);
      try {
        const combinedText = registry.texts.join('\n').trim();
        const latestMsg = registry.msg;
        const currentSenderNumber = registry.senderNumber;
        const currentUserName = registry.userName;

        log('INFO', `[Debounce] Memproses ${registry.texts.length} pesan gabungan untuk ${currentSenderNumber}: "${combinedText.substring(0, 100).replace(/\r?\n/g, ' ')}..."`);

        await processIncomingMessage(currentSock, from, combinedText, latestMsg, currentSenderNumber, currentUserName);
      } catch (err) {
        log('ERROR', `Error di dalam pemrosesan pesan debounce: ${err.message}`);
      }
    }, debounceTime);
  });

  currentSock.ev.on('messages.update', (updates) => {
    if (generation !== connectionGeneration || sock !== currentSock) return;
    for (const update of updates || []) {
      const key = update.key || {};
      if (!key.fromMe) continue;
      const status = update.update && Object.prototype.hasOwnProperty.call(update.update, 'status')
        ? update.update.status
        : null;
      if (status === null) continue;
      log('INFO', `Status pesan keluar ${key.id || '-'} ke ${cleanNumber(key.remoteJid || '')}: ${status}`);
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
    if (connection === 'open') {
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
    if (connection === 'close') {
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
      if (reason === DisconnectReason.loggedOut) {
        const logoutKind = baileysLogoutKind(lastDisconnect?.error);
        setWAStatus('waiting_scan', `logged_out:${logoutKind}`);
        log('WARN', `Connection logged out (${logoutKind}). ${logoutAdvice(logoutKind)}`);
        resetAuthDir(`auto_logged_out:${logoutKind}`);
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
app.post('/send-message', requireInternalAuth, async (req, res) => {
  const { to, message } = req.body || {};
  const cleanTo = String(to || '').trim();
  const cleanMessage = String(message || '').trim();
  if (!cleanTo || !cleanMessage) return res.status(400).json({ success: false, error: 'Nomor tujuan dan pesan wajib diisi' });
  if (!sock || !isReady) return res.status(503).json({ success: false, error: 'WA not ready' });
  try {
    const jid = cleanTo.includes('@s.whatsapp.net') ? cleanTo : cleanTo + '@s.whatsapp.net';
    const result = await sock.sendMessage(jid, { text: cleanMessage });
    res.json({ success: true, messageId: result && result.key ? result.key.id : null });
  } catch (e) {
    log('ERROR', `send-message failed: ${summarizeBaileysError(e)}`);
    res.status(500).json({ success: false, error: e.message || 'Gagal mengirim pesan WhatsApp' });
  }
});

app.get('/wa-status', requireInternalAuth, (req, res) => res.json({
  status: waStatus,
  detail: waStatusDetail,
  updatedAt: waStatusUpdatedAt,
  isReady,
  hasQR: lastQR !== null,
  hasSocket: !!sock,
  reconnecting: !!reconnectTimer,
  lastDisconnectCode,
  auth: authDirStats()
}));

app.get('/wa-qr', requireInternalAuth, (req, res) => {
  if (!lastQR) return res.json({ success: false });
  res.json({ success: true, qr: lastQR });
});

app.post('/wa-disconnect', requireInternalAuth, async (req, res) => {
  try {
    connectionGeneration++;
    clearConnectionTimers();
    const oldSock = sock;
    stopCurrentSocket();
    lastQR = null;
    setWAStatus('disconnected', 'manual_disconnect');
    if (oldSock) {
      try { await oldSock.logout(); } catch (e) { }
    }
    res.json({ success: true, status: waStatus, detail: waStatusDetail });
  }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/wa-reconnect', requireInternalAuth, async (req, res) => {
  try {
    connectionGeneration++;
    clearConnectionTimers();
    stopCurrentSocket();
    lastQR = null;
    isReady = false;
    lastDisconnectCode = null;
    setWAStatus('connecting', 'manual_reconnect_keep_auth');
    setTimeout(connectToWhatsApp, 800);
    res.json({ success: true, status: waStatus, detail: waStatusDetail });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/wa-reset-session', requireInternalAuth, async (req, res) => {
  try {
    connectionGeneration++;
    clearConnectionTimers();
    stopCurrentSocket();
    resetAuthDir('manual_reset_auth');
    lastQR = null;
    isReady = false;
    lastDisconnectCode = null;
    setWAStatus('connecting', 'manual_reset_auth');
    setTimeout(connectToWhatsApp, 800);
    res.json({ success: true, status: waStatus, detail: waStatusDetail });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Health check
app.get('/health', (req, res) => res.json({
  status: 'ok',
  version: 'v2.6-save-creds-scope-fix',
  waStatus,
  waStatusDetail,
  isReady,
  hasQR: lastQR !== null,
  reconnecting: !!reconnectTimer,
  lastDisconnectCode,
  auth: authDirStats()
}));

// ------------------------------------------------------------------
// 11. START SERVER
// ------------------------------------------------------------------
acquireAuthLock();
process.once('SIGINT', () => {
  releaseAuthLock();
  process.exit(0);
});
process.once('SIGTERM', () => {
  releaseAuthLock();
  process.exit(0);
});
process.once('exit', releaseAuthLock);

app.listen(PORT, () => {
  const auth = authDirStats();
  log('INFO', `WA Gateway v2.6-save-creds-scope-fix on port ${PORT}`);
  log('INFO', `WA auth dir: ${auth.path} | files=${auth.files} | hasCreds=${auth.hasCreds}`);
  connectToWhatsApp();
});
