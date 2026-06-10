/* =============================================
   db.js — PostgreSQL connection pool
   AKTA IAT Backend
   ============================================= */
'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME     || 'akta_iat',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max:                   20,
  min:                   2,
  idleTimeoutMillis:     30000,
  connectionTimeoutMillis: 2000,
  allowExitOnIdle:       true,
});

pool.on('error', (err, client) => {
  console.error('[db] Pool client error (koneksi mati):', err.message);
});

pool.on('connect', () => {
  if (process.env.NODE_ENV !== 'production') return;
});

pool.on('remove', () => {
  // client removed from pool — normal lifecycle, no action needed
});

/**
 * Connect to PostgreSQL with retry logic.
 * @param {number} retries — number of attempts (default 3)
 * @returns {Promise<boolean>} true if connected, false if all retries exhausted
 */
async function connect(retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const client = await pool.connect();
      const { rows } = await client.query('SELECT NOW() AS now');
      client.release();
      console.log(`[db] PostgreSQL connected — server time: ${rows[0].now}`);
      return true;
    } catch (e) {
      console.error(`[db] Connection attempt ${attempt}/${retries} failed: ${e.message}`);
      if (attempt < retries) {
        const delay = 2000 * attempt;
        console.log(`[db] Retrying in ${delay / 1000}s…`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  console.error('[db] All connection attempts failed. Running without PostgreSQL.');
  return false;
}

/**
 * Execute a parameterized SQL query.
 * @param {string} sql
 * @param {Array}  params
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(sql, params) {
  return pool.query(sql, params);
}

/**
 * Acquire a raw client from the pool (caller must release).
 * @returns {Promise<import('pg').PoolClient>}
 */
function getClient() {
  return pool.connect();
}

module.exports = { pool, query, getClient, connect };
