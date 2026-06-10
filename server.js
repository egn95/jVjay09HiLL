/* =============================================
   server.js â€” AKTA IAT Backend
   Node.js + Express | JSON file storage
   ============================================= */
'use strict';

require('dotenv').config();

const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcrypt');    // BCRYPT
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit   = require('express-rate-limit');
const ExcelJS     = require('exceljs');
const PDFDocument = require('pdfkit');
const nodemailer  = require('nodemailer');
const cron        = require('node-cron');
const compression = require('compression');
const morgan      = require('morgan');
const NodeCache   = require('node-cache');
const db          = require('./db');
const { runBackup, cleanOldBackups, listBackups, restoreBackup } = require('./backup');
const reports = require('./reports');
const sse     = require('./sse');
const mailer  = require('./mailer');
const { body, validationResult } = require('express-validator');

const app        = express();
const PORT       = process.env.PORT || 3000;
const PKG        = require('./package.json');
const JWT_SECRET         = process.env.JWT_SECRET || 'akta-iat-secret-2026-change-in-prod';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || JWT_SECRET + '-refresh';
const JWT_ACCESS_EXPIRY  = process.env.JWT_ACCESS_EXPIRY  || '1h';
const JWT_REFRESH_EXPIRY = process.env.JWT_REFRESH_EXPIRY || '7d';
const BCRYPT_ROUNDS      = parseInt(process.env.BCRYPT_ROUNDS, 10) || 12;
const DATA_DIR           = path.join(__dirname, 'data');

// â”€â”€ Logs directory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// â”€â”€ In-memory cache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const _cache = new NodeCache({ stdTTL: 15, checkperiod: 30, useClones: false });

function getCache(key)                { return _cache.get(key); }
function setCache(key, data, ttl)     { _cache.set(key, data, ttl ?? 15); }
function clearCache(prefix)           {
  _cache.keys().filter(k => k.startsWith(prefix)).forEach(k => _cache.del(k));
}

// â”€â”€ Response compression â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(compression());

// â”€â”€ Request logging (morgan) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  const _logStream = fs.createWriteStream(path.join(LOGS_DIR, 'access.log'), { flags: 'a' });
  app.use(morgan('combined', { stream: _logStream }));
}

// â”€â”€ Request rate counter (rolling 60s window) â”€â”€â”€â”€
let _reqCount  = 0;
let _reqWindow = Date.now();
app.use((req, _res, next) => { _reqCount++; next(); });
function _reqPerMin() {
  const now  = Date.now();
  const secs = (now - _reqWindow) / 1000;
  const rpm  = secs > 0 ? Math.round((_reqCount / secs) * 60) : 0;
  if (secs >= 60) { _reqCount = 0; _reqWindow = now; }
  return rpm;
}

// â”€â”€ Security middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(helmet({
  contentSecurityPolicy:     false,
  crossOriginEmbedderPolicy: false,
}));

// CORS: multi-origin support + dev mode
const _isDev = process.env.NODE_ENV === 'development';
const _allowedOrigins = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || 'http://localhost:3000')
  .split(',').map(o => o.trim()).filter(Boolean);
const _localPattern  = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/;
app.use(cors({
  origin(origin, cb) {
    if (_isDev || !origin) return cb(null, true);
    if (_allowedOrigins.includes(origin) || _localPattern.test(origin)) return cb(null, true);
    cb(new Error('CORS: origin tidak diizinkan â€” ' + origin));
  },
  credentials: true,
}));

// Rate limiter untuk login â€” max 10 percobaan per 15 menit per IP
const _loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    res.status(429).json({ error: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.' });
  },
});

const _apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 menit
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    res.status(429).json({ error: 'Terlalu banyak permintaan. Coba lagi dalam 1 menit.' });
  },
});
app.use('/api/', _apiLimiter);

app.use(express.json({
  limit: '50mb',
  // Jika body melebihi limit, Express akan throw PayloadTooLargeError â€” ditangani di error handler bawah
}));

// â”€â”€ Force cache-bust: redirect HTML tanpa versi ke URL berversi â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Memaksa browser memuat file terbaru, bahkan jika file lama sudah di-cache
const APP_VER = '20260609w';
app.get('/dashboard.html', (req, res, next) => {
  if (req.query.v === APP_VER) return next();
  return res.redirect(302, '/dashboard.html?v=' + APP_VER);
});
app.get('/login.html', (req, res, next) => {
  if (req.query.v === APP_VER) return next();
  return res.redirect(302, '/login.html?v=' + APP_VER);
});
app.get('/', (req, res) => {
  return res.redirect(302, '/login.html?v=' + APP_VER);
});

app.use(express.static(path.join(__dirname), {
  maxAge:       '0',
  etag:         false,
  lastModified: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js') || filePath.endsWith('.html') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

// â”€â”€ Data directory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DATA_KEYS = [
  // Core
  'akta_kas',
  'akta_plans',
  'akta_tasks',
  'akta_audit_kas',
  'akta_rekomendasi',
  'akta_menu_config',
  'akta_custom_users',
  'akta_saved_pemeriksaan',
  'akta_lampiran',
  'akta_sk',
  // SMH
  'akta_smh_onhand',
  'akta_smh_perlengkapan',
  'akta_smh_plafon',
  'akta_smh_unit_area',
  'akta_smh_harga',
  'akta_smh_hasil',
  'akta_smh_luar_fisik',
  // Grading
  'akta_grading_db',
  'akta_grading_sessions',
  // HGP
  'akta_hgp_stok',
  'akta_hgp_hasil',
  'akta_hgp_meta',
  'akta_hgp_wo',
  // BPKB
  'akta_bpkb_db',
  'akta_bpkb_scan',
  'akta_bpkb_info',
  // Pemeriksaan lainnya
  'akta_pemeriksaan_bank',
  'akta_meterai_tempel',
  'akta_piutang_reg',
  'akta_tunggakan_kds',
  'akta_ttp_gantung',
  'akta_lapos_bpkb',
  'akta_kwt_db',
  'akta_kwt_scan',
  // MT
  'akta_mt_database',
  'akta_mt_pemeriksaan',
  // Database tambahan
  'akta_het_db',
  // BU Performance
  'akta_bu_performance',
  // Rekomendasi & SK
  'akta_pem_menu_cfg',
  'akta_realisasi_sk',
  'akta_sk_notif',
  // Mandiri
  'akta_mandiri_jenis_cfg',
  'akta_mandiri_pengecekan',
  'akta_sertijab_cek',
  // Dashboard & config
  'akta_dash_chart_vals',
  'akta_dash_unit_vals',
  'akta_biaya_data',
  'akta_aktiv_override',
];

// â”€â”€ File-based fallback DB (digunakan ketika PostgreSQL tidak tersedia) â”€â”€
const FILE_DB_PATH = path.join(DATA_DIR, 'app_data.json');

function _fileDbReadAll() {
  try {
    if (!fs.existsSync(FILE_DB_PATH)) return {};
    return JSON.parse(fs.readFileSync(FILE_DB_PATH, 'utf8')) || {};
  } catch { return {}; }
}

function _fileDbRead(key) {
  const store = _fileDbReadAll();
  return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : [];
}

function _fileDbWrite(key, data) {
  try {
    const store = _fileDbReadAll();
    store[key]  = data;
    fs.writeFileSync(FILE_DB_PATH, JSON.stringify(store), 'utf8');
  } catch (e) { console.error('[filedb] write error:', key, e.message); }
}

async function dbRead(key) {
  try {
    const { rows } = await db.query('SELECT data_value FROM app_data WHERE data_key = $1', [key]);
    if (rows.length > 0) return rows[0].data_value;
    // Key belum ada di PostgreSQL â€” cek file fallback (mungkin diisi sebelum PG tersedia)
    return _fileDbRead(key);
  } catch (e) {
    // PostgreSQL tidak tersedia â€” baca dari file
    return _fileDbRead(key);
  }
}

async function dbWrite(key, data) {
  // Selalu tulis ke file terlebih dahulu agar data tidak hilang saat server restart
  _fileDbWrite(key, data);
  try {
    await db.query(
      'INSERT INTO app_data (data_key, data_value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (data_key) DO UPDATE SET data_value = EXCLUDED.data_value, updated_at = NOW()',
      [key, JSON.stringify(data)]
    );
  } catch {
    // PostgreSQL tidak tersedia â€” data sudah tersimpan di file, tidak perlu log error berulang
  }
}

// Password overrides untuk built-in USERS (diubah via change-password)
const PASSWORDS_KEY = 'akta_user_passwords';
// â”€â”€ Activity Log â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const LOG_KEY = 'akta_activity_log';
const LOG_MAX = 5000;

async function initDbData() {
  const OBJ_KEYS = new Set([PASSWORDS_KEY, 'akta_menu_config', 'akta_pem_menu_cfg', 'akta_mandiri_jenis_cfg', 'akta_dash_chart_vals', 'akta_dash_unit_vals', 'akta_aktiv_override']);
  const allKeys = [...DATA_KEYS, PASSWORDS_KEY];
  for (const k of allKeys) {
    const def = OBJ_KEYS.has(k) ? '{}' : '[]';
    await db.query(
      'INSERT INTO app_data (data_key, data_value) VALUES ($1, $2::jsonb) ON CONFLICT (data_key) DO NOTHING',
      [k, def]
    );
  }
  // Tabel users (dibuat otomatis jika belum ada â€” fallback jika migration 003 belum dijalankan)
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL       PRIMARY KEY,
      username      VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      display_name  VARCHAR(200),
      role          VARCHAR(50)  NOT NULL DEFAULT 'auditor',
      unit_usaha    VARCHAR(100) DEFAULT '',
      is_disabled   BOOLEAN      DEFAULT false,
      created_by    VARCHAR(100),
      created_at    TIMESTAMPTZ  DEFAULT NOW(),
      updated_at    TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)');

  // Tabel refresh_tokens
  await db.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id         BIGSERIAL    PRIMARY KEY,
      token      VARCHAR(512) UNIQUE NOT NULL,
      username   VARCHAR(100) NOT NULL,
      expires_at TIMESTAMPTZ  NOT NULL,
      created_at TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS idx_rt_token    ON refresh_tokens(token)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_rt_username ON refresh_tokens(username)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_rt_expires  ON refresh_tokens(expires_at)');

  // Tabel notifications (inbox per-user)
  await db.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id               BIGSERIAL    PRIMARY KEY,
      username         VARCHAR(100) NOT NULL,
      title            VARCHAR(200) NOT NULL,
      message          TEXT,
      type             VARCHAR(50)  DEFAULT 'info',
      is_read          BOOLEAN      DEFAULT false,
      created_at       TIMESTAMPTZ  DEFAULT NOW(),
      related_resource VARCHAR(100),
      related_id       VARCHAR(100)
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(username, is_read, created_at DESC)');
}

function writeLog(req, action, resource, detail) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  db.query(
    'INSERT INTO activity_log (timestamp, username, display_name, role, action, resource, detail, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      new Date().toISOString(),
      req.user?.username    || req.body?.username || 'anonymous',
      req.user?.displayName || '',
      req.user?.role        || '',
      action,
      resource || '',
      detail   || '',
      ip,
      (req.headers['user-agent'] || '').slice(0, 200),
    ]
  ).catch(e => console.error('[writeLog]', e.message));
}

// â”€â”€ Notification helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * Simpan notifikasi ke DB dan push real-time via SSE.
 * @param {string} username
 * @param {string} title
 * @param {string} message
 * @param {'info'|'warning'|'success'|'error'} type
 * @param {string} [resource]
 * @param {string} [relatedId]
 */
async function createNotif(username, title, message, type, resource, relatedId) {
  let id;
  try {
    const { rows } = await db.query(
      'INSERT INTO notifications(username,title,message,type,related_resource,related_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [username, title, message || '', type || 'info', resource || null, relatedId || null]
    );
    id = rows[0]?.id;
  } catch (e) {
    console.error('[createNotif]', e.message);
    return;
  }
  sse.sendToUser(username, 'notification', { id, title, message, type, resource, relatedId, createdAt: new Date().toISOString(), isRead: false });
}

/**
 * Simpan notifikasi ke semua user dengan role tertentu.
 */
async function createNotifRole(role, title, message, type, resource, relatedId) {
  try {
    const { rows } = await db.query(
      `SELECT username FROM users WHERE role = $1 AND (is_disabled IS NULL OR is_disabled = false)`,
      [role]
    );
    for (const { username } of rows) {
      await createNotif(username, title, message, type, resource, relatedId);
    }
  } catch (e) {
    console.error('[createNotifRole]', e.message);
  }
}

// â”€â”€ Failed login tracker (in-memory) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Map: IP â†’ { count, firstAt }
const _failedLogins = new Map();
// Bersihkan entri lama setiap 10 menit
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [ip, v] of _failedLogins) {
    if (v.firstAt < cutoff) _failedLogins.delete(ip);
  }
}, 10 * 60 * 1000);

function _trackFailedLogin(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
  const prev = _failedLogins.get(ip) || { count: 0, firstAt: Date.now() };
  prev.count++;
  _failedLogins.set(ip, prev);
  if (prev.count === 5) {
    const adminEmail = process.env.ADMIN_EMAIL || process.env.NOTIFY_EMAIL_ADMIN || '';
    const username   = req.body?.username || 'unknown';
    mailer.sendMail(
      adminEmail,
      '[AKTA IAT] âš  Alert: 5 Percobaan Login Gagal',
      mailer.emailTemplate(
        'Peringatan: Login Gagal Berulang',
        `Terdeteksi 5 percobaan login gagal dari IP yang sama dalam 30 menit terakhir.`,
        [
          ['IP Address', ip],
          ['Username Dicoba', username],
          ['Jumlah Gagal', String(prev.count)],
          ['Pertama Kali', new Date(prev.firstAt).toLocaleString('id-ID')],
          ['Waktu Deteksi', new Date().toLocaleString('id-ID')],
        ],
        'Jika ini bukan aktivitas yang dikenali, periksa log akses dan pertimbangkan memblokir IP tersebut.'
      )
    );
  }
}

// â”€â”€ Backup System â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const BACKUP_RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS, 10) || 30;

// Req sintetis untuk log dari scheduler (bukan request HTTP sungguhan)
const _sysReq = { user: { username: 'system', displayName: 'System Scheduler', role: 'system' }, ip: '127.0.0.1', headers: {} };

function _dateStr(d) {
  return (d || new Date()).toISOString().slice(0, 10); // YYYY-MM-DD
}

// Backup harian pukul 01:00 via node-cron
cron.schedule('0 1 * * *', async () => {
  console.log('[backup] Memulai backup harianâ€¦');
  const adminEmail = process.env.ADMIN_EMAIL || process.env.NOTIFY_EMAIL_ADMIN || '';
  try {
    const result  = await runBackup();
    const removed = cleanOldBackups(BACKUP_RETENTION_DAYS);
    const detail  = `pg_dump â†’ ${result.filePath} (${result.fileSizeHuman}, ${result.duration}ms)${result.s3Path ? ' â†’ ' + result.s3Path : ''}${removed ? ` | ${removed} folder lama dihapus` : ''}`;
    writeLog(_sysReq, 'BACKUP', 'system', detail);
    mailer.sendMail(
      adminEmail, '[AKTA IAT] âœ“ Backup Harian Berhasil',
      mailer.emailTemplate('Backup Harian Berhasil', 'Database AKTA IAT berhasil dibackup.', [
        ['Status',    'âœ“ Berhasil'],
        ['File',      result.filePath || '-'],
        ['Ukuran',    result.fileSizeHuman || '-'],
        ['Durasi',    `${result.duration} ms`],
        ['Cloud',     result.s3Path || 'Tidak diaktifkan'],
        ['Dihapus',   removed ? `${removed} folder lama` : '-'],
        ['Waktu',     new Date().toLocaleString('id-ID')],
      ], null)
    );
  } catch (e) {
    console.error('[backup] Backup harian gagal:', e.message);
    writeLog(_sysReq, 'BACKUP', 'system', `GAGAL: ${e.message}`);
    mailer.sendMail(
      adminEmail, '[AKTA IAT] âœ— Backup Harian GAGAL',
      mailer.emailTemplate('Backup Harian GAGAL', 'Terjadi kesalahan saat melakukan backup database.', [
        ['Status', 'âœ— Gagal'],
        ['Error',  e.message],
        ['Waktu',  new Date().toLocaleString('id-ID')],
      ], 'Segera periksa server dan pastikan backup berhasil sebelum data hilang.')
    );
  }
}, { timezone: 'Asia/Jakarta' });

// â”€â”€ Notification System â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const _smtpConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const _mailer = _smtpConfigured
  ? nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT, 10) || 587,
      secure: parseInt(process.env.SMTP_PORT, 10) === 465,
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;
const APP_URL      = process.env.APP_URL              || 'http://localhost:3000';
const NOTIFY_ADMIN = process.env.NOTIFY_EMAIL_ADMIN   || '';
const SMTP_FROM    = process.env.SMTP_FROM             || (process.env.SMTP_USER ? `AKTA IAT <${process.env.SMTP_USER}>` : '');

// Kirim email â€” graceful: gagal tidak crash server
async function sendNotification(to, subject, htmlBody) {
  if (!_mailer) { console.warn('[notify] SMTP tidak dikonfigurasi â€” dilewati:', subject); return; }
  if (!to)      { console.warn('[notify] Penerima kosong â€” dilewati:', subject); return; }
  try {
    await _mailer.sendMail({ from: SMTP_FROM, to, subject, html: htmlBody });
    writeLog(_sysReq, 'NOTIFY', 'email', `â†’ ${to} | ${subject}`);
    console.log(`[notify] Terkirim â†’ ${to}: ${subject}`);
  } catch (e) {
    console.error('[notify] Gagal kirim email:', e.message);
  }
}

// Bangun HTML email
function _emailHtml(title, intro, tableRows, footerNote) {
  const rows = tableRows.map(([label, value]) =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;color:#374151;width:160px;background:#f8fafc;white-space:nowrap">${label}</td>` +
    `<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#1f2937">${value}</td></tr>`
  ).join('');
  return `<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)">
  <div style="background:linear-gradient(135deg,#1e3a8a,#4f46e5);padding:28px 32px">
    <div style="font-size:22px;font-weight:700;color:#fff;letter-spacing:.5px">AKTA IAT</div>
    <div style="font-size:12px;color:rgba(255,255,255,.7);margin-top:3px">Honda Dealer Audit System</div>
  </div>
  <div style="padding:28px 32px">
    <h2 style="margin:0 0 8px;font-size:18px;color:#1e3a8a">${title}</h2>
    <p style="margin:0 0 20px;color:#6b7280;font-size:14px">${intro}</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;font-size:14px">
      ${rows}
    </table>
    ${footerNote ? `<p style="margin:16px 0 0;font-size:13px;color:#6b7280">${footerNote}</p>` : ''}
  </div>
  <div style="padding:0 32px 20px">
    <a href="${APP_URL}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600">Buka Aplikasi</a>
  </div>
  <div style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;font-size:12px;color:#9ca3af">
    Email ini dikirim otomatis oleh AKTA IAT pada ${new Date().toLocaleString('id-ID')}. Jangan balas email ini.
  </div>
</div>
</body></html>`;
}

// Cek kondisi dan kirim notifikasi harian
async function runDailyNotifications() {
  if (!_mailer || !NOTIFY_ADMIN) return;
  console.log('[notify] Menjalankan pengecekan harianâ€¦');
  const today  = new Date(); today.setHours(0, 0, 0, 0);
  const h3     = new Date(today); h3.setDate(h3.getDate() + 3);
  const h3Str  = h3.toISOString().slice(0, 10);

  // 1. Task H-3
  const tasks = (await dbRead('akta_tasks')).filter(t => {
    const tgl = (t.tglMulai || t.tanggal || '').slice(0, 10);
    return tgl === h3Str && !['selesai', 'done', 'completed'].includes((t.status || '').toLowerCase());
  });
  for (const t of tasks) {
    await sendNotification(
      NOTIFY_ADMIN,
      `[AKTA IAT] Reminder: Task Audit H-3 â€” ${t.noSPT || t.cabangPlan || t.id}`,
      _emailHtml(
        'Pengingat Task Audit H-3',
        'Terdapat task audit yang dijadwalkan <strong>3 hari lagi</strong>. Pastikan persiapan sudah dilakukan.',
        [
          ['No. SPT',    t.noSPT || '-'],
          ['Cabang',     t.cabangPlan || t.cabang || '-'],
          ['Tipe Audit', t.tipeAudit || t.jenis || '-'],
          ['Tanggal',    t.tglMulai || t.tanggal || '-'],
          ['Auditor',    t.auditor || t.namaPemeriksa || '-'],
          ['Status',     t.status || '-'],
        ],
        'Silakan login untuk melihat detail task.'
      )
    );
  }

  // 2. SK pending_manajer > 2 hari
  const cutoff2        = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const reks           = await dbRead('akta_rekomendasi');
  const pendingManajer = reks.filter(r => (r.status || '').toLowerCase() === 'pending_manajer' && r.updatedAt && new Date(r.updatedAt).getTime() < cutoff2);
  if (pendingManajer.length > 0) {
    await sendNotification(
      NOTIFY_ADMIN,
      `[AKTA IAT] ${pendingManajer.length} SK Menunggu Persetujuan Manajer (>2 hari)`,
      _emailHtml(
        'Reminder: SK Pending Manajer',
        `Terdapat <strong>${pendingManajer.length} item</strong> yang menunggu persetujuan Manajer lebih dari 2 hari.`,
        pendingManajer.slice(0, 10).map(r => [r.judul || r.title || String(r.id), `Sejak: ${_fmtDate(r.updatedAt)}`]),
        pendingManajer.length > 10 ? `â€¦dan ${pendingManajer.length - 10} item lainnya.` : null
      )
    );
  }

  // 3. SK pending_afd > 2 hari
  const pendingAfd = reks.filter(r => (r.status || '').toLowerCase() === 'pending_afd' && r.updatedAt && new Date(r.updatedAt).getTime() < cutoff2);
  if (pendingAfd.length > 0) {
    await sendNotification(
      NOTIFY_ADMIN,
      `[AKTA IAT] ${pendingAfd.length} SK Menunggu Persetujuan AFD (>2 hari)`,
      _emailHtml(
        'Reminder: SK Pending AFD',
        `Terdapat <strong>${pendingAfd.length} item</strong> yang menunggu persetujuan AFD lebih dari 2 hari.`,
        pendingAfd.slice(0, 10).map(r => [r.judul || r.title || String(r.id), `Sejak: ${_fmtDate(r.updatedAt)}`]),
        pendingAfd.length > 10 ? `â€¦dan ${pendingAfd.length - 10} item lainnya.` : null
      )
    );
  }
}

// Jadwal harian pukul 08:00
(function _scheduleNotifications() {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(8, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(function tick() {
    runDailyNotifications().catch(e => console.error('[notify] Error:', e.message));
    setTimeout(tick, 24 * 60 * 60 * 1000);
  }, next - now);
  if (_smtpConfigured) console.log(`  Notify : terjadwal pukul 08:00 (${Math.round((next - now) / 60000)} menit lagi)`);
  else                 console.log('  Notify : âš  SMTP tidak dikonfigurasi');
})();

// Cron per-jam: cek kondisi dan push SSE in-app notification
cron.schedule('0 * * * *', async () => {
  try {
    const now    = new Date();
    const h3Date = new Date(now); h3Date.setDate(h3Date.getDate() + 3);
    const h3Str  = h3Date.toISOString().slice(0, 10);

    // 1. Plan audit H-3 â†’ notify koordinator via SSE
    const plans = await dbRead('akta_plans');
    for (const p of plans) {
      const tgl = (p.tglMulai || p.tanggal || '').slice(0, 10);
      if (tgl !== h3Str) continue;
      if (['selesai', 'done', 'batal'].includes((p.status || '').toLowerCase())) continue;
      const msg = `Plan audit di ${p.cabangPlan || p.cabang || p.id} dijadwalkan 3 hari lagi (${tgl}).`;
      await createNotifRole('koordinator', 'Reminder: Audit H-3', msg, 'warning', 'akta_plans', String(p.id));
      await createNotifRole('admin',       'Reminder: Audit H-3', msg, 'info',    'akta_plans', String(p.id));
    }

    // 2. SK pending_manajer > 24 jam â†’ notify manajer + admin
    const reks   = await dbRead('akta_rekomendasi');
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const r of reks) {
      if ((r.status || '').toLowerCase() !== 'pending_manajer') continue;
      if (!r.updatedAt || new Date(r.updatedAt).getTime() > cutoff) continue;
      const msg = `SK "${r.judul || r.id}" menunggu persetujuan Manajer lebih dari 24 jam.`;
      await createNotifRole('manajer', 'Pending Approval: SK Manajer', msg, 'warning', 'akta_rekomendasi', String(r.id));
      await createNotifRole('admin',   'Pending Approval: SK Manajer', msg, 'info',    'akta_rekomendasi', String(r.id));
    }

    // 3. SK pending_manajer baru (< 1 jam) â†’ notify manajer
    const recentCutoff = Date.now() - 60 * 60 * 1000;
    for (const r of reks) {
      if ((r.status || '').toLowerCase() !== 'pending_manajer') continue;
      if (!r.updatedAt || new Date(r.updatedAt).getTime() < recentCutoff) continue;
      const msg = `SK baru "${r.judul || r.id}" menunggu persetujuan Anda.`;
      await createNotifRole('manajer', 'SK Baru Menunggu Persetujuan', msg, 'info', 'akta_rekomendasi', String(r.id));
    }
  } catch (e) {
    console.error('[cron-notif]', e.message);
  }
}, { timezone: 'Asia/Jakarta' });

// â”€â”€ Users (mirror of auth.js USERS) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const USERS = [
  { username: 'admin',        password: 'admin123',  displayName: 'Administrator',  role: 'admin',       unitUsaha: '' },
  { username: 'manajer1',     password: 'mgr2024',   displayName: 'Budi Hartono',   role: 'manajer',     unitUsaha: '' },
  { username: 'koordinator1', password: 'koord2024', displayName: 'Hendra Wijaya',  role: 'koordinator', unitUsaha: '' },
  { username: 'coo1',         password: 'coo2024',   displayName: 'Ir. Susanto',    role: 'coo',         unitUsaha: '' },
  { username: 'adm01',        password: 'adm2024',   displayName: 'Ahmad Fauzi',    role: 'adm',         unitUsaha: '' },
  { username: 'auditor1',     password: 'audit2024', displayName: 'Siti Rahayu',    role: 'auditor',     unitUsaha: '' },
  { username: 'auditor2',     password: 'audit2',    displayName: 'Ahmad Rizky',    role: 'auditor',     unitUsaha: '' },
  { username: 'auditor3',     password: 'audit3',    displayName: 'Dewi Anggraini', role: 'auditor',     unitUsaha: '' },
  { username: 'so01',         password: 'so2024',    displayName: 'Budi Santoso',   role: 'so',          unitUsaha: 'SO TPP' },
  { username: 'ajo',          password: 'ajo2024',   displayName: 'Ajo',            role: 'so',          unitUsaha: 'SO BBT' },
  { username: 'csc01',        password: 'csc2024',   displayName: 'Dewi Kusuma',    role: 'csc',         unitUsaha: 'CSC TBS' },
  { username: 'whs01',        password: 'whs2024',   displayName: 'Rizky Pratama',  role: 'whs',         unitUsaha: 'WHS MDN' },
  { username: 'kasir01',      password: 'kasir2024', displayName: 'Kasir TPP',      role: 'kasir',       unitUsaha: 'SO TPP'  },
  { username: 'kasir02',      password: 'kasir2',    displayName: 'Kasir TBS',      role: 'kasir',       unitUsaha: 'CSC TBS' },
  { username: 'rss01',        password: 'rss2024',   displayName: 'Rina Sanjaya',   role: 'rss',         unitUsaha: '' },
  { username: 'afd01',        password: 'afd2024',   displayName: 'Ir. Bambang W.', role: 'afd',         unitUsaha: '' },
];

// â”€â”€ Validation middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const _loginValidation = [
  body('username').trim().escape().isLength({ max: 100 }).withMessage('Username maksimal 100 karakter.'),
  body('password').isLength({ max: 200 }).withMessage('Password maksimal 200 karakter.'),
];
const _DATA_KEY_SET = new Set(DATA_KEYS);
const _dataValidation = [
  body('key').custom((val) => {
    if (!val || typeof val !== 'string') throw new Error('Key wajib diisi.');
    if (_DATA_KEY_SET.has(val)) return true;
    // Izinkan dynamic key patterns yang digunakan auth.js
    if (val.startsWith('akta_smh_onhand_')) return true;  // SMH per-cabang
    if (val.startsWith('akta_hgp_'))        return true;  // HGP per-session
    if (val.startsWith('akta_kas_'))        return true;  // Kas per-plan
    throw new Error('Key tidak diizinkan: ' + val);
  }),
];

// â”€â”€ Auth middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Token diperlukan.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token tidak valid atau kadaluarsa.' });
  }
}

// Opsional auth: decode token jika ada, tapi tidak blokir jika tidak ada
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  next();
}

// Helper: parse JWT expiry string (e.g. '7d', '1h') ke milliseconds
function _expiryMs(exp) {
  const m = String(exp).match(/^(\d+)([smhd])$/);
  if (!m) return 7 * 86400 * 1000;
  return parseInt(m[1], 10) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
}

// â”€â”€ Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Health check (basic)
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Health check detail â€” tanpa auth, untuk monitoring eksternal
app.get('/api/health', async (req, res) => {
  let dbStatus = 'error';
  try { await db.query('SELECT 1'); dbStatus = 'connected'; } catch {}
  const mem = process.memoryUsage();
  res.json({
    status:    'ok',
    uptime:    Math.floor(process.uptime()),
    database:  dbStatus,
    memory: {
      rss:       Math.round(mem.rss       / 1048576) + ' MB',
      heapUsed:  Math.round(mem.heapUsed  / 1048576) + ' MB',
      heapTotal: Math.round(mem.heapTotal / 1048576) + ' MB',
    },
    cache:     { keys: _cache.keys().length, stats: _cache.getStats() },
    version:   PKG.version,
    timestamp: new Date().toISOString(),
  });
});

// BCRYPT: cek apakah string adalah bcrypt hash
function _isHashed(pw) { // BCRYPT
  return typeof pw === 'string' && (pw.startsWith('$2b$') || pw.startsWith('$2a$')); // BCRYPT
} // BCRYPT

// Normalkan password: strip prefix PLAINTEXT: (dari seed migration 002)
function _normPw(pw) {
  if (typeof pw === 'string' && pw.startsWith('PLAINTEXT:')) return pw.slice('PLAINTEXT:'.length);
  return pw;
}

// Baca override password built-in users dari PostgreSQL
async function _readPwOverrides() {
  try {
    const d = await dbRead(PASSWORDS_KEY);
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  } catch { return {}; }
}

// Kembalikan password efektif built-in user: override hash jika ada, else null
async function _builtinPw(username) {
  const overrides = await _readPwOverrides();
  return Object.prototype.hasOwnProperty.call(overrides, username) ? overrides[username] : null;
}

// Login
app.post('/api/auth/login', _loginLimiter, _loginValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Input tidak valid.' });

  const { username, password } = req.body;

  // Coba login via users table (PostgreSQL)
  let userData = null;
  try {
    const { rows } = await db.query(
      'SELECT username, password_hash, display_name, role, unit_usaha, is_disabled FROM users WHERE username = $1',
      [username]
    );
    if (rows.length > 0) {
      const u = rows[0];
      if (u.is_disabled) {
        writeLog(req, 'LOGIN_FAILED', 'auth', `Akun dinonaktifkan: ${username}`);
        _trackFailedLogin(req);
        return res.status(401).json({ error: 'Akun ini dinonaktifkan.' });
      }
      const valid = await bcrypt.compare(password, u.password_hash);
      if (!valid) {
        writeLog(req, 'LOGIN_FAILED', 'auth', `Password salah untuk: ${username}`);
        _trackFailedLogin(req);
        return res.status(401).json({ error: 'Username atau password salah.' });
      }
      userData = { username: u.username, displayName: u.display_name, role: u.role, unitUsaha: u.unit_usaha || '' };
    }
  } catch (e) { console.error('[login] DB error:', e.message); }

  // Fallback ke USERS array + app_data (backward compat sebelum setup-passwords.js dijalankan)
  if (!userData) {
    const customUsers = await dbRead('akta_custom_users');
    let u = USERS.find(u => u.username === username);
    if (u) {
      // Cek apakah ada override di custom_users (misal: dinonaktifkan atau diubah via Admin)
      const override = customUsers.find(c => c.username === username);
      if (override) {
        if (override._disabled) {
          writeLog(req, 'LOGIN_FAILED', 'auth', `Akun dinonaktifkan (override): ${username}`);
          _trackFailedLogin(req);
          return res.status(401).json({ error: 'Akun ini dinonaktifkan.' });
        }
        // Gunakan data override (role/displayName/unitUsaha mungkin sudah diubah)
        const effectivePw = _isHashed(override.password) ? override.password : _normPw((await _builtinPw(u.username)) ?? u.password);
        const valid = _isHashed(effectivePw)
          ? await bcrypt.compare(password, effectivePw)
          : effectivePw === password;
        if (!valid) {
          writeLog(req, 'LOGIN_FAILED', 'auth', `Password salah untuk: ${username}`);
          _trackFailedLogin(req);
          return res.status(401).json({ error: 'Username atau password salah.' });
        }
        userData = { username: override.username, displayName: override.displayName, role: override.role, unitUsaha: override.unitUsaha || '' };
      } else {
        const effectivePw = _normPw((await _builtinPw(u.username)) ?? u.password);
        const valid = _isHashed(effectivePw)
          ? await bcrypt.compare(password, effectivePw)
          : effectivePw === password;
        if (!valid) {
          writeLog(req, 'LOGIN_FAILED', 'auth', `Password salah untuk: ${username}`);
          _trackFailedLogin(req);
          return res.status(401).json({ error: 'Username atau password salah.' });
        }
        userData = { username: u.username, displayName: u.displayName, role: u.role, unitUsaha: u.unitUsaha || '' };
      }
    } else {
      const cu = customUsers.find(c => c.username === username && !c._disabled);
      if (cu) {
        const valid = _isHashed(cu.password)
          ? await bcrypt.compare(password, cu.password)
          : cu.password === password;
        if (valid) userData = { username: cu.username, displayName: cu.displayName, role: cu.role, unitUsaha: cu.unitUsaha || '' };
      }
    }
  }

  if (!userData) {
    writeLog(req, 'LOGIN_FAILED', 'auth', `Username tidak ditemukan: ${username}`);
    _trackFailedLogin(req);
    return res.status(401).json({ error: 'Username atau password salah.' });
  }

  const payload = { ...userData, loginTime: Date.now() };
  const accessToken  = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_ACCESS_EXPIRY });
  const refreshToken = jwt.sign({ username: userData.username }, JWT_REFRESH_SECRET, { expiresIn: JWT_REFRESH_EXPIRY });

  // Simpan refresh token ke DB
  const expiresAt = new Date(Date.now() + _expiryMs(JWT_REFRESH_EXPIRY));
  await db.query(
    'INSERT INTO refresh_tokens (token, username, expires_at) VALUES ($1, $2, $3) ON CONFLICT (token) DO NOTHING',
    [refreshToken, userData.username, expiresAt]
  ).catch(e => console.error('[login] refresh token save error:', e.message));

  // Hapus refresh token lama milik user ini yang sudah kadaluarsa
  db.query('DELETE FROM refresh_tokens WHERE username = $1 AND expires_at < NOW()', [userData.username])
    .catch(() => {});

  req.user = payload;
  writeLog(req, 'LOGIN', 'auth', `${userData.displayName} (${userData.role}) login berhasil`);
  res.json({ token: accessToken, refreshToken, user: payload });
});

// Change password
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  const { username } = req.user;

  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'currentPassword dan newPassword wajib diisi.' });
  if (newPassword.length < 8)
    return res.status(400).json({ error: 'Password baru minimal 8 karakter.' });
  if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword))
    return res.status(400).json({ error: 'Password baru harus mengandung huruf dan angka.' });
  if (confirmPassword !== undefined && confirmPassword !== newPassword)
    return res.status(400).json({ error: 'Konfirmasi password tidak cocok.' });
  if (currentPassword === newPassword)
    return res.status(400).json({ error: 'Password baru tidak boleh sama dengan password lama.' });

  const isBuiltin = USERS.some(u => u.username === username);

  if (isBuiltin) {
    const builtinUser  = USERS.find(u => u.username === username);
    const effectivePw  = _normPw((await _builtinPw(username)) ?? (builtinUser?.password || ''));
    const valid = _isHashed(effectivePw)
      ? await bcrypt.compare(currentPassword, effectivePw)
      : effectivePw === currentPassword;
    if (!valid) return res.status(401).json({ error: 'Password saat ini tidak cocok.' });

    const newHash        = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const overrides      = await _readPwOverrides();
    overrides[username]  = newHash;
    await dbWrite(PASSWORDS_KEY, overrides);

    // Sinkronisasi ke users table
    db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE username = $2',
      [newHash, username]).catch(() => {});

  } else {
    const users = await dbRead('akta_custom_users');
    const idx   = users.findIndex(u => u.username === username && !u._disabled);
    if (idx < 0) return res.status(404).json({ error: 'User tidak ditemukan.' });

    const valid = _isHashed(users[idx].password)
      ? await bcrypt.compare(currentPassword, users[idx].password)
      : users[idx].password === currentPassword;
    if (!valid) return res.status(401).json({ error: 'Password saat ini tidak cocok.' });

    const customHash    = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    users[idx].password = customHash;
    await dbWrite('akta_custom_users', users);

    // Sinkronisasi ke users table
    db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE username = $2',
      [customHash, username]).catch(() => {});
  }

  writeLog(req, 'UPDATE', 'auth', `${req.user.displayName} mengganti password`);
  res.json({ ok: true, message: 'Password berhasil diubah.' });
});

// Refresh access token
app.post('/api/auth/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken wajib diisi.' });

  // Verifikasi JWT signature DULU â€” ini selalu bisa dilakukan tanpa DB
  let decoded;
  try { decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET); }
  catch { return res.status(401).json({ error: 'Refresh token tidak valid.' }); }

  const username = decoded.username;

  // Cek revocation di DB jika tersedia; jika DB down â€” skip (trust JWT signature)
  try {
    const { rows } = await db.query(
      'SELECT expires_at FROM refresh_tokens WHERE token = $1',
      [refreshToken]
    );
    if (rows.length > 0 && new Date(rows[0].expires_at) < new Date()) {
      return res.status(401).json({ error: 'Refresh token sudah kadaluarsa.' });
    }
    // rows.length === 0 berarti token belum sempat disimpan ke DB (mode no-PG) â€” tetap izinkan
  } catch {
    // DB tidak tersedia â€” lanjutkan dengan validasi JWT saja
  }

  let userData = null;

  // Cek apakah user dinonaktifkan via custom_users override
  try {
    const customUsers = await dbRead('akta_custom_users');
    const override = customUsers.find(c => c.username === username);
    if (override && override._disabled) {
      return res.status(401).json({ error: 'Akun ini dinonaktifkan.' });
    }
    if (override) {
      userData = { username: override.username, displayName: override.displayName, role: override.role, unitUsaha: override.unitUsaha || '' };
    }
  } catch {}

  // Cek di PostgreSQL users table
  if (!userData) {
    try {
      const { rows: urows } = await db.query(
        'SELECT username, display_name, role, unit_usaha, is_disabled FROM users WHERE username = $1',
        [username]
      );
      if (urows.length > 0) {
        if (urows[0].is_disabled) return res.status(401).json({ error: 'Akun ini dinonaktifkan.' });
        const u = urows[0];
        userData = { username: u.username, displayName: u.display_name, role: u.role, unitUsaha: u.unit_usaha || '' };
      }
    } catch {}
  }

  // Fallback ke USERS array built-in
  if (!userData) {
    const u = USERS.find(u => u.username === username);
    if (u) userData = { username: u.username, displayName: u.displayName, role: u.role, unitUsaha: u.unitUsaha || '' };
  }

  if (!userData) return res.status(401).json({ error: 'User tidak ditemukan.' });

  const payload = { ...userData, loginTime: Date.now() };
  const newAccessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_ACCESS_EXPIRY });
  res.json({ token: newAccessToken, user: payload });
});

// Logout â€” invalidate refresh token
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const { refreshToken } = req.body || {};
  if (refreshToken) {
    await db.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]).catch(() => {});
  }
  writeLog(req, 'LOGOUT', 'auth', `${req.user.displayName} logout`);
  res.json({ ok: true });
});

// â”€â”€ SSE Stream â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/notifications/stream
app.get('/api/notifications/stream', requireAuth, async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering
  res.flushHeaders();

  const { username, role } = req.user;
  sse.addClient(username, role, res);

  // Kirim notifikasi unread saat pertama konek
  try {
    const { rows } = await db.query(
      'SELECT * FROM notifications WHERE username=$1 AND is_read=false ORDER BY created_at DESC LIMIT 20',
      [username]
    );
    rows.forEach(n => {
      res.write(`event: notification\ndata: ${JSON.stringify({
        id: n.id, title: n.title, message: n.message, type: n.type,
        resource: n.related_resource, relatedId: n.related_id,
        createdAt: n.created_at, isRead: false,
      })}\n\n`);
    });
  } catch { /* DB mungkin belum siap */ }

  // Keep-alive setiap 30 detik
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
  }, 30000);

  req.on('close', () => {
    clearInterval(ping);
    sse.removeClient(username, res);
  });
});

// â”€â”€ Notification Inbox CRUD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/notifications â€” list notifikasi user login (unread dulu)
app.get('/api/notifications', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  try {
    const { rows } = await db.query(
      `SELECT id, title, message, type, is_read, created_at, related_resource, related_id
       FROM notifications WHERE username=$1
       ORDER BY is_read ASC, created_at DESC LIMIT $2`,
      [req.user.username, limit]
    );
    const unread = rows.filter(r => !r.is_read).length;
    res.json({ data: rows, unread });
  } catch (e) {
    res.status(500).json({ error: 'Gagal ambil notifikasi.' });
  }
});

// PUT /api/notifications/:id/read
app.put('/api/notifications/:id/read', requireAuth, async (req, res) => {
  await db.query(
    'UPDATE notifications SET is_read=true WHERE id=$1 AND username=$2',
    [req.params.id, req.user.username]
  ).catch(() => {});
  res.json({ ok: true });
});

// PUT /api/notifications/read-all
app.put('/api/notifications/read-all', requireAuth, async (req, res) => {
  await db.query('UPDATE notifications SET is_read=true WHERE username=$1', [req.user.username])
    .catch(() => {});
  res.json({ ok: true });
});

// DELETE /api/notifications/:id
app.delete('/api/notifications/:id', requireAuth, async (req, res) => {
  await db.query(
    'DELETE FROM notifications WHERE id=$1 AND username=$2',
    [req.params.id, req.user.username]
  ).catch(() => {});
  res.json({ ok: true });
});

// GET /api/auth/me â€” profil user yang sedang login
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT username, display_name, role, unit_usaha, is_disabled, created_at, updated_at FROM users WHERE username = $1',
      [req.user.username]
    );
    if (rows.length > 0) {
      const u = rows[0];
      return res.json({ username: u.username, displayName: u.display_name, role: u.role, unitUsaha: u.unit_usaha || '', isDisabled: u.is_disabled, createdAt: u.created_at, updatedAt: u.updated_at });
    }
  } catch (e) { console.error('[me]', e.message); }
  res.json({ username: req.user.username, displayName: req.user.displayName, role: req.user.role, unitUsaha: req.user.unitUsaha || '' });
});

// PUT /api/auth/me â€” update displayName saja
app.put('/api/auth/me', requireAuth, async (req, res) => {
  const { displayName } = req.body || {};
  if (!displayName || typeof displayName !== 'string') return res.status(400).json({ error: 'displayName wajib diisi.' });
  const dn = displayName.trim();
  if (dn.length < 3 || dn.length > 100) return res.status(400).json({ error: 'displayName harus 3â€“100 karakter.' });
  try {
    await db.query('UPDATE users SET display_name = $1, updated_at = NOW() WHERE username = $2', [dn, req.user.username]);
    writeLog(req, 'UPDATE', 'auth', `Update profil displayName â†’ ${dn}`);
    res.json({ ok: true, displayName: dn });
  } catch (e) {
    console.error('[me PUT]', e.message);
    res.status(500).json({ error: 'Gagal memperbarui profil.' });
  }
});

// GET /api/admin/users â€” admin & manajer, dengan pagination + filter
app.get('/api/admin/users', requireAuth, async (req, res) => {
  if (!['admin', 'manajer'].includes(req.user.role)) return res.status(403).json({ error: 'Akses ditolak.' });

  const page   = Math.max(parseInt(req.query.page,  10) || 1, 1);
  const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = (page - 1) * limit;

  const conditions = [];
  const countParams = [];
  const _cp = v => { countParams.push(v); return `$${countParams.length}`; };

  if (req.query.role) conditions.push(`role = ${_cp(req.query.role)}`);
  if (req.query.search) {
    const s = '%' + req.query.search.replace(/[%_]/g, '\\$&') + '%';
    conditions.push(`(username ILIKE ${_cp(s)} OR display_name ILIKE ${_cp(s)})`);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const dataParams = [...countParams, limit, offset];
  const lp = `$${countParams.length + 1}`;
  const op = `$${countParams.length + 2}`;

  try {
    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) AS total FROM users ${where}`, countParams),
      db.query(`SELECT username, display_name, role, unit_usaha, is_disabled, created_at, updated_at FROM users ${where} ORDER BY username ASC LIMIT ${lp} OFFSET ${op}`, dataParams),
    ]);
    const total = parseInt(countRes.rows[0].total, 10);
    // Gabungkan dengan custom_users dari app_data (mode non-PostgreSQL)
    const customUsers = await dbRead('akta_custom_users');
    const filtered    = customUsers.filter(u => {
      if (req.query.role   && u.role    !== req.query.role) return false;
      if (req.query.search && !((u.username||'').includes(req.query.search) || (u.displayName||'').includes(req.query.search))) return false;
      return true;
    });
    // Tambahkan built-in users yang belum ada di PostgreSQL maupun custom_users
    const dbUsernames     = new Set(dataRes.rows.map(u => u.username));
    const customUsernames = new Set(customUsers.map(u => u.username));
    const builtinExtra    = USERS
      .filter(u => !dbUsernames.has(u.username) && !customUsernames.has(u.username))
      .filter(u => {
        if (req.query.role   && u.role !== req.query.role) return false;
        if (req.query.search) {
          const s = req.query.search.toLowerCase();
          if (!(u.username.toLowerCase().includes(s) || (u.displayName||'').toLowerCase().includes(s))) return false;
        }
        return true;
      })
      .map(u => ({ username: u.username, displayName: u.displayName, role: u.role, unitUsaha: u.unitUsaha || '', isDisabled: false, source: 'builtin' }));
    const combined = [
      ...dataRes.rows.map(u => ({ username: u.username, displayName: u.display_name, role: u.role, unitUsaha: u.unit_usaha || '', isDisabled: u.is_disabled, createdAt: u.created_at, updatedAt: u.updated_at, source: 'db' })),
      ...filtered.map(u => ({ username: u.username, displayName: u.displayName, role: u.role, unitUsaha: u.unitUsaha || '', isDisabled: !!u._disabled, createdAt: u.createdAt, updatedAt: u.updatedAt, source: 'local' })),
      ...builtinExtra,
    ];
    const totalCombined = total + filtered.length + builtinExtra.length;
    res.json({ data: combined, total: totalCombined, page, totalPages: Math.ceil(totalCombined / limit) });
  } catch (e) {
    // Fallback: gunakan akta_custom_users saja jika PostgreSQL tidak tersedia
    console.warn('[admin/users GET] DB tidak tersedia, fallback ke local:', e.message);
    try {
      const customUsers = await dbRead('akta_custom_users');
      // custom_users mungkin berisi override untuk built-in users â€” deduplicate
      const overriddenUsernames = new Set(customUsers.map(u => u.username));
      const builtinOnly = USERS
        .filter(u => !overriddenUsernames.has(u.username))
        .map(u => ({ username: u.username, displayName: u.displayName, role: u.role, unitUsaha: u.unitUsaha || '', isDisabled: false, source: 'builtin' }));
      const allCustom = customUsers.map(u => ({
        username: u.username, displayName: u.displayName, role: u.role,
        unitUsaha: u.unitUsaha || '', isDisabled: !!u._disabled,
        createdAt: u.createdAt, updatedAt: u.updatedAt,
        source: USERS.some(b => b.username === u.username) ? 'builtin' : 'local',
      }));
      let all = [...builtinOnly, ...allCustom];
      // Apply filter jika ada query params
      if (req.query.role)   all = all.filter(u => u.role === req.query.role);
      if (req.query.search) {
        const s = req.query.search.toLowerCase();
        all = all.filter(u => (u.username||'').toLowerCase().includes(s) || (u.displayName||'').toLowerCase().includes(s));
      }
      res.json({ data: all, total: all.length, page: 1, totalPages: 1 });
    } catch (e2) {
      res.status(500).json({ error: 'Gagal mengambil data pengguna.' });
    }
  }
});

// GET /api/admin/users/:username/password â€” ambil password untuk ditampilkan di form edit (admin only)
app.get('/api/admin/users/:username/password', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak.' });
  const { username } = req.params;

  // Cek custom_users â€” prioritas utama karena menyimpan _passwordClear
  try {
    const customUsers = await dbRead('akta_custom_users');
    const cu = customUsers.find(u => u.username === username);
    if (cu) {
      // Prioritas 1: ada simpanan plain-text dari pembuatan/edit admin
      if (cu._passwordClear) return res.json({ password: cu._passwordClear, encrypted: false });

      // Prioritas 2: password belum di-hash â€” langsung tampilkan
      if (!_isHashed(cu.password)) return res.json({ password: cu.password, encrypted: false });

      // Prioritas 3: hash â€” coba cocokkan dengan built-in USERS (untuk auditor1 dll)
      const builtIn = USERS.find(u => u.username === username);
      if (builtIn) {
        try {
          const match = await bcrypt.compare(builtIn.password, cu.password);
          if (match) return res.json({ password: builtIn.password, encrypted: false });
        } catch {}
      }

      // Tidak bisa dipulihkan
      return res.json({ password: null, encrypted: true });
    }
  } catch {}

  // Tidak ada di custom_users â€” cek built-in USERS
  const builtIn = USERS.find(u => u.username === username);
  if (builtIn) {
    // Cek apakah ada override password hash (dari change-password)
    try {
      const overrides = await _readPwOverrides();
      if (overrides[username] && _isHashed(overrides[username])) {
        // Ada override hash â€” coba cocokkan dengan built-in password
        const match = await bcrypt.compare(builtIn.password, overrides[username]);
        if (match) return res.json({ password: builtIn.password, encrypted: false });
        return res.json({ password: null, encrypted: true });
      }
    } catch {}
    return res.json({ password: builtIn.password, encrypted: false });
  }

  // Cek PostgreSQL (selalu hashed, tidak bisa ditampilkan)
  try {
    const { rows } = await db.query('SELECT username FROM users WHERE username = $1', [username]);
    if (rows.length > 0) return res.json({ password: null, encrypted: true });
  } catch {}

  res.status(404).json({ error: 'User tidak ditemukan.' });
});

// POST /api/admin/users â€” buat user baru (admin only)
const _VALID_ROLES = ['admin','manajer','koordinator','coo','adm','auditor','so','csc','whs','kasir','rss','afd'];

app.post('/api/admin/users', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak.' });

  const { username, password, displayName, role, unitUsaha } = req.body || {};
  if (!username || !/^[a-zA-Z0-9_]{3,50}$/.test(username))
    return res.status(400).json({ error: 'Username tidak valid (3â€“50 karakter, huruf/angka/underscore).' });
  if (!password || password.length < 8)
    return res.status(400).json({ error: 'Password minimal 8 karakter.' });
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
    return res.status(400).json({ error: 'Password harus mengandung huruf dan angka.' });
  if (!displayName || String(displayName).trim().length < 3)
    return res.status(400).json({ error: 'Nama lengkap minimal 3 karakter.' });
  if (!_VALID_ROLES.includes(role))
    return res.status(400).json({ error: 'Role tidak valid.' });

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    // Cek duplikat di DB
    const { rows } = await db.query('SELECT username FROM users WHERE username = $1', [username]);
    if (rows.length > 0) return res.status(409).json({ error: `Username "${username}" sudah digunakan.` });
    await db.query(
      'INSERT INTO users (username, password_hash, display_name, role, unit_usaha) VALUES ($1,$2,$3,$4,$5)',
      [username, hash, String(displayName).trim(), role, unitUsaha || '']
    );
    writeLog(req, 'CREATE', 'users', `Buat user: ${username} (${role})`);
    return res.status(201).json({ ok: true, username, storage: 'db' });
  } catch (dbErr) {
    // Fallback: simpan ke akta_custom_users di app_data jika PostgreSQL tidak tersedia
    console.warn('[admin/users POST] DB tidak tersedia, fallback ke local:', dbErr.message);
    try {
      const customUsers = await dbRead('akta_custom_users');
      // Cek duplikat di built-in USERS dan custom_users
      if (USERS.some(u => u.username === username))
        return res.status(409).json({ error: `Username "${username}" sudah digunakan (user bawaan).` });
      if (customUsers.some(u => u.username === username))
        return res.status(409).json({ error: `Username "${username}" sudah digunakan.` });
      customUsers.push({
        username,
        password:        hash,
        _passwordClear:  password,          // simpan plain-text untuk tampilan admin
        displayName:     String(displayName).trim(),
        role,
        unitUsaha:       unitUsaha || '',
        _disabled:       false,
        createdAt:       new Date().toISOString(),
        updatedAt:       new Date().toISOString(),
      });
      await dbWrite('akta_custom_users', customUsers);
      writeLog(req, 'CREATE', 'users', `Buat user (local): ${username} (${role})`);
      return res.status(201).json({ ok: true, username, storage: 'local' });
    } catch (e2) {
      console.error('[admin/users POST fallback]', e2.message);
      res.status(500).json({ error: 'Gagal membuat pengguna.' });
    }
  }
});

// PUT /api/admin/users/:username â€” edit user (admin only)
app.put('/api/admin/users/:username', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak.' });

  const { username } = req.params;
  const { displayName, role, unitUsaha, is_disabled, newPassword } = req.body || {};
  const sets = [];
  const params = [];
  const _p = v => { params.push(v); return `$${params.length}`; };

  if (displayName !== undefined) {
    const dn = String(displayName).trim();
    if (dn.length < 3 || dn.length > 100) return res.status(400).json({ error: 'displayName harus 3â€“100 karakter.' });
    sets.push(`display_name = ${_p(dn)}`);
  }
  if (role !== undefined) {
    if (!_VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Role tidak valid.' });
    sets.push(`role = ${_p(role)}`);
  }
  if (unitUsaha !== undefined) sets.push(`unit_usaha = ${_p(String(unitUsaha || ''))}`);
  if (is_disabled !== undefined) sets.push(`is_disabled = ${_p(!!is_disabled)}`);
  if (newPassword !== undefined && newPassword !== '') {
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password baru minimal 8 karakter.' });
    if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword))
      return res.status(400).json({ error: 'Password baru harus mengandung huruf dan angka.' });
    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    sets.push(`password_hash = ${_p(hash)}`);
    if (USERS.some(u => u.username === username)) {
      _readPwOverrides().then(ov => { ov[username] = hash; dbWrite(PASSWORDS_KEY, ov); }).catch(() => {});
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Tidak ada field yang diperbarui.' });
  sets.push('updated_at = NOW()');
  params.push(username);

  try {
    const { rowCount } = await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE username = $${params.length}`, params
    );
    if (rowCount > 0) {
      writeLog(req, 'UPDATE', 'users', `Update user: ${username}`);
      return res.json({ ok: true });
    }
    // rowCount = 0: mungkin ada di custom_users
    throw new Error('not_found_in_db');
  } catch (e) {
    // Fallback: update di akta_custom_users (termasuk built-in USERS)
    try {
      const cu = await dbRead('akta_custom_users');
      let idx = cu.findIndex(u => u.username === username);
      if (idx === -1) {
        // Buat override entry dari built-in user jika ada
        const builtIn = USERS.find(u => u.username === username);
        if (!builtIn) return res.status(404).json({ error: 'User tidak ditemukan.' });
        cu.push({
          username:        builtIn.username,
          password:        builtIn.password,
          _passwordClear:  _isHashed(builtIn.password) ? null : builtIn.password,
          displayName:     builtIn.displayName,
          role:            builtIn.role,
          unitUsaha:       builtIn.unitUsaha || '',
          _disabled:       false,
          createdAt:       new Date().toISOString(),
          updatedAt:       new Date().toISOString(),
        });
        idx = cu.length - 1;
      }
      const u = cu[idx];
      if (displayName  !== undefined) u.displayName = String(displayName).trim();
      if (role         !== undefined) u.role        = role;
      if (unitUsaha    !== undefined) u.unitUsaha   = String(unitUsaha || '');
      if (is_disabled  !== undefined) u._disabled   = !!is_disabled;
      if (newPassword) {
        const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
        u.password = hash;
        u._passwordClear = newPassword;
      }
      u.updatedAt = new Date().toISOString();
      await dbWrite('akta_custom_users', cu);
      writeLog(req, 'UPDATE', 'users', `Update user (local): ${username}`);
      res.json({ ok: true });
    } catch (e2) {
      console.error('[admin/users PUT fallback]', e2.message);
      res.status(500).json({ error: 'Gagal memperbarui pengguna.' });
    }
  }
});

// DELETE /api/admin/users/:username â€” soft delete (default) atau hard delete (?permanent=true)
app.delete('/api/admin/users/:username', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak.' });
  const { username } = req.params;
  const permanent = req.query.permanent === 'true';
  if (username === req.user.username) return res.status(400).json({ error: 'Tidak dapat menghapus/menonaktifkan akun sendiri.' });

  // Hard delete: hapus dari PostgreSQL + custom_users
  if (permanent) {
    const isBuiltin = USERS.some(u => u.username === username);
    if (isBuiltin) return res.status(400).json({ error: 'User sistem bawaan tidak dapat dihapus permanen.' });
    try {
      await db.query('DELETE FROM users WHERE username = $1', [username]);
    } catch {}
    try {
      const cu = await dbRead('akta_custom_users');
      const filtered = cu.filter(u => u.username !== username);
      if (filtered.length !== cu.length) await dbWrite('akta_custom_users', filtered);
    } catch {}
    writeLog(req, 'DELETE', 'users', `Hapus permanen user: ${username}`);
    return res.json({ ok: true, message: `User ${username} dihapus permanen.` });
  }

  try {
    const { rowCount } = await db.query(
      'UPDATE users SET is_disabled = true, updated_at = NOW() WHERE username = $1', [username]
    );
    if (rowCount > 0) {
      writeLog(req, 'DELETE', 'users', `Nonaktifkan user: ${username}`);
      return res.json({ ok: true, message: `User ${username} dinonaktifkan.` });
    }
    throw new Error('not_found_in_db');
  } catch (e) {
    // Fallback: nonaktifkan di akta_custom_users (termasuk built-in USERS)
    try {
      const cu = await dbRead('akta_custom_users');
      const idx = cu.findIndex(u => u.username === username);
      if (idx === -1) {
        // Buat override entry dari built-in user jika ada
        const builtIn = USERS.find(u => u.username === username);
        if (!builtIn) return res.status(404).json({ error: 'User tidak ditemukan.' });
        cu.push({
          username:    builtIn.username,
          password:    builtIn.password,
          displayName: builtIn.displayName,
          role:        builtIn.role,
          unitUsaha:   builtIn.unitUsaha || '',
          _disabled:   true,
          createdAt:   new Date().toISOString(),
          updatedAt:   new Date().toISOString(),
        });
      } else {
        cu[idx]._disabled = true;
        cu[idx].updatedAt = new Date().toISOString();
      }
      await dbWrite('akta_custom_users', cu);
      writeLog(req, 'DELETE', 'users', `Nonaktifkan user (local): ${username}`);
      res.json({ ok: true, message: `User ${username} dinonaktifkan.` });
    } catch (e2) {
      res.status(500).json({ error: 'Gagal menonaktifkan pengguna.' });
    }
  }
});

// â”€â”€ Admin Stats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// GET /api/admin/stats â€” dashboard monitoring (admin only)
app.get('/api/admin/stats', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak.' });
  try {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayISO   = todayStart.toISOString();
    const thisMonthStart = new Date(); thisMonthStart.setDate(1); thisMonthStart.setHours(0,0,0,0);

    const [
      usersTotal, usersAktifHariIni,
      loginHariIni, loginGagalHariIni, exportHariIni,
      recentActivity,
      dbPool,
    ] = await Promise.all([
      db.query('SELECT COUNT(*) FROM users WHERE is_disabled IS NOT DISTINCT FROM false'),
      db.query(`SELECT COUNT(DISTINCT username) FROM activity_log WHERE timestamp >= $1 AND action = 'LOGIN'`, [todayISO]),
      db.query(`SELECT COUNT(*) FROM activity_log WHERE timestamp >= $1 AND action = 'LOGIN'`,         [todayISO]),
      db.query(`SELECT COUNT(*) FROM activity_log WHERE timestamp >= $1 AND action = 'LOGIN_FAILED'`, [todayISO]),
      db.query(`SELECT COUNT(*) FROM activity_log WHERE timestamp >= $1 AND action = 'EXPORT'`,       [todayISO]),
      db.query(
        `SELECT username, display_name, action, resource, detail, timestamp, ip
         FROM activity_log ORDER BY timestamp DESC LIMIT 20`
      ),
      db.query('SELECT count FROM pg_stat_activity WHERE state IS NOT NULL'),
    ]);

    const plans = await dbRead('akta_plans');
    const tasks = await dbRead('akta_tasks');
    const reks  = await dbRead('akta_rekomendasi');

    const plansMonthIni = plans.filter(p => {
      const t = new Date(p.tglMulai || p.tanggal || 0);
      return t >= thisMonthStart;
    }).length;

    const tasksOpen    = tasks.filter(t => !['selesai','done','completed'].includes((t.status||'').toLowerCase())).length;
    const tasksSelesai = tasks.filter(t =>  ['selesai','done','completed'].includes((t.status||'').toLowerCase())).length;
    const skPending    = reks.filter(r => (r.status||'').toLowerCase().startsWith('pending')).length;
    const skSelesai    = reks.filter(r => ['approved','selesai','done'].includes((r.status||'').toLowerCase())).length;

    const mem = process.memoryUsage();
    const cacheStats = _cache.getStats();

    res.json({
      users: {
        total:          parseInt(usersTotal.rows[0].count, 10),
        aktif_hari_ini: parseInt(usersAktifHariIni.rows[0].count, 10),
        online_sekarang: sse.clientCount(),
      },
      data: {
        total_plans:    plans.length,
        plans_bulan_ini: plansMonthIni,
        tasks_open:     tasksOpen,
        tasks_selesai:  tasksSelesai,
        sk_pending:     skPending,
        sk_selesai:     skSelesai,
      },
      server: {
        uptime_detik:   Math.floor(process.uptime()),
        memory_mb:      Math.round(mem.rss / 1048576),
        memory_heap_mb: Math.round(mem.heapUsed / 1048576),
        db_connections: dbPool.rows.length,
        cache_hits:     cacheStats.hits,
        cache_keys:     _cache.keys().length,
      },
      activity: {
        login_hari_ini:       parseInt(loginHariIni.rows[0].count, 10),
        login_gagal_hari_ini: parseInt(loginGagalHariIni.rows[0].count, 10),
        request_per_menit:    _reqPerMin(),
        export_hari_ini:      parseInt(exportHariIni.rows[0].count, 10),
      },
      recent_activity: recentActivity.rows.map(r => ({
        timestamp:   r.timestamp,
        username:    r.username,
        displayName: r.display_name,
        action:      r.action,
        resource:    r.resource,
        detail:      r.detail,
        ip:          r.ip,
      })),
    });
  } catch (e) {
    console.error('[admin/stats]', e.message);
    res.status(500).json({ error: 'Gagal mengambil statistik.' });
  }
});

// GET /api/admin/stats/chart â€” data grafik 7 hari terakhir (admin only)
app.get('/api/admin/stats/chart', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak.' });
  try {
    const since = new Date(); since.setDate(since.getDate() - 6); since.setHours(0, 0, 0, 0);
    const sinceISO = since.toISOString();

    const [loginRows, syncRows, activeRows] = await Promise.all([
      db.query(
        `SELECT DATE(timestamp AT TIME ZONE 'Asia/Jakarta') AS date, COUNT(*) AS count
         FROM activity_log WHERE timestamp >= $1 AND action = 'LOGIN'
         GROUP BY 1 ORDER BY 1`,
        [sinceISO]
      ),
      db.query(
        `SELECT DATE(timestamp AT TIME ZONE 'Asia/Jakarta') AS date, COUNT(*) AS count
         FROM activity_log WHERE timestamp >= $1 AND action IN ('SYNC','CREATE','UPDATE','DELETE')
         GROUP BY 1 ORDER BY 1`,
        [sinceISO]
      ),
      db.query(
        `SELECT DATE(timestamp AT TIME ZONE 'Asia/Jakarta') AS date, COUNT(DISTINCT username) AS unique_users
         FROM activity_log WHERE timestamp >= $1
         GROUP BY 1 ORDER BY 1`,
        [sinceISO]
      ),
    ]);

    // Lengkapi semua 7 hari (isi 0 jika tidak ada data)
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const toMap = (rows, field = 'count') => {
      const m = {};
      rows.forEach(r => { m[String(r.date).slice(0, 10)] = parseInt(r[field], 10); });
      return m;
    };

    const loginMap  = toMap(loginRows.rows);
    const syncMap   = toMap(syncRows.rows);
    const activeMap = toMap(activeRows.rows, 'unique_users');

    res.json({
      login_per_hari:       days.map(d => ({ date: d, count:        loginMap[d]  || 0 })),
      data_sync_per_hari:   days.map(d => ({ date: d, count:        syncMap[d]   || 0 })),
      user_aktif_per_hari:  days.map(d => ({ date: d, unique_users: activeMap[d] || 0 })),
    });
  } catch (e) {
    console.error('[admin/stats/chart]', e.message);
    res.status(500).json({ error: 'Gagal mengambil data chart.' });
  }
});

// Bulk read all keys (for initial page sync) â€” optionalAuth agar data tetap muat meski token kosong
app.get('/api/all-data', optionalAuth, async (req, res) => {
  const cacheKey = 'all-data';
  const cached   = getCache(cacheKey);
  if (cached) return res.json(cached);
  const result = {};
  for (const k of DATA_KEYS) { result[k] = await dbRead(k); }
  setCache(cacheKey, result, 30);
  res.json(result);
});

// Universal data sync (client â†’ server)
app.put('/api/data', requireAuth, _dataValidation, async (req, res) => {
  const vErrors = validationResult(req);
  if (!vErrors.isEmpty()) return res.status(400).json({ error: vErrors.array()[0].msg });

  const { key, value } = req.body || {};

  // BCRYPT: Auto-hash password custom users yang belum di-hash saat disimpan
  if (key === 'akta_custom_users' && Array.isArray(value)) { // BCRYPT
    for (const user of value) { // BCRYPT
      if (user.password && !_isHashed(user.password)) { // BCRYPT
        user.password = await bcrypt.hash(user.password, BCRYPT_ROUNDS); // BCRYPT
      } // BCRYPT
    } // BCRYPT
  } // BCRYPT

  await dbWrite(key, value);
  clearCache(`col:${key}`);
  clearCache('all-data');
  writeLog(req, 'SYNC', key, `Sync ${Array.isArray(value) ? value.length + ' item' : typeof value}`);
  res.json({ ok: true });
});

// Individual collection endpoints (optional fine-grained access)
DATA_KEYS.forEach(key => {
  const route = '/api/' + key.replace('akta_', '').replace(/_/g, '-');

  app.get(route, requireAuth, async (req, res) => {
    const { role, unitUsaha } = req.user;
    const needsFilter = key === 'akta_tasks' && unitUsaha && ['so', 'csc', 'whs', 'kasir'].includes(role);
    const cacheKey    = needsFilter ? `col:${key}:${role}:${(unitUsaha || '').toUpperCase()}` : `col:${key}`;
    const cached      = getCache(cacheKey);
    if (cached) return res.json(cached);

    let data = await dbRead(key);
    if (needsFilter) {
      const myUU = unitUsaha.trim().toUpperCase();
      data = data.filter(t => (t.cabangPlan || '').trim().toUpperCase() === myUU);
    }
    setCache(cacheKey, data, 15);
    res.json(data);
  });

  app.post(route, requireAuth, async (req, res) => {
    const data = await dbRead(key);
    const item = { id: Date.now() + Math.random(), ...req.body };
    data.push(item);
    await dbWrite(key, data);
    clearCache(`col:${key}`);
    clearCache('all-data');
    writeLog(req, 'CREATE', key, `Tambah item id=${item.id}`);
    res.status(201).json(item);
  });

  app.put(route + '/:id', requireAuth, async (req, res) => {
    const data = await dbRead(key);
    const idx  = data.findIndex(i => String(i.id) === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Tidak ditemukan.' });
    data[idx] = { ...data[idx], ...req.body };
    await dbWrite(key, data);
    clearCache(`col:${key}`);
    clearCache('all-data');
    writeLog(req, 'UPDATE', key, `Update item id=${req.params.id}`);
    res.json(data[idx]);
  });

  app.delete(route + '/:id', requireAuth, async (req, res) => {
    const data = (await dbRead(key)).filter(i => String(i.id) !== req.params.id);
    await dbWrite(key, data);
    clearCache(`col:${key}`);
    clearCache('all-data');
    writeLog(req, 'DELETE', key, `Hapus item id=${req.params.id}`);
    res.json({ ok: true });
  });
});

// Activity log â€” admin, manajer, koordinator
app.get('/api/activity-log', requireAuth, async (req, res) => {
  const _allowed = ['admin', 'manajer', 'koordinator'];
  if (!_allowed.includes(req.user.role)) return res.status(403).json({ error: 'Akses ditolak.' });

  const page      = Math.max(parseInt(req.query.page,  10) || 1, 1);
  const limit     = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const offset    = (page - 1) * limit;

  const conditions = [];
  const params     = [];

  const _p = (val) => { params.push(val); return `$${params.length}`; };

  if (req.query.username)  conditions.push(`username = ${_p(req.query.username)}`);
  if (req.query.action)    conditions.push(`action = ${_p(req.query.action.toUpperCase())}`);
  if (req.query.resource)  conditions.push(`resource = ${_p(req.query.resource)}`);
  if (req.query.date_from) conditions.push(`timestamp >= ${_p(req.query.date_from + 'T00:00:00')}`);
  if (req.query.date_to)   conditions.push(`timestamp <= ${_p(req.query.date_to   + 'T23:59:59')}`);
  if (req.query.search)    conditions.push(`detail ILIKE ${_p('%' + req.query.search.replace(/[%_]/g, '\\$&') + '%')}`);

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const countSql = `SELECT COUNT(*) AS total FROM activity_log ${where}`;
    const dataSql  = `
      SELECT id, timestamp, username,
             display_name AS "displayName", role, action, resource, detail, ip,
             user_agent AS "userAgent"
      FROM activity_log ${where}
      ORDER BY timestamp DESC
      LIMIT ${_p(limit)} OFFSET ${_p(offset)}`;

    const [countRes, dataRes] = await Promise.all([
      db.query(countSql, params.slice(0, params.length - 2)),
      db.query(dataSql, params),
    ]);
    const total      = parseInt(countRes.rows[0].total, 10);
    const totalPages = Math.ceil(total / limit);
    res.json({ data: dataRes.rows, total, page, totalPages });
  } catch (e) {
    console.error('[activity-log]', e.message);
    res.status(500).json({ error: 'Gagal membaca log.' });
  }
});

// Activity log stats â€” hanya admin
app.get('/api/activity-log/stats', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak.' });

  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const [loginHariIni, loginGagal, userAktif, aksiTerbanyak, loginPerJam] = await Promise.all([
      db.query(
        `SELECT COUNT(*) AS n FROM activity_log WHERE action = 'LOGIN' AND timestamp::date = $1::date`,
        [today]
      ),
      db.query(
        `SELECT COUNT(*) AS n FROM activity_log WHERE action = 'LOGIN_FAILED' AND timestamp::date = $1::date`,
        [today]
      ),
      db.query(
        `SELECT DISTINCT username FROM activity_log WHERE action = 'LOGIN' AND timestamp::date = $1::date`,
        [today]
      ),
      db.query(
        `SELECT action, COUNT(*) AS count FROM activity_log
         GROUP BY action ORDER BY count DESC LIMIT 10`
      ),
      db.query(
        `SELECT EXTRACT(HOUR FROM timestamp)::int AS jam, COUNT(*) AS count
         FROM activity_log
         WHERE action = 'LOGIN' AND timestamp >= NOW() - INTERVAL '24 hours'
         GROUP BY jam ORDER BY jam`
      ),
    ]);

    res.json({
      total_login_hari_ini:       parseInt(loginHariIni.rows[0].n, 10),
      total_login_gagal_hari_ini: parseInt(loginGagal.rows[0].n, 10),
      user_aktif_hari_ini:        userAktif.rows.map(r => r.username),
      aksi_terbanyak:             aksiTerbanyak.rows.map(r => ({ action: r.action, count: parseInt(r.count, 10) })),
      login_per_jam:              loginPerJam.rows.map(r => ({ jam: r.jam, count: parseInt(r.count, 10) })),
    });
  } catch (e) {
    console.error('[activity-log/stats]', e.message);
    res.status(500).json({ error: 'Gagal mengambil statistik.' });
  }
});

// â”€â”€ Admin: Backup & Restore â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// POST /api/admin/backup â€” trigger backup manual (pg_dump + gzip)
app.post('/api/admin/backup', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak.' });
  try {
    const result = await runBackup();
    writeLog(req, 'BACKUP', 'system',
      `Manual backup: ${result.filePath} (${result.fileSizeHuman})${result.s3Path ? ' â†’ ' + result.s3Path : ''}`
    );
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: 'Backup gagal: ' + e.message });
  }
});

// GET /api/admin/backups â€” list semua backup tersedia
app.get('/api/admin/backups', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak.' });
  try {
    res.json(listBackups());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/restore â€” restore dari file backup (.sql.gz)
// Wajib header X-Confirm: yes
app.post('/api/admin/restore', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak.' });
  if (req.headers['x-confirm'] !== 'yes')
    return res.status(400).json({ error: 'Wajib sertakan header X-Confirm: yes untuk konfirmasi restore.' });

  const { filePath } = req.body || {};
  if (!filePath) return res.status(400).json({ error: 'filePath wajib diisi.' });

  // Cegah path traversal
  const absPath    = path.resolve(__dirname, filePath);
  const backupRoot = path.resolve(__dirname, 'backups');
  if (!absPath.startsWith(backupRoot + path.sep) && absPath !== backupRoot)
    return res.status(400).json({ error: 'Path tidak valid.' });

  try {
    const result = await restoreBackup(filePath);
    writeLog(req, 'RESTORE', 'system', `Restore dari: ${filePath} | snapshot: ${result.preRestoreSnapshot || '-'}`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: 'Restore gagal: ' + e.message });
  }
});

// DELETE /api/admin/backups/cleanup â€” hapus backup lama secara manual
app.delete('/api/admin/backups/cleanup', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak.' });
  const days    = Math.max(parseInt(req.query.days, 10) || BACKUP_RETENTION_DAYS, 1);
  const removed = cleanOldBackups(days);
  writeLog(req, 'DELETE', 'system', `Cleanup ${removed} backup folder lama (>${days} hari)`);
  res.json({ ok: true, removed, message: `${removed} folder backup dihapus.` });
});

// POST /api/admin/notify/test â€” kirim email test, hanya admin
app.post('/api/admin/notify/test', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak.' });
  if (!_mailer) return res.status(400).json({ error: 'SMTP tidak dikonfigurasi. Periksa variabel SMTP_* di .env' });
  const to = NOTIFY_ADMIN || req.body?.to;
  if (!to) return res.status(400).json({ error: 'NOTIFY_EMAIL_ADMIN belum diset di .env dan tidak ada to di body.' });
  await sendNotification(
    to,
    '[AKTA IAT] Test Notifikasi Email',
    _emailHtml(
      'Test Notifikasi Berhasil',
      'Email ini memverifikasi bahwa konfigurasi SMTP Anda sudah benar.',
      [
        ['Dikirim oleh', req.user.displayName],
        ['Waktu',        new Date().toLocaleString('id-ID')],
        ['SMTP Host',    process.env.SMTP_HOST || '-'],
        ['Penerima',     to],
        ['Status',       'âœ“ Terkirim'],
      ],
      null
    )
  );
  res.json({ ok: true, sentTo: to });
});

// POST /api/admin/notify/run â€” trigger manual pengecekan notifikasi, hanya admin
app.post('/api/admin/notify/run', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak.' });
  runDailyNotifications().catch(e => console.error('[notify]', e.message));
  res.json({ ok: true, message: 'Pengecekan notifikasi dimulai (background).' });
});

// â”€â”€ Export helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _xlsxHeaderRow(sheet) {
  const row    = sheet.getRow(1);
  row.font     = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
  row.height   = 22;
  sheet.views  = [{ state: 'frozen', ySplit: 1 }];
}

function _xlsxAutoWidth(sheet) {
  sheet.columns.forEach(col => {
    let max = col.header ? String(col.header).length : 8;
    col.eachCell({ includeEmpty: false }, cell => {
      const len = String(cell.value ?? '').length;
      if (len > max) max = len;
    });
    col.width = Math.min(max + 2, 50);
  });
}

async function _sendXlsx(res, filename, buildFn) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AKTA IAT'; wb.created = new Date();
  await buildFn(wb);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  await wb.xlsx.write(res);
  res.end();
}

function _sendPdf(res, filename, title, displayName, buildFn) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  doc.pipe(res);
  doc.fontSize(14).font('Helvetica-Bold').fillColor('#1E3A8A').text('AKTA IAT â€” Honda Dealer Audit', { align: 'center' });
  doc.fontSize(10).font('Helvetica').fillColor('#374151').text(title, { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(8).fillColor('#6B7280').text(`Digenerate: ${new Date().toLocaleString('id-ID')}   |   Oleh: ${displayName}`, { align: 'center' });
  doc.fillColor('#000').moveDown(0.6);
  doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor('#CBD5E1').lineWidth(0.5).stroke();
  doc.moveDown(0.5);
  buildFn(doc);
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(pages.start + i);
    doc.fontSize(8).fillColor('#9CA3AF').text(`Halaman ${i + 1} dari ${pages.count}`, 40, doc.page.height - 30, { align: 'center', width: doc.page.width - 80 });
  }
  doc.end();
}

function _pdfTable(doc, headers, rows, colWidths) {
  if (!colWidths) {
    const total = doc.page.width - 80;
    colWidths = headers.map(() => Math.floor(total / headers.length));
  }
  const pageBottom = doc.page.height - 60;
  let y = doc.y;
  function drawRow(cells, isHdr) {
    const h = isHdr ? 20 : 15;
    if (y + h > pageBottom) { doc.addPage(); y = 50; }
    let x = 40;
    cells.forEach((cell, ci) => {
      const w = colWidths[ci] || 50;
      if (isHdr) {
        doc.rect(x, y, w, h).fillAndStroke('#1E40AF', '#1E3A8A');
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8).text(String(cell ?? ''), x + 3, y + 5, { width: w - 6, lineBreak: false });
      } else {
        doc.rect(x, y, w, h).fillAndStroke('#FFFFFF', '#E5E7EB');
        doc.fillColor('#111827').font('Helvetica').fontSize(7.5).text(String(cell ?? ''), x + 3, y + 4, { width: w - 6, lineBreak: false });
      }
      x += w;
    });
    y += h;
  }
  drawRow(headers, true);
  rows.forEach(r => drawRow(r, false));
  doc.y = y + 6;
}

function _fmtDate(v) { if (!v) return '-'; const d = new Date(v); return isNaN(d) ? String(v) : d.toLocaleDateString('id-ID'); }
function _fmtNum(v)  { if (v === null || v === undefined || v === '') return '-'; const n = Number(v); return isNaN(n) ? String(v) : n.toLocaleString('id-ID'); }

// â”€â”€ Export routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// GET /api/export/kas/:planId?format=excel|pdf
app.get('/api/export/kas/:planId', requireAuth, async (req, res) => {
  const { planId } = req.params;
  const format   = (req.query.format || 'excel').toLowerCase();
  const dateStr  = _dateStr();
  const kas      = (await dbRead('akta_kas')).filter(k => String(k.planId || k.auditPlanId || '') === String(planId));
  const plan     = (await dbRead('akta_plans')).find(p => String(p.id) === String(planId)) || {};
  const infoLine = `Cabang: ${plan.cabangPlan || '-'}   No. SPT: ${plan.noSPT || '-'}   Tgl: ${_fmtDate(plan.tglMulai || plan.tanggal)}`;
  writeLog(req, 'EXPORT', 'akta_kas', `planId=${planId} format=${format}`);

  if (format === 'pdf') {
    return _sendPdf(res, `laporan-kas-${planId}-${dateStr}.pdf`, `Laporan Kas â€” ${plan.cabangPlan || planId}`, req.user.displayName, (doc) => {
      doc.fontSize(9).text(infoLine); doc.moveDown(0.5);
      _pdfTable(doc,
        ['No', 'Uraian / Pos Kas', 'Jumlah (Rp)', 'Saldo Buku (Rp)', 'Selisih (Rp)', 'Keterangan'],
        kas.length ? kas.map((k, i) => [i + 1, k.uraian || k.namaPos || k.nama || '-', _fmtNum(k.jumlah || k.nominal || k.saldoFisik), _fmtNum(k.saldoBuku || k.saldoSistem), _fmtNum(k.selisih), k.keterangan || k.catatan || '-'])
                   : [['â€”', 'Tidak ada data kas untuk plan ini.', '', '', '', '']],
        [22, 90, 62, 62, 52, 82]
      );
    });
  }

  await _sendXlsx(res, `laporan-kas-${planId}-${dateStr}.xlsx`, async (wb) => {
    const ws = wb.addWorksheet('Laporan Kas');
    ws.columns = [
      { header: 'No',              key: 'no',        width: 5  },
      { header: 'Uraian / Pos Kas', key: 'uraian',   width: 34 },
      { header: 'Jumlah (Rp)',     key: 'jumlah',    width: 20 },
      { header: 'Saldo Buku (Rp)', key: 'saldoBuku', width: 20 },
      { header: 'Selisih (Rp)',    key: 'selisih',   width: 18 },
      { header: 'Keterangan',      key: 'ket',       width: 32 },
    ];
    _xlsxHeaderRow(ws);
    kas.forEach((k, i) => ws.addRow({ no: i + 1, uraian: k.uraian || k.namaPos || k.nama || '-', jumlah: Number(k.jumlah || k.nominal || k.saldoFisik) || 0, saldoBuku: Number(k.saldoBuku || k.saldoSistem) || 0, selisih: Number(k.selisih) || 0, ket: k.keterangan || k.catatan || '-' }));
    ['jumlah', 'saldoBuku', 'selisih'].forEach(c => { ws.getColumn(c).numFmt = '#,##0'; });
    _xlsxAutoWidth(ws);
    const wi = wb.addWorksheet('Info');
    [['Laporan Kas â€” AKTA IAT'], ['Cabang', plan.cabangPlan || '-'], ['No. SPT', plan.noSPT || '-'], ['Export', new Date().toLocaleString('id-ID')], ['Oleh', req.user.displayName]].forEach(r => wi.addRow(r));
  });
});

// GET /api/export/tasks?format=excel|pdf&status=&bulan=
app.get('/api/export/tasks', requireAuth, async (req, res) => {
  const format  = (req.query.format || 'excel').toLowerCase();
  const dateStr = _dateStr();
  let tasks = await dbRead('akta_tasks');
  if (req.query.status) tasks = tasks.filter(t => (t.status || '').toLowerCase() === req.query.status.toLowerCase());
  if (req.query.bulan)  tasks = tasks.filter(t => (t.bulan || t.tglMulai || t.tanggal || '').startsWith(req.query.bulan));
  if (req.user.unitUsaha && ['so', 'csc', 'whs', 'kasir'].includes(req.user.role)) {
    const myUU = req.user.unitUsaha.trim().toUpperCase();
    tasks = tasks.filter(t => (t.cabangPlan || '').trim().toUpperCase() === myUU);
  }
  writeLog(req, 'EXPORT', 'akta_tasks', `format=${format} count=${tasks.length}`);

  const _rows = tasks.map((t, i) => [i + 1, t.noSPT || '-', t.cabangPlan || t.cabang || '-', t.tipeAudit || t.jenis || '-', _fmtDate(t.tglMulai || t.tanggal), t.status || '-', t.auditor || t.namaPemeriksa || '-', t.keterangan || '-']);

  if (format === 'pdf') {
    return _sendPdf(res, `laporan-tasks-${dateStr}.pdf`, 'Daftar Task Audit', req.user.displayName, (doc) => {
      _pdfTable(doc, ['No', 'No. SPT', 'Cabang', 'Tipe', 'Tanggal', 'Status', 'Auditor', 'Ket.'], _rows, [22, 52, 64, 42, 44, 38, 56, 52]);
    });
  }

  await _sendXlsx(res, `laporan-tasks-${dateStr}.xlsx`, async (wb) => {
    const ws = wb.addWorksheet('Task Audit');
    ws.columns = [
      { header: 'No',         key: 'no',     width: 5  },
      { header: 'No. SPT',    key: 'noSPT',  width: 20 },
      { header: 'Cabang',     key: 'cabang', width: 22 },
      { header: 'Tipe Audit', key: 'tipe',   width: 16 },
      { header: 'Tanggal',    key: 'tgl',    width: 14 },
      { header: 'Status',     key: 'status', width: 14 },
      { header: 'Auditor',    key: 'auditor',width: 24 },
      { header: 'Keterangan', key: 'ket',    width: 30 },
    ];
    _xlsxHeaderRow(ws);
    tasks.forEach((t, i) => ws.addRow({ no: i + 1, noSPT: t.noSPT || '-', cabang: t.cabangPlan || t.cabang || '-', tipe: t.tipeAudit || t.jenis || '-', tgl: t.tglMulai || t.tanggal || '-', status: t.status || '-', auditor: t.auditor || t.namaPemeriksa || '-', ket: t.keterangan || '-' }));
    _xlsxAutoWidth(ws);
  });
});

// GET /api/export/summary/:planId?format=excel|pdf
app.get('/api/export/summary/:planId', requireAuth, async (req, res) => {
  const { planId } = req.params;
  const format  = (req.query.format || 'excel').toLowerCase();
  const dateStr = _dateStr();
  const plan    = (await dbRead('akta_plans')).find(p => String(p.id) === String(planId)) || {};
  const kas     = (await dbRead('akta_kas')).filter(k => String(k.planId || k.auditPlanId || '') === String(planId));
  const smh     = (await dbRead('akta_smh_hasil')).filter(s => String(s.auditPlanId || s.planId || '') === String(planId));
  const rek     = (await dbRead('akta_rekomendasi')).filter(r => String(r.planId || r.auditPlanId || '') === String(planId));
  writeLog(req, 'EXPORT', 'summary', `planId=${planId} format=${format}`);

  if (format === 'pdf') {
    return _sendPdf(res, `laporan-summary-${planId}-${dateStr}.pdf`, `Ringkasan Audit â€” ${plan.cabangPlan || planId}`, req.user.displayName, (doc) => {
      doc.fontSize(9).text(`Cabang: ${plan.cabangPlan || '-'}   No. SPT: ${plan.noSPT || '-'}`); doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(10).text('A. Pemeriksaan Kas'); doc.font('Helvetica').moveDown(0.3);
      _pdfTable(doc, ['No', 'Uraian', 'Jumlah (Rp)', 'Saldo Buku (Rp)', 'Selisih (Rp)'],
        kas.length ? kas.map((k, i) => [i + 1, k.uraian || k.nama || '-', _fmtNum(k.jumlah || k.nominal), _fmtNum(k.saldoBuku), _fmtNum(k.selisih)]) : [['â€”', 'Tidak ada data', '', '', '']],
        [22, 130, 68, 68, 58]);
      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').fontSize(10).text('B. Hasil Pemeriksaan SMH'); doc.font('Helvetica').moveDown(0.3);
      _pdfTable(doc, ['No', 'No. Mesin', 'No. Rangka', 'Jenis', 'Status', 'Keterangan'],
        smh.length ? smh.slice(0, 100).map((s, i) => [i + 1, s.noMesin || '-', s.noRangka || '-', s.jenis || '-', s.status || '-', s.keterangan || '-']) : [['â€”', 'Tidak ada data', '', '', '', '']],
        [22, 64, 64, 44, 38, 64]);
      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').fontSize(10).text('C. Rekomendasi Audit'); doc.font('Helvetica').moveDown(0.3);
      _pdfTable(doc, ['No', 'Judul Rekomendasi', 'Status', 'Deadline', 'PIC'],
        rek.length ? rek.map((r, i) => [i + 1, r.judul || r.title || '-', r.status || '-', _fmtDate(r.deadline || r.targetDate), r.pic || r.penanggungJawab || '-']) : [['â€”', 'Tidak ada data', '', '', '']],
        [22, 180, 58, 58, 58]);
    });
  }

  await _sendXlsx(res, `laporan-summary-${planId}-${dateStr}.xlsx`, async (wb) => {
    // Sheet: Kas
    const wsK = wb.addWorksheet('Kas');
    wsK.columns = [{ header: 'No', key: 'no', width: 5 }, { header: 'Uraian', key: 'uraian', width: 34 }, { header: 'Jumlah (Rp)', key: 'jumlah', width: 20 }, { header: 'Saldo Buku (Rp)', key: 'saldoBuku', width: 20 }, { header: 'Selisih (Rp)', key: 'selisih', width: 18 }, { header: 'Keterangan', key: 'ket', width: 30 }];
    _xlsxHeaderRow(wsK);
    kas.forEach((k, i) => wsK.addRow({ no: i + 1, uraian: k.uraian || k.nama || '-', jumlah: Number(k.jumlah || k.nominal) || 0, saldoBuku: Number(k.saldoBuku) || 0, selisih: Number(k.selisih) || 0, ket: k.keterangan || '-' }));
    ['jumlah', 'saldoBuku', 'selisih'].forEach(c => wsK.getColumn(c).numFmt = '#,##0');
    _xlsxAutoWidth(wsK);
    // Sheet: SMH
    const wsS = wb.addWorksheet('SMH');
    wsS.columns = [{ header: 'No', key: 'no', width: 5 }, { header: 'No. Mesin', key: 'noMesin', width: 22 }, { header: 'No. Rangka', key: 'noRangka', width: 22 }, { header: 'Jenis', key: 'jenis', width: 16 }, { header: 'Warna', key: 'warna', width: 14 }, { header: 'Status', key: 'status', width: 14 }, { header: 'Keterangan', key: 'ket', width: 28 }];
    _xlsxHeaderRow(wsS);
    smh.forEach((s, i) => wsS.addRow({ no: i + 1, noMesin: s.noMesin || '-', noRangka: s.noRangka || '-', jenis: s.jenis || '-', warna: s.warna || '-', status: s.status || '-', ket: s.keterangan || '-' }));
    _xlsxAutoWidth(wsS);
    // Sheet: Rekomendasi
    const wsR = wb.addWorksheet('Rekomendasi');
    wsR.columns = [{ header: 'No', key: 'no', width: 5 }, { header: 'Judul', key: 'judul', width: 40 }, { header: 'Status', key: 'status', width: 16 }, { header: 'Deadline', key: 'deadline', width: 16 }, { header: 'PIC', key: 'pic', width: 24 }];
    _xlsxHeaderRow(wsR);
    rek.forEach((r, i) => wsR.addRow({ no: i + 1, judul: r.judul || r.title || '-', status: r.status || '-', deadline: r.deadline || r.targetDate || '-', pic: r.pic || r.penanggungJawab || '-' }));
    _xlsxAutoWidth(wsR);
    // Sheet: Info
    const wi = wb.addWorksheet('Info');
    [['Ringkasan Audit â€” AKTA IAT'], ['Cabang', plan.cabangPlan || '-'], ['No. SPT', plan.noSPT || '-'], ['Export', new Date().toLocaleString('id-ID')], ['Oleh', req.user.displayName], ['Total Kas', kas.length], ['Total SMH', smh.length], ['Total Rekomendasi', rek.length]].forEach(r => wi.addRow(r));
  });
});

// GET /api/export/plans?format=excel|pdf&bulan=YYYY-MM&status=
app.get('/api/export/plans', requireAuth, async (req, res) => {
  const format  = (req.query.format || 'excel').toLowerCase();
  const dateStr = _dateStr();
  try {
    let data = await dbRead('akta_plans');
    if (req.query.bulan)  data = data.filter(p => (p.tglMulai || p.tanggal || '').startsWith(req.query.bulan));
    if (req.query.status) data = data.filter(p => (p.status || '').toLowerCase() === req.query.status.toLowerCase());
    writeLog(req, 'EXPORT', 'akta_plans', `format=${format} count=${data.length}`);

    const columns = [
      { key: 'no',        header: 'No',          width: 1 },
      { key: 'noSPT',     header: 'No. SPT',      width: 3 },
      { key: 'cabang',    header: 'Cabang',        width: 3.5 },
      { key: 'jenis',     header: 'Jenis Audit',   width: 3 },
      { key: 'tglPlan',   header: 'Tgl Plan',      width: 2.5 },
      { key: 'kepalaTim', header: 'Kepala Tim',    width: 3 },
      { key: 'tim',       header: 'Tim Audit',     width: 3 },
      { key: 'status',    header: 'Status',        width: 2.5 },
    ];
    const rows = data.map((p, i) => ({
      no:        i + 1,
      noSPT:     p.noSPT || '-',
      cabang:    p.cabangPlan || p.cabang || '-',
      jenis:     p.jenisAudit || p.jenis || '-',
      tglPlan:   _fmtDate(p.tglMulai || p.tanggal),
      kepalaTim: p.kepalaTim || p.namaPemeriksa || '-',
      tim:       Array.isArray(p.tim) ? p.tim.join(', ') : (p.tim || '-'),
      status:    p.status || '-',
    }));

    if (format === 'pdf') {
      const buf = await reports.generatePDF('Daftar Plan Audit', `Total: ${rows.length} plan`, columns, rows, req.user.displayName);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="plan-audit-${dateStr}.pdf"`);
      return res.send(buf);
    }
    const buf = await reports.generateExcel(rows, columns, 'Plan Audit', 'Daftar Plan Audit â€” AKTA IAT', req.user.displayName);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="plan-audit-${dateStr}.xlsx"`);
    return res.send(buf);
  } catch (e) {
    console.error('[export/plans]', e.message);
    res.status(500).json({ error: 'Gagal generate export plans.' });
  }
});

// GET /api/export/bpkb?format=excel|pdf&bulan=YYYY-MM&planId=
app.get('/api/export/bpkb', requireAuth, async (req, res) => {
  const format  = (req.query.format || 'excel').toLowerCase();
  const dateStr = _dateStr();
  try {
    let data = await dbRead('akta_bpkb_db');
    if (req.query.bulan)  data = data.filter(b => (b.tanggal || b.bulan || '').startsWith(req.query.bulan));
    if (req.query.planId) data = data.filter(b => String(b.planId || b.auditPlanId || '') === String(req.query.planId));
    writeLog(req, 'EXPORT', 'akta_bpkb_db', `format=${format} count=${data.length}`);

    const columns = [
      { key: 'no',       header: 'No',         width: 0.8 },
      { key: 'noBpkb',   header: 'No. BPKB',   width: 3 },
      { key: 'noPol',    header: 'No. Polisi',  width: 2.5 },
      { key: 'noMesin',  header: 'No. Mesin',   width: 3 },
      { key: 'noRangka', header: 'No. Rangka',  width: 3 },
      { key: 'jenis',    header: 'Jenis',        width: 2.5 },
      { key: 'tanggal',  header: 'Tanggal',      width: 2.5 },
      { key: 'status',   header: 'Status',       width: 2 },
      { key: 'ket',      header: 'Keterangan',   width: 4 },
    ];
    const rows = data.map((b, i) => ({
      no:       i + 1,
      noBpkb:   b.noBpkb || b.noBPKB || '-',
      noPol:    b.noPol || b.nomorPolisi || '-',
      noMesin:  b.noMesin || '-',
      noRangka: b.noRangka || '-',
      jenis:    b.jenis || b.tipe || '-',
      tanggal:  _fmtDate(b.tanggal || b.tglBeli),
      status:   b.status || '-',
      ket:      b.keterangan || b.catatan || '-',
    }));

    if (format === 'pdf') {
      const buf = await reports.generatePDF('Laporan BPKB Onhand', `Total: ${rows.length} unit`, columns, rows, req.user.displayName);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="bpkb-${dateStr}.pdf"`);
      return res.send(buf);
    }
    const buf = await reports.generateExcel(rows, columns, 'BPKB Onhand', 'Laporan BPKB Onhand â€” AKTA IAT', req.user.displayName);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="bpkb-${dateStr}.xlsx"`);
    return res.send(buf);
  } catch (e) {
    console.error('[export/bpkb]', e.message);
    res.status(500).json({ error: 'Gagal generate export BPKB.' });
  }
});

// GET /api/export/rekomendasi?format=excel|pdf&planId=&status=
app.get('/api/export/rekomendasi', requireAuth, async (req, res) => {
  const format  = (req.query.format || 'excel').toLowerCase();
  const dateStr = _dateStr();
  try {
    let data = await dbRead('akta_rekomendasi');
    if (req.query.planId) data = data.filter(r => String(r.planId || r.auditPlanId || '') === String(req.query.planId));
    if (req.query.status) data = data.filter(r => (r.status || '').toLowerCase() === req.query.status.toLowerCase());
    writeLog(req, 'EXPORT', 'akta_rekomendasi', `format=${format} count=${data.length}`);

    const columns = [
      { key: 'no',       header: 'No',          width: 0.8 },
      { key: 'judul',    header: 'Judul',        width: 5 },
      { key: 'cabang',   header: 'Cabang',       width: 3 },
      { key: 'status',   header: 'Status',       width: 2.5 },
      { key: 'deadline', header: 'Deadline',     width: 2.5 },
      { key: 'pic',      header: 'PIC',          width: 3 },
      { key: 'ket',      header: 'Keterangan',   width: 4 },
    ];
    const rows = data.map((r, i) => ({
      no:       i + 1,
      judul:    r.judul || r.title || '-',
      cabang:   r.cabang || r.cabangPlan || '-',
      status:   r.status || '-',
      deadline: _fmtDate(r.deadline || r.targetDate),
      pic:      r.pic || r.penanggungJawab || '-',
      ket:      r.keterangan || r.catatan || '-',
    }));

    if (format === 'pdf') {
      const buf = await reports.generatePDF('Laporan Rekomendasi Audit', `Total: ${rows.length} item`, columns, rows, req.user.displayName);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="rekomendasi-${dateStr}.pdf"`);
      return res.send(buf);
    }
    const buf = await reports.generateExcel(rows, columns, 'Rekomendasi', 'Laporan Rekomendasi Audit â€” AKTA IAT', req.user.displayName);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rekomendasi-${dateStr}.xlsx"`);
    return res.send(buf);
  } catch (e) {
    console.error('[export/rekomendasi]', e.message);
    res.status(500).json({ error: 'Gagal generate export rekomendasi.' });
  }
});

// Serve login page as root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

// â”€â”€ Error handler (PayloadTooLarge, CORS, dll) â”€â”€
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request terlalu besar. Maksimal ukuran body adalah 50MB.' });
  }
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ error: err.message });
  }
  console.error('[server error]', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

// â”€â”€ Start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(async () => {
  const dbOk = await db.connect();
  if (dbOk) await initDbData();
  app.listen(PORT, () => {
    console.log(`\nâ•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—`);
    console.log(`â•‘   AKTA IAT Server v1.0               â•‘`);
    console.log(`â•‘   http://localhost:${PORT}                â•‘`);
    console.log(`â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•`);
    console.log(`\n  Data dir : ${DATA_DIR}`);
    console.log(`  DB       : ${dbOk ? 'âœ“ PostgreSQL' : 'âš  tidak terhubung'}`);
    console.log(`  JWT      : ${JWT_SECRET === 'akta-iat-secret-2026-change-in-prod' ? 'âš  default (ganti di .env)' : 'âœ“ custom'}\n`);
  });
})();
