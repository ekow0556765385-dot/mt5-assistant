// ═══════════════════════════════════════════════════════════════
// PATCH — replaces validateKey() in auth-middleware.js (line 602).
//
// Response shape is UNCHANGED. The EA's ParseLicenceResponse looks for
// the literal substrings "valid":true, "plan":" and "error":" — all
// three still appear exactly as before, so no EA rebuild is needed.
//
// Three things this adds, in order of how safe they are:
//
//   1. Records every attempt to licence_attempts. Always on, never
//      blocks a check. This is what makes sharing visible.
//   2. Checks access_status, so a suspended or banned account's EA
//      actually stops. Previously the ban column did nothing here.
//   3. Binds the key to the first MT5 account it sees, and refuses
//      others — but ONLY when LICENCE_BINDING=enforce. Default is
//      observe: record the mismatch, let the EA run.
//
// Add near the top of auth-middleware.js:
//   const licenceAttempts = require('./licence-attempts');
// ═══════════════════════════════════════════════════════════════

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
      `&select=plan,status,expires_at,user_id,bound_account,access_status`,
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
    const access = sub.access_status || 'active';
    if (access === 'suspended' || access === 'banned') {
      record('refused');
      console.warn(`[LICENCE] refused — account ${access} user=${sub.user_id}`);
      return res.json({
        valid: false,
        error: access === 'banned'
          ? 'This licence has been revoked. Contact support.'
          : 'Access is suspended. Check your email or sign in to your account page.'
      });
    }

    if (sub.status !== 'active') {
      record('refused');
      return res.json({ valid: false, error: 'Subscription not active' });
    }

    if (sub.plan === 'pro' && sub.expires_at && new Date(sub.expires_at) < new Date()) {
      record('refused');
      return res.json({ valid: false, error: 'Subscription expired' });
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

    console.log(
      `[LICENCE] Key validated for plan=${sub.plan} user=${sub.user_id}` +
      (account ? ` account=${account} (${binding.outcome})` : '')
    );
    res.json({ valid: true, plan: sub.plan, expires_at: sub.expires_at });

  } catch (e) {
    console.error('[LICENCE] Validation error:', e.message);
    res.status(500).json({ valid: false, error: 'Server error' });
  }
}
