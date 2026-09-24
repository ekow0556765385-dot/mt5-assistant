// ═══════════════════════════════════════════════════════════════
// licence-attempts.js — licence validation history + optional binding.
//
// Two jobs, deliberately separable:
//
//   1. RECORD every /api/validate-key call. Always on. This is what
//      makes sharing visible; `bound_account` holds one number, and
//      the interesting accounts are the ones that were refused.
//
//   2. ENFORCE one-account-per-key. OFF by default. Turning it on
//      before you have looked at the recorded data would cut off
//      anyone legitimately running two terminals. Watch first, then
//      switch it on:  LICENCE_BINDING=enforce
//
// Recording never blocks or fails a licence check. A logging table
// being unreachable must not stop a paying customer's EA from
// starting, so every write here is fire-and-forget.
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');

const MODE = (process.env.LICENCE_BINDING || 'observe').toLowerCase();
const ENFORCING = MODE === 'enforce';

// A key seen on more than this many accounts within the window is
// reported as sharing regardless of mode.
const SHARING_THRESHOLD = 2;

function ip(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
         req.socket?.remoteAddress || null;
}

// ── Sharing signals (v4.2 EA) ─────────────────────────────────
// The EA now sends three extra facts with every check: `fp` (which
// machine), `holder` (who the broker account belongs to) and `tzMin`
// (the machine's clock offset). All three are optional — an older EA
// sends none of them and is recorded exactly as before.

const FP_RE = /^[0-9a-f]{12}$/;

function cleanFp(v) {
  const s = String(v || '').toLowerCase().trim();
  return FP_RE.test(s) ? s : null;
}

function cleanTz(v) {
  const n = Number(v);
  // Real offsets run from UTC-12:00 to UTC+14:00. Anything outside that
  // is not a timezone, so it is dropped rather than stored.
  return Number.isInteger(n) && n >= -720 && n <= 840 ? n : null;
}

// Words of a name, compared without case or accents, so "AKOTÉ",
// "Akote" and "akoté" are the same surname. Hyphenated names are split
// too, so "Mensah-Akoté" can match either half.
function nameWords(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z']+/)
    .filter(w => w.length >= 2);
}

function titleCase(w) {
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

// The ONLY part of the broker name that is ever stored.
//
// Which word to keep matters. "Keep the last word" breaks on records
// written surname-first — MENSAH KOFI would keep Kofi. "Keep any word
// that matches" is worse: Kofi, Kwame and Ama are day names shared by
// millions, so two friends both called Kofi would look like one person.
//
// So: take the Blackwood account's surname and look for it anywhere in
// the broker name. Found → keep it, wherever it sits. Not found → keep
// the broker name's last word. First names are never used to match.
//
// Returned in the broker's own spelling (accents kept) for display;
// comparisons elsewhere go through nameWords().
function surnameFrom(holder, blackwoodName) {
  const raw = String(holder || '').trim();
  if (!raw) return null;
  const rawWords = raw.split(/[\s\-]+/).filter(w => nameWords(w).length);
  if (!rawWords.length) return null;

  const bw = nameWords(blackwoodName);
  const bwSurname = bw.length ? bw[bw.length - 1] : null;

  if (bwSurname) {
    const hit = rawWords.find(w => nameWords(w)[0] === bwSurname);
    if (hit) return titleCase(hit).slice(0, 60);
  }
  return titleCase(rawWords[rawWords.length - 1]).slice(0, 60);
}

// The Blackwood name, cached per user. The EA re-checks its licence on
// a timer, and fetching the same name from Supabase every time would be
// a pointless round trip. An hour is long enough to matter and short
// enough that a renamed account catches up the same day.
const NAME_TTL = 60 * 60 * 1000;
const nameCache = new Map();

// The cache holds the lookup itself, not only its result. Caching only
// the result let two checks arriving together both miss and both fetch —
// and several terminals starting on one key at once is exactly the case
// this feature exists for.
function blackwoodName(supabaseUrl, headers, userId) {
  if (!userId) return Promise.resolve({ ok: true, name: null });
  const hit = nameCache.get(userId);
  if (hit && Date.now() - hit.at < NAME_TTL) return hit.p;
  const p = axios.get(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
                      { headers, timeout: 4000 })
    .then(({ data }) => ({ ok: true, name: data?.user_metadata?.full_name || null }))
    .catch(() => {
      // Forget the failure so the next check retries instead of trusting
      // a blip for an hour.
      nameCache.delete(userId);
      return { ok: false, name: null };
    });
  nameCache.set(userId, { p, at: Date.now() });
  return p;
}

// Fire-and-forget. Never awaited by the caller's happy path, never
// throws into it. The name lookup happens in here, AFTER the licence
// answer has already gone back to the EA, so the check is no slower.
//
// The full broker name is never stored and never logged: it is reduced
// to one surname in memory, and only that surname is written.
function recordAttempt({ supabaseUrl, headers, licenceKey, account, outcome, req,
                         fp, holder, tzMin, userId }) {
  if (!licenceKey || !account) return;
  (async () => {
    // If the Blackwood name could not be FETCHED, store no surname at all
    // rather than guessing. A guess is not harmless here: with no name to
    // match against, MENSAH KOFI falls back to its last word and stores
    // "Kofi" - a first name - which the scorer would count as a second
    // holder. One network blip would cost an innocent trader 40 points
    // for the next 30 days. Unknown is ignored; wrong is not.
    //
    // A user who simply never set a name is different: every row for them
    // uses the same last-word rule, so their rows stay consistent.
    let holderSurname = null;
    if (holder) {
      const bw = await blackwoodName(supabaseUrl, headers, userId);
      if (bw.ok) holderSurname = surnameFrom(holder, bw.name);
    }
    const row = {
      licence_key:    String(licenceKey),
      account:        Number(account),
      outcome,
      ip:             req ? ip(req) : null,
      user_agent:     req ? String(req.headers['user-agent'] || '').slice(0, 250) : null,
      fp:             cleanFp(fp),
      holder_surname: holderSurname,
      tz_min:         cleanTz(tzMin)
    };
    await axios.post(`${supabaseUrl}/rest/v1/licence_attempts`, row, {
      headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      timeout: 4000
    });
  })().catch(e => {
    // Logged, not thrown. If this table is missing or Supabase is
    // briefly unreachable, licence checks must carry on working.
    console.warn('[LICENCE] could not record attempt:', e.response?.data?.message || e.message);
  });
}

// Decides what this validation means for binding, and returns the
// outcome to record plus whether to refuse.
//
//   bound   — first account ever seen for this key; we claim it
//   match   — same account as before
//   refused — a different account
//
// In observe mode a mismatch still returns refuse:false, so the EA
// keeps working and you simply collect the evidence.
async function evaluateBinding({ supabaseUrl, headers, licenceKey, account, boundAccount }) {
  const acct = Number(account);
  if (!acct) return { outcome: 'match', refuse: false, note: 'no account supplied' };

  if (boundAccount === null || boundAccount === undefined) {
    // Claim the first account we see. Done with a conditional PATCH so
    // two terminals racing on a fresh key cannot both win — whichever
    // lands first is the binding, the other reads as a mismatch.
    try {
      const { data } = await axios.patch(
        `${supabaseUrl}/rest/v1/subscriptions?licence_key=eq.${encodeURIComponent(licenceKey)}&bound_account=is.null`,
        { bound_account: acct, updated_at: new Date().toISOString() },
        { headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' }, timeout: 6000 }
      );
      if (Array.isArray(data) && data.length === 0) {
        return { outcome: 'refused', refuse: ENFORCING, note: 'another terminal claimed this key first' };
      }
      return { outcome: 'bound', refuse: false, note: 'account bound to this key' };
    } catch (e) {
      console.warn('[LICENCE] could not bind account:', e.response?.data?.message || e.message);
      // Binding failed for an infrastructure reason — never punish the
      // user for that.
      return { outcome: 'match', refuse: false, note: 'binding deferred' };
    }
  }

  if (Number(boundAccount) === acct) {
    return { outcome: 'match', refuse: false, note: null };
  }

  return {
    outcome: 'refused',
    refuse:  ENFORCING,
    note:    `key is bound to account ${boundAccount}, this is ${acct}`
  };
}

// How many distinct accounts this key has been seen on recently.
// Used by the admin console; safe to call when the table is empty.
async function distinctAccounts({ supabaseUrl, headers, licenceKey, days = 30 }) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  try {
    const { data } = await axios.get(
      `${supabaseUrl}/rest/v1/licence_attempts` +
      `?licence_key=eq.${encodeURIComponent(licenceKey)}` +
      `&seen_at=gte.${since}&select=account`,
      { headers, timeout: 6000 }
    );
    return [...new Set((data || []).map(r => r.account))];
  } catch {
    return [];
  }
}

module.exports = {
  MODE, ENFORCING, SHARING_THRESHOLD,
  recordAttempt, evaluateBinding, distinctAccounts,
  // exported for tests and for the Phase 3 scorer
  surnameFrom, nameWords, cleanFp, cleanTz
};
