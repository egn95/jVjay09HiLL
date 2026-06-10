/* =============================================
   setup-passwords.js — AKTA IAT
   Hash built-in dan custom users ke PostgreSQL users table.
   Jalankan sekali setelah migrate.js:
     node migrate.js
     node setup-passwords.js
   ============================================= */
'use strict';

require('dotenv').config();
const bcrypt = require('bcrypt');
const db     = require('./db');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS, 10) || 12;

// Harus identik dengan USERS array di server.js
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

function _isHashed(pw) {
  return typeof pw === 'string' && (pw.startsWith('$2b$') || pw.startsWith('$2a$'));
}

function _normPw(pw) {
  if (typeof pw === 'string' && pw.startsWith('PLAINTEXT:')) return pw.slice('PLAINTEXT:'.length);
  return pw;
}

async function main() {
  console.log('\n=== setup-passwords.js — AKTA IAT ===');
  console.log(`  bcrypt rounds : ${BCRYPT_ROUNDS}`);
  console.log('');

  const dbOk = await db.connect();
  if (!dbOk) {
    console.error('[ERROR] Tidak bisa terhubung ke database. Periksa .env');
    process.exit(1);
  }

  let successCount = 0;
  let errorCount   = 0;

  // ── 1. Built-in users ─────────────────────────────
  console.log('--- Built-in users ---');
  for (const u of USERS) {
    try {
      const hash = await bcrypt.hash(u.password, BCRYPT_ROUNDS);
      await db.query(
        `INSERT INTO users (username, password_hash, display_name, role, unit_usaha, created_by)
         VALUES ($1, $2, $3, $4, $5, 'setup-passwords')
         ON CONFLICT (username) DO UPDATE SET
           password_hash = EXCLUDED.password_hash,
           display_name  = EXCLUDED.display_name,
           role          = EXCLUDED.role,
           unit_usaha    = EXCLUDED.unit_usaha,
           updated_at    = NOW()`,
        [u.username, hash, u.displayName, u.role, u.unitUsaha || '']
      );
      console.log(`  [OK] ${u.username.padEnd(16)} (${u.role}) — hashed`);
      successCount++;
    } catch (e) {
      console.error(`  [ERR] ${u.username}: ${e.message}`);
      errorCount++;
    }
  }

  // ── 2. Custom users dari app_data ─────────────────
  console.log('\n--- Custom users (dari app_data.akta_custom_users) ---');
  let customUsers = [];
  try {
    const { rows } = await db.query(
      "SELECT data_value FROM app_data WHERE data_key = 'akta_custom_users'"
    );
    if (rows.length > 0 && Array.isArray(rows[0].data_value)) {
      customUsers = rows[0].data_value;
    }
  } catch (e) {
    console.warn('  [WARN] Tidak bisa baca akta_custom_users:', e.message);
  }

  if (customUsers.length === 0) {
    console.log('  (tidak ada custom users)');
  }

  for (const cu of customUsers) {
    if (!cu.username) continue;
    // Skip jika username sudah ada di built-in list
    if (USERS.some(u => u.username === cu.username)) {
      console.log(`  [SKIP] ${cu.username} — sudah ada di built-in users`);
      continue;
    }
    try {
      const rawPw    = _normPw(cu.password || '');
      const hash     = _isHashed(rawPw)
        ? rawPw  // sudah di-hash, pakai langsung
        : await bcrypt.hash(rawPw, BCRYPT_ROUNDS);
      const disabled = cu._disabled || false;

      await db.query(
        `INSERT INTO users (username, password_hash, display_name, role, unit_usaha, is_disabled, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'setup-passwords-custom')
         ON CONFLICT (username) DO UPDATE SET
           password_hash = EXCLUDED.password_hash,
           display_name  = EXCLUDED.display_name,
           role          = EXCLUDED.role,
           unit_usaha    = EXCLUDED.unit_usaha,
           is_disabled   = EXCLUDED.is_disabled,
           updated_at    = NOW()`,
        [cu.username, hash, cu.displayName || cu.username, cu.role || 'auditor', cu.unitUsaha || '', disabled]
      );
      const status = _isHashed(rawPw) ? 'sudah hash' : 'hashed';
      console.log(`  [OK] ${cu.username.padEnd(16)} (${cu.role || 'auditor'}) — ${status}${disabled ? ' [disabled]' : ''}`);
      successCount++;
    } catch (e) {
      console.error(`  [ERR] ${cu.username}: ${e.message}`);
      errorCount++;
    }
  }

  // ── Summary ────────────────────────────────────────
  console.log('');
  console.log('=== Summary ===');
  console.log(`  Berhasil : ${successCount} user`);
  if (errorCount > 0) console.log(`  Gagal    : ${errorCount} user`);
  console.log('');
  console.log('Semua password sudah di-hash ke tabel users.');
  console.log('Sekarang server.js akan login via PostgreSQL users table.\n');

  await db.pool?.end?.();
  process.exit(errorCount > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
