// ═══════════════════════════════════════════════════════════════
// agent-auth.js — sign-in for support agents, at /support.
//
// Built from the approved prototype (support-agents-prototype.html).
// Needs migration-support-agents.sql.
//
// Separate from BOTH other sign-ins, on purpose:
//   · customers  — Supabase, bw-session           (auth-middleware.js)
//   · you        — bw-admin, env-configured       (admin-auth.js)
//   · agents     — bw-agent, path /support only   (this file)
// An agent's cookie is only ever sent to /support, is signed with a key
// of its own, and is refused everywhere in your console. Reuses your
// tested password and authenticator code from admin-auth.js rather than
// writing a second copy.
//
// Env: AGENT_SECRET — a long random value (64 hex characters). Every
// agent key is derived from it: one for signing cookies, one for
// encrypting authenticator secrets. Without it, /support refuses all
// traffic instead of running unprotected.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');
const { hashPassword, verifyPassword, verifyTOTP, readCookie, clientIp } = require('./admin-auth');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL      = (process.env.APP_URL || 'https://app.blackwoodmt5.com').trim();

const COOKIE        = 'bw-agent';           // never bw-admin, never bw-session
const SESSION_HOURS = 8;
const MAX_ATTEMPTS  = 5;
const LOCKOUT_MS    = 15 * 60 * 1000;
const SETUP_HOURS   = 48;
const MIN_PASSWORD  = 12;
const isProd = process.env.NODE_ENV === 'production';

function headers(extra = {}) {
  const isNew = String(SUPABASE_SVC || '').startsWith('sb_secret_');
  return { apikey: SUPABASE_SVC, ...(isNew ? {} : { Authorization: `Bearer ${SUPABASE_SVC}` }), ...extra };
}
const REST = `${SUPABASE_URL}/rest/v1`;

// ── Keys, derived from AGENT_SECRET ─────────────────────────────
function keys() {
  const secret = String(process.env.AGENT_SECRET || '');
  if (secret.length < 32) return null;
  return {
    session: Buffer.from(crypto.hkdfSync('sha256', secret, 'blackwood-agents', 'session', 32)),
    totp:    Buffer.from(crypto.hkdfSync('sha256', secret, 'blackwood-agents', 'totp', 32))
  };
}

// ── Authenticator secrets: generated here, stored encrypted ──────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function encryptSecret(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1$${iv.toString('hex')}$${c.getAuthTag().toString('hex')}$${ct.toString('hex')}`;
}
function decryptSecret(stored, key) {
  try {
    const [v, iv, tag, ct] = String(stored).split('$');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
    d.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(ct, 'hex')), d.final()]).toString('utf8');
  } catch { return null; }
}

// ── The cookie: signed, and carrying the agent's session version ──
function mint(agent, key) {
  const payload = Buffer.from(JSON.stringify({
    a: agent.id, v: agent.session_version, exp: Date.now() + SESSION_HOURS * 3600e3,
    n: crypto.randomBytes(8).toString('hex')
  })).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', key).update(payload).digest('base64url')}`;
}
function read(token, key) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expect = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return d.exp && Date.now() < d.exp ? d : null;
  } catch { return null; }
}
function setCookie(res, token) {
  res.cookie(COOKIE, token, { httpOnly: true, secure: isProd, sameSite: 'strict', path: '/support',
                              maxAge: SESSION_HOURS * 3600e3 });
}
function clearCookie(res) { res.clearCookie(COOKIE, { path: '/support' }); }

// ── Agents, briefly remembered ───────────────────────────────────
// Every agent request checks the agent is still active and the cookie's
// session version still matches. Remembered for a minute so that is not
// a database trip per click — and FORGOTTEN the instant you disable or
// reset them (forget() below), so Disable still takes effect at once.
const cache = new Map();
const CACHE_MS = 60 * 1000;
async function loadAgent(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.agent;
  const { data } = await axios.get(`${REST}/support_agents?id=eq.${id}&select=id,email,name,active,session_version`,
    { headers: headers(), timeout: 8000 });
  const agent = (data && data[0]) || null;
  cache.set(id, { at: Date.now(), agent });
  return agent;
}
function forget(id) { if (id) cache.delete(id); else cache.clear(); }

// ── The gate ─────────────────────────────────────────────────────
// Terminates on failure; never falls through to any other sign-in.
async function requireAgent(req, res, next) {
  const k = keys();
  if (!k) {
    console.error('[AGENT] refusing all agent traffic — AGENT_SECRET is not set');
    return res.status(503).json({ error: 'The support console is not configured on this server' });
  }
  const sess = read(readCookie(req, COOKIE), k.session);
  let agent = null;
  try { agent = sess && /^[0-9a-f-]{36}$/i.test(sess.a) ? await loadAgent(sess.a) : null; }
  catch (e) { return res.status(502).json({ error: 'Could not check your sign-in — please try again' }); }
  if (!agent || !agent.active || agent.session_version !== sess.v) {
    clearCookie(res);
    return res.status(401).json({ error: 'Please sign in again' });
  }
  req.agent = { id: agent.id, email: agent.email, name: agent.name };
  next();
}

// ── Per-address limit (the account limit lives in the database) ──
// Kept apart from your admin sign-in's limit, so a mistyping agent on
// the same network can never lock YOU out of your console.
const ipAttempts = new Map();
function ipLocked(ip) {
  const r = ipAttempts.get(ip);
  if (!r || !r.until) return false;
  if (Date.now() < r.until) return true;
  ipAttempts.delete(ip); return false;
}
function ipFail(ip) {
  const r = ipAttempts.get(ip) || { count: 0 };
  r.count++; if (r.count >= MAX_ATTEMPTS) r.until = Date.now() + LOCKOUT_MS;
  ipAttempts.set(ip, r);
}

// Setup links: the link carries a random token; only its fingerprint is stored.
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
function newSetupToken() { const token = crypto.randomBytes(24).toString('base64url'); return { token, hash: sha(token) }; }
function setupLink(token) { return `${APP_URL}/support/setup#${token}`; }

// Used when the email matches no agent, so a wrong email takes as long
// as a wrong password — the timing never reveals which accounts exist.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
const MISMATCH = 'Those details did not match.';

async function agentByEmail(email) {
  const { data } = await axios.get(`${REST}/support_agents?email=eq.${encodeURIComponent(email)}&select=*`,
    { headers: headers(), timeout: 8000 });
  return (data && data[0]) || null;
}
async function patchAgent(id, body) {
  await axios.patch(`${REST}/support_agents?id=eq.${id}`, body,
    { headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), timeout: 8000 });
}
async function agentBySetupToken(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const { data } = await axios.get(`${REST}/support_agents?setup_token_hash=eq.${sha(token)}&select=*`,
    { headers: headers(), timeout: 8000 });
  const a = (data && data[0]) || null;
  if (!a || !a.active || !a.setup_expires_at || Date.parse(a.setup_expires_at) < Date.now()) return null;
  return a;
}
function audit(req, action, email, note) {
  axios.post(`${REST}/admin_audit`, { actor_email: email || 'unknown', action, note: note || null, ip: clientIp(req) },
    { headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), timeout: 6000 })
    .catch(() => {});
}

// ═══════════════════════════════════════════════════════════════
//  ROUTES — mounted at /support
// ═══════════════════════════════════════════════════════════════
const router = express.Router();
router.use(express.json({ limit: '16kb' }));

// Every POST here must be JSON. Together with the strict cookie this
// stops another website from submitting a form on an agent's behalf.
function jsonOnly(req, res, next) {
  if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'JSON only' });
  next();
}
function configured(req, res, next) {
  if (!keys()) return res.status(503).json({ error: 'The support console is not configured on this server' });
  if (!SUPABASE_URL || !SUPABASE_SVC) return res.status(503).json({ error: 'Supabase is not configured' });
  next();
}
router.use('/api', jsonOnly, configured);

// Sign in. One message for every failure: it never says whether the
// email, the password or the code was wrong, or whether an email belongs
// to an agent at all.
router.post('/api/login', async (req, res) => {
  const ip = clientIp(req);
  if (ipLocked(ip)) return res.status(429).json({ error: 'Too many attempts. Sign-in is locked for 15 minutes.' });
  const email = String(req.body && req.body.email || '').trim().toLowerCase().slice(0, 200);
  const password = String(req.body && req.body.password || '');
  const code = String(req.body && req.body.code || '');
  try {
    const a = email ? await agentByEmail(email) : null;
    const locked = a && a.locked_until && Date.parse(a.locked_until) > Date.now();
    const passOk = verifyPassword(password, (a && a.password_hash) || DUMMY_HASH);
    const secret = a && a.totp_secret_enc ? decryptSecret(a.totp_secret_enc, keys().totp) : null;
    const codeOk = !!secret && verifyTOTP(secret, code);
    if (!a || !a.active || !a.password_hash || locked || !passOk || !codeOk) {
      ipFail(ip);
      if (a && !locked) {
        const n = (a.failed_attempts || 0) + 1;
        await patchAgent(a.id, n >= MAX_ATTEMPTS
          ? { failed_attempts: 0, locked_until: new Date(Date.now() + LOCKOUT_MS).toISOString() }
          : { failed_attempts: n });
        if (n >= MAX_ATTEMPTS) audit(req, 'agent.locked', a.email, 'five failed sign-ins — locked for 15 minutes');
      }
      return res.status(401).json({ error: MISMATCH });
    }
    await patchAgent(a.id, { failed_attempts: 0, locked_until: null, last_active_at: new Date().toISOString() });
    setCookie(res, mint(a, keys().session));
    audit(req, 'agent.signin', a.email, null);
    res.json({ ok: true, agent: { name: a.name, email: a.email } });
  } catch (e) {
    console.error('[AGENT] login:', e.response?.data || e.message);
    res.status(502).json({ error: 'Could not sign in just now — please try again' });
  }
});

router.post('/api/logout', (req, res) => { clearCookie(res); res.json({ ok: true }); });
router.get('/api/me', requireAgent, (req, res) => res.json({ agent: { name: req.agent.name, email: req.agent.email } }));

// One-time setup, step 1: the link's token → the authenticator secret to
// scan. Generated once and kept (encrypted), so reopening the link before
// finishing shows the same one.
router.post('/api/setup/start', async (req, res) => {
  const ip = clientIp(req);
  if (ipLocked(ip)) return res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes.' });
  try {
    const a = await agentBySetupToken(req.body && req.body.token);
    if (!a) { ipFail(ip); return res.status(404).json({ error: 'This setup link is not valid — it may have expired or already been used. Ask for a new one.' }); }
    let secret = a.totp_secret_enc ? decryptSecret(a.totp_secret_enc, keys().totp) : null;
    if (!secret) {
      secret = base32Encode(crypto.randomBytes(20));
      await patchAgent(a.id, { totp_secret_enc: encryptSecret(secret, keys().totp) });
    }
    const label = encodeURIComponent(`Blackwood Support:${a.email}`);
    res.json({ name: a.name, email: a.email, secret,
               otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Blackwood Support')}&digits=6&period=30` });
  } catch (e) {
    console.error('[AGENT] setup start:', e.response?.data || e.message);
    res.status(502).json({ error: 'Could not open the setup — please try again' });
  }
});

// Step 2: choose a password and prove the authenticator works. The link
// is used up here, and the agent is signed in.
router.post('/api/setup/finish', async (req, res) => {
  const ip = clientIp(req);
  if (ipLocked(ip)) return res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes.' });
  try {
    const a = await agentBySetupToken(req.body && req.body.token);
    if (!a) { ipFail(ip); return res.status(404).json({ error: 'This setup link is not valid — it may have expired or already been used. Ask for a new one.' }); }
    const password = String(req.body && req.body.password || '');
    if (password.length < MIN_PASSWORD) return res.status(400).json({ error: `Choose a password of at least ${MIN_PASSWORD} characters.` });
    if (password.toLowerCase().includes(a.email.split('@')[0].toLowerCase())) {
      return res.status(400).json({ error: 'Choose a password that does not contain your email name.' });
    }
    const secret = a.totp_secret_enc ? decryptSecret(a.totp_secret_enc, keys().totp) : null;
    if (!secret || !verifyTOTP(secret, req.body && req.body.code)) {
      return res.status(400).json({ error: 'That code did not match. Check your authenticator app and try the current code.' });
    }
    const version = (a.session_version || 1) + 1;
    await patchAgent(a.id, { password_hash: hashPassword(password), setup_token_hash: null, setup_expires_at: null,
      failed_attempts: 0, locked_until: null, session_version: version, last_active_at: new Date().toISOString() });
    forget(a.id);
    setCookie(res, mint({ ...a, session_version: version }, keys().session));
    audit(req, 'agent.setup', a.email, 'set up password and authenticator');
    res.json({ ok: true, agent: { name: a.name, email: a.email } });
  } catch (e) {
    console.error('[AGENT] setup finish:', e.response?.data || e.message);
    res.status(502).json({ error: 'Could not finish the setup — please try again' });
  }
});

// The agent's page (Phase 3). Sign-in, setup and the Inbox are one page.
const PAGE = path.join(__dirname, 'support-agent.html');
router.get(['/', '/login', '/setup'], (req, res) => {
  if (!fs.existsSync(PAGE)) return res.status(503).type('text').send('The support console is being set up.');
  res.set('Cache-Control', 'no-store');
  res.sendFile(PAGE);
});

module.exports = {
  router, requireAgent, forget, newSetupToken, setupLink,
  // exported for tests
  base32Encode, encryptSecret, decryptSecret, keys, mint, read, COOKIE, SETUP_HOURS
};
