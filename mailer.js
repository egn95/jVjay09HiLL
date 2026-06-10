/* =============================================
   mailer.js — Email Notification
   AKTA IAT | Nodemailer + HTML template
   Graceful: tidak crash jika SMTP tidak dikonfigurasi
   ============================================= */
'use strict';

const nodemailer = require('nodemailer');

const _configured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const APP_URL   = process.env.APP_URL   || 'http://localhost:3000';
const SMTP_FROM = process.env.SMTP_FROM
  || (process.env.SMTP_USER ? `AKTA IAT <${process.env.SMTP_USER}>` : 'AKTA IAT <noreply@localhost>');

let _transport = null;
if (_configured) {
  _transport = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true' || parseInt(process.env.SMTP_PORT, 10) === 465,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls:    { rejectUnauthorized: false },
  });
}

/**
 * Build HTML email body dari template standar AKTA IAT.
 * @param {string} title
 * @param {string} intro
 * @param {[string, string][]} tableRows   — pasangan [label, nilai]
 * @param {string|null} footerNote
 * @returns {string} HTML string
 */
function emailTemplate(title, intro, tableRows, footerNote) {
  const rows = tableRows.map(([label, value]) =>
    `<tr>
      <td style="padding:8px 14px;border-bottom:1px solid #e2e8f0;font-weight:600;color:#374151;width:160px;background:#f8fafc;white-space:nowrap;font-size:13px">${label}</td>
      <td style="padding:8px 14px;border-bottom:1px solid #e2e8f0;color:#1f2937;font-size:13px">${String(value ?? '-').replace(/</g, '&lt;')}</td>
    </tr>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1e3a5f 0%,#2d5fa3 100%);padding:28px 32px">
      <div style="font-size:22px;font-weight:700;color:#fff;letter-spacing:.5px">AKTA IAT</div>
      <div style="font-size:12px;color:rgba(255,255,255,.7);margin-top:3px">Honda Dealer Audit System</div>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px">
      <h2 style="margin:0 0 8px;font-size:18px;color:#1e3a5f;font-weight:700">${title}</h2>
      <p style="margin:0 0 20px;color:#6b7280;font-size:14px;line-height:1.6">${intro}</p>

      <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
        ${rows}
      </table>

      ${footerNote ? `<p style="margin:16px 0 0;font-size:13px;color:#6b7280;line-height:1.6">${footerNote}</p>` : ''}
    </div>

    <!-- CTA Button -->
    <div style="padding:0 32px 24px">
      <a href="${APP_URL}" style="display:inline-block;background:#1e3a5f;color:#fff;text-decoration:none;padding:11px 28px;border-radius:8px;font-size:14px;font-weight:600;letter-spacing:.3px">Buka Aplikasi</a>
    </div>

    <!-- Footer -->
    <div style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0">
      <p style="margin:0;font-size:11px;color:#9ca3af">
        Email ini dikirim otomatis oleh AKTA IAT pada ${new Date().toLocaleString('id-ID')}.
        Jangan membalas email ini.
      </p>
    </div>

  </div>
</body>
</html>`;
}

/**
 * Kirim email.
 * @param {string|string[]} to       — penerima
 * @param {string}          subject
 * @param {string}          htmlBody
 * @param {string}          [textBody] — fallback plain text (auto-generated jika tidak diisi)
 * @returns {Promise<void>}
 */
async function sendMail(to, subject, htmlBody, textBody) {
  if (!to || !subject) return;
  if (!_transport) {
    console.warn(`[mailer] SMTP tidak dikonfigurasi — dilewati: "${subject}" → ${Array.isArray(to) ? to.join(', ') : to}`);
    return;
  }
  try {
    const toStr = Array.isArray(to) ? to.join(', ') : to;
    const text  = textBody || htmlBody.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
    await _transport.sendMail({ from: SMTP_FROM, to: toStr, subject, html: htmlBody, text });
    console.log(`[mailer] ✓ Terkirim → ${toStr}: ${subject}`);
  } catch (e) {
    console.error(`[mailer] ✗ Gagal kirim → ${Array.isArray(to) ? to.join(', ') : to}: ${e.message}`);
  }
}

module.exports = { sendMail, emailTemplate, isConfigured: _configured };
