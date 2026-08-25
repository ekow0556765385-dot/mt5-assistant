// ═══════════════════════════════════════════════════════════════
// usage-route.js — how long people actually spend in each module.
//
// Mount in app.js with the other /api routes:
//     const usageRoute = require('./usage-route');
//     app.use(usageRoute);
//
// The shell posts a beat every 30 seconds WHILE THE TAB IS VISIBLE.
// Visibility is the whole trick: without it, a forgotten tab left open
// overnight reports eight hours of "usage" and every number downstream
// becomes fiction.
//
// Writes are batched in memory and flushed once a minute. A beat every
// 30s per user per module would otherwise mean a database round trip
// per user per half minute, for data nobody reads more than twice a day.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const axios   = require('axios');
const router  = express.Router();

const { requireAuth } = require('./auth-middleware');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BEAT_SECONDS = 30;
const MAX_BEAT     = 120;   // ignore anything larger; a tab that was
                            // asleep must not dump its whole nap in one beat
const FLUSH_MS     = 60000;

const MODULES = ['assistant', 'brain', 'smc', 'patterns', 'math', 'agent', 'retracement', 'dashboard'];

function headers(extra = {}) {
  return { Authorization: `Bearer ${SUPABASE_SVC}`, apikey: SUPABASE_SVC, ...extra };
}

// key: `${userId}|${day}|${module}` -> seconds
const pending = new Map();

// ── POST /api/usage/beat ───────────────────────────────────────
router.post('/api/usage/beat', requireAuth, (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.json({ ok: false });

  let mod = String(req.body?.module || 'dashboard').toLowerCase();
  if (!MODULES.includes(mod)) mod = 'dashboard';

  let secs = Number(req.body?.seconds);
  if (!Number.isFinite(secs) || secs <= 0) secs = BEAT_SECONDS;
  secs = Math.min(secs, MAX_BEAT);

  const day = new Date().toISOString().slice(0, 10);
  const key = `${userId}|${day}|${mod}`;
  pending.set(key, (pending.get(key) || 0) + Math.round(secs));

  res.json({ ok: true });
});

// ── flush ──────────────────────────────────────────────────────
async function flush() {
  if (!pending.size || !SUPABASE_URL || !SUPABASE_SVC) return;
  const batch = [...pending.entries()];
  pending.clear();

  for (const [key, seconds] of batch) {
    const [user_id, day, module] = key.split('|');
    try {
      // Read-add-write rather than an upsert, because PostgREST cannot
      // express "add to the existing value" and two dashboards open at
      // once would otherwise overwrite each other.
      const { data } = await axios.get(
        `${SUPABASE_URL}/rest/v1/usage_daily?user_id=eq.${user_id}&day=eq.${day}&module=eq.${module}&select=seconds`,
        { headers: headers(), timeout: 8000 }
      );
      const existing = data?.[0]?.seconds || 0;
      await axios.post(`${SUPABASE_URL}/rest/v1/usage_daily`,
        { user_id, day, module, seconds: existing + seconds },
        { headers: headers({ 'Content-Type': 'application/json',
                             Prefer: 'resolution=merge-duplicates,return=minimal' }), timeout: 8000 });
    } catch (e) {
      // Put it back so the next flush retries rather than losing it.
      pending.set(key, (pending.get(key) || 0) + seconds);
      console.warn('[USAGE] flush failed, will retry:', e.response?.data?.message || e.message);
    }
  }
}
setInterval(flush, FLUSH_MS).unref?.();
process.on('SIGTERM', () => { flush().catch(() => {}); });

// ── GET /api/usage/summary (admin only — mounted under /admin) ──
async function summary(days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const { data } = await axios.get(
    `${SUPABASE_URL}/rest/v1/usage_daily?day=gte.${since}&select=user_id,day,module,seconds`,
    { headers: headers(), timeout: 12000 }
  );
  const rows = data || [];

  const byModule = {}, byUser = {}, byDay = {};
  let total = 0;
  for (const r of rows) {
    const s = Number(r.seconds) || 0;
    total += s;
    if (!byModule[r.module]) byModule[r.module] = { seconds: 0, users: new Set() };
    byModule[r.module].seconds += s;
    byModule[r.module].users.add(r.user_id);
    byUser[r.user_id] = (byUser[r.user_id] || 0) + s;
    byDay[r.day] = (byDay[r.day] || 0) + s;
  }

  return {
    days,
    totalSeconds: total,
    activeUsers: Object.keys(byUser).length,
    modules: Object.entries(byModule)
      .map(([module, v]) => ({ module, seconds: v.seconds, users: v.users.size }))
      .sort((a, b) => b.seconds - a.seconds),
    perUser: byUser,
    perDay: Object.entries(byDay).map(([day, seconds]) => ({ day, seconds })).sort((a, b) => a.day < b.day ? -1 : 1),
    collecting: rows.length > 0
  };
}

module.exports = router;
module.exports.summary = summary;
module.exports.flush = flush;
