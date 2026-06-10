/* =============================================
   sse.js — Server-Sent Events Manager
   AKTA IAT | Multi-tab support per user
   ============================================= */
'use strict';

// Map: username → Set<res> (support multiple browser tabs)
const _clients = new Map();
// Map: username → role  (untuk sendToRole)
const _roles   = new Map();

/**
 * Daftarkan koneksi SSE baru.
 * @param {string} username
 * @param {string} role
 * @param {import('express').Response} res
 */
function addClient(username, role, res) {
  if (!_clients.has(username)) _clients.set(username, new Set());
  _clients.get(username).add(res);
  _roles.set(username, role);
}

/**
 * Hapus koneksi SSE saat client disconnect.
 * @param {string} username
 * @param {import('express').Response} res
 */
function removeClient(username, res) {
  const set = _clients.get(username);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) {
    _clients.delete(username);
    _roles.delete(username);
  }
}

/**
 * Tulis satu SSE event ke satu response object.
 */
function _write(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  } catch {
    // Client sudah disconnect — abaikan saja
  }
}

/**
 * Kirim event ke satu user (semua tab-nya).
 * @param {string} username
 * @param {string} event
 * @param {*} data
 */
function sendToUser(username, event, data) {
  const set = _clients.get(username);
  if (!set || set.size === 0) return;
  set.forEach(res => _write(res, event, data));
}

/**
 * Kirim event ke semua user dengan role tertentu.
 * @param {string} role
 * @param {string} event
 * @param {*} data
 */
function sendToRole(role, event, data) {
  for (const [username, r] of _roles) {
    if (r === role) sendToUser(username, event, data);
  }
}

/**
 * Broadcast event ke semua connected users.
 * @param {string} event
 * @param {*} data
 */
function sendToAll(event, data) {
  for (const username of _clients.keys()) {
    sendToUser(username, event, data);
  }
}

/** Jumlah total koneksi aktif (untuk monitoring). */
function clientCount() {
  let total = 0;
  for (const set of _clients.values()) total += set.size;
  return total;
}

module.exports = { addClient, removeClient, sendToUser, sendToRole, sendToAll, clientCount };
