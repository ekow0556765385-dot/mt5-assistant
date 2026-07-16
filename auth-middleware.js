// ═══════════════════════════════════════════════════════════════
// auth-middleware.js — Supabase JWT validation for Railway
// Place this file in the same folder as app.js
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');

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
  let token = req.headers.authorization?.split(' ')[1]
    || req.cookies?.['sb-access-token'];

  if (!token && req.query?.ticket) token = consumeTicket(req.query.ticket);
  if (!token && req.query?.token) token = req.query.token; // legacy fallback

  if (!token) {
    return res.status(401).json({ error: 'Not logged in', redirect: '/?login=required' });
  }

  const user = await getUserFromToken(token);
  if (!user || !user.id) {
    return res.status(401).json({ error: 'Invalid session', redirect: '/?login=required' });
  }

  req.user = user;
  req.token = token;
  next();
}

// ── requirePlan — checks user has required plan ───────────────
function requirePlan(minPlan) {
  return async (req, res, next) => {
    let token = req.headers.authorization?.split(' ')[1]
      || req.cookies?.['sb-access-token'];

    if (!token && req.query?.ticket) token = consumeTicket(req.query.ticket);
    if (!token && req.query?.token) token = req.query.token; // legacy fallback

    if (!token) {
      // For HTML page requests, redirect to website with login prompt
      const acceptsHtml = req.headers.accept?.includes('text/html');
      if (acceptsHtml) {
        return res.redirect(SITE_URL + '/?login=required&plan=' + minPlan);
      }
      return res.status(401).json({ error: 'Not logged in' });
    }

    const user = await getUserFromToken(token);
    if (!user || !user.id) {
      const acceptsHtml = req.headers.accept?.includes('text/html');
      if (acceptsHtml) return res.redirect(SITE_URL + '/?login=required');
      return res.status(401).json({ error: 'Invalid session' });
    }

    // ── Owner bypass — skip all plan checks entirely ────────────
    if (isOwner(user.email)) {
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
        if (acceptsHtml) return res.redirect(SITE_URL + '/?plan=expired');
        return res.status(403).json({ error: 'Subscription expired', plan: 'free' });
      }
    }

    if (sub.status !== 'active' || planRank(sub.plan) < planRank(minPlan)) {
      const acceptsHtml = req.headers.accept?.includes('text/html');
      if (acceptsHtml) return res.redirect(SITE_URL + '/?upgrade=required&plan=' + minPlan);
      return res.status(403).json({ error: 'Upgrade required', current: sub.plan, required: minPlan });
    }

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
    licence_key: sub.licence_key
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
      { licence_key: newKey, updated_at: new Date().toISOString() },
      { headers: supabaseServiceHeaders({ 'Content-Type': 'application/json' }) }
    );
    console.log(`[AUTH] Licence key regenerated for user=${user.id}`);
    res.json({ licence_key: newKey });
  } catch (e) {
    console.error('[AUTH] regenerateKey failed:', e.response?.data || e.message);
    res.status(500).json({ error: 'Could not regenerate licence key' });
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

module.exports = { requireAuth, requirePlan, getMe, validateKey, regenerateKey, getUserFromToken, getUserPlan, isOwner, issueTicketRoute, SUPABASE_URL, SUPABASE_SERVICE, supabaseServiceHeaders };
