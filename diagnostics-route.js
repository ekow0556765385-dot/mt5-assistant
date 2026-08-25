// ═══════════════════════════════════════════════════════════════
// diagnostics-route.js — collect the errors that happen on users'
// devices, which is where every silent breakage so far has hidden.
//
// Mount with the other /api routes:
//     const diagnosticsRoute = require('./diagnostics-route');
//     app.use(diagnosticsRoute);
//
// This is error REPORTING, not code analysis. Nothing here reads your
// source looking for bugs; it collects failures that already happened.
//
// Deliberately open (no requireAuth): the most valuable report is the
// one from a page that failed BEFORE the user was authenticated — a
// blocked CDN, a broken token exchange, a module that never booted. An
// error nobody can report is an error you never learn about.
//
// Being open means it must be defended:
//   * a per-IP rate limit, so one looping page cannot flood the table
//   * every field length-capped before it reaches the database
//   * identical errors collapsed into one row with a count, so a bug
//     firing every second does not become 86,400 rows a day
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const router  = express.Router();

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_PER_IP_PER_MIN = 20;
const FLUSH_MS           = 30000;
const MAX_LEN            = { message: 500, source: 300, module: 40, ua: 250 };

function headers(extra = {}) {
  return { Authorization: `Bearer ${SUPABASE_SVC}`, apikey: SUPABASE_SVC, ...extra };
}
const cut = (v, n) => v == null ? null : String(v).slice(0, n);

// ── rate limit ─────────────────────────────────────────────────
const seen = new Map();   // ip -> { count, resetAt }
function overLimit(ip) {
  const now = Date.now();
  const rec = seen.get(ip);
  if (!rec || now > rec.resetAt) { seen.set(ip, { count: 1, resetAt: now + 60000 }); return false; }
  rec.count += 1;
  return rec.count > MAX_PER_IP_PER_MIN;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of seen) if (now > rec.resetAt) seen.delete(ip);
}, 120000).unref?.();

// A stable fingerprint for "the same bug", so a hundred occurrences read
// as one problem with a count rather than a hundred separate lines.
// The line number is deliberately included — the same message from two
// places is usually two different faults.
function signature({ message, source, line }) {
  const norm = String(message || '')
    .replace(/https?:\/\/[^\s)]+/g, '<url>')     // URLs differ per user
    .replace(/\b\d{3,}\b/g, '<n>')               // ids, timestamps, ports
    .slice(0, 200);
  return crypto.createHash('sha1')
    .update(`${norm}|${String(source || '').split('/').pop()}|${line || 0}`)
    .digest('hex').slice(0, 16);
}

const pending = new Map();   // signature -> row

// ── POST /api/client-error ─────────────────────────────────────
router.post('/api/client-error', express.json({ limit: '16kb' }), (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
             req.socket?.remoteAddress || 'unknown';
  // Always 204: a reporter that gets an error back may report THAT too.
  if (overLimit(ip)) return res.sendStatus(204);

  const b = req.body || {};
  if (!b.message) return res.sendStatus(204);

  const sig = signature({ message: b.message, source: b.source, line: b.line });
  const existing = pending.get(sig);
  if (existing) {
    existing.count += 1;
    if (b.userId && !existing.user_id) existing.user_id = b.userId;
    return res.sendStatus(204);
  }

  pending.set(sig, {
    signature:  sig,
    message:    cut(b.message, MAX_LEN.message),
    source:     cut(b.source, MAX_LEN.source),
    line_no:    Number.isFinite(Number(b.line)) ? Number(b.line) : null,
    module:     cut(b.module, MAX_LEN.module),
    user_agent: cut(req.headers['user-agent'], MAX_LEN.ua),
    user_id:    b.userId || null,
    count:      1
  });
  res.sendStatus(204);
});

// ── flush ──────────────────────────────────────────────────────
async function flush() {
  if (!pending.size || !SUPABASE_URL || !SUPABASE_SVC) return;
  const batch = [...pending.values()];
  pending.clear();
  for (const row of batch) {
    try {
      // One row per occurrence would be useless to read, so the batch
      // is collapsed and the occurrence count travels WITH the row —
      // dropping it here would make six failures look like one.
      await axios.post(`${SUPABASE_URL}/rest/v1/client_errors`, row, {
        headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
        timeout: 8000
      });
    } catch (e) {
      console.warn('[DIAG] could not record error:', e.response?.data?.message || e.message);
    }
  }
}
setInterval(flush, FLUSH_MS).unref?.();

// ── summary, for the admin console ─────────────────────────────
async function summary(days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data } = await axios.get(
    `${SUPABASE_URL}/rest/v1/client_errors?at=gte.${since}&select=*&order=at.desc&limit=2000`,
    { headers: headers(), timeout: 12000 }
  );
  const rows = data || [];

  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.signature) || {
      signature: r.signature, message: r.message, source: r.source,
      line_no: r.line_no, module: r.module, count: 0,
      users: new Set(), browsers: new Set(),
      firstSeen: r.at, lastSeen: r.at
    };
    g.count += Number(r.count) || 1;
    if (r.user_id) g.users.add(r.user_id);
    if (r.user_agent) g.browsers.add(browserOf(r.user_agent));
    if (r.at < g.firstSeen) g.firstSeen = r.at;
    if (r.at > g.lastSeen)  g.lastSeen  = r.at;
    groups.set(r.signature, g);
  }

  return {
    days,
    total: rows.reduce((a, r) => a + (Number(r.count) || 1), 0),
    collecting: true,
    groups: [...groups.values()]
      .map(g => ({ ...g, users: g.users.size, browsers: [...g.browsers] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 60)
  };
}

// Enough to spot "only Safari" or "only on iOS", which is exactly the
// shape of bug that has bitten this platform before.
function browserOf(ua) {
  if (/Edg\//.test(ua))                      return 'Edge';
  if (/OPR\//.test(ua))                      return 'Opera';
  if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) return /Mobile/.test(ua) ? 'Chrome mobile' : 'Chrome';
  if (/Firefox\//.test(ua))                  return 'Firefox';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return /iPhone|iPad/.test(ua) ? 'Safari iOS' : 'Safari';
  return 'Other';
}

module.exports = router;
module.exports.summary = summary;
module.exports.flush = flush;
module.exports.signature = signature;
