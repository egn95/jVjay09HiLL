/* =============================================
   migrate.js — Database migration runner
   AKTA IAT
   Usage: node migrate.js
   ============================================= */
'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const db   = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const DATA_DIR       = path.join(__dirname, 'data');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(50) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function getAppliedVersions(client) {
  const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version');
  return new Set(rows.map(r => r.version));
}

async function runSqlFile(client, filePath) {
  const sql = fs.readFileSync(filePath, 'utf8');
  await client.query(sql);
}

async function runMigrations() {
  console.log('\n[migrate] Starting AKTA IAT database migration…\n');

  const connected = await db.connect();
  if (!connected) {
    console.error('[migrate] Cannot connect to PostgreSQL. Aborting.');
    process.exit(1);
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    await ensureMigrationsTable(client);
    const applied = await getAppliedVersions(client);

    // Sort migration files alphabetically (001_..., 002_..., etc.)
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      // Extract version from filename prefix (e.g. "001" from "001_initial_schema.sql")
      const version = file.split('_')[0];
      if (applied.has(version)) {
        console.log(`  [skip] ${file} (already applied)`);
        continue;
      }

      console.log(`  [run ] ${file} …`);
      const filePath = path.join(MIGRATIONS_DIR, file);
      await runSqlFile(client, filePath);
      console.log(`  [done] ${file}`);
      ran++;
    }

    await client.query('COMMIT');

    if (ran === 0) {
      console.log('\n[migrate] All migrations already applied. Nothing to do.\n');
    } else {
      console.log(`\n[migrate] ${ran} migration(s) applied successfully.\n`);
    }

    // Migrate existing JSON data files → PostgreSQL
    await migrateJsonData();

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[migrate] Migration failed, rolled back:', e.message);
    process.exit(1);
  } finally {
    client.release();
  }
}

async function migrateJsonData() {
  if (!fs.existsSync(DATA_DIR)) {
    console.log('[migrate] No data/ directory found — skipping JSON migration.\n');
    return;
  }

  const jsonFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  if (jsonFiles.length === 0) {
    console.log('[migrate] No JSON files found in data/ — skipping JSON migration.\n');
    return;
  }

  console.log(`[migrate] Found ${jsonFiles.length} JSON file(s) in data/ — migrating to PostgreSQL…`);
  let migrated = 0;
  let skipped  = 0;

  for (const file of jsonFiles) {
    // Derive data_key from filename: akta_kas.json → akta_kas
    const dataKey = file.replace('.json', '');
    const filePath = path.join(DATA_DIR, file);

    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.warn(`  [warn] Cannot parse ${file}: ${e.message} — skipping`);
      skipped++;
      continue;
    }

    // Skip empty arrays/objects (no real data to migrate)
    if (
      (Array.isArray(data) && data.length === 0) ||
      (data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0)
    ) {
      console.log(`  [skip] ${file} (empty)`);
      skipped++;
      continue;
    }

    try {
      await db.query(
        `INSERT INTO app_data (data_key, data_value, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (data_key) DO UPDATE
           SET data_value = EXCLUDED.data_value,
               updated_at = NOW()`,
        [dataKey, JSON.stringify(data)]
      );
      const count = Array.isArray(data) ? data.length : Object.keys(data).length;
      console.log(`  [ok  ] ${file} → ${dataKey} (${count} item(s))`);
      migrated++;
    } catch (e) {
      console.error(`  [err ] ${file}: ${e.message}`);
      skipped++;
    }
  }

  console.log(`\n[migrate] JSON migration done: ${migrated} migrated, ${skipped} skipped.\n`);
}

runMigrations()
  .then(() => {
    console.log('[migrate] Complete. Exiting.');
    process.exit(0);
  })
  .catch(e => {
    console.error('[migrate] Unexpected error:', e.message);
    process.exit(1);
  });
