// ═══════════════════════════════════════════════════════════════
// auth-middleware.js — Supabase JWT validation for Railway
// Place this file in the same folder as app.js
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');

const SUPABASE_URL     = process.env.SUPABASE_URL     || 'https://nzazhjnbjolkvjpunqna.supabase.co';
const SITE_URL         = (process.env.SITE_URL || 'https://blackwoodmt5.com').trim();
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56YXpoam5iam9sa3ZqcHVucW5hIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjcwMTU0NywiZXhwIjoyMDk4Mjc3NTQ3fQ.6iQqLhTyd8YjMrWmLTQIs8Ivv3ggXh2Fy_2fwQcU8FM';
const SUPABASE_ANON    = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56YXpoam5iam9sa3ZqcHVucW5hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3MDE1NDcsImV4cCI6MjA5ODI3NzU0N30.Wb7UnsRUpjlfOM14A1ZVSoT85z2usFquuKubIr_pJ1M';

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

// ── Get subscription plan from Supabase ───────────────────────
async function getUserPlan(userId) {
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=plan,status,expires_at,licence_key`,
      {
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE}`,
          apikey: SUPABASE_SERVICE
        }
      }
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
  const token = req.headers.authorization?.split(' ')[1]
    || req.cookies?.['sb-access-token']
    || req.query?.token;

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
    const token = req.headers.authorization?.split(' ')[1]
      || req.cookies?.['sb-access-token']
      || req.query?.token;

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

  const sub = await getUserPlan(user.id);

  res.json({
    loggedIn:    true,
    id:          user.id,
    email:       user.email,
    name:        user.user_metadata?.full_name || user.email,
    avatar:      user.user_metadata?.avatar_url || null,
    plan:        sub.plan,
    status:      sub.status,
    expires_at:  sub.expires_at,
    licence_key: sub.licence_key
  });
}

// ── /api/validate-key — EA licence key check ─────────────────
async function validateKey(req, res) {
  const { key } = req.body;
  if (!key) return res.status(400).json({ valid: false, error: 'No key provided' });

  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?licence_key=eq.${key}&select=plan,status,expires_at,user_id`,
      {
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE}`,
          apikey: SUPABASE_SERVICE
        }
      }
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

module.exports = { requireAuth, requirePlan, getMe, validateKey, getUserFromToken, getUserPlan };
