// ═══════════════════════════════════════════════════════════════
// live-overlap.js — notices two MT5 accounts on one licence posting
// data at the same time.
//
// WHY THIS EXISTS
// Overlap was meant to come from licence checks, but the EA only
// re-checks its licence every 6 hours. Two terminals running side by
// side all day would almost never check in the same minute, so an
// overlap signal built on licence_attempts would silently never fire.
//
// The data feed is different: every terminal posts market data every
// few seconds. Each post says which MT5 account it came from. If
// account A and account B both post for the same user within the same
// two minutes, both terminals are demonstrably running at once.
//
// WHAT IT DOES NOT DECIDE
// Two accounts live together is normal for a prop trader running
// several terminals on one PC. Whether it counts as evidence depends on
// whether the two accounts sit on DIFFERENT machines — and that is
// worked out later by the sweep, which knows each account's
// fingerprint. This module only records that the overlap happened.
//
// COST
// A small map per user, pruned as it goes. Writes are fire-and-forget
// and throttled to one row per account pair per hour, so a pair that
// runs together all day produces about 24 rows, not 17,000.
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CONCURRENT_MS   = 2 * 60 * 1000;   // both posted within 2 minutes = both live
const PAIR_COOLDOWN   = 60 * 60 * 1000;  // one record per pair per hour
const FORGET_AFTER_MS = 10 * 60 * 1000;  // drop accounts that have gone quiet

const live     = new Map();  // userId -> Map(account -> lastPostMs)
const lastPair = new Map();  // `${userId}|${a}|${b}` -> lastRecordedMs

function headers() {
  return { Authorization: `Bearer ${SUPABASE_SVC}`, apikey: SUPABASE_SVC,
           'Content-Type': 'application/json', Prefer: 'return=minimal' };
}

function record(userId, a, b) {
  if (!SUPABASE_URL || !SUPABASE_SVC) return;
  axios.post(`${SUPABASE_URL}/rest/v1/licence_overlaps`,
    { user_id: userId, account_a: a, account_b: b },
    { headers: headers(), timeout: 4000 }
  ).catch(e => {
    // Never allowed to disturb the data feed that called it.
    console.warn('[OVERLAP] could not record:', e.response?.data?.message || e.message);
  });
}

// Called on every data post. Cheap: a map lookup and, at most, one
// comparison per other live account on the same user.
function note(userId, account) {
  const acct = Number(account);
  if (!userId || !acct) return;
  const now = Date.now();

  let m = live.get(userId);
  if (!m) { m = new Map(); live.set(userId, m); }
  m.set(acct, now);

  for (const [other, at] of m) {
    if (other === acct) continue;
    if (now - at > FORGET_AFTER_MS) { m.delete(other); continue; }
    if (now - at > CONCURRENT_MS) continue;

    // Order the pair so A+B and B+A are the same pair.
    const [a, b] = acct < other ? [acct, other] : [other, acct];
    const k = `${userId}|${a}|${b}`;
    if (now - (lastPair.get(k) || 0) < PAIR_COOLDOWN) continue;
    lastPair.set(k, now);
    record(userId, a, b);
  }
}

// Housekeeping, so a user who stopped trading does not sit in memory
// forever. Runs rarely and touches nothing on the network.
setInterval(() => {
  const now = Date.now();
  for (const [u, m] of live) {
    for (const [a, at] of m) if (now - at > FORGET_AFTER_MS) m.delete(a);
    if (!m.size) live.delete(u);
  }
  for (const [k, at] of lastPair) if (now - at > PAIR_COOLDOWN) lastPair.delete(k);
}, 5 * 60 * 1000).unref();

module.exports = { note, CONCURRENT_MS, PAIR_COOLDOWN };
