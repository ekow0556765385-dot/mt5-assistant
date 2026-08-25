// ═══════════════════════════════════════════════════════════════
// notices-route.js — the user-facing half of in-app messages.
//
// Mount in app.js AFTER auth-middleware is available:
//     const noticesRoute = require('./notices-route');
//     app.use(noticesRoute);
//
// Two endpoints, both requireAuth (not requirePlan — a free user needs
// to see "your access is suspended" just as much as a Pro user does):
//   GET  /api/notices              what this user should see right now
//   POST /api/notices/:id/dismiss  remember they closed it
//
// The BANNER IS RENDERED BY THE SHELL ONLY. Each module runs in its own
// iframe, so rendering per-module would show the same warning seven
// times over.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const axios   = require('axios');
const router  = express.Router();

const { requireAuth } = require('./auth-middleware');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;

function svcHeaders() {
  return { Authorization: `Bearer ${SUPABASE_SVC}`, apikey: SUPABASE_SVC };
}

// Cheap in-process cache. Every dashboard load asks for notices, and
// they change a few times a month — hitting Supabase on each poll would
// be pure waste.
let cache = { at: 0, rows: [] };
const CACHE_MS = 30000;

// Publishing from the admin console clears this, so a notice appears at
// once instead of waiting out the cache. Exposed on globalThis rather
// than imported, to avoid a circular require between the two routers.
globalThis.bwNoticeCacheBust = function () {
  cache = { at: 0, rows: [] };
  dismissCache.clear();
};

async function activeMessages() {
  if (Date.now() - cache.at < CACHE_MS) return cache.rows;
  const nowIso = new Date().toISOString();
  const { data } = await axios.get(
    `${SUPABASE_URL}/rest/v1/messages` +
    `?select=id,audience,audience_key,severity,body,dismissible,starts_at,expires_at` +
    `&starts_at=lte.${nowIso}` +
    `&or=(expires_at.is.null,expires_at.gt.${nowIso})` +
    `&order=severity.desc,created_at.desc&limit=20`,
    { headers: svcHeaders(), timeout: 6000 }
  );
  cache = { at: Date.now(), rows: data || [] };
  return cache.rows;
}

// ── GET /api/notices ───────────────────────────────────────────
router.get('/api/notices', requireAuth, async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.json({ notices: [] });

  try {
    const [rows, plan, dismissed] = await Promise.all([
      activeMessages(),
      planFor(userId),
      dismissedBy(userId)
    ]);

    const notices = rows.filter(m => {
      if (dismissed.has(m.id)) return false;
      if (m.audience === 'all')  return true;
      if (m.audience === 'plan') return m.audience_key === plan;
      if (m.audience === 'user') return m.audience_key === userId;
      return false;
    }).map(m => ({
      id: m.id, severity: m.severity, body: m.body, dismissible: m.dismissible
    }));

    // Only ever one banner. More than one stacked on a dashboard is
    // noise, and the most severe is the one that matters.
    const rank = { critical: 3, warning: 2, info: 1 };
    notices.sort((a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0));

    res.json({ notices: notices.slice(0, 1), more: Math.max(0, notices.length - 1) });
  } catch (e) {
    // A notice system failing must never break the dashboard around it.
    console.warn('[NOTICES] could not read notices:', e.response?.data?.message || e.message);
    res.json({ notices: [], more: 0 });
  }
});

// ── POST /api/notices/:id/dismiss ──────────────────────────────
router.post('/api/notices/:id/dismiss', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.user?.id;
  if (!Number.isInteger(id) || !userId) return res.status(400).json({ error: 'Bad request' });
  try {
    await axios.post(
      `${SUPABASE_URL}/rest/v1/message_dismissals`,
      { message_id: id, user_id: userId },
      { headers: { ...svcHeaders(), 'Content-Type': 'application/json',
                   Prefer: 'resolution=merge-duplicates,return=minimal' }, timeout: 6000 }
    );
    dismissCache.delete(userId);
    res.json({ ok: true });
  } catch (e) {
    console.warn('[NOTICES] dismiss failed:', e.response?.data?.message || e.message);
    res.json({ ok: false });   // the banner hides client-side regardless
  }
});

const dismissCache = new Map();
async function dismissedBy(userId) {
  const hit = dismissCache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.set;
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/message_dismissals?user_id=eq.${userId}&select=message_id`,
      { headers: svcHeaders(), timeout: 6000 }
    );
    const set = new Set((data || []).map(r => r.message_id));
    dismissCache.set(userId, { at: Date.now(), set });
    return set;
  } catch { return new Set(); }
}

const planCache = new Map();
async function planFor(userId) {
  const hit = planCache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.plan;
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=plan`,
      { headers: svcHeaders(), timeout: 6000 }
    );
    const plan = data?.[0]?.plan || 'free';
    planCache.set(userId, { at: Date.now(), plan });
    return plan;
  } catch { return 'free'; }
}

module.exports = router;
