// ═══════════════════════════════════════════════════════════════
// licence-sharing.js — graduated response to licence sharing.
//
// Deliberately NOT a hard block. licence-attempts.js can refuse a
// mismatched account outright (LICENCE_BINDING=enforce), but that cuts
// off anyone legitimately running two terminals with no warning and no
// way back. This is the softer path:
//
//   STRIKE 1  (2 confirmed accounts) — a warning on their account page.
//             Nothing is blocked. Most people at this level are running
//             their own second terminal and simply need telling.
//
//   STRIKE 2  (3 confirmed accounts) — the Pro dashboard is blocked.
//             The account, licence key and Telegram alerts keep working;
//             only the dashboard closes.
//
// Both are reversible from the admin console, and both can be applied
// or lifted by hand at any time.
//
// ── What it scores on (v2) ─────────────────────────────────────
// It used to count "confirmed accounts". That was the one signal where
// a trader running eight prop challenges and a key sold to three people
// look IDENTICAL, so it punished exactly the customers you want.
//
// It now scores five signals, and account count is recorded but never
// scored:
//
//   machines      distinct fingerprints, 2 allowed free, +30 each beyond
//   holders       distinct broker surnames, 1 free, +40 each extra
//   overlap       two accounts live at once on DIFFERENT machines,
//                 +25 each, capped at 50
//   travel        two machines in different countries within an hour, +20
//   timezones     more than one clock offset, +5
//
// When one holder owns everything, overlap and travel are cut to a
// fifth: one trader with a home PC and a London VPS produces both,
// legitimately.
//
// Bands and what they do (auto or manual, set in the admin console):
//   watch    30-59   warned   — account page warning, nothing blocked
//   review   60-99   blocked  — Pro dashboard paused; EA and alerts run
//   shared   100+    blocked  — and a ban RECOMMENDED. Never automatic.
//
// ── Clearing ───────────────────────────────────────────────────
// Clearing accepts the setup that was reviewed — its machines AND its
// holders — so it will not flag again. Anything NEW still counts.
//
// Needs migration-licence-sharing-v2.sql.
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');
const cron  = require('node-cron');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;

const WINDOW_DAYS      = 30;

function headers(extra = {}) {
  return { Authorization: `Bearer ${SUPABASE_SVC}`, apikey: SUPABASE_SVC, ...extra };
}

let geo = null;
function countryOf(ip) {
  if (!ip) return null;
  // Offline database: ~1µs per lookup, loaded once, and no user IP ever
  // leaves this server.
  if (!geo) { try { geo = require('geoip-country'); } catch { geo = false; } }
  if (!geo) return null;
  const hit = geo.lookup(String(ip).replace(/^::ffff:/, ''));
  return hit ? hit.country : null;
}

// Every row in the window, a page at a time. The old reader asked for
// limit=20000 in one go, which silently dropped everything past that
// line once the table grew — the newest rows first, since nothing
// ordered them. Paging with an explicit order reads all of it.
async function readAll(table, select, since) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/${table}?seen_at=gte.${since}&select=${select}&order=seen_at.asc`,
      { headers: headers({ Range: `${from}-${from + PAGE - 1}` }), timeout: 15000 }
    );
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// Gathers everything the score needs, per licence key.
async function gatherEvidence() {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
  const attempts = await readAll('licence_attempts',
    'licence_key,account,seen_at,fp,holder_surname,tz_min,ip', since);

  let overlaps = [];
  try { overlaps = await readAll('licence_overlaps', 'user_id,account_a,account_b,seen_at', since); }
  catch { /* table not created yet — overlap simply scores 0 */ }

  const byKey = new Map();
  for (const r of attempts) {
    if (!r.licence_key || r.account == null) continue;
    let e = byKey.get(r.licence_key);
    if (!e) {
      e = { accounts: new Map(), machines: new Map(), holders: new Map(), tzs: new Set(),
            acctFp: new Map(), trail: [] };
      byKey.set(r.licence_key, e);
    }
    const acct = Number(r.account), at = r.seen_at;

    const a = e.accounts.get(acct) || { n: String(acct), lastSeen: at, holder: null };
    if (at >= a.lastSeen) a.lastSeen = at;
    if (r.holder_surname) a.holder = r.holder_surname;
    e.accounts.set(acct, a);

    const country = countryOf(r.ip);
    if (r.fp) {
      const m = e.machines.get(r.fp) || { fp: r.fp, lastSeen: at, countries: new Set(), overlaps: 0 };
      if (at >= m.lastSeen) m.lastSeen = at;
      if (country) m.countries.add(country);
      e.machines.set(r.fp, m);
      e.acctFp.set(acct, r.fp);                 // latest machine for this account
      if (country) e.trail.push({ at: Date.parse(at), fp: r.fp, country });
    }
    // Keyed by the accent- and case-free form, so MENSAH and Mensah are
    // one holder; the broker's own spelling is kept for display.
    if (r.holder_surname) e.holders.set(norm(r.holder_surname), r.holder_surname);
    if (r.tz_min != null) e.tzs.add(r.tz_min);
  }
  return { byKey, overlaps };
}

// The score. Same arithmetic as the approved prototype.
function score(e, ok = { fps: [], holders: [] }) {
  const okFps = new Set(ok.fps || []);
  const okHolders = new Set((ok.holders || []).map(norm));
  const cleared = okFps.size > 0 || okHolders.size > 0;

  const liveMachines = [...e.machines.keys()].filter(fp => !okFps.has(fp));
  const holderKeys   = [...e.holders.keys()];
  const newHolders   = holderKeys.filter(h => !okHolders.has(h));
  const extraNames   = cleared ? newHolders.length : Math.max(0, holderKeys.length - 1);

  // Overlap only counts between two DIFFERENT machines, at least one of
  // them not already accepted. Two accounts on one fingerprint is one
  // PC running several terminals — normal for a prop trader.
  let overlapEvents = 0;
  // Reset first: scoring the same evidence twice must not double the
  // per-machine counts shown in the drawer.
  for (const m of e.machines.values()) m.overlaps = 0;
  for (const o of e.overlapPairs || []) {
    const fa = e.acctFp.get(o.a), fb = e.acctFp.get(o.b);
    if (!fa || !fb || fa === fb) continue;          // unknown or same machine: not evidence
    if (okFps.has(fa) && okFps.has(fb)) continue;   // an accepted setup
    overlapEvents++;
    e.machines.get(fa).overlaps++; e.machines.get(fb).overlaps++;
  }

  // Impossible travel: two DIFFERENT machines in different countries
  // within an hour. One machine changing country is a VPN being toggled,
  // not two people, so it never counts.
  let travel = false;
  const t = (e.trail || []).slice().sort((x, y) => x.at - y.at);
  for (let i = 1; i < t.length && !travel; i++) {
    const p = t[i - 1], q = t[i];
    if (p.fp !== q.fp && p.country !== q.country && q.at - p.at <= 3600000 &&
        !(okFps.has(p.fp) && okFps.has(q.fp))) travel = true;
  }

  const oneHolder = holderKeys.length <= 1 || (cleared && newHolders.length === 0);
  const damp  = oneHolder ? 0.2 : 1;
  const quiet = cleared && liveMachines.length === 0 && newHolders.length === 0;

  const breakdown = {
    accounts: 0,
    machines: Math.max(0, liveMachines.length - (cleared ? 0 : 2)) * 30,
    names:    extraNames * 40,
    overlap:  quiet ? 0 : Math.round(Math.min(overlapEvents * 25, 50) * damp),
    travel:   quiet ? 0 : Math.round((travel ? 20 : 0) * damp),
    tz:       quiet ? 0 : (e.tzs.size > 1 ? 5 : 0)
  };
  const total = Object.values(breakdown).reduce((x, y) => x + y, 0);
  const band  = total >= 100 ? 'shared' : total >= 60 ? 'review' : total >= 30 ? 'watch' : 'clear';
  return { total, band, breakdown, overlapEvents, travel, damped: oneHolder && (overlapEvents > 0 || travel) };
}

// Plain JSON the admin console can render without recomputing anything.
function evidenceJson(e, s, ok) {
  const okFps = new Set((ok && ok.fps) || []);
  return {
    score: s.total, band: s.band, breakdown: s.breakdown, damped: s.damped,
    banRecommended: s.band === 'shared',
    accounts: [...e.accounts.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)),
    machines: [...e.machines.values()].map(m => ({
      fp: m.fp, lastSeen: m.lastSeen, countries: [...m.countries], overlaps: m.overlaps,
      accepted: okFps.has(m.fp)
    })),
    holders: [...e.holders.values()],
    timezones: [...e.tzs],
    overlapEvents: s.overlapEvents, travel: s.travel
  };
}

// What state SHOULD this row be in? Returns null to leave it alone.
function decide({ band, state, source, policy }) {
  // A hand-set state is the operator's decision and is never overridden
  // by the sweep — in either direction.
  if (source === 'manual') return null;

  if (band === 'review' || band === 'shared') {
    if (policy.review === 'auto' && state !== 'blocked') return 'blocked';
    // Review on manual: fall through so it is at least warned, if that is automatic.
  }
  if (band !== 'clear' && policy.watch === 'auto' && !state) return 'warned';

  // De-escalate on its own once the evidence has aged out of the window:
  // someone who stopped a year ago should not carry it forever.
  if (band === 'clear' && state) return 'clear';
  return null;
}

// Auto or manual for each band, as set in the admin console. Defaults to
// automatic — the same behaviour the previous sweep already had.
async function readPolicy() {
  const policy = { watch: 'auto', review: 'auto' };
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/admin_settings?key=eq.sharing_policy&select=value`,
      { headers: headers(), timeout: 8000 });
    const v = data && data[0] && data[0].value;
    if (v && (v.watch === 'auto' || v.watch === 'manual')) policy.watch = v.watch;
    if (v && (v.review === 'auto' || v.review === 'manual')) policy.review = v.review;
  } catch { /* no settings row yet — defaults stand */ }
  return policy;
}

// Rows older than the window are never read again, and holder surnames
// are personal data with no reason to outlive their use.
async function prune() {
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
  for (const table of ['licence_attempts', 'licence_overlaps']) {
    try {
      await axios.delete(`${SUPABASE_URL}/rest/v1/${table}?seen_at=lt.${cutoff}`,
        { headers: headers({ Prefer: 'return=minimal' }), timeout: 15000 });
    } catch (e) {
      console.warn(`[SHARING] could not prune ${table}:`, e.response?.data?.message || e.message);
    }
  }
}

async function sweep() {
  if (!SUPABASE_URL || !SUPABASE_SVC) {
    console.warn('[SHARING] Supabase is not configured — skipping');
    return { warned: 0, blocked: 0, cleared: 0 };
  }

  let ev;
  try {
    ev = await gatherEvidence();
  } catch (e) {
    // A missing licence_attempts table means "not collecting yet", which
    // is not an error worth shouting about every night.
    const missing = e.response?.status === 404 ||
      /relation .* does not exist|Could not find the table/i.test(e.response?.data?.message || '');
    if (!missing) console.warn('[SHARING] could not read licence_attempts:', e.response?.data?.message || e.message);
    return { warned: 0, blocked: 0, cleared: 0 };
  }

  let rows;
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions` +
      `?licence_key=not.is.null&plan=in.(pro,lifetime)` +
      `&select=user_id,licence_key,plan,sharing_state,sharing_state_source,sharing_ok_fps,sharing_ok_holders`,
      { headers: headers(), timeout: 15000 }
    );
    rows = data || [];
  } catch (e) {
    console.warn('[SHARING] could not read subscriptions:', e.response?.data?.message || e.message);
    return { warned: 0, blocked: 0, cleared: 0 };
  }

  const policy = await readPolicy();

  // Overlap rows are keyed by user; attach them to that user's key.
  const overlapsByUser = new Map();
  for (const o of ev.overlaps) {
    if (!overlapsByUser.has(o.user_id)) overlapsByUser.set(o.user_id, []);
    overlapsByUser.get(o.user_id).push({ a: Number(o.account_a), b: Number(o.account_b) });
  }

  let warned = 0, blocked = 0, cleared = 0;

  for (const row of rows) {
    const e = ev.byKey.get(row.licence_key);
    if (!e) {
      // No attempts in the window at all. Only worth a write if there is
      // an automatic state to lift.
      if (!row.sharing_state || row.sharing_state_source === 'manual') continue;
    }
    const empty = { accounts: new Map(), machines: new Map(), holders: new Map(), tzs: new Set(),
                    acctFp: new Map(), trail: [] };
    const evd = e || empty;
    evd.overlapPairs = overlapsByUser.get(row.user_id) || [];

    const ok = { fps: row.sharing_ok_fps || [], holders: row.sharing_ok_holders || [] };
    const s = score(evd, ok);
    const next = decide({
      band: s.band, state: row.sharing_state || null,
      source: row.sharing_state_source || null, policy
    });

    // Always keep the evidence fresh, even when the state is unchanged —
    // the admin console reads it straight from here.
    const patch = {
      sharing_accounts:   evd.accounts.size,
      sharing_score:      s.total,
      sharing_band:       s.band,
      sharing_evidence:   evidenceJson(evd, s, ok),
      sharing_updated_at: new Date().toISOString()
    };

    if (next === 'clear') {
      patch.sharing_state = null;
      patch.sharing_state_source = null;
      cleared++;
    } else if (next) {
      patch.sharing_state = next;
      patch.sharing_state_source = 'auto';
      if (next === 'warned') warned++; else blocked++;
    }

    try {
      await axios.patch(
        `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${row.user_id}`,
        patch,
        { headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), timeout: 8000 }
      );
      if (next) console.log(`[SHARING] user=${row.user_id} -> ${next} (score ${s.total}, ${s.band})`);
    } catch (e2) {
      console.warn(`[SHARING] could not update user=${row.user_id}:`, e2.response?.data?.message || e2.message);
    }
  }

  await prune();

  if (warned || blocked || cleared) {
    console.log(`[SHARING] sweep: ${warned} warned, ${blocked} blocked, ${cleared} cleared`);
  }
  return { warned, blocked, cleared };
}

// Operator actions from the admin console.
//   warn / block   — set by hand; the sweep will not undo these
//   clear          — withdraw, and remember the count it was cleared at
//                    so the sweep does not immediately re-apply it
async function setState(userId, action) {
  const now = new Date().toISOString();
  let patch;

  if (action === 'clear') {
    // Clearing ACCEPTS the setup that was reviewed: its machines and its
    // holders stop counting, so the same setup will not flag again. A new
    // machine or a new holder still would. Accepting only the account
    // count, as before, left anyone whose score came from two holders
    // overlapping to re-flag the very next night.
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=sharing_evidence`,
      { headers: headers(), timeout: 8000 }
    );
    const evd = (data && data[0] && data[0].sharing_evidence) || {};
    patch = {
      sharing_state: null,
      sharing_state_source: 'manual',
      sharing_ok_fps:     (evd.machines || []).map(m => m.fp),
      sharing_ok_holders: evd.holders || [],
      sharing_updated_at: now
    };
  } else if (action === 'unblock') {
    // Lift the dashboard block but KEEP the warning. Going straight from
    // 'blocked' to nothing would erase the fact that they were warned, and
    // the next sweep would then treat a repeat as a first offence.
    patch = {
      sharing_state: 'warned',
      sharing_state_source: 'manual',
      sharing_ack_accounts: null,
      sharing_updated_at: now
    };
  } else if (action === 'warn' || action === 'block') {
    patch = {
      sharing_state: action === 'warn' ? 'warned' : 'blocked',
      sharing_state_source: 'manual',
      sharing_ack_accounts: null,
      sharing_updated_at: now
    };
  } else {
    throw new Error('Unknown sharing action: ' + action);
  }

  await axios.patch(
    `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}`,
    patch,
    { headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), timeout: 8000 }
  );
  console.log(`[SHARING] user=${userId} set to ${patch.sharing_state || 'clear'} (manual)`);
  return patch;
}

function start() {
  // 00:20 UTC — after the credit reset and the pending-plan sweep, so a
  // downgrade that cleared a licence key is already reflected.
  cron.schedule('20 0 * * *', () =>
    sweep().catch(e => console.warn('[SHARING] sweep failed:', e.message)));
  console.log('[SHARING] daily licence-sharing sweep scheduled for 00:20 UTC');
}

module.exports = {
  start, sweep, setState, decide, score, gatherEvidence, evidenceJson, readPolicy, countryOf,
  WINDOW_DAYS
};
