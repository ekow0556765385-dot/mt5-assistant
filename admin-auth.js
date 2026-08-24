// ═══════════════════════════════════════════════════════════════
// admin-auth.js — admin identity, completely separate from user auth.
//
// Nothing here touches Supabase, requireAuth, requirePlan, bw-session
// or the Supabase JWT. That separation is the point: the user token
// travels through URLs, iframes, tickets and sessionStorage, and has
// already been the subject of several bypass rounds. An admin session
// that only /admin/* accepts has a blast radius of one route tree.
//
// Env required:
//   ADMIN_EMAIL          you@example.com
//   ADMIN_PASSWORD_HASH  scrypt hash — run `node admin-setup.js`
//   ADMIN_TOTP_SECRET    base32 secret — run `node admin-setup.js`
//   ADMIN_SESSION_SECRET long random string (openssl rand -hex 32)
//
// No dependencies beyond Node's own crypto.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');

const SESSION_HOURS   = 8;
const COOKIE          = 'bw-admin';         // never 'bw-session'
const MAX_ATTEMPTS    = 5;
const LOCKOUT_MS      = 15 * 60 * 1000;

// ── base32 (RFC 4648) decode, for the TOTP secret ──────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Bad base32 character in ADMIN_TOTP_SECRET');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ── TOTP, RFC 6238 ─────────────────────────────────────────────
function hotp(keyBuf, counter, digits = 6) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = crypto.createHmac('sha1', keyBuf).update(buf).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) |
              (mac[off + 2] << 8)        |  mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

// A window of ±1 step (30s either side) covers ordinary clock drift
// between the phone and the server without meaningfully widening the
// guessing surface.
function verifyTOTP(secret, token, atMs = Date.now(), window = 1) {
  const t = String(token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(t)) return false;
  const key = base32Decode(secret);
  const step = Math.floor(atMs / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    if (timingSafeEq(hotp(key, step + i), t)) return true;
  }
  return false;
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ── password: scrypt, format  scrypt$<saltHex>$<hashHex> ───────
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(plain, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

function verifyPassword(plain, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const dk = crypto.scryptSync(plain, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(dk, Buffer.from(hashHex, 'hex'));
  } catch { return false; }
}

// ── session token: <payloadB64>.<hmac> ─────────────────────────
// Self-contained and signed, so there is no session table to keep.
// Short-lived by design — 8 hours, then sign in again.
function mintSession(email, secret) {
  const payload = Buffer.from(JSON.stringify({
    e: email,
    iat: Date.now(),
    exp: Date.now() + SESSION_HOURS * 3600 * 1000,
    n: crypto.randomBytes(8).toString('hex')
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function readSession(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expect = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (!timingSafeEq(sig, expect)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); }
  catch { return null; }
  if (!data.exp || Date.now() > data.exp) return null;
  return data;
}

// ── brute-force throttle (in memory, per process) ──────────────
const attempts = new Map();
function throttleState(ip) {
  const rec = attempts.get(ip);
  if (!rec) return { locked: false, left: MAX_ATTEMPTS };
  if (rec.until && Date.now() < rec.until) {
    return { locked: true, retryInMs: rec.until - Date.now() };
  }
  if (rec.until && Date.now() >= rec.until) {
    attempts.delete(ip);
    return { locked: false, left: MAX_ATTEMPTS };
  }
  return { locked: false, left: Math.max(0, MAX_ATTEMPTS - rec.count) };
}
function recordFailure(ip) {
  const rec = attempts.get(ip) || { count: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) rec.until = Date.now() + LOCKOUT_MS;
  attempts.set(ip, rec);
  return rec;
}
function clearFailures(ip) { attempts.delete(ip); }

// ── config check, so misconfiguration fails loudly at boot ─────
function adminConfig() {
  const cfg = {
    email:   process.env.ADMIN_EMAIL,
    hash:    process.env.ADMIN_PASSWORD_HASH,
    totp:    process.env.ADMIN_TOTP_SECRET,
    secret:  process.env.ADMIN_SESSION_SECRET
  };
  const missing = Object.entries(cfg).filter(([, v]) => !v).map(([k]) => k);
  return { cfg, missing };
}

// ── the gate ───────────────────────────────────────────────────
// Terminates on failure. It never falls through to requireAuth,
// never consults isOwner, and never reads bw-session. Being signed
// in as a user is not, and must never become, sufficient.
function requireAdmin(req, res, next) {
  const { cfg, missing } = adminConfig();
  if (missing.length) {
    console.error('[ADMIN] refusing all admin traffic — missing env:', missing.join(', '));
    return res.status(503).json({ error: 'Admin console is not configured on this server' });
  }

  const raw = readCookie(req, COOKIE);
  const sess = readSession(raw, cfg.secret);

  if (!sess || sess.e !== cfg.email) {
    // Name the reason, otherwise "sign-in required" covers three very
    // different failures: no cookie arrived, a cookie arrived but the
    // signature did not verify, or it verified for a different address.
    const names = (req.headers.cookie || '')
      .split(';').map(c => c.split('=')[0].trim()).filter(Boolean);
    const why = !req.headers.cookie ? 'no cookie header at all'
              : !raw                ? `bw-admin not among [${names.join(', ')}]`
              : !sess               ? 'bw-admin present but invalid or expired'
              : `session is for ${sess.e}, expected ${cfg.email}`;
    console.warn(`[ADMIN] denied ${req.method} ${req.path} from ${clientIp(req)} — ${why}`);
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Admin sign-in required' });
    }
    return res.redirect('/admin/login');
  }

  req.admin = { email: sess.e, issuedAt: sess.iat };
  next();
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return null;
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
         req.socket?.remoteAddress || 'unknown';
}

module.exports = {
  COOKIE, SESSION_HOURS,
  base32Decode, hotp, verifyTOTP,
  hashPassword, verifyPassword,
  mintSession, readSession,
  throttleState, recordFailure, clearFailures,
  adminConfig, requireAdmin, readCookie, clientIp
};
