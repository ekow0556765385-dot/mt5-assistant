// ═══════════════════════════════════════════════════════════════
// auth-middleware.js — Supabase JWT validation for Railway
// Place this file in the same folder as app.js
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');
const crypto = require('crypto');
const licenceAttempts = require('./licence-attempts');
const lastSeen        = require('./last-seen');

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


// The single route allowed to accept a token in the query string: the
// dashboard hand-off from the account page. It exchanges the token for a
// bw-session cookie immediately, and the page strips it from the address
// bar, so it never lingers anywhere copyable.

// Records how a request got in. Written because "a copied URL still works"
// has several very different explanations - a live session cookie in that
// browser, the owner bypass, a valid ticket, or a genuine hole - and they
// are indistinguishable from the outside. One log line names which.
function bwLogAuth(req, method, email, plan){
  const p = (req.path || req.originalUrl || '').split('?')[0];
  // Page loads only; the API chatter would drown it out.
  if (p.startsWith('/api/') || p.endsWith('.js') || p.endsWith('.css')) return;
  const q = Object.keys(req.query || {}).join(',') || 'none';
  console.log(`[AUTH] ${p} via ${method} | ${email || '?'} | plan=${plan || '?'} | query=${q}`);
}

function isDashboardEntry(req){
  const p = (req.path || req.originalUrl || '').split('?')[0];
  return p === '/dashboard' || p === '/dashboard/';
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
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=plan,plan_key,status,expires_at,licence_key,access_status,access_reason,grace_until,licence_expires_at,pending_plan,pending_plan_key,pending_plan_at`,
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
  // Same rule as requirePlan: an explicitly presented credential wins over
  // a leftover cookie. Without this, every API the account page and the
  // modules call would answer as whichever account signed in FIRST on that
  // device, regardless of the Bearer token actually sent.
  const appSession = hasExplicitCredential(req)
    ? null
    : verifyAppSession(req.cookies?.['bw-session']);
  if (appSession) {
    req.user = { id: appSession.uid, email: appSession.email };
    lastSeen.touch(appSession.uid);
    return next();
  }

  // Fallback: no app session yet (e.g. direct API testing, or this
  // page was never routed through requirePlan) — check with Supabase.
  let token = req.headers.authorization?.split(' ')[1];

  if (!token && req.query?.ticket) token = consumeTicket(req.query.ticket);
  // ── SECURITY ──────────────────────────────────────────────────────
  // A raw ?token=<JWT> in the query string used to authenticate ANY route.
  // That made every module URL shareable: copy it out of the address bar
  // (the dashboard has an "open in new tab" button that puts it there),
  // paste it into another browser, and the server would accept it AND set
  // a bw-session cookie - a working Pro session for someone who never paid,
  // valid until the token expired.
  //
  // It is now accepted ONLY on the /dashboard entry route, which is how
  // account.html hands the session over. Everything else - module pages and
  // every API - must use the Authorization header, a one-time ticket, or
  // the bw-session cookie. Those cannot be copied out of a URL.
  if (!token && req.query?.token && isDashboardEntry(req)) token = req.query.token;

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
  lastSeen.touch(user.id);
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

/* ═══ MODULE PAGES MUST BE FRAMED BY OUR OWN DASHBOARD ═══════════════
   The requirement: a module URL (/brain, /smc-panel, /patterns, /math,
   /agent, /) works ONLY inside the Pro dashboard's iframe. Copy it into
   another tab - same browser, another browser, incognito - and it must be
   refused. Being logged in is NOT enough, and this deliberately applies to
   the owner account too: the owner bypass skips PLAN checks, it must not
   skip this one, or the strictest account on the system is the one hole.

   How it is decided:
   - Browsers send Sec-Fetch-Dest on every request. A top-level navigation
     (typing/pasting a URL, a bookmark, a new tab) is `document`. A load
     inside an <iframe> is `iframe`. Sec-Fetch-Site tells us the frame's
     parent is our own origin. These headers are set by the browser and
     cannot be forged from page JavaScript, which is what makes this a real
     gate rather than a hint.
   - Browsers too old to send them (pre-2023 Safari, mostly) fall back to
     requiring a valid one-time ticket. The dashboard mints a fresh ticket
     for every iframe load; a copied URL carries a ticket that was already
     spent on the original load, so it fails there too.

   The dashboard shell itself (/dashboard) is exempt - it IS the top-level
   page, and it stays protected by requirePlan as before.  */

/* ═══ EXPLICIT CREDENTIALS BEAT A LEFTOVER COOKIE ════════════════════
   The bw-session cookie used to be checked FIRST and returned immediately,
   so an Authorization header, a one-time ticket, or the /dashboard entry
   token was never even looked at when a cookie existed.

   That is how a WebRequest account ended up showing the file-bridge
   dashboard on a phone. One device, two accounts tested in turn:
     1. sign in as the file-bridge account -> server sets bw-session for
        THAT user (httpOnly, sameSite=none, long-lived)
     2. sign in as the WebRequest account on the account page -> that page
        authenticates with the Supabase token in sessionStorage, so it
        correctly shows the WebRequest account
     3. open the dashboard: /dashboard?token=<WebRequest JWT> -> the stale
        bridge cookie wins, and every module renders the bridge account
   Account page and dashboard disagree, and the bridge account always wins
   because it is whichever one signed in first on that device.

   Desktop looked fine only because each account was used in its own
   browser/profile, so the cookie always matched.

   Rule: if the caller presents a credential explicitly, honour it and
   re-issue the cookie for that user. The cookie is a convenience for
   requests that carry nothing else, never an override. */
function hasExplicitCredential(req) {
  if (req.headers.authorization) return true;
  if (req.query?.ticket) return true;                       // consumed below
  if (req.query?.token && isDashboardEntry(req)) return true;
  if (req.cookies?.['sb-access-token']) return true;
  return false;
}

function requireFramedByDashboard(req, res, next) {
  // Belt and braces: tell the browser only OUR origin may frame this
  // response, and never let it sit in a shared cache where the next person
  // could be served it without passing this gate.
  res.set('Content-Security-Policy', "frame-ancestors 'self'");
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Cache-Control', 'private, no-store, must-revalidate');

  const dest = req.headers['sec-fetch-dest'];
  const site = req.headers['sec-fetch-site'];

  if (dest) {
    const framed = dest === 'iframe' || dest === 'frame';
    const ownOrigin = !site || site === 'same-origin';
    if (!framed || !ownOrigin) {
      console.warn(`[FRAME-GATE] refused ${req.path} — dest=${dest} site=${site || 'n/a'}`);
      return denyDirectOpen(req, res);
    }
  } else if (!req.query?.ticket) {
    // No Sec-Fetch headers and no ticket: cannot prove this came from the
    // dashboard, so refuse rather than assume.
    console.warn(`[FRAME-GATE] refused ${req.path} — no Sec-Fetch headers and no ticket`);
    return denyDirectOpen(req, res);
  }
  next();
}

function denyDirectOpen(req, res) {
  const acceptsHtml = req.headers.accept?.includes('text/html');
  if (!acceptsHtml) {
    return res.status(403).json({ error: 'Open this module from the Blackwood dashboard' });
  }
  // A plain, self-contained page - it must not depend on the icon CDN or
  // any other asset, because it is shown to someone who may not be a
  // customer at all.
  res.status(403).type('html').send(`<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Open from your dashboard — Blackwood</title>
<style>
 html,body{margin:0;height:100%;background:#09090e;color:#eceae0;
   font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
   display:flex;align-items:center;justify-content:center;padding:1.5rem}
 .b{max-width:420px;text-align:center}
 h1{font-size:19px;margin:0 0 .6rem;letter-spacing:-.01em}
 p{color:#9a9890;font-size:13.5px;margin:0 0 1.3rem}
 a{display:inline-block;background:#fff;color:#000;text-decoration:none;
   font-weight:700;font-size:13.5px;padding:11px 20px;border-radius:7px}
</style></head><body><div class="b">
 <h1>This module opens inside your dashboard</h1>
 <p>Blackwood modules can't be opened as a direct link. Sign in and open it
    from your Pro dashboard.</p>
 <a href="${SITE_URL}/account">Go to my account</a>
</div></body></html>`);
}

function requirePlan(minPlan) {
  return async (req, res, next) => {
    // Fast path: trust our own signed session if present, but still
    // re-check the plan/subscription row (cheap DB read, no Supabase
    // auth call) since plans can change (upgrade/downgrade/expiry)
    // independent of login state.
    const appSession = hasExplicitCredential(req)
      ? null                       // explicit credential wins - see above
      : verifyAppSession(req.cookies?.['bw-session']);
    if (appSession) {
      if (isOwner(appSession.email)) {
        req.user         = { id: appSession.uid, email: appSession.email };
        req.subscription = { plan: 'lifetime', status: 'active', owner: true };
        // OWNER BYPASS. Worth being loud about: testing a "bypass" while
        // signed in as the owner will ALWAYS succeed regardless of plan,
        // which can look exactly like a hole that is not there.
        bwLogAuth(req, 'bw-session cookie + OWNER BYPASS', appSession.email, 'lifetime');
        return next();
      }
      const sub = await getUserPlan(appSession.uid);
      const expired = sub.plan === 'pro' && sub.expires_at && new Date(sub.expires_at) < new Date();
      if (!expired && sub.status === 'active' && planRank(sub.plan) >= planRank(minPlan)) {
        req.user         = { id: appSession.uid, email: appSession.email };
        req.subscription = sub;
        bwLogAuth(req, 'bw-session cookie', appSession.email, sub.plan);
        return next();
      }
      // Fall through to full re-check below if plan no longer qualifies
      // (covers legitimate downgrade/expiry, not just a stale cookie).
    }

    let token = req.headers.authorization?.split(' ')[1]
      || req.cookies?.['sb-access-token'];

    if (!token && req.query?.ticket) token = consumeTicket(req.query.ticket);
    // ── SECURITY ──────────────────────────────────────────────────────
  // A raw ?token=<JWT> in the query string used to authenticate ANY route.
  // That made every module URL shareable: copy it out of the address bar
  // (the dashboard has an "open in new tab" button that puts it there),
  // paste it into another browser, and the server would accept it AND set
  // a bw-session cookie - a working Pro session for someone who never paid,
  // valid until the token expired.
  //
  // It is now accepted ONLY on the /dashboard entry route, which is how
  // account.html hands the session over. Everything else - module pages and
  // every API - must use the Authorization header, a one-time ticket, or
  // the bw-session cookie. Those cannot be copied out of a URL.
  if (!token && req.query?.token && isDashboardEntry(req)) token = req.query.token;

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
      bwLogAuth(req, req.query?.ticket ? 'ticket + OWNER BYPASS' : 'token + OWNER BYPASS',
                user.email, 'lifetime');
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

    // Suspension, ban, expiry and grace — all decided in accessState()
    // so every entry point agrees.
    const access = accessState(sub);
    if (!access.ok) {
      const acceptsHtml = req.headers.accept?.includes('text/html');
      if (access.state === 'expired') {
        if (acceptsHtml) return htmlRedirect(res, SITE_URL + '/?plan=expired');
        return res.status(403).json({ error: 'Subscription expired', plan: 'free' });
      }
      console.warn(`[ACCESS] ${access.state} — blocked ${req.path} for ${user.email}`);
      if (acceptsHtml) return htmlRedirect(res, SITE_URL + '/?access=' + access.state);
      return res.status(403).json({
        error: accessMessage(access.state, access.reason),
        accessStatus: access.state
      });
    }
    req.access = access;   // downstream can show a grace banner
    lastSeen.touch(user.id);

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
    || (isDashboardEntry(req) ? req.query?.token : undefined);

  if (!token) return res.json({ loggedIn: false, plan: 'free' });

  const user = await getUserFromToken(token);
  if (!user) return res.json({ loggedIn: false, plan: 'free' });

  // Owner sees themself as lifetime, no Supabase lookup needed
  const sub = isOwner(user.email)
    ? { plan: 'lifetime', status: 'active', owner: true }
    : await getUserPlan(user.id);

  // Same function the licence check and requirePlan use, so the account
  // page can never disagree with the server about whether access is live.
  const graceInfo = accessState(sub);

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
    broker_type: sub.broker_type || null,
    // GRACE — two different things the account page must not conflate:
    //   grace_until   = someone deliberately extended this account from
    //                   the admin console (POST /admin/api/users/:id/grace).
    //   access_state  = 'grace' means the subscription is PAST expires_at
    //                   and running on borrowed time, whether that came
    //                   from the manual extension or the automatic
    //                   post-failure window in accessState().
    // The end date is computed here rather than on the client, because
    // GRACE_DAYS lives on the server and the page must not guess it.
    grace_until:     sub.grace_until || null,
    // A downgrade the user scheduled for the end of the period they have
    // already paid for. Nothing has changed yet — this is what WILL happen.
    pending_plan:     sub.pending_plan || null,
    pending_plan_key: sub.pending_plan_key || null,
    pending_plan_at:  sub.pending_plan_at || null,
    access_state:    graceInfo.state,
    grace_ends_at:   graceInfo.graceEndsAt || null,
    grace_days_left: graceInfo.daysLeft ?? null,
    // MT5 licence term — drives the countdown card on the account page.
    licence_expires_at: sub.licence_expires_at || null,
    licence_state:      licenceKeyState(sub).state,
    licence_days_left:  licenceKeyState(sub).daysLeft ?? null
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

// ── Access policy ─────────────────────────────────────────────
// One place that decides whether a subscription may be used right now,
// so the dashboard, the module pages and the EA cannot drift apart.
//
// Two states beyond plain active/expired:
//
//   SUSPENDED / BANNED — set from the admin console. Blocks everything,
//   checked before expiry so a suspended account cannot ride out an
//   unexpired subscription.
//
//   GRACE — a Pro subscription past expires_at but inside grace_until.
//   A failed renewal is usually an expired card, not a decision to
//   leave, and cutting a paying customer off the same hour their card
//   bounces is a bad way to find out. Access continues for GRACE_DAYS
//   while they fix it.
const GRACE_DAYS = 3;

function accessState(sub) {
  const access = sub.access_status || 'active';
  if (access === 'banned')    return { ok: false, state: 'banned',    reason: sub.access_reason || null };
  if (access === 'suspended') return { ok: false, state: 'suspended', reason: sub.access_reason || null };

  if (sub.plan === 'pro' && sub.expires_at) {
    const expired = new Date(sub.expires_at) < new Date();
    if (expired) {
      // A grace_until from a PREVIOUS cycle must not govern this one.
      // updateSubscription() clears the column on payment, but a row that
      // was renewed before that fix shipped still carries a stale date —
      // and because this branch prefers grace_until whenever it is set, a
      // stale one silently removes the automatic window and locks the
      // customer out the instant their subscription expires. Ignoring any
      // date that predates expires_at makes those rows self-heal instead
      // of needing to be found and cleaned up by hand.
      const manualGrace = sub.grace_until ? new Date(sub.grace_until) : null;
      const manualUsable = manualGrace && !isNaN(manualGrace.getTime())
                           && manualGrace > new Date(sub.expires_at);
      const graceEnd = manualUsable ? manualGrace
                     : new Date(new Date(sub.expires_at).getTime() + GRACE_DAYS * 86400000);
      if (new Date() < graceEnd) {
        return {
          ok: true, state: 'grace',
          graceEndsAt: graceEnd.toISOString(),
          daysLeft: Math.max(0, Math.ceil((graceEnd - new Date()) / 86400000))
        };
      }
      return { ok: false, state: 'expired' };
    }
  }
  return { ok: true, state: 'active' };
}

function accessMessage(state, reason) {
  if (state === 'banned')    return reason || 'This account has been closed. Contact support.';
  if (state === 'suspended') return reason || 'Access is suspended. Check your email or contact support.';
  if (state === 'expired')   return 'Your subscription has expired.';
  return 'Access denied.';
}

// ── MT5 LICENCE KEY TERM (Lifetime plans only) ────────────────────
// Deliberately SEPARATE from accessState() above. accessState governs
// PLATFORM access — dashboards, modules, the account page — and a
// Lifetime buyer's platform access never expires, whatever happens to
// their MT5 key. This function governs only whether the compiled EA and
// indicators may run in their terminal, and is consulted ONLY by
// validateKey(). Wiring it into accessState() would expire the very
// thing the Lifetime fee bought, which is exactly what the Software
// Licence promises will not happen.
//
// Matches Software Licence sections 4 and 5: 12-month term, 14-day
// grace, lapse is reversible and is not a breach.
const LICENCE_TERM_GRACE_DAYS = 14;

function licenceKeyState(sub) {
  // Pro pays for the key through the subscription — no separate term.
  if (sub.plan !== 'lifetime') return { ok: true, state: 'n/a' };

  // NULL means no term has been set for this row yet (pre-existing
  // Lifetime holders, and the owner account). Treat as "no expiry
  // recorded, allow" — NEVER as expired. Switching this feature on must
  // not lock out an account that predates the column.
  if (!sub.licence_expires_at) return { ok: true, state: 'unset' };

  const now      = new Date();
  const expires  = new Date(sub.licence_expires_at);
  if (isNaN(expires.getTime())) {
    console.warn('[LICENCE] Unparseable licence_expires_at, allowing:', sub.licence_expires_at);
    return { ok: true, state: 'unset' };
  }

  const DAY = 86400000;
  if (now < expires) {
    const daysLeft = Math.ceil((expires - now) / DAY);
    // Only warn inside the last 30 days; before that the reminder is noise.
    return daysLeft <= 30
      ? { ok: true, state: 'expiring', daysLeft, expiresAt: expires.toISOString() }
      : { ok: true, state: 'active', daysLeft, expiresAt: expires.toISOString() };
  }

  const graceEnd = new Date(expires.getTime() + LICENCE_TERM_GRACE_DAYS * DAY);
  if (now < graceEnd) {
    return {
      ok: true, state: 'grace',
      daysLeft: Math.max(0, Math.ceil((graceEnd - now) / DAY)),
      expiresAt: expires.toISOString()
    };
  }
  return { ok: false, state: 'lapsed', expiresAt: expires.toISOString() };
}

// ── /api/validate-key — EA licence key check ─────────────────
async function validateKey(req, res) {
  const { key, account } = req.body;
  if (!key) return res.status(400).json({ valid: false, error: 'No key provided' });

  const headers = supabaseServiceHeaders();
  const record = (outcome) => licenceAttempts.recordAttempt({
    supabaseUrl: SUPABASE_URL, headers, licenceKey: key, account, outcome, req
  });

  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?licence_key=eq.${key}` +
      `&select=plan,status,expires_at,user_id,bound_account,access_status,access_reason,grace_until,licence_expires_at`,
      { headers }
    );

    if (!data || data.length === 0) {
      // A wrong key has no row to attribute the attempt to, so there is
      // nothing useful to record — and recording it would let anyone
      // fill the table by guessing keys.
      return res.json({ valid: false, error: 'Invalid licence key' });
    }

    const sub = data[0];

    // Suspension and ban. Checked BEFORE the plan, so a banned account
    // cannot keep running on an unexpired subscription.
    // Same policy the dashboard uses, so the EA and the web app never
    // disagree about whether an account is usable — including the grace
    // window after a failed renewal.
    const access = accessState(sub);
    if (!access.ok) {
      record('refused');
      console.warn(`[LICENCE] refused — ${access.state} user=${sub.user_id}`);
      return res.json({
        valid: false,
        error: access.state === 'banned'
          ? 'This licence has been revoked. Contact support.'
          : access.state === 'suspended'
            ? (access.reason || 'Access is suspended. Check your email or sign in to your account page.')
            : 'Subscription expired'
      });
    }

    if (sub.status !== 'active') {
      record('refused');
      return res.json({ valid: false, error: 'Subscription not active' });
    }

    // A free plan never runs the compiled tools. accessState() only ever
    // expires a 'pro' row, so a downgraded account sitting on plan='free'
    // with status='active' would otherwise validate forever. The downgrade
    // path clears licence_key too — this is the second lock on the same
    // door, because only one of them has to survive a future refactor.
    if (sub.plan === 'free') {
      record('refused');
      console.warn(`[LICENCE] refused — free plan holds a licence key user=${sub.user_id}`);
      return res.json({
        valid: false,
        error: 'This licence key is not active on a free plan. Upgrade at blackwoodmt5.com/account to use the EA and indicators.'
      });
    }

    // One key, one MT5 account. In observe mode a mismatch is recorded
    // and allowed; in enforce mode it is refused.
    const binding = await licenceAttempts.evaluateBinding({
      supabaseUrl: SUPABASE_URL, headers,
      licenceKey: key, account, boundAccount: sub.bound_account
    });
    record(binding.outcome);

    if (binding.outcome === 'refused') {
      console.warn(
        `[LICENCE] ${licenceAttempts.ENFORCING ? 'REFUSED' : 'MISMATCH (observing)'} — ` +
        `user=${sub.user_id} ${binding.note}`
      );
    }

    if (binding.refuse) {
      return res.json({
        valid: false,
        error: 'This licence key is already in use on another MT5 account. ' +
               'One key works on one account. Contact support if you have changed accounts.'
      });
    }

    // MT5 licence term (Lifetime only). Checked AFTER binding so the
    // attempt is still recorded, and last of all the refusal reasons so
    // a lapsed term never masks a more serious one like a ban.
    const term = licenceKeyState(sub);
    if (!term.ok) {
      record('refused');
      console.warn(`[LICENCE] refused — term lapsed user=${sub.user_id} expired=${term.expiresAt}`);
      return res.json({
        valid: false,
        licence_expires_at: term.expiresAt,
        error: 'Your MT5 licence key expired on ' + term.expiresAt.slice(0, 10) +
               '. Renew for $100/year at blackwoodmt5.com/account to restart the EA. ' +
               'Your platform access and dashboards are unaffected.'
      });
    }

    console.log(
      `[LICENCE] Key validated for plan=${sub.plan} user=${sub.user_id} term=${term.state}` +
      (account ? ` account=${account} (${binding.outcome})` : '')
    );
    res.json({
      valid: true, plan: sub.plan, expires_at: sub.expires_at,
      licence_expires_at: term.expiresAt || null,
      licence_state: term.state,
      ...(access.state === 'grace' ? { grace: true, grace_days_left: access.daysLeft } : {}),
      // `warning` is additive and only present when action is needed. The
      // EA prints it; older EA builds ignore the field and keep working.
      ...(term.state === 'expiring'
        ? { warning: `MT5 licence key expires in ${term.daysLeft} day(s). Renew for $100/year at blackwoodmt5.com/account.` }
        : {}),
      ...(term.state === 'grace'
        ? { warning: `MT5 licence key EXPIRED. Grace period ends in ${term.daysLeft} day(s), after which the EA and indicators will stop. Renew for $100/year at blackwoodmt5.com/account.` }
        : {})
    });

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
// ── SOURCE RESOLUTION ─────────────────────────────────────────────
// A "source" is ONE licence key — i.e. one MT5 terminal feeding us data.
//
// Scoping data by user_id alone is NOT enough: one user can hold more
// than one licence key (a second seat, a test key, the owner's own
// keys). Both keys resolve to the same user_id, so both terminals wrote
// into the same bucket and last-writer-won — which is exactly why a
// file-bridge terminal's data showed up on a direct-WebRequest
// terminal's dashboard. Data is now keyed by licence key, so two keys
// are always two separate feeds even under one account.
//
// sourceId is a short digest of the key rather than the key itself, so
// raw licence keys never end up in memory-store keys, log lines, or the
// WebSocket URL.
// (crypto is already required at the top of this file)

function sourceIdForKey(licenceKey) {
  return crypto.createHash('sha256').update(String(licenceKey)).digest('hex').slice(0, 12);
}

// Returns { userId, sourceId, accountLabel } or null. Same validation
// rules as getUserIdForLicenceKey below — inactive and expired keys are
// still rejected.
async function getSourceForLicenceKey(licenceKey) {
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
    return {
      userId:   sub.user_id,
      sourceId: sourceIdForKey(licenceKey),
      // Last 4 characters, so the dashboard can label the feed
      // recognisably without ever displaying the whole key.
      keyTail:  String(licenceKey).slice(-4).toUpperCase()
    };
  } catch (e) {
    console.error('[AUTH] getSourceForLicenceKey failed:', e.response?.data || e.message);
    return null;
  }
}

// Resolves a licence key to its owner, and says WHY when it cannot.
//
// Returns { userId, reason }. userId is null on any failure; reason is a
// short machine-ish string for the log line. Callers that only need the id
// use getUserIdForLicenceKey() below.
//
// Uses accessState() rather than its own expiry test. The old inline check
// here was `plan === 'pro' && expires_at < now → reject`, which ignored both
// grace_until and GRACE_DAYS — so during a grace period validateKey() would
// let the EA run while this function rejected everything it posted. The EA
// looked alive and its data silently vanished. Any expiry rule lives in
// accessState() and nowhere else.
async function resolveLicenceKey(licenceKey) {
  if (!licenceKey) return { userId: null, reason: 'no key in payload' };
  const key = String(licenceKey).trim();
  if (!key) return { userId: null, reason: 'empty key in payload' };
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?licence_key=eq.${encodeURIComponent(key)}` +
      `&select=user_id,status,plan,expires_at,grace_until,access_status,access_reason`,
      { headers: supabaseServiceHeaders() }
    );
    if (!data || data.length === 0) {
      return { userId: null, reason: `key not found in subscriptions (${maskKey(key)})` };
    }
    const sub = data[0];
    if (sub.status !== 'active') {
      return { userId: null, reason: `subscription status is '${sub.status}' (${maskKey(key)})` };
    }
    const access = accessState(sub);
    if (!access.ok) {
      return { userId: null, reason: `access ${access.state} (${maskKey(key)})` };
    }
    return { userId: sub.user_id, reason: null, plan: sub.plan, graceState: access.state };
  } catch (e) {
    console.error('[AUTH] resolveLicenceKey failed:', e.response?.data || e.message);
    return { userId: null, reason: 'lookup error — see [AUTH] line above' };
  }
}

// Never put a whole licence key in a log line; a log is not a secret store.
function maskKey(k) {
  return k.length <= 8 ? k : k.slice(0, 6) + '…' + k.slice(-4);
}

async function getUserIdForLicenceKey(licenceKey) {
  const { userId } = await resolveLicenceKey(licenceKey);
  return userId;
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

module.exports = {
  getSourceForLicenceKey,
  sourceIdForKey, licenceKeyState, LICENCE_TERM_GRACE_DAYS, resolveLicenceKey, requireAuth, requirePlan, requireFramedByDashboard, getMe, validateKey, regenerateKey, setBrokerType, cancelSubscription, getUserFromToken, getUserPlan, getUserIdForLicenceKey, verifyAppSession, isOwner, issueTicketRoute, SUPABASE_URL, SUPABASE_SERVICE, supabaseServiceHeaders, htmlRedirect, MONTHLY_CREDIT_USD, getUserCredits, deductCredits, resetUserCredits };
