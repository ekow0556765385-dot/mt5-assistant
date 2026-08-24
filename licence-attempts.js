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

// Fire-and-forget. Never awaited by the caller's happy path, never
// throws into it.
function recordAttempt({ supabaseUrl, headers, licenceKey, account, outcome, req }) {
  if (!licenceKey || !account) return;
  const row = {
    licence_key: String(licenceKey),
    account:     Number(account),
    outcome,
    ip:          req ? ip(req) : null,
    user_agent:  req ? String(req.headers['user-agent'] || '').slice(0, 250) : null
  };
  axios.post(`${supabaseUrl}/rest/v1/licence_attempts`, row, {
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    timeout: 4000
  }).catch(e => {
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
  recordAttempt, evaluateBinding, distinctAccounts
};
