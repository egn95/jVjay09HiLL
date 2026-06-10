/* =============================================
   backup.js — PostgreSQL Backup Module
   AKTA IAT | pg_dump + gzip + optional S3
   ============================================= */
'use strict';

const { spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');
const zlib       = require('zlib');

const BACKUP_DIR = path.join(__dirname, 'backups');

// ── Helpers ──────────────────────────────────────

function _dbConn() {
  return {
    host: process.env.DB_HOST     || 'localhost',
    port: process.env.DB_PORT     || '5432',
    name: process.env.DB_NAME     || 'akta_iat',
    user: process.env.DB_USER     || 'postgres',
  };
}

function _pgEnv() {
  return { ...process.env, PGPASSWORD: process.env.DB_PASSWORD || '' };
}

function _timestamp() {
  // YYYY-MM-DD_HH-MM
  return new Date().toISOString().replace('T', '_').slice(0, 16).replace(/:/g, '-');
}

function _fmtBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// ── S3 Upload (optional) ─────────────────────────

async function _uploadToS3(filePath) {
  const bucket    = process.env.BACKUP_S3_BUCKET;
  const endpoint  = process.env.BACKUP_S3_ENDPOINT;
  const accessKey = process.env.BACKUP_S3_ACCESS_KEY;
  const secretKey = process.env.BACKUP_S3_SECRET_KEY;
  const region    = process.env.BACKUP_S3_REGION || 'auto';

  if (!bucket || !accessKey || !secretKey) return null;

  let S3Client, PutObjectCommand;
  try {
    const sdk    = require('@aws-sdk/client-s3');
    S3Client     = sdk.S3Client;
    PutObjectCommand = sdk.PutObjectCommand;
  } catch {
    console.warn('[backup] @aws-sdk/client-s3 tidak terinstall — S3 upload dilewati.');
    return null;
  }

  const s3Config = { region, credentials: { accessKeyId: accessKey, secretAccessKey: secretKey } };
  if (endpoint) s3Config.endpoint = endpoint;
  const s3  = new S3Client(s3Config);
  const key = path.basename(filePath);

  await s3.send(new PutObjectCommand({
    Bucket:      bucket,
    Key:         key,
    Body:        fs.createReadStream(filePath),
    ContentType: 'application/gzip',
  }));

  return `s3://${bucket}/${key}`;
}

// ── runBackup ────────────────────────────────────

/**
 * Jalankan pg_dump, kompres dengan gzip, simpan ke backups/TIMESTAMP/.
 * Jika BACKUP_S3_BUCKET dikonfigurasi, upload ke S3-compatible storage.
 * @returns {{ success, filePath, fileSize, fileSizeHuman, duration, s3Path }}
 */
async function runBackup() {
  const ts       = _timestamp();
  const dir      = path.join(BACKUP_DIR, ts);
  const filename = `akta_iat_backup_${ts}.sql.gz`;
  const absPath  = path.join(dir, filename);

  fs.mkdirSync(dir, { recursive: true });

  const { host, port, name, user } = _dbConn();
  const pgDump = process.env.PG_DUMP_PATH || 'pg_dump';
  const start  = Date.now();

  await new Promise((resolve, reject) => {
    const dump    = spawn(pgDump, ['-h', host, '-p', port, '-U', user, '-d', name, '--format=plain', '--no-password'], { env: _pgEnv() });
    const gzip    = zlib.createGzip({ level: 9 });
    const outFile = fs.createWriteStream(absPath);

    dump.stdout.pipe(gzip).pipe(outFile);

    const stderrBufs = [];
    dump.stderr.on('data', c => stderrBufs.push(c));

    outFile.on('finish', resolve);
    outFile.on('error', reject);

    dump.on('close', code => {
      if (code !== 0) {
        const msg = Buffer.concat(stderrBufs).toString().trim().slice(0, 500);
        reject(new Error(`pg_dump exited ${code}: ${msg}`));
      }
    });
    dump.on('error', e => reject(new Error(`pg_dump tidak ditemukan: ${e.message}. Set PG_DUMP_PATH di .env`)));
  });

  const stat     = fs.statSync(absPath);
  const fileSize = stat.size;
  const duration = Date.now() - start;
  const relPath  = path.relative(__dirname, absPath).replace(/\\/g, '/');

  console.log(`[backup] pg_dump selesai: ${relPath} (${_fmtBytes(fileSize)}, ${duration}ms)`);

  // Optional S3 upload
  let s3Path = null;
  try { s3Path = await _uploadToS3(absPath); }
  catch (e) { console.error('[backup] S3 upload gagal:', e.message); }
  if (s3Path) console.log(`[backup] S3 upload: ${s3Path}`);

  return { success: true, filePath: relPath, fileSize, fileSizeHuman: _fmtBytes(fileSize), duration, s3Path };
}

// ── cleanOldBackups ──────────────────────────────

/**
 * Hapus folder backup lebih dari retentionDays hari.
 * @param {number} retentionDays
 * @returns {number} jumlah folder yang dihapus
 */
function cleanOldBackups(retentionDays = 30) {
  if (!fs.existsSync(BACKUP_DIR)) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed  = 0;
  for (const entry of fs.readdirSync(BACKUP_DIR)) {
    const entryPath = path.join(BACKUP_DIR, entry);
    try {
      if (!fs.statSync(entryPath).isDirectory()) continue;
      // Nama folder: YYYY-MM-DD_HH-MM
      const dateStr = entry.slice(0, 10);
      const ts      = Date.parse(dateStr);
      if (!isNaN(ts) && ts < cutoff) {
        fs.rmSync(entryPath, { recursive: true, force: true });
        removed++;
        console.log(`[backup] Dihapus: ${entry}`);
      }
    } catch (e) {
      console.error(`[backup] Gagal hapus ${entry}:`, e.message);
    }
  }
  return removed;
}

// ── listBackups ──────────────────────────────────

/**
 * Kembalikan array semua backup yang tersedia.
 * @returns {{ date, filePath, fileSize, fileSizeHuman, createdAt }[]}
 */
function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  const result = [];
  for (const entry of fs.readdirSync(BACKUP_DIR).sort().reverse()) {
    const entryPath = path.join(BACKUP_DIR, entry);
    try {
      if (!fs.statSync(entryPath).isDirectory()) continue;
      const files = fs.readdirSync(entryPath).filter(f => f.endsWith('.sql.gz'));
      for (const file of files) {
        const absFile = path.join(entryPath, file);
        const stat    = fs.statSync(absFile);
        result.push({
          date:          entry,
          filePath:      path.relative(__dirname, absFile).replace(/\\/g, '/'),
          fileSize:      stat.size,
          fileSizeHuman: _fmtBytes(stat.size),
          createdAt:     stat.birthtime.toISOString(),
        });
      }
    } catch (e) {
      console.error(`[backup] listBackups error for ${entry}:`, e.message);
    }
  }
  return result;
}

// ── restoreBackup ────────────────────────────────

/**
 * Restore database dari file .sql.gz.
 * Otomatis buat snapshot sebelum restore.
 * @param {string} filePath — path relatif dari root proyek
 * @returns {{ success, message, preRestoreSnapshot }}
 */
async function restoreBackup(filePath) {
  const absPath = path.resolve(__dirname, filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`File backup tidak ditemukan: ${filePath}`);
  }

  // Buat snapshot sebelum restore
  let preRestoreSnapshot = null;
  try {
    const snap = await runBackup();
    preRestoreSnapshot = snap.filePath;
    console.log(`[backup] Pre-restore snapshot: ${preRestoreSnapshot}`);
  } catch (e) {
    console.warn(`[backup] Pre-restore snapshot gagal: ${e.message}`);
  }

  const { host, port, name, user } = _dbConn();
  const psql = process.env.PSQL_PATH || 'psql';

  await new Promise((resolve, reject) => {
    const psqlProc = spawn(psql, ['-h', host, '-p', port, '-U', user, '-d', name, '--no-password'], { env: _pgEnv() });

    const gunzip     = zlib.createGunzip();
    const readStream = fs.createReadStream(absPath);

    readStream.pipe(gunzip).pipe(psqlProc.stdin);

    const stderrBufs = [];
    psqlProc.stderr.on('data', c => stderrBufs.push(c));

    psqlProc.on('close', code => {
      if (code === 0) resolve();
      else {
        const msg = Buffer.concat(stderrBufs).toString().trim().slice(0, 500);
        reject(new Error(`psql exited ${code}: ${msg}`));
      }
    });
    psqlProc.on('error', e => reject(new Error(`psql tidak ditemukan: ${e.message}. Set PSQL_PATH di .env`)));
  });

  console.log(`[backup] Restore berhasil dari: ${filePath}`);
  return { success: true, message: `Restore berhasil dari ${path.basename(filePath)}`, preRestoreSnapshot };
}

module.exports = { runBackup, cleanOldBackups, listBackups, restoreBackup };
