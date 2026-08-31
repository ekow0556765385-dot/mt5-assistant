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
// ── What counts as a "confirmed account" ───────────────────────────
// A distinct MT5 account number that has been seen MORE THAN ONCE for
// this licence key inside the window. The second condition matters: a
// single stray connection — a wrong terminal, one demo login, a test —
// should never cost someone a strike. Sharing shows up as an account
// that keeps coming back.
//
// ── Why the acknowledgement count exists ───────────────────────────
// If the operator withdraws a warning, the sweep must not re-apply it
// the next night — that would make "dismiss" meaningless and bury a
// real escalation in noise. Clearing records the count it was cleared
// AT, and auto-escalation only fires again if the count goes HIGHER.
//
// Needs:
//   alter table subscriptions
//     add column if not exists sharing_state          text,
//     add column if not exists sharing_state_source   text,
//     add column if not exists sharing_accounts       int,
//     add column if not exists sharing_ack_accounts   int,
//     add column if not exists sharing_updated_at     timestamptz;
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');
const cron  = require('node-cron');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;

const WINDOW_DAYS      = 30;
const MIN_SEEN         = 2;   // times an account must appear to be "confirmed"
const WARN_AT          = 2;   // confirmed accounts -> strike 1
const BLOCK_AT         = 3;   // confirmed accounts -> strike 2

function headers(extra = {}) {
  return { Authorization: `Bearer ${SUPABASE_SVC}`, apikey: SUPABASE_SVC, ...extra };
}

// Distinct MT5 accounts seen more than MIN_SEEN-1 times for each key.
async function confirmedAccountsByKey() {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
  const { data } = await axios.get(
    `${SUPABASE_URL}/rest/v1/licence_attempts` +
    `?seen_at=gte.${since}&select=licence_key,account&limit=20000`,
    { headers: headers(), timeout: 15000 }
  );

  const counts = new Map();   // key -> Map(account -> times seen)
  for (const r of data || []) {
    if (!r.licence_key || r.account === null || r.account === undefined) continue;
    if (!counts.has(r.licence_key)) counts.set(r.licence_key, new Map());
    const m = counts.get(r.licence_key);
    m.set(r.account, (m.get(r.account) || 0) + 1);
  }

  const out = new Map();
  for (const [key, m] of counts) {
    const confirmed = [...m.entries()].filter(([, n]) => n >= MIN_SEEN).map(([acct]) => acct);
    out.set(key, confirmed);
  }
  return out;
}

// What state SHOULD this row be in, given the count and what the
// operator has already acknowledged? Returns null to leave it alone.
function decide({ confirmed, state, source, ackAccounts }) {
  // A hand-set state is the operator's decision and is never overridden
  // by the sweep — in either direction.
  if (source === 'manual') return null;

  const ack = Number.isFinite(ackAccounts) ? ackAccounts : -1;

  // Only escalate past what has already been dismissed.
  if (confirmed > ack) {
    if (confirmed >= BLOCK_AT && state !== 'blocked') return 'blocked';
    if (confirmed >= WARN_AT && !state)               return 'warned';
  }

  // De-escalate on its own once the extra accounts have aged out of the
  // window: someone who stopped a year ago should not carry it forever.
  if (confirmed < WARN_AT && state) return 'clear';

  return null;
}

async function sweep() {
  if (!SUPABASE_URL || !SUPABASE_SVC) {
    console.warn('[SHARING] Supabase is not configured — skipping');
    return { warned: 0, blocked: 0, cleared: 0 };
  }

  let byKey;
  try {
    byKey = await confirmedAccountsByKey();
  } catch (e) {
    // A missing licence_attempts table means "not collecting yet", which
    // is not an error worth shouting about every night.
    const missing = e.response?.status === 404 ||
      /relation .* does not exist|Could not find the table/i.test(e.response?.data?.message || '');
    if (missing) return { warned: 0, blocked: 0, cleared: 0 };
    console.warn('[SHARING] could not read licence_attempts:', e.response?.data?.message || e.message);
    return { warned: 0, blocked: 0, cleared: 0 };
  }

  let rows;
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions` +
      `?licence_key=not.is.null&plan=in.(pro,lifetime)` +
      `&select=user_id,licence_key,plan,sharing_state,sharing_state_source,sharing_accounts,sharing_ack_accounts`,
      { headers: headers(), timeout: 15000 }
    );
    rows = data || [];
  } catch (e) {
    console.warn('[SHARING] could not read subscriptions:', e.response?.data?.message || e.message);
    return { warned: 0, blocked: 0, cleared: 0 };
  }

  let warned = 0, blocked = 0, cleared = 0;

  for (const row of rows) {
    const confirmed = (byKey.get(row.licence_key) || []).length;
    const next = decide({
      confirmed,
      state:       row.sharing_state || null,
      source:      row.sharing_state_source || null,
      ackAccounts: row.sharing_ack_accounts
    });

    // Always keep the observed count fresh, even when the state is
    // unchanged — the admin console reads it.
    const patch = { sharing_accounts: confirmed, sharing_updated_at: new Date().toISOString() };

    if (next === 'clear') {
      patch.sharing_state = null;
      patch.sharing_state_source = null;
      patch.sharing_ack_accounts = null;
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
      if (next) {
        console.log(`[SHARING] user=${row.user_id} -> ${next} (${confirmed} confirmed accounts)`);
      }
    } catch (e) {
      console.warn(`[SHARING] could not update user=${row.user_id}:`, e.response?.data?.message || e.message);
    }
  }

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
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=sharing_accounts`,
      { headers: headers(), timeout: 8000 }
    );
    const seen = (data && data[0] && data[0].sharing_accounts) || 0;
    patch = {
      sharing_state: null,
      sharing_state_source: null,
      // Re-escalate only if it goes HIGHER than what was dismissed.
      sharing_ack_accounts: seen,
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
  start, sweep, setState, decide, confirmedAccountsByKey,
  WINDOW_DAYS, MIN_SEEN, WARN_AT, BLOCK_AT
};
