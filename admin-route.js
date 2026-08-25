// ═══════════════════════════════════════════════════════════════
// admin-route.js — the /admin route tree.
//
// Mount in app.js AFTER express.json() and BEFORE any catch-all:
//     const adminRoute = require('./admin-route');
//     app.use('/admin', adminRoute);
//
// Everything here is read-only. Write actions (change plan, suspend,
// regenerate key) come next, and each will wrap its change in an
// admin_audit insert so nothing can be changed without a record.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const axios   = require('axios');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();

const lastSeen = require('./last-seen');

const {
  COOKIE, SESSION_HOURS, verifyTOTP, verifyPassword, mintSession,
  throttleState, recordFailure, clearFailures, adminConfig,
  requireAdmin, clientIp
} = require('./admin-auth');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;

// The service role key bypasses row-level security, so it is only ever
// used server-side, inside routes already behind requireAdmin.
function svcHeaders() {
  if (!SUPABASE_SVC) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return { Authorization: `Bearer ${SUPABASE_SVC}`, apikey: SUPABASE_SVC };
}

// Collapses app.js's per-source registry down to the most recent feed
// per user — the one the roster's "last seen" column reflects.
function newestByUser() {
  const reg = globalThis.bwSourcesByUser || {};
  const out = {};
  for (const [userId, sources] of Object.entries(reg)) {
    for (const meta of Object.values(sources || {})) {
      if (!out[userId] || (meta.lastSeen || 0) > (out[userId].lastSeen || 0)) {
        out[userId] = meta;
      }
    }
  }
  return out;
}

const isProd = process.env.NODE_ENV === 'production';
function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure:   isProd,
    sameSite: 'lax',              // not 'none' — admin is never framed
    path:     '/admin',           // the browser won't send it anywhere else
    maxAge:   SESSION_HOURS * 3600 * 1000
  });
}

// Own body parsers, so this router works wherever it is mounted —
// including ahead of the app's global express.json().
router.use(express.json());
router.use(express.urlencoded({ extended: false }));

// Admin pages are never cached and never framed.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "frame-ancestors 'none'");
  // 'no-referrer' made browsers send `Origin: null` on the login form
  // POST, which a strict CORS allow-list rejects — surfacing as a 500
  // before the request ever reached this router. 'same-origin' keeps
  // referrers off external links while leaving Origin intact.
  res.set('Referrer-Policy', 'same-origin');
  next();
});

// ── GET /admin/login ───────────────────────────────────────────
router.get('/login', (req, res) => {
  const { missing } = adminConfig();
  res.type('html').send(loginPage({
    error: req.query.e ? decodeURIComponent(req.query.e) : null,
    unconfigured: missing.length ? missing : null
  }));
});

// ── POST /admin/login ──────────────────────────────────────────
router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const { cfg, missing } = adminConfig();
  if (missing.length) {
    return res.redirect('/admin/login?e=' + encodeURIComponent('Admin console is not configured on this server.'));
  }

  const ip = clientIp(req);
  const gate = throttleState(ip);
  if (gate.locked) {
    const mins = Math.ceil(gate.retryInMs / 60000);
    console.warn(`[ADMIN] locked out ${ip}, ${mins}m remaining`);
    return res.redirect('/admin/login?e=' + encodeURIComponent(`Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`));
  }

  const email = String(req.body.email || '').trim().toLowerCase();
  const pw    = String(req.body.password || '');
  const code  = String(req.body.code || '');

  // One message for every failure mode. Saying which factor was wrong
  // tells an attacker whether they have the password.
  const emailOk = email === String(cfg.email).trim().toLowerCase();
  const pwOk    = verifyPassword(pw, cfg.hash);
  const totpOk  = verifyTOTP(cfg.totp, code);

  if (!emailOk || !pwOk || !totpOk) {
    const rec = recordFailure(ip);
    console.warn(`[ADMIN] failed sign-in from ${ip} (attempt ${rec.count})`);
    const left = Math.max(0, 5 - rec.count);
    const msg = left > 0
      ? `Those details were not accepted. ${left} attempt${left === 1 ? '' : 's'} left.`
      : 'Those details were not accepted. This address is now locked for 15 minutes.';
    return res.redirect('/admin/login?e=' + encodeURIComponent(msg));
  }

  clearFailures(ip);
  setSessionCookie(res, mintSession(cfg.email, cfg.secret));
  console.log(`[ADMIN] signed in — ${cfg.email} from ${ip}`);
  res.redirect('/admin');
});

// ── POST /admin/logout ─────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/admin', httpOnly: true, secure: isProd, sameSite: 'lax' });
  res.redirect('/admin/login');
});

// ═══ everything below requires an admin session ════════════════
router.use(requireAdmin);

// ── GET /admin ─────────────────────────────────────────────────
// sendFile throws a bare 500 when the file is absent, which reads as
// "the server is broken" rather than "one file did not get deployed".
// Say which file, and where it was expected.
router.get('/', (req, res) => {
  const file = path.join(__dirname, 'admin.html');
  if (!fs.existsSync(file)) {
    console.error(`[ADMIN] admin.html not found at ${file}`);
    return res.status(500).type('html').send(missingPage(file));
  }
  res.sendFile(file, err => {
    if (err && !res.headersSent) {
      console.error('[ADMIN] could not send admin.html:', err.message);
      res.status(500).type('html').send(missingPage(file));
    }
  });
});

// ── GET /admin/api/me ──────────────────────────────────────────
router.get('/api/me', (req, res) => {
  res.json({ email: req.admin.email, issuedAt: req.admin.issuedAt });
});

// ── GET /admin/api/users ───────────────────────────────────────
// One row per account: plan, renewal, licence, credits, activity.
router.get('/api/users', async (req, res) => {
  try {
    const cols = [
      'user_id', 'plan', 'plan_key', 'status', 'licence_key', 'expires_at',
      'created_at', 'updated_at', 'credit_balance', 'credit_reset_at',
      'bound_account', 'broker_type', 'watch_pairs', 'preferred_source',
      'telegram_chat_id', 'legal_version', 'access_status', 'access_reason', 'grace_until', 'last_seen_at'
    ].join(',');

    const { data: subs } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?select=${cols}&order=created_at.desc`,
      { headers: svcHeaders() }
    );

    // Emails live in auth.users, which PostgREST does not expose, so
    // they come from the admin API instead.
    const emails = await fetchEmails();

    // app.js already keeps this: userId -> { sourceId -> {transport,lastSeen} },
    // published as globalThis.bwSourcesByUser so smc-route.js can read it
    // without a circular require. Reusing it means no new activity map and
    // no change to app.js.
    const activity = newestByUser();
    const now = Date.now();

    const users = subs.map(s => {
      const seen = activity[s.user_id];
      const expiresMs = s.expires_at ? Date.parse(s.expires_at) : null;
      return {
        userId:        s.user_id,
        email:         emails[s.user_id] || null,
        plan:          s.plan,
        planKey:       s.plan_key,
        subStatus:     s.status,
        accessStatus:  s.access_status || 'active',
        accessReason:  s.access_reason || null,
        graceUntil:    s.grace_until || null,
        licenceKey:    s.licence_key,
        licenceShort:  s.licence_key ? s.licence_key.slice(0, 7) + '…' : null,
        boundAccount:  s.bound_account,
        brokerType:    s.broker_type,
        transport:     seen?.transport || null,
        expiresAt:     s.expires_at,
        daysToRenewal: expiresMs === null ? null : Math.round((expiresMs - now) / 86400000),
        credits:       s.credit_balance === null ? null : Number(s.credit_balance),
        creditResetAt: s.credit_reset_at,
        watchPairs:    s.watch_pairs || [],
        telegram:      Boolean(s.telegram_chat_id),
        joinedAt:      s.created_at,
        // Real activity for ANY signed-in account, from last_seen_at.
        // The feed registry only knows about terminals, so a free user
        // with no EA used to read "Never" however often they signed in.
        // In-memory is fresher than the row between throttled writes.
        lastSeenMs:    (() => {
          const mem  = lastSeen.recent(s.user_id);
          const row  = s.last_seen_at ? Date.parse(s.last_seen_at) : 0;
          const feed = seen ? seen.lastSeen : 0;
          const best = Math.max(mem, row, feed);
          return best ? now - best : null;
        })(),
        lastSeenSource: (() => {
          const row  = s.last_seen_at ? Date.parse(s.last_seen_at) : 0;
          const feed = seen ? seen.lastSeen : 0;
          const mem  = lastSeen.recent(s.user_id);
          const best = Math.max(mem, row, feed);
          if (!best) return null;
          return best === feed && feed > Math.max(mem, row) ? 'terminal' : 'dashboard';
        })()
      };
    });

    res.json({
      users,
      counts: {
        total:     users.length,
        paid:      users.filter(u => u.plan !== 'free').length,
        liveNow:   users.filter(u => u.lastSeenMs !== null && u.lastSeenMs < 5 * 60000).length,
        dueSoon:   users.filter(u => u.daysToRenewal !== null && u.daysToRenewal >= 0 && u.daysToRenewal <= 7).length,
        overdue:   users.filter(u => u.daysToRenewal !== null && u.daysToRenewal < 0).length,
        suspended: users.filter(u => u.accessStatus !== 'active').length
      },
      // Told plainly rather than shown as an empty state, because a
      // missing table looks exactly like "nobody is sharing".
      notes: emails.__unavailable ? ['Email addresses unavailable — check the service role key.'] : []
    });
  } catch (e) {
    console.error('[ADMIN] /api/users failed:', e.response?.data || e.message);
    res.status(502).json({ error: 'Could not read subscriptions', detail: e.response?.data?.message || e.message });
  }
});

async function fetchEmails() {
  const map = {};
  try {
    let page = 1;
    for (;;) {
      const { data } = await axios.get(
        `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=200`,
        { headers: svcHeaders() }
      );
      const list = data.users || data || [];
      list.forEach(u => { map[u.id] = u.email; });
      if (list.length < 200) break;
      page += 1;
      if (page > 25) break;   // hard stop so a paging bug can't spin
    }
  } catch (e) {
    console.warn('[ADMIN] could not list auth users:', e.response?.data || e.message);
    map.__unavailable = true;
  }
  return map;
}

// ── GET /admin/api/licence-sharing ─────────────────────────────
// Distinct MT5 accounts seen per licence key. Reads licence_attempts
// if it exists; without it, returns an explicit "not collecting yet"
// rather than an empty list that would read as "no sharing found".
router.get('/api/licence-sharing', async (req, res) => {
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/licence_attempts?select=licence_key,account,outcome,seen_at&order=seen_at.desc&limit=5000`,
      { headers: svcHeaders() }
    );
    const byKey = new Map();
    for (const row of data) {
      if (!byKey.has(row.licence_key)) byKey.set(row.licence_key, { accounts: new Map(), refused: 0 });
      const rec = byKey.get(row.licence_key);
      if (row.outcome === 'refused') rec.refused += 1;
      const prev = rec.accounts.get(row.account);
      if (!prev || row.seen_at > prev) rec.accounts.set(row.account, row.seen_at);
    }
    const flagged = [...byKey.entries()]
      .map(([key, rec]) => ({
        licenceKey: key,
        accounts:   [...rec.accounts.entries()].map(([account, lastSeen]) => ({ account, lastSeen })),
        distinct:   rec.accounts.size,
        refused:    rec.refused,
        score:      Math.max(0, rec.accounts.size - 1) * 40 + Math.min(rec.refused, 5) * 4
      }))
      .filter(x => x.distinct > 1 || x.refused > 0)
      .sort((a, b) => b.score - a.score);
    res.json({ collecting: true, flagged });
  } catch (e) {
    const missingTable = e.response?.status === 404 ||
                         /relation .* does not exist|Could not find the table/i.test(e.response?.data?.message || '');
    if (missingTable) {
      return res.json({
        collecting: false,
        flagged: [],
        message: 'Not collecting yet — create the licence_attempts table and record a row in /api/validate-key.'
      });
    }
    console.error('[ADMIN] /api/licence-sharing failed:', e.response?.data || e.message);
    res.status(502).json({ error: 'Could not read licence attempts' });
  }
});

// ── GET /admin/api/health ──────────────────────────────────────
router.get('/api/health', (req, res) => {
  const now = Date.now();
  const seen = Object.values(newestByUser());
  res.json({
    linked:    seen.length,
    liveNow:   seen.filter(s => now - s.lastSeen < 5 * 60000).length,
    byTransport: {
      bridge: seen.filter(s => s.transport === 'bridge' && now - s.lastSeen < 5 * 60000).length,
      direct: seen.filter(s => s.transport === 'direct' && now - s.lastSeen < 5 * 60000).length
    },
    silentOverAnHour: seen.filter(s => now - s.lastSeen > 3600000).length,
    counters: req.app.get('adminCounters') || null,
    uptimeSeconds: Math.round(process.uptime()),
    note: 'Activity is held in memory and resets on every deploy.'
  });
});

// ── audit ──────────────────────────────────────────────────────
// Every write goes through here. Fire-and-forget so a logging failure
// cannot roll back a change the operator already saw succeed, but
// loudly warned about, because an unaudited write is the thing this
// table exists to prevent.
function audit({ req, action, targetUser = null, before = null, after = null, note = null }) {
  const row = {
    actor_email: req.admin?.email || 'unknown',
    action, target_user: targetUser,
    before_value: before, after_value: after, note,
    ip: clientIp(req)
  };
  axios.post(`${SUPABASE_URL}/rest/v1/admin_audit`, row, {
    headers: { ...svcHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    timeout: 5000
  }).catch(e => console.warn('[ADMIN] AUDIT WRITE FAILED:', action, e.response?.data?.message || e.message));
}

// ── GET /admin/api/messages ────────────────────────────────────
router.get('/api/messages', async (req, res) => {
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/messages?select=*&order=created_at.desc&limit=100`,
      { headers: svcHeaders() }
    );
    const now = Date.now();
    const messages = (data || []).map(m => ({
      ...m,
      active: Date.parse(m.starts_at) <= now && (!m.expires_at || Date.parse(m.expires_at) > now)
    }));
    // Seen counts come from the dismissal table; absent rows just mean
    // nobody has dismissed it, which is not the same as nobody seeing it.
    let seen = {};
    try {
      const { data: d } = await axios.get(
        `${SUPABASE_URL}/rest/v1/message_dismissals?select=message_id`, { headers: svcHeaders() });
      (d || []).forEach(r => { seen[r.message_id] = (seen[r.message_id] || 0) + 1; });
    } catch {}
    res.json({ messages, dismissals: seen });
  } catch (e) {
    console.error('[ADMIN] /api/messages failed:', e.response?.data || e.message);
    res.status(502).json({ error: 'Could not read messages', detail: e.response?.data?.message || e.message });
  }
});

// ── POST /admin/api/messages ───────────────────────────────────
router.post('/api/messages', async (req, res) => {
  const { audience, audienceKey, severity, body, dismissible, expiresAt } = req.body || {};

  const AUD = ['all', 'plan', 'user'];
  const SEV = ['info', 'warning', 'critical'];
  if (!AUD.includes(audience))  return res.status(400).json({ error: 'audience must be all, plan or user' });
  if (!SEV.includes(severity))  return res.status(400).json({ error: 'severity must be info, warning or critical' });
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Message body is required' });
  if (String(body).length > 500)     return res.status(400).json({ error: 'Message must be under 500 characters' });
  if (audience !== 'all' && !audienceKey) {
    return res.status(400).json({ error: audience === 'plan' ? 'Pick a plan' : 'Pick an account' });
  }

  const row = {
    audience,
    audience_key: audience === 'all' ? null : String(audienceKey),
    severity,
    body: String(body).trim(),
    dismissible: dismissible !== false,
    expires_at: expiresAt || null,
    created_by: req.admin.email
  };

  try {
    const { data } = await axios.post(`${SUPABASE_URL}/rest/v1/messages`, row, {
      headers: { ...svcHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' }
    });
    const created = Array.isArray(data) ? data[0] : data;
    if (typeof globalThis.bwNoticeCacheBust === 'function') globalThis.bwNoticeCacheBust();
    audit({ req, action: 'message.publish', targetUser: audience === 'user' ? audienceKey : null,
            after: created, note: `${severity} to ${audience}${audienceKey ? ' ' + audienceKey : ''}` });
    res.json({ ok: true, message: created });
  } catch (e) {
    console.error('[ADMIN] publish failed:', e.response?.data || e.message);
    res.status(502).json({ error: 'Could not publish', detail: e.response?.data?.message || e.message });
  }
});

// ── POST /admin/api/messages/:id/retract ───────────────────────
// Expires a notice rather than deleting it, so the audit trail and the
// dismissal counts survive.
router.post('/api/messages/:id/retract', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad message id' });
  try {
    const { data: before } = await axios.get(
      `${SUPABASE_URL}/rest/v1/messages?id=eq.${id}&select=*`, { headers: svcHeaders() });
    if (!before || !before.length) return res.status(404).json({ error: 'No such message' });

    const { data } = await axios.patch(
      `${SUPABASE_URL}/rest/v1/messages?id=eq.${id}`,
      { expires_at: new Date().toISOString() },
      { headers: { ...svcHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' } }
    );
    if (typeof globalThis.bwNoticeCacheBust === 'function') globalThis.bwNoticeCacheBust();
    audit({ req, action: 'message.retract', before: before[0],
            after: Array.isArray(data) ? data[0] : data, note: 'expired immediately' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[ADMIN] retract failed:', e.response?.data || e.message);
    res.status(502).json({ error: 'Could not retract' });
  }
});

// ── POST /admin/api/users/:id/access ───────────────────────────
// Suspend, ban, warn, or restore. Writes access_status — deliberately
// NOT the existing `status` column, which paystack-route.js sets on every
// charge.success and would silently un-ban someone on renewal.
//
// Optionally publishes a notice in the same action, so a suspended user
// finds out why instead of meeting a locked door with no explanation.
router.post('/api/users/:id/access', async (req, res) => {
  const userId = req.params.id;
  const { status, reason, notify } = req.body || {};
  const OK = ['active', 'warned', 'suspended', 'banned'];
  if (!OK.includes(status)) {
    return res.status(400).json({ error: 'status must be one of: ' + OK.join(', ') });
  }
  if ((status === 'suspended' || status === 'banned') && !String(reason || '').trim()) {
    // A reason is required, because it is what the user is shown and what
    // future-you reads in the audit log months later.
    return res.status(400).json({ error: 'Give a reason — the user sees it, and so will you in the audit log' });
  }

  try {
    const { data: before } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=user_id,plan,access_status,access_reason`,
      { headers: svcHeaders() }
    );
    if (!before || !before.length) return res.status(404).json({ error: 'No such account' });

    const patch = {
      access_status: status,
      access_reason: status === 'active' ? null : String(reason).trim(),
      access_changed_at: new Date().toISOString()
    };
    const { data: after } = await axios.patch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}`,
      patch,
      { headers: { ...svcHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' } }
    );

    if (notify && status !== 'active') {
      await axios.post(`${SUPABASE_URL}/rest/v1/messages`, {
        audience: 'user', audience_key: userId,
        severity: status === 'banned' ? 'critical' : status === 'suspended' ? 'critical' : 'warning',
        body: String(reason).trim(), dismissible: status === 'warned',
        created_by: req.admin.email
      }, { headers: { ...svcHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' } })
        .catch(e => console.warn('[ADMIN] access notice failed:', e.message));
      if (typeof globalThis.bwNoticeCacheBust === 'function') globalThis.bwNoticeCacheBust();
    }

    audit({ req, action: 'access.' + status, targetUser: userId,
            before: before[0], after: Array.isArray(after) ? after[0] : after,
            note: reason ? String(reason).slice(0, 200) : null });
    console.log(`[ADMIN] access set to ${status} for ${userId} by ${req.admin.email}`);
    res.json({ ok: true, status });
  } catch (e) {
    console.error('[ADMIN] access change failed:', e.response?.data || e.message);
    res.status(502).json({ error: 'Could not change access', detail: e.response?.data?.message || e.message });
  }
});

// ── POST /admin/api/users/:id/grace ────────────────────────────
// Extend the window after a failed renewal. Default is 3 days from
// expiry; this lets you give someone longer while they sort a card out.
router.post('/api/users/:id/grace', async (req, res) => {
  const userId = req.params.id;
  const days = Number(req.body?.days);
  if (!Number.isFinite(days) || days < 0 || days > 60) {
    return res.status(400).json({ error: 'days must be between 0 and 60' });
  }
  try {
    const { data: before } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=user_id,expires_at,grace_until`,
      { headers: svcHeaders() }
    );
    if (!before || !before.length) return res.status(404).json({ error: 'No such account' });

    // Measured from expiry, not from today — otherwise "3 days" means
    // something different depending on when you happen to click it.
    const from = before[0].expires_at ? Date.parse(before[0].expires_at) : Date.now();
    const until = days === 0 ? null : new Date(from + days * 86400000).toISOString();

    const { data: after } = await axios.patch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}`,
      { grace_until: until },
      { headers: { ...svcHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' } }
    );
    audit({ req, action: 'grace.set', targetUser: userId, before: before[0],
            after: Array.isArray(after) ? after[0] : after,
            note: days === 0 ? 'grace removed' : `${days} days from expiry` });
    res.json({ ok: true, graceUntil: until });
  } catch (e) {
    console.error('[ADMIN] grace change failed:', e.response?.data || e.message);
    res.status(502).json({ error: 'Could not set grace' });
  }
});

// ── GET /admin/api/audit ───────────────────────────────────────
router.get('/api/audit', async (req, res) => {
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/admin_audit?select=*&order=at.desc&limit=200`,
      { headers: svcHeaders() }
    );
    res.json({ entries: data || [] });
  } catch (e) {
    console.error('[ADMIN] /api/audit failed:', e.response?.data || e.message);
    res.status(502).json({ error: 'Could not read the audit log' });
  }
});

// ── GET /admin/api/diagnostics ─────────────────────────────────
router.get('/api/diagnostics', async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  try {
    res.json(await require('./diagnostics-route').summary(days));
  } catch (e) {
    const missing = e.response?.status === 404 ||
                    /relation .* does not exist|Could not find the table/i.test(e.response?.data?.message || '');
    if (missing) return res.json({ collecting: false, groups: [], total: 0,
      message: 'The client_errors table is missing — run the migration.' });
    console.error('[ADMIN] /api/diagnostics failed:', e.response?.data || e.message);
    res.status(502).json({ error: 'Could not read diagnostics', detail: e.response?.data?.message || e.message });
  }
});

// ── GET /admin/api/usage ───────────────────────────────────────
router.get('/api/usage', async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  try {
    const usage = require('./usage-route').summary;
    res.json(await usage(days));
  } catch (e) {
    const missing = e.response?.status === 404 ||
                    /relation .* does not exist|Could not find the table/i.test(e.response?.data?.message || '');
    if (missing) {
      return res.json({ collecting: false, message: 'The usage_daily table is missing — run the migration.' });
    }
    console.error('[ADMIN] /api/usage failed:', e.response?.data || e.message);
    res.status(502).json({ error: 'Could not read usage', detail: e.response?.data?.message || e.message });
  }
});

// ── POST /admin/api/audit/clear ────────────────────────────────
// Clears MESSAGE entries only. Access changes — suspend, ban, restore,
// grace — are never deletable, because those are the ones a dispute
// turns on months later, and an audit log you can quietly edit is not
// an audit log.
//
// Optionally removes the test notices themselves, which is the real
// point: test messages should not be sitting in the list when the first
// paying customer arrives.
const CLEARABLE = ['message.publish', 'message.retract'];

router.post('/api/audit/clear', async (req, res) => {
  const { before, alsoMessages } = req.body || {};
  const cutoff = before ? new Date(before) : new Date();
  if (isNaN(cutoff.getTime())) return res.status(400).json({ error: 'Bad cutoff date' });

  try {
    const inList = CLEARABLE.map(a => `"${a}"`).join(',');
    const { data: doomed } = await axios.get(
      `${SUPABASE_URL}/rest/v1/admin_audit?action=in.(${inList})&at=lte.${cutoff.toISOString()}&select=id`,
      { headers: svcHeaders() }
    );
    const count = (doomed || []).length;

    if (count) {
      await axios.delete(
        `${SUPABASE_URL}/rest/v1/admin_audit?action=in.(${inList})&at=lte.${cutoff.toISOString()}`,
        { headers: { ...svcHeaders(), Prefer: 'return=minimal' } }
      );
    }

    let msgCount = 0;
    if (alsoMessages) {
      const { data: msgs } = await axios.get(
        `${SUPABASE_URL}/rest/v1/messages?created_at=lte.${cutoff.toISOString()}&select=id`,
        { headers: svcHeaders() }
      );
      msgCount = (msgs || []).length;
      if (msgCount) {
        // Dismissals cascade on delete, so they go with them.
        await axios.delete(
          `${SUPABASE_URL}/rest/v1/messages?created_at=lte.${cutoff.toISOString()}`,
          { headers: { ...svcHeaders(), Prefer: 'return=minimal' } }
        );
        if (typeof globalThis.bwNoticeCacheBust === 'function') globalThis.bwNoticeCacheBust();
      }
    }

    // The clear itself IS audited, and that entry is not clearable —
    // so the log always shows that something was removed and by whom.
    audit({ req, action: 'audit.clear',
            note: `removed ${count} message entr${count === 1 ? 'y' : 'ies'}` +
                  (alsoMessages ? ` and ${msgCount} notice${msgCount === 1 ? '' : 's'}` : '') +
                  ` up to ${cutoff.toISOString().slice(0, 10)}` });
    console.log(`[ADMIN] audit cleared by ${req.admin.email} — ${count} entries, ${msgCount} messages`);
    res.json({ ok: true, cleared: count, messagesDeleted: msgCount });
  } catch (e) {
    console.error('[ADMIN] audit clear failed:', e.response?.data || e.message);
    res.status(502).json({ error: 'Could not clear', detail: e.response?.data?.message || e.message });
  }
});

// ── shown when admin.html is missing from the deploy ───────────
function missingPage(expected) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blackwood — admin.html missing</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
background:#0b0b11;color:#f2f1ee;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px}
.b{max-width:520px;background:#0e0e15;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:24px}
h1{margin:0 0 4px;font-size:17px;font-weight:600}
p{color:#8b8a95;line-height:1.6;font-size:13px}
code{font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;background:rgba(255,255,255,.05);
padding:2px 6px;border-radius:5px;font-size:12px;color:#9dbcff;word-break:break-all}
a{color:#6d9bff}</style></head><body><div class="b">
<h1>You are signed in — but admin.html is missing</h1>
<p>The sign-in worked, so your credentials and session are fine. The server just cannot find the page file.</p>
<p>It was expected at:<br><code>${expected}</code></p>
<p>Copy <code>admin.html</code> into the same folder as <code>app.js</code>, commit it, and redeploy. Check it is not excluded by <code>.gitignore</code> — that is the usual reason one file is left behind.</p>
<p><a href="/admin/api/users">Check /admin/api/users</a> — if that returns JSON, the backend is working and only the page file is absent.</p>
</div></body></html>`;
}

// ── login page ─────────────────────────────────────────────────
function loginPage({ error, unconfigured }) {
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blackwood — Admin sign in</title>
<style>
:root{--bg:#0b0b11;--card:#0e0e15;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);
--text:#f2f1ee;--muted:#8b8a95;--steel:#6d9bff;--red:#ff6b6a}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
background:radial-gradient(900px 460px at 70% -10%,rgba(109,155,255,.10),transparent 60%),var(--bg);
color:var(--text);font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
font-size:14px;-webkit-font-smoothing:antialiased}
.box{width:100%;max-width:372px}
.brand{display:flex;align-items:baseline;gap:9px;margin-bottom:22px}
.brand b{font-size:20px;font-weight:650;letter-spacing:-.03em}
.brand span{font-size:9.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);font-weight:600}
form{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;
box-shadow:0 1px 2px rgba(0,0,0,.3),0 20px 50px -24px rgba(0,0,0,.7)}
h1{margin:0 0 3px;font-size:16px;font-weight:600;letter-spacing:-.02em}
p.sub{margin:0 0 18px;color:var(--muted);font-size:12.5px}
label{display:block;font-size:9.5px;letter-spacing:.11em;text-transform:uppercase;
color:var(--muted);margin-bottom:6px;font-weight:500}
input{width:100%;background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:9px;
padding:10px 12px;color:var(--text);font-size:14px;font-family:inherit;outline:none;transition:border-color .15s}
input:focus{border-color:rgba(109,155,255,.45);background:rgba(255,255,255,.05)}
.f{margin-bottom:13px}
.code input{font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;letter-spacing:.34em;
font-size:18px;text-align:center;padding:11px 12px}
button{width:100%;margin-top:6px;padding:11px;border:none;border-radius:99px;background:var(--steel);
color:#08111f;font-weight:600;font-size:14px;font-family:inherit;cursor:pointer;transition:filter .15s}
button:hover{filter:brightness(1.08)}
.err{background:rgba(255,107,106,.12);color:#ff9b9a;border-radius:9px;padding:10px 12px;
font-size:12.5px;margin-bottom:15px;line-height:1.5}
.foot{margin-top:16px;color:var(--muted);font-size:11.5px;text-align:center;line-height:1.55}
:focus-visible{outline:2px solid var(--steel);outline-offset:2px}
</style></head><body>
<div class="box">
<div class="brand"><b>Blackwood</b><span>Operations</span></div>
<form method="post" action="/admin/login">
<h1>Admin sign in</h1>
<p class="sub">This console can change every account on the platform.</p>
${unconfigured ? `<div class="err">Not configured on this server. Missing: ${esc(unconfigured.join(', '))}. Run <b>node admin-setup.js</b> and add the values to Railway.</div>` : ''}
${error ? `<div class="err">${esc(error)}</div>` : ''}
<div class="f"><label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required autofocus></div>
<div class="f"><label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required></div>
<div class="f code"><label for="code">Six-digit code</label>
<input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
autocomplete="one-time-code" placeholder="000000" required></div>
<button type="submit">Sign in</button>
</form>
<p class="foot">Signing in as a Blackwood user does not grant access here.</p>
</div></body></html>`;
}

module.exports = router;
