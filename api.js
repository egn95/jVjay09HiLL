/* =============================================
   api.js — AKTA IAT Frontend API Client
   Harus dimuat SEBELUM auth.js
   Graceful degradation: jika server tidak ada,
   app tetap berjalan dengan localStorage.
   ============================================= */
window.API = (function () {
  'use strict';

  const BASE    = '/api';
  const RT_KEY  = 'akta_refresh_token';
  let _ok       = false;  // server reachable?
  let _syncing  = false;
  let _refreshing = false;

  function _tok() {
    try { return JSON.parse(sessionStorage.getItem('akta_session'))?.token || ''; }
    catch { return ''; }
  }

  // Coba refresh access token menggunakan refresh token tersimpan
  async function _refreshAccessToken() {
    if (_refreshing) return false;
    const rt = localStorage.getItem(RT_KEY);
    if (!rt) return false;
    _refreshing = true;
    try {
      const r = await fetch(BASE + '/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!r.ok) {
        localStorage.removeItem(RT_KEY);
        _refreshing = false;
        return false;
      }
      const d = await r.json();
      // Update token di session
      try {
        const sess = JSON.parse(sessionStorage.getItem('akta_session')) || {};
        sess.token = d.token;
        if (d.user) {
          sess.displayName = d.user.displayName;
          sess.role        = d.user.role;
          sess.unitUsaha   = d.user.unitUsaha;
        }
        sessionStorage.setItem('akta_session', JSON.stringify(sess));
      } catch {}
      _refreshing = false;
      return true;
    } catch (e) {
      console.warn('[API] refresh failed:', e.message);
      localStorage.removeItem(RT_KEY);
      _refreshing = false;
      return false;
    }
  }

  // Wrapper fetch dengan auto-refresh on 401
  async function _apiFetch(method, path, body) {
    const tok = _tok();
    const headers = { 'Content-Type': 'application/json' };
    if (tok) headers['Authorization'] = 'Bearer ' + tok;
    const opts = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);

    let r = await fetch(BASE + path, opts);

    // 401 → coba refresh, lalu retry sekali
    if (r.status === 401) {
      const refreshed = await _refreshAccessToken();
      if (refreshed) {
        const newTok = _tok();
        opts.headers = { ...headers, 'Authorization': 'Bearer ' + newTok };
        r = await fetch(BASE + path, opts);
      }
    }

    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { msg = (await r.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    return r.json();
  }

  // ── Public API ──────────────────────────────────

  return {
    isAvailable() { return _ok; },

    // Check server + pre-load all data into localStorage
    async init() {
      try {
        await fetch(BASE + '/ping', { signal: AbortSignal.timeout(2500) });
        _ok = true;
      } catch {
        _ok = false;
        return false;
      }

      try {
        if (_syncing) return true;
        _syncing = true;
        // all-data menggunakan optionalAuth — bisa diakses dengan atau tanpa token
        const tok = _tok();
        const headers = { 'Content-Type': 'application/json' };
        if (tok) headers['Authorization'] = 'Bearer ' + tok;
        const r = await fetch(BASE + '/all-data', { headers, signal: AbortSignal.timeout(5000) });
        if (!r.ok) { _syncing = false; return true; }
        const data = await r.json();
        Object.entries(data).forEach(([k, v]) => {
          if (v === null || v === undefined) return;
          // Jangan timpa data lokal yang sudah ada dengan data kosong dari server
          // Server wins only if server has data; local wins if server returns empty
          const isEmptyServer = Array.isArray(v) ? v.length === 0
            : (typeof v === 'object' && v !== null && Object.keys(v).length === 0);
          if (isEmptyServer) {
            const localRaw = localStorage.getItem(k);
            if (localRaw) {
              try {
                const local = JSON.parse(localRaw);
                const localHasData = Array.isArray(local) ? local.length > 0
                  : (typeof local === 'object' && local !== null && Object.keys(local).length > 0);
                if (localHasData) return; // Pertahankan data lokal
              } catch {}
            }
          }
          localStorage.setItem(k, JSON.stringify(v));
        });
        _syncing = false;
      } catch (e) {
        _syncing = false;
        console.warn('[API] init data load failed:', e.message);
      }
      return true;
    },

    // Login via server, returns { token, refreshToken, user }
    async login(username, password) {
      const data = await _apiFetch('POST', '/auth/login', { username, password });
      // Simpan refresh token ke localStorage
      if (data.refreshToken) {
        localStorage.setItem(RT_KEY, data.refreshToken);
      }
      return data;
    },

    // Logout via server — hapus refresh token
    async logout(refreshToken) {
      const rt = refreshToken || localStorage.getItem(RT_KEY);
      localStorage.removeItem(RT_KEY);
      if (!_ok || !_tok()) return;
      _apiFetch('POST', '/auth/logout', { refreshToken: rt }).catch(() => {});
    },

    // Sync a single localStorage key to server (fire-and-forget)
    sync(key, data) {
      if (!_ok || !_tok()) return;
      _apiFetch('PUT', '/data', { key, value: data }).catch(e => {
        console.warn('[API] sync failed for', key, e.message);
      });
    },
  };
})();
