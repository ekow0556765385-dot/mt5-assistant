// notify-route.js — Blackwood pop-up alerts, Phase 2a (Nov 2026)
//
// Phase 1 shows pop-ups from an OPEN dashboard on a computer. This file is the
// server half: it delivers alerts to every device a trader has switched alerts
// on for (phones included), even when every Blackwood page is closed.
//
// It reuses what the Arbiter's phone push (N-3) already set up: the web-push
// library (package.json) and the VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY variables.
// If either is missing, push is simply off and nothing else is affected.
//
// Devices are kept in their OWN table (push_subscriptions), not in the user's
// settings record: POST /api/settings replaces that record with whatever the
// Math Dashboard sends, which would wipe a list kept inside it.
//
// ── Run once in the Supabase SQL editor ─────────────────────────────────────
// create table if not exists push_subscriptions (
//   endpoint   text primary key,
//   user_id    uuid not null references auth.users(id) on delete cascade,
//   p256dh     text not null,
//   auth       text not null,
//   device     text,
//   tz         text,
//   created_at timestamptz default now(),
//   last_ok_at timestamptz
// );
// create index if not exists push_subscriptions_user on push_subscriptions(user_id);
// alter table push_subscriptions enable row level security;
// ────────────────────────────────────────────────────────────────────────────
//
// What it sends (each follows the trader's switches in the account page's Alerts tab):
//   terminal  — MT5 went dark for 2 minutes while the market is open / back online
//   signin    — a new sign-in to the account (sent to the trader's OTHER devices)
//   patterns  — the pattern alerts and live candle warnings that also go to Telegram
//   trades    — Trade Closed, also as on Telegram
// Red alerts (terminal dark, sign-in, live candle warning) stay on screen until
// dismissed and are never held back by quiet hours; the others are amber.
//
// No doubles: a computer with the dashboard open already shows terminal and
// live candle alerts itself (Phase 1). It tells this server so every minute
// (POST /api/notify/here), and those two kinds then skip that one device.

const axios = require('axios');

module.exports = function notifyRoute(app, deps) {
  const { requireAuth, SUPABASE_URL, supabaseServiceHeaders } = deps;
  const listSources = deps.listSources || (() => []);
  const env = deps.env || process.env;
  const log = deps.log || console;
  const TABLE = 'push_subscriptions';
  const DASH = '/dashboard';

  /* ── the push library, loaded carefully (same rule as the Arbiter) ── */
  let webpush = null, tried = false;
  function lib() {
    if (tried) return webpush; tried = true;
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) { log.warn('[NOTIFY] push off: VAPID keys not set'); return null; }
    try {
      webpush = deps.webpush || require('web-push');
      webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:alerts@blackwoodmt5.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    } catch (e) { webpush = null; log.warn('[NOTIFY] push unavailable:', e.message); }
    return webpush;
  }

  /* ── the table ── */
  let tableMissing = false;
  const H = (extra) => supabaseServiceHeaders(extra || {});
  async function subsFor(userId) {
    if (tableMissing) return [];
    try {
      const { data } = await axios.get(`${SUPABASE_URL}/rest/v1/${TABLE}?user_id=eq.${encodeURIComponent(userId)}&select=endpoint,p256dh,auth,device,tz`, { headers: H() });
      return Array.isArray(data) ? data : [];
    } catch (e) { noteMissing(e); return []; }
  }
  function noteMissing(e) {
    const st = e.response && e.response.status, msg = JSON.stringify((e.response && e.response.data) || e.message);
    if (st === 404 || /does not exist|PGRST205|42P01/.test(msg)) {
      if (!tableMissing) log.warn('[NOTIFY] push_subscriptions table not found — run the SQL at the top of notify-route.js');
      tableMissing = true; setTimeout(() => { tableMissing = false; }, 10 * 60 * 1000);
    } else log.warn('[NOTIFY] table error:', st || '', e.message);
  }
  async function dropSub(endpoint) {
    try { await axios.delete(`${SUPABASE_URL}/rest/v1/${TABLE}?endpoint=eq.${encodeURIComponent(endpoint)}`, { headers: H() }); } catch (e) {}
  }

  /* Every user with at least one device, for the terminal watch. Refreshed every 5 minutes. */
  let watched = new Set();
  async function refreshWatched() {
    if (tableMissing) return;
    try {
      const { data } = await axios.get(`${SUPABASE_URL}/rest/v1/${TABLE}?select=user_id`, { headers: H() });
      watched = new Set((data || []).map(r => r.user_id));
    } catch (e) { noteMissing(e); }
  }

  /* ── the trader's switches (account page → Supabase user_metadata.notify_prefs) ── */
  const DEF = { stop: true, arbiter: true, patterns: true, risk: true, smc: true, terminal: true, trades: true, signin: true, quiet: false };
  const prefCache = new Map();   // userId -> { at, prefs }
  async function prefsFor(userId) {
    const hit = prefCache.get(userId);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.prefs;
    let prefs = Object.assign({}, DEF);
    try {
      const { data } = await axios.get(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { headers: H() });
      const p = data && data.user_metadata && data.user_metadata.notify_prefs;
      if (p && typeof p === 'object') Object.keys(DEF).forEach(k => { if (typeof p[k] === 'boolean') prefs[k] = p[k]; });
    } catch (e) { /* unreadable: everything stays on, never silently off */ }
    prefCache.set(userId, { at: Date.now(), prefs });
    return prefs;
  }
  function quietIn(tz) {
    let h;
    try { h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: tz || 'UTC' }).format(new Date())); }
    catch (e) { h = new Date().getUTCHours(); }
    return h >= 22 || h < 7;
  }

  /* ── "this computer's dashboard is open and showing pop-ups itself" ── */
  const here = new Map();   // endpoint -> ms
  const COVERED = { terminal: true, candle: true };

  /* ── send to every device of one trader ──
     o = { kind:'terminal'|'signin'|'patterns'|'trades', sub:'candle'?, title, body, url, tag, urgent, skipDevice } */
  async function notifyUser(userId, o) {
    try {
      if (!userId || !lib()) return 0;
      const prefs = await prefsFor(userId);
      if (prefs[o.kind] === false) return 0;
      const subs = await subsFor(userId);
      if (!subs.length) return 0;
      const payload = JSON.stringify({ title: String(o.title || 'Blackwood').slice(0, 120), body: String(o.body || '').slice(0, 300),
        url: o.url || DASH, tag: o.tag || ('bw-' + o.kind), urgent: !!o.urgent });
      let sent = 0;
      await Promise.all(subs.map(async s => {
        if (o.skipDevice && s.device && s.device === o.skipDevice) return;
        if (!o.urgent && prefs.quiet && quietIn(s.tz)) return;
        if (COVERED[o.sub || o.kind] && Date.now() - (here.get(s.endpoint) || 0) < 150 * 1000) return;
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: o.urgent ? 3600 : 900, urgency: o.urgent ? 'high' : 'normal' });
          sent++;
        } catch (e) {
          const st = e.statusCode;
          if (st === 404 || st === 410) dropSub(s.endpoint);   /* the device unsubscribed or the browser was reset */
          else log.warn('[NOTIFY] send failed', st || '', e.body || e.message);
        }
      }));
      return sent;
    } catch (e) { log.warn('[NOTIFY] notifyUser failed:', e.message); return 0; }
  }

  /* A Telegram message, as a pop-up: first line is the title, the rest the body, tags and icons removed. */
  function fromTelegram(html) {
    const plain = String(html || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/[\u{1F300}-\u{1FAFF}☀-➿️]/gu, '').split('\n').map(s => s.trim()).filter(Boolean);
    return { title: plain[0] || 'Blackwood', body: plain.slice(1).join(' · ') };
  }

  /* ── routes ── */
  app.get('/api/notify/key', (req, res) => res.json({ publicKey: lib() ? env.VAPID_PUBLIC_KEY : null, ready: !tableMissing }));

  function deviceOf(req) {
    const ua = String(req.headers['user-agent'] || '');
    const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
    const os = /iPhone|iPad/.test(ua) ? 'an iPhone' : /Android/.test(ua) ? 'an Android phone' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'a Mac' : /Linux/.test(ua) ? 'Linux' : 'a device';
    return br + ' on ' + os;
  }
  function countryOf(req) {
    try {
      const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
      const g = require('geoip-country').lookup(ip);
      if (!g || !g.country) return '';
      try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(g.country) || g.country; } catch (e) { return g.country; }
    } catch (e) { return ''; }
  }

  app.post('/api/notify/subscribe', requireAuth, async (req, res) => {
    const sub = req.body && req.body.subscription;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return res.status(400).json({ ok: false, error: 'a push subscription is required' });
    if (!/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1000) return res.status(400).json({ ok: false, error: 'bad endpoint' });
    const tz = String((req.body && req.body.tz) || '').slice(0, 60) || null;
    try {
      await axios.post(`${SUPABASE_URL}/rest/v1/${TABLE}?on_conflict=endpoint`,
        { endpoint: sub.endpoint, user_id: req.user.id, p256dh: sub.keys.p256dh, auth: sub.keys.auth, device: deviceOf(req), tz, last_ok_at: new Date().toISOString() },
        { headers: H({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }) });
      watched.add(req.user.id);
      res.json({ ok: true });
    } catch (e) { noteMissing(e); res.json({ ok: false, ready: false }); }
  });

  app.post('/api/notify/unsubscribe', requireAuth, async (req, res) => {
    const ep = req.body && req.body.endpoint;
    if (!ep) return res.status(400).json({ ok: false });
    try { await axios.delete(`${SUPABASE_URL}/rest/v1/${TABLE}?endpoint=eq.${encodeURIComponent(ep)}&user_id=eq.${req.user.id}`, { headers: H() }); } catch (e) {}
    res.json({ ok: true });
  });

  app.post('/api/notify/here', requireAuth, (req, res) => {
    const ep = req.body && req.body.endpoint;
    if (ep && typeof ep === 'string') { here.set(ep, Date.now()); if (here.size > 20000) here.clear(); }
    res.json({ ok: true });
  });

  /* Sent by the account page right after a sign-in. Goes to the trader's other devices. */
  const signinAt = new Map();
  app.post('/api/notify/signin', requireAuth, async (req, res) => {
    const uid = req.user.id, now = Date.now();
    if (now - (signinAt.get(uid) || 0) < 2 * 60 * 1000) return res.json({ sent: 0, reason: 'cooldown' });
    signinAt.set(uid, now);
    const dev = deviceOf(req), where = countryOf(req);
    const sent = await notifyUser(uid, { kind: 'signin', urgent: true, tag: 'bw-signin', url: 'https://blackwoodmt5.com/account',
      skipDevice: dev,
      title: 'New sign-in to your Blackwood account',
      body: dev + (where ? ', ' + where : '') + ', just now. If this wasn\'t you, change your password in Settings on your account page.' });
    res.json({ sent });
  });

  app.post('/api/notify/test', requireAuth, async (req, res) => {
    const sent = await notifyUser(req.user.id, { kind: 'test', urgent: false, tag: 'bw-test', title: 'Blackwood alerts are on',
      body: 'This device will get your alerts, even when Blackwood is closed.' });
    res.json({ sent });
  });

  /* The service worker, the phone app details and its icons. Served from the top of the site
     so the worker can show alerts for the whole dashboard. */
  const path = require('path'), dir = deps.dir || __dirname;
  app.get('/bw-push-sw.js', (req, res) => { res.set('Cache-Control', 'no-cache'); res.type('application/javascript'); res.sendFile(path.join(dir, 'bw-push-sw.js')); });
  app.get('/bw-icon-192.png', (req, res) => res.sendFile(path.join(dir, 'bw-icon-192.png')));
  app.get('/bw-icon-512.png', (req, res) => res.sendFile(path.join(dir, 'bw-icon-512.png')));
  app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json');
    res.send(JSON.stringify({ name: 'Blackwood', short_name: 'Blackwood', start_url: DASH, scope: '/', display: 'standalone',
      background_color: '#09090e', theme_color: '#09090e',
      icons: [{ src: '/bw-icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/bw-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }] }));
  });

  /* ── terminal watch: MT5 went dark / came back ──
     Uses the same lastSeen times as /api/mt5-pulse (memory, no database). Only for traders
     with a device, only for a terminal seen live since this server started (so a restart
     never reports every terminal as dark), and quiet while the forex market is shut. */
  const term = new Map();   // userId -> { live:bool, sent:bool }
  function marketOpen() { const d = new Date(), w = d.getUTCDay(), h = d.getUTCHours(); return !(w === 6 || (w === 5 && h >= 21) || (w === 0 && h < 22)); }
  async function terminalTick() {
    const now = Date.now();
    for (const uid of watched) {
      let last = 0;
      try { const l = listSources(uid); last = (l && l[0] && l[0].lastSeen) || 0; } catch (e) {}
      if (!last) continue;
      const t = term.get(uid) || { live: false, sent: false };
      const age = now - last;
      if (age < 30 * 1000) {
        if (t.sent) { t.sent = false; notifyUser(uid, { kind: 'terminal', urgent: false, tag: 'bw-terminal', title: 'Your MT5 terminal is back online', body: 'Data is flowing again.' }); }
        t.live = true;
      } else if (age >= 2 * 60 * 1000 && t.live && !t.sent && marketOpen()) {
        t.sent = true;
        notifyUser(uid, { kind: 'terminal', urgent: true, tag: 'bw-terminal', title: 'Your MT5 terminal has gone dark',
          body: 'Blackwood has had no data from it for ' + Math.round(age / 60000) + ' minutes. Check that MT5 is open and the Blackwood EA is still on a chart.' });
      }
      term.set(uid, t);
    }
  }
  if (!deps.noTimers) {
    setTimeout(refreshWatched, 5000);
    setInterval(refreshWatched, 5 * 60 * 1000).unref?.();
    setInterval(terminalTick, 30 * 1000).unref?.();
  }

  return { notifyUser, fromTelegram, _test: { terminalTick, refreshWatched, here, term, prefCache, quietIn, deviceOf, set watched(v) { watched = v; } } };
};
