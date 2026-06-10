/* =============================================
   hash-passwords.js — AKTA IAT Utility
   Jalankan sekali: node hash-passwords.js
   Lalu copy-paste output ke array USERS di server.js
   ============================================= */
'use strict';

const bcrypt = require('bcrypt');
const SALT_ROUNDS = 10;

// Salin dari array USERS di server.js
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

(async () => {
  console.log('\n// ── Ganti array USERS di server.js dengan ini ───────────────\n');
  console.log('const USERS = [');
  for (const u of USERS) {
    const hash = await bcrypt.hash(u.password, SALT_ROUNDS);
    const unitStr = u.unitUsaha ? `'${u.unitUsaha}'` : "''";
    console.log(
      `  { username: '${u.username.padEnd(13)}', password: '${hash}', displayName: '${u.displayName}', role: '${u.role}', unitUsaha: ${unitStr} },`
    );
  }
  console.log('];');
  console.log('\n// ─────────────────────────────────────────────────────────────\n');
  console.log('Selesai. Copy semua baris di atas ke server.js, gantikan array USERS yang lama.');
  console.log('Password asli TIDAK disimpan di mana pun — simpan di tempat aman jika perlu.\n');
})();
