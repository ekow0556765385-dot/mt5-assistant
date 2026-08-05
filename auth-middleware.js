// ═══════════════════════════════════════════════════════════════
// auth-middleware.js — Supabase JWT validation for Railway
// Place this file in the same folder as app.js
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');
const crypto = require('crypto');

// ── App session — independent of Supabase's own session table ──────
// Supabase's /auth/v1/user check depends on a session row existing in
// their database. That row can vanish for reasons outside this app's
// control (an explicit sign-out anywhere, Supabase's own session
// cleanup, etc.), which then permanently 401s an otherwise-valid-
// looking JWT with "session_not_found" — even minutes after a fresh
// login. requirePlan already proves identity against Supabase once,
// at page load. Rather than re-proving that on every single /api/
// analyse click (and being at the mercy of Supabase's session table
// staying alive for the whole click), we mint our own short-lived,
// self-verifying session right after that one successful check, and
// trust it for the rest of the browsing session.
const APP_SESSION_SECRET = process.env.APP_SESSION_SECRET || 'blackwood-app-session-fallback-secret-2026-change-me';
const APP_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function signAppSession(userId, email) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, email, exp: Date.now() + APP_SESSION_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', APP_SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifyAppSession(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', APP_SESSION_SECRET).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data; // { uid, email, exp }
  } catch {
    return null;
  }
}

const SUPABASE_URL     = process.env.SUPABASE_URL     || 'https://nzazhjnbjolkvjpunqna.supabase.co';
const SITE_URL         = (process.env.SITE_URL || 'https://blackwoodmt5.com').trim();
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56YXpoam5iam9sa3ZqcHVucW5hIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjcwMTU0NywiZXhwIjoyMDk4Mjc3NTQ3fQ.6iQqLhTyd8YjMrWmLTQIs8Ivv3ggXh2Fy_2fwQcU8FM';
const SUPABASE_ANON    = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56YXpoam5iam9sa3ZqcHVucW5hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3MDE1NDcsImV4cCI6MjA5ODI3NzU0N30.Wb7UnsRUpjlfOM14A1ZVSoT85z2usFquuKubIr_pJ1M';

// ── Owner bypass — founder(s) get full access without paying ──
// Comma-separated list of emails in Railway env var OWNER_EMAILS.
// Falls back to your account so this works even if the env var is
// not yet set. Add more emails separated by commas as needed.
const OWNER_EMAILS = (process.env.OWNER_EMAILS || 'ekowassan12@gmail.com,ekow0556765385@gmail.com,samuelassanekow@gmail.com')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

function isOwner(email) {
  return !!email && OWNER_EMAILS.includes(email.toLowerCase());
}

// ── Short-lived ticket system ──────────────────────────────────
// Prevents the real Supabase token from ever appearing in a URL.
// A ticket is a random one-time-use code, valid for 20 seconds,
// that resolves to a token server-side and is deleted on first use.
const TICKET_TTL_MS = 20 * 1000;
const tickets = new Map(); // ticket -> { token, expires }

function issueTicket(token) {
  const ticket = require('crypto').randomBytes(24).toString('hex');
  tickets.set(ticket, { token, expires: Date.now() + TICKET_TTL_MS });
  return ticket;
}

function consumeTicket(ticket) {
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket); // one-time use, regardless of expiry
  if (Date.now() > entry.expires) return null;
  return entry.token;
}

// Periodic cleanup of expired, unused tickets
setInterval(() => {
  const now = Date.now();
  for (const [t, entry] of tickets.entries()) {
    if (now > entry.expires) tickets.delete(t);
  }
}, 60 * 1000);

// ── /api/ticket — exchange a real token for a one-time ticket ──
// Requires a valid Authorization: Bearer <token> header.
async function issueTicketRoute(req, res) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const user = await getUserFromToken(token);
  if (!user || !user.id) return res.status(401).json({ error: 'Invalid session' });

  res.json({ ticket: issueTicket(token) });
}

// ── Get user from Supabase JWT ────────────────────────────────
async function getUserFromToken(token) {
  try {
    const { data } = await axios.get(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON
      }
    });
    return data;
  } catch (e) {
    console.error('[AUTH] getUserFromToken failed:', e.response?.data || e.message);
    return null;
  }
}

// Supabase now issues two key formats: legacy service_role (a JWT,
// starts with "eyJ") and the new secret key (starts with "sb_secret_").
// New-format keys are NOT JWTs and get rejected with 401 if sent in the
// Authorization header — they must go in apikey only. This helper builds
// the right header set for whichever format is configured.
function supabaseServiceHeaders(extra = {}) {
  const isNewFormat = SUPABASE_SERVICE.startsWith('sb_secret_');
  return {
    apikey: SUPABASE_SERVICE,
    ...(isNewFormat ? {} : { Authorization: `Bearer ${SUPABASE_SERVICE}` }),
    ...extra,
  };
}
async function getUserPlan(userId) {
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=plan,plan_key,status,expires_at,licence_key`,
      { headers: supabaseServiceHeaders() }
    );
    console.log(`[AUTH] getUserPlan for ${userId}:`, JSON.stringify(data));
    if (data && data.length > 0) return data[0];
    console.warn(`[AUTH] No subscription row found for user ${userId} — defaulting to free`);
    return { plan: 'free', status: 'active' };
  } catch (e) {
    console.error('[AUTH] getUserPlan failed:', e.response?.data || e.message);
    return { plan: 'free', status: 'active' };
  }
}

// ── Plan rank helper ───────────────────────────────────────────
function planRank(plan) {
  const ranks = { free: 0, pro: 1, lifetime: 2 };
  return ranks[plan] || 0;
}

// ── requireAuth — just checks user is logged in ───────────────
async function requireAuth(req, res, next) {
  // Fast path: our own signed session, set once by requirePlan after a
  // successful Supabase check. Doesn't touch Supabase again, so a
  // session revoked in Supabase's own table (elsewhere, or by their
  // internal cleanup) can't retroactively break an already-loaded page.
  const appSession = verifyAppSession(req.cookies?.['bw-session']);
  if (appSession) {
    req.user = { id: appSession.uid, email: appSession.email };
    return next();
  }

  // Fallback: no app session yet (e.g. direct API testing, or this
  // page was never routed through requirePlan) — check with Supabase.
  let token = req.headers.authorization?.split(' ')[1];

  if (!token && req.query?.ticket) token = consumeTicket(req.query.ticket);
  if (!token && req.query?.token) token = req.query.token; // legacy fallback

  if (!token) {
    return res.status(401).json({ error: 'Not logged in', redirect: '/?login=required' });
  }

  const user = await getUserFromToken(token);
  if (!user || !user.id) {
    return res.status(401).json({ error: 'Invalid session', redirect: '/?login=required' });
  }

  // Mint our own session here too, so the next call takes the fast path.
  res.cookie('bw-session', signAppSession(user.id, user.email), {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: APP_SESSION_TTL_MS
  });

  req.user = user;
  req.token = token;
  next();
}

// ── Iframe-safe redirect ────────────────────────────────────────
// Every module in the Pro dashboard runs inside its own iframe. A plain
// res.redirect() here would load the marketing site (or account.html,
// downstream of it) INSIDE that iframe — which is what was happening
// whenever a token expired mid-session. This sends a tiny HTML page
// that breaks out to the top-level window first, so an expired session
// takes the whole tab to login instead of embedding it in a module.
function htmlRedirect(res, url) {
  res.set('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><body><script>
    if (window.top !== window.self) { window.top.location.href = ${JSON.stringify(url)}; }
    else { window.location.href = ${JSON.stringify(url)}; }
  </script></body></html>`);
}

// ── requirePlan — checks user has required plan ───────────────
function requirePlan(minPlan) {
  return async (req, res, next) => {
    // Fast path: trust our own signed session if present, but still
    // re-check the plan/subscription row (cheap DB read, no Supabase
    // auth call) since plans can change (upgrade/downgrade/expiry)
    // independent of login state.
    const appSession = verifyAppSession(req.cookies?.['bw-session']);
    if (appSession) {
      if (isOwner(appSession.email)) {
        req.user         = { id: appSession.uid, email: appSession.email };
        req.subscription = { plan: 'lifetime', status: 'active', owner: true };
        return next();
      }
      const sub = await getUserPlan(appSession.uid);
      const expired = sub.plan === 'pro' && sub.expires_at && new Date(sub.expires_at) < new Date();
      if (!expired && sub.status === 'active' && planRank(sub.plan) >= planRank(minPlan)) {
        req.user         = { id: appSession.uid, email: appSession.email };
        req.subscription = sub;
        return next();
      }
      // Fall through to full re-check below if plan no longer qualifies
      // (covers legitimate downgrade/expiry, not just a stale cookie).
    }

    let token = req.headers.authorization?.split(' ')[1]
      || req.cookies?.['sb-access-token'];

    if (!token && req.query?.ticket) token = consumeTicket(req.query.ticket);
    if (!token && req.query?.token) token = req.query.token; // legacy fallback

    if (!token) {
      // For HTML page requests, redirect to website with login prompt
      const acceptsHtml = req.headers.accept?.includes('text/html');
      if (acceptsHtml) {
        return htmlRedirect(res, SITE_URL + '/?login=required&plan=' + minPlan);
      }
      return res.status(401).json({ error: 'Not logged in' });
    }

    const user = await getUserFromToken(token);
    if (!user || !user.id) {
      const acceptsHtml = req.headers.accept?.includes('text/html');
      if (acceptsHtml) return htmlRedirect(res, SITE_URL + '/?login=required');
      return res.status(401).json({ error: 'Invalid session' });
    }

    // ── Owner bypass — skip all plan checks entirely ────────────
    if (isOwner(user.email)) {
      res.cookie('bw-session', signAppSession(user.id, user.email), {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: APP_SESSION_TTL_MS
      });
      req.user         = user;
      req.subscription = { plan: 'lifetime', status: 'active', owner: true };
      req.token        = token;
      return next();
    }

    const sub = await getUserPlan(user.id);

    // Check expiry for pro (not lifetime)
    if (sub.plan === 'pro' && sub.expires_at) {
      if (new Date(sub.expires_at) < new Date()) {
        const acceptsHtml = req.headers.accept?.includes('text/html');
        if (acceptsHtml) return htmlRedirect(res, SITE_URL + '/?plan=expired');
        return res.status(403).json({ error: 'Subscription expired', plan: 'free' });
      }
    }

    if (sub.status !== 'active' || planRank(sub.plan) < planRank(minPlan)) {
      const acceptsHtml = req.headers.accept?.includes('text/html');
      if (acceptsHtml) return htmlRedirect(res, SITE_URL + '/?upgrade=required&plan=' + minPlan);
      return res.status(403).json({ error: 'Upgrade required', current: sub.plan, required: minPlan });
    }

    // ── Set our own app session cookie for this origin ─────────────
    // The dashboard forwards a single-use ticket (or, as a fallback,
    // the raw Supabase token) into this page's iframe src. That only
    // proves identity for THIS page load. We've just verified the
    // user against Supabase above (getUserFromToken + getUserPlan
    // succeeded) — that's the one moment we actually need Supabase's
    // session table to be alive. From here on, subsequent same-origin
    // calls this page makes on its own (e.g. Trading Brain's
    // /api/analyse) use our own signed cookie instead of re-checking
    // Supabase every time, so a Supabase-side session revocation
    // (sign-out elsewhere, their own session cleanup, etc.) can't
    // retroactively break an already-loaded page.
    res.cookie('bw-session', signAppSession(user.id, user.email), {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: APP_SESSION_TTL_MS
    });

    req.user         = user;
    req.subscription = sub;
    req.token        = token;
    next();
  };
}

// ── /api/me — returns current user + plan ────────────────────
// Add this route to app.js: app.get('/api/me', getMe);
async function getMe(req, res) {
  const token = req.headers.authorization?.split(' ')[1]
    || req.cookies?.['sb-access-token']
    || req.query?.token;

  if (!token) return res.json({ loggedIn: false, plan: 'free' });

  const user = await getUserFromToken(token);
  if (!user) return res.json({ loggedIn: false, plan: 'free' });

  // Owner sees themself as lifetime, no Supabase lookup needed
  const sub = isOwner(user.email)
    ? { plan: 'lifetime', status: 'active', owner: true }
    : await getUserPlan(user.id);

  res.json({
    loggedIn:    true,
    id:          user.id,
    email:       user.email,
    name:        user.user_metadata?.full_name || user.email,
    avatar:      user.user_metadata?.avatar_url || null,
    plan:        sub.plan,
    plan_key:    sub.plan_key,
    status:      sub.status,
    isOwner:     !!sub.owner,
    expires_at:  sub.expires_at,
    licence_key: sub.licence_key,
    broker_type: sub.broker_type || null
  });
}

// ── /api/regenerate-key — self-serve licence key rotation ─────
// Invalidates the current key and issues a fresh BW-XXXX one for
// the calling user's own subscription row. Free-plan users (no
// existing licence_key) are rejected — nothing to regenerate.
async function regenerateKey(req, res) {
  const token = req.headers.authorization?.split(' ')[1]
    || req.cookies?.['sb-access-token'];

  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const user = await getUserFromToken(token);
  if (!user || !user.id) return res.status(401).json({ error: 'Invalid session' });

  const sub = isOwner(user.email)
    ? { plan: 'lifetime', status: 'active', owner: true }
    : await getUserPlan(user.id);

  if (!sub.licence_key && sub.plan === 'free') {
    return res.status(403).json({ error: 'Upgrade to Pro to get a licence key' });
  }

  const newKey = 'BW-' + require('crypto').randomBytes(12).toString('hex').toUpperCase();

  try {
    await axios.patch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${user.id}`,
      { licence_key: newKey, bound_account: null, updated_at: new Date().toISOString() },
      { headers: supabaseServiceHeaders({ 'Content-Type': 'application/json' }) }
    );
    console.log(`[AUTH] Licence key regenerated for user=${user.id} (account binding cleared)`);
    res.json({ licence_key: newKey });
  } catch (e) {
    console.error('[AUTH] regenerateKey failed:', e.response?.data || e.message);
    res.status(500).json({ error: 'Could not regenerate licence key' });
  }
}

// ── /api/cancel-subscription — self-serve cancellation ─────────
// Immediately deactivates the account: sets status to 'canceled',
// which validateKey() and requirePlan() already check against, so
// the licence key stops validating and the dashboard locks without
// any changes needed to that existing gating logic. Deliberately
// leaves plan/licence_key/expires_at untouched as a record of what
// was purchased — no refund, no retroactive changes. Owner accounts
// can't cancel (nothing to cancel — they're not on a paid plan).
async function cancelSubscription(req, res) {
  const token = req.headers.authorization?.split(' ')[1]
    || req.cookies?.['sb-access-token'];

  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const user = await getUserFromToken(token);
  if (!user || !user.id) return res.status(401).json({ error: 'Invalid session' });

  if (isOwner(user.email)) {
    return res.status(403).json({ error: 'Owner accounts cannot be cancelled' });
  }

  const sub = await getUserPlan(user.id);
  if (sub.plan === 'free') {
    return res.status(400).json({ error: 'No active subscription to cancel' });
  }
  if (sub.status === 'canceled') {
    return res.status(400).json({ error: 'Subscription is already cancelled' });
  }

  try {
    await axios.patch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${user.id}`,
      { status: 'canceled', updated_at: new Date().toISOString() },
      { headers: supabaseServiceHeaders({ 'Content-Type': 'application/json' }) }
    );
    console.log(`[AUTH] Subscription cancelled for user=${user.id}`);
    res.json({ ok: true, status: 'canceled' });
  } catch (e) {
    console.error('[AUTH] cancelSubscription failed:', e.response?.data || e.message);
    res.status(500).json({ error: 'Could not cancel subscription' });
  }
}

// ── /api/validate-key — EA licence key check ─────────────────
async function validateKey(req, res) {
  const { key } = req.body;
  if (!key) return res.status(400).json({ valid: false, error: 'No key provided' });

  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?licence_key=eq.${key}&select=plan,status,expires_at,user_id`,
      { headers: supabaseServiceHeaders() }
    );

    if (!data || data.length === 0) {
      return res.json({ valid: false, error: 'Invalid licence key' });
    }

    const sub = data[0];

    if (sub.status !== 'active') {
      return res.json({ valid: false, error: 'Subscription not active' });
    }

    if (sub.plan === 'pro' && sub.expires_at && new Date(sub.expires_at) < new Date()) {
      return res.json({ valid: false, error: 'Subscription expired' });
    }

    console.log(`[LICENCE] Key validated for plan=${sub.plan} user=${sub.user_id}`);
    res.json({ valid: true, plan: sub.plan, expires_at: sub.expires_at });

  } catch (e) {
    console.error('[LICENCE] Validation error:', e.message);
    res.status(500).json({ valid: false, error: 'Server error' });
  }
}

// ── getUserIdForLicenceKey — canonical licence key → user_id lookup ──
// Same logic as validateKey() above, but returns the user_id directly
// instead of an HTTP response, so any backend module (journal-store,
// settings-store, smc-route, patternDetector, agent-module, and the
// /api/update handler in app.js) can resolve "whose data is this?"
// the same way. journal-store.js used to keep its own private copy of
// this — it now imports it from here instead.
async function getUserIdForLicenceKey(licenceKey) {
  if (!licenceKey) return null;
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?licence_key=eq.${licenceKey}&select=user_id,status,plan,expires_at`,
      { headers: supabaseServiceHeaders() }
    );
    if (!data || data.length === 0) return null;
    const sub = data[0];
    if (sub.status !== 'active') return null;
    if (sub.plan === 'pro' && sub.expires_at && new Date(sub.expires_at) < new Date()) return null;
    return sub.user_id;
  } catch (e) {
    console.error('[AUTH] getUserIdForLicenceKey failed:', e.response?.data || e.message);
    return null;
  }
}

// ── Analysis credits ────────────────────────────────────────────
// Each paying user gets a $8.00/month soft-budget for /api/analyse
// clicks, covering Claude API cost at a worst-case $0.01/click ceiling
// (40 clicks/day × 5 days/week × 4 weeks). Resets on payment/renewal
// (see paystack-route.js) and, independently, every 30 days via the
// cron in app.js — so yearly and lifetime users also get refreshed
// monthly instead of waiting for their next invoice.
const MONTHLY_CREDIT_USD = 8.00;

async function getUserCredits(userId) {
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=credit_balance,credit_reset_at`,
      { headers: supabaseServiceHeaders() }
    );
    if (data && data.length > 0) {
      return {
        balance:  data[0].credit_balance != null ? parseFloat(data[0].credit_balance) : MONTHLY_CREDIT_USD,
        resetAt:  data[0].credit_reset_at
      };
    }
    return { balance: MONTHLY_CREDIT_USD, resetAt: null };
  } catch (e) {
    console.error('[CREDITS] getUserCredits failed:', e.response?.data || e.message);
    return { balance: MONTHLY_CREDIT_USD, resetAt: null };
  }
}

async function deductCredits(userId, amount) {
  const current = await getUserCredits(userId);
  const next = Math.max(0, current.balance - amount);
  try {
    await axios.patch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}`,
      { credit_balance: next },
      { headers: supabaseServiceHeaders({ 'Content-Type': 'application/json' }) }
    );
  } catch (e) {
    console.error('[CREDITS] deductCredits failed:', e.response?.data || e.message);
  }
  return next;
}

async function resetUserCredits(userId) {
  const resetAt = new Date(Date.now() + 30 * 86400000).toISOString();
  try {
    await axios.patch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}`,
      { credit_balance: MONTHLY_CREDIT_USD, credit_reset_at: resetAt },
      { headers: supabaseServiceHeaders({ 'Content-Type': 'application/json' }) }
    );
  } catch (e) {
    console.error('[CREDITS] resetUserCredits failed:', e.response?.data || e.message);
  }
  return resetAt;
}


// ── /api/set-broker-type — saves the user's MT5 broker selection ──
// Called from account.html when the user picks "Prop Firm" or "Exness".
// Saved to the subscriptions table so the choice persists across sessions
// and the Downloads section pre-selects the right option on next load.
async function setBrokerType(req, res) {
  const { broker_type } = req.body;
  if (!['prop', 'exness'].includes(broker_type)) {
    return res.status(400).json({ error: 'Invalid broker_type. Must be prop or exness.' });
  }

  try {
    await axios.patch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${req.user.id}`,
      { broker_type, updated_at: new Date().toISOString() },
      { headers: supabaseServiceHeaders({ 'Content-Type': 'application/json' }) }
    );
    console.log(`[BROKER] broker_type=${broker_type} saved for user=${req.user.id}`);
    res.json({ ok: true, broker_type });
  } catch (e) {
    console.error('[BROKER] set-broker-type failed:', e.response?.data || e.message);
    res.status(500).json({ error: 'Could not save broker type' });
  }
}

module.exports = { requireAuth, requirePlan, getMe, validateKey, regenerateKey, setBrokerType, cancelSubscription, getUserFromToken, getUserPlan, getUserIdForLicenceKey, verifyAppSession, isOwner, issueTicketRoute, SUPABASE_URL, SUPABASE_SERVICE, supabaseServiceHeaders, htmlRedirect, MONTHLY_CREDIT_USD, getUserCredits, deductCredits, resetUserCredits };
