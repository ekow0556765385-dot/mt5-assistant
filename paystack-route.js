// ═══════════════════════════════════════════════════════════════
// paystack-route.js — Paystack payment + webhook handler
// Place in same folder as app.js
// Add to app.js: const paystackRoute = require('./paystack-route');
//                app.use(paystackRoute);
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const crypto  = require('crypto');
const { sendWelcomeEmail } = require('./email-service');
const { requireAuth } = require('./auth-middleware');

// ── Configuration ─────────────────────────────────────────────
// No fallback values. A missing credential must stop the server, not
// silently run on a key committed to source control — that is how a
// secret ends up in a public repo and stays there.
//
// Required Railway variables:
//   PAYSTACK_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const SUPABASE_URL    = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SVC    = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RAILWAY_URL     = (process.env.RAILWAY_URL || 'https://app.blackwoodmt5.com').trim();
const SITE_URL        = (process.env.SITE_URL || 'https://blackwoodmt5.com').trim();

const REQUIRED = { PAYSTACK_SECRET_KEY: PAYSTACK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SUPABASE_SVC };
const MISSING = Object.entries(REQUIRED).filter(([, v]) => !v).map(([k]) => k);
if (MISSING.length) {
  console.error(
    '[PAYSTACK] FATAL — missing environment variables: ' + MISSING.join(', ') + '\n' +
    '  Set them in Railway -> Variables, then redeploy.\n' +
    '  Payments and licence key issuing cannot work without them.'
  );
  throw new Error('paystack-route: missing required environment variables: ' + MISSING.join(', '));
}

// Bump this string whenever Terms of Use / Privacy Policy / Software Licence /
// Risk Disclaimer content materially changes, so historical agreements stay
// tied to the version the user actually saw.
const LEGAL_VERSION = '2026-08-02';

// ── Plan config ───────────────────────────────────────────────
// Amounts in smallest currency unit (kobo for NGN, pesewas for GHS, cents for USD)
const PLANS = {
  pro_monthly: {
    name:       'Blackwood Pro — Monthly',
    amount_usd: 2900,   // $29.00 in cents
    amount_ghs: 42000,  // GHS 420 in pesewas
    plan:       'pro',
    duration:   30,     // days
  },
  pro_yearly: {
    name:       'Blackwood Pro — Yearly',
    amount_usd: 19900,  // $199.00 in cents
    amount_ghs: 290000, // GHS 2,900 in pesewas
    plan:       'pro',
    duration:   365,
  },
  lifetime: {
    name:       'Blackwood Lifetime Access',
    amount_usd: 240000, // $2,400.00 in cents
    amount_ghs: 3491600, // GHS 34,916 in pesewas (same USD/GHS rate as before)
    plan:       'lifetime',
    duration:   null,   // never expires
  }
};

// ── Generate licence key ──────────────────────────────────────
function generateLicenceKey() {
  return 'BW-' + crypto.randomBytes(12).toString('hex').toUpperCase();
}

// ── Update Supabase subscription ──────────────────────────────
async function updateSubscription(userId, planKey, paystackRef, legalMeta, card) {
  const planConfig = PLANS[planKey];
  if (!planConfig) throw new Error('Unknown plan: ' + planKey);

  if (!SUPABASE_SVC) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set on the server');
  }

  const headers = {
    Authorization:  `Bearer ${SUPABASE_SVC}`,
    apikey:         SUPABASE_SVC,
    'Content-Type': 'application/json',
    Prefer:         'return=representation'
  };

  // Idempotency guard — the callback redirect and the webhook can both
  // fire for the same transaction. If this exact paystack_ref was already
  // recorded (whichever path won the race got there first), don't
  // generate a second licence key and overwrite it — just return what's
  // already on file so both paths agree on the same key.
  try {
    const existing = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=plan,licence_key,expires_at,paystack_ref`,
      { headers: { Authorization: `Bearer ${SUPABASE_SVC}`, apikey: SUPABASE_SVC } }
    );
    const row = existing.data && existing.data[0];
    if (row && row.paystack_ref === paystackRef && row.licence_key) {
      console.log(`[PAYSTACK] updateSubscription — ref=${paystackRef} already processed, reusing key`);
      return { licenceKey: row.licence_key, expiresAt: row.expires_at, plan: row.plan };
    }
  } catch (e) {
    console.warn('[PAYSTACK] Idempotency check failed, proceeding anyway:', e.response?.data || e.message);
  }

  const licenceKey = generateLicenceKey();
  const expiresAt  = planConfig.duration
    ? new Date(Date.now() + planConfig.duration * 86400000).toISOString()
    : null;

  const payload = {
    plan:             planConfig.plan,
    plan_key:         planKey,
    status:           'active',
    paystack_ref:     paystackRef,
    licence_key:      licenceKey,
    expires_at:       expiresAt,
    credit_balance:   8.00,
    credit_reset_at:  new Date(Date.now() + 30 * 86400000).toISOString(),
    updated_at:       new Date().toISOString()
  };

  // Card expiry, so we can warn before a renewal fails. Paystack sends
  // this on the authorization object and we previously discarded it.
  // Only the last four digits and the expiry month/year are kept — never
  // a full number, which we neither receive nor want.
  if (card && card.exp_month && card.exp_year) {
    payload.card_exp_month = Number(card.exp_month);
    payload.card_exp_year  = Number(card.exp_year);
    payload.card_last4     = card.last4 || null;
    payload.card_brand     = card.brand || card.card_type || null;
  }

  if (legalMeta && legalMeta.agreedAt) {
    payload.legal_agreed_at = legalMeta.agreedAt;
    payload.legal_version   = legalMeta.version || LEGAL_VERSION;
  }

  try {
    // Try PATCH first (row should already exist from the signup trigger)
    const patchRes = await axios.patch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}`,
      payload,
      { headers }
    );

    // If PATCH affected 0 rows (no existing subscription row), create one with POST
    if (!patchRes.data || patchRes.data.length === 0) {
      console.log(`[PAYSTACK] No existing row for user=${userId} — inserting new subscription`);
      await axios.post(
        `${SUPABASE_URL}/rest/v1/subscriptions`,
        { user_id: userId, ...payload },
        { headers }
      );
    }

  } catch (err) {
    console.error('[PAYSTACK] Supabase update failed:', err.response?.data || err.message);
    throw new Error('Supabase update failed: ' + (err.response?.data?.message || err.message));
  }

  console.log(`[PAYSTACK] Subscription updated — user=${userId} plan=${planConfig.plan} key=${licenceKey}`);
  return { licenceKey, expiresAt, plan: planConfig.plan };
}

// ── GET /api/pay/initiate ─────────────────────────────────────
// Called from website when user clicks a pricing button
router.post('/api/pay/initiate', requireAuth, async (req, res) => {
  const { planKey, currency, agreedToLegal } = req.body;
  const email  = req.user.email;
  const userId = req.user.id;

  if (!planKey) {
    return res.status(400).json({ error: 'planKey is required' });
  }

  // Server-side enforcement — don't just trust the frontend checkbox.
  // No agreement, no checkout session.
  if (agreedToLegal !== true) {
    return res.status(400).json({ error: 'You must agree to the Terms of Use, Privacy Policy, Software Licence, and Risk Disclaimer before continuing.' });
  }

  const plan = PLANS[planKey];
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });

  const cur    = (currency || 'USD').toUpperCase();
  const amount = cur === 'GHS' ? plan.amount_ghs : plan.amount_usd;
  const legalAgreedAt = new Date().toISOString();

  try {
    const { data } = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount,
        currency: cur,
        metadata: {
          user_id:  userId,
          plan_key: planKey,
          legal_agreed_at: legalAgreedAt,
          legal_version:   LEGAL_VERSION,
          custom_fields: [
            { display_name: 'Plan',    variable_name: 'plan',    value: plan.name },
            { display_name: 'User ID', variable_name: 'user_id', value: userId }
          ]
        },
        callback_url: RAILWAY_URL + '/api/pay/callback'
      },
      {
        headers: {
          Authorization:  `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`[PAYSTACK] Initiated — plan=${planKey} email=${email} ref=${data.data.reference}`);
    res.json({ ok: true, url: data.data.authorization_url, reference: data.data.reference });

  } catch (e) {
    console.error('[PAYSTACK] Initiate error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── GET /api/pay/callback ─────────────────────────────────────
// Paystack redirects here after payment
router.get('/api/pay/callback', async (req, res) => {
  const { reference } = req.query;
  if (!reference) return res.redirect(SITE_URL + '/?payment=failed');

  try {
    // Verify payment with Paystack
    const { data } = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );

    const tx = data.data;

    // Card payments usually confirm instantly. Mobile money and bank
    // transfer (common in Ghana) often redirect the browser back
    // before Paystack has finished confirming the charge — status
    // can still be 'pending'/'ongoing' here even though it succeeds
    // moments later via the webhook. Only treat genuine terminal
    // failures as failed; anything still in flight gets a "processing"
    // redirect instead of a false failure.
    const TERMINAL_FAILURE = ['failed', 'abandoned', 'reversed'];

    if (tx.status !== 'success') {
      if (TERMINAL_FAILURE.includes(tx.status)) {
        console.warn('[PAYSTACK] Callback — payment failed:', tx.status);
        return res.redirect(SITE_URL + '/?payment=failed');
      }
      console.log('[PAYSTACK] Callback — payment still confirming:', tx.status);
      return res.redirect(SITE_URL + '/?payment=processing&reference=' + reference);
    }

    const userId  = tx.metadata?.user_id;
    const planKey = tx.metadata?.plan_key;

    if (!userId || !planKey) {
      console.error('[PAYSTACK] Callback — missing metadata');
      return res.redirect(SITE_URL + '/?payment=failed');
    }

    const legalMeta = {
      agreedAt: tx.metadata?.legal_agreed_at || null,
      version:  tx.metadata?.legal_version || null
    };

    const result = await updateSubscription(userId, planKey, reference, legalMeta, tx.authorization);
    console.log(`[PAYSTACK] Callback success — ${planKey} for ${userId}`);

    // Redirect to dashboard with success message
    res.redirect(`${SITE_URL}/?payment=success&plan=${result.plan}&key=${result.licenceKey}`);

  } catch (e) {
    console.error('[PAYSTACK] Callback error:', e.message);
    res.redirect(SITE_URL + '/?payment=failed');
  }
});

// ── POST /api/pay/webhook ─────────────────────────────────────
// Paystack fires this server-to-server on every event
// Set this URL in Paystack dashboard: Settings → Webhooks
// Uses req.rawBody (captured in app.js's express.json verify hook)
// for accurate signature verification against the exact bytes sent.
router.post('/api/pay/webhook', async (req, res) => {
  if (!req.rawBody) {
    console.error('[PAYSTACK] Webhook — req.rawBody missing. Check express.json verify hook in app.js');
    return res.status(500).json({ error: 'Server misconfiguration: raw body not captured' });
  }

  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET)
    .update(req.rawBody)
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    console.warn('[PAYSTACK] Webhook — invalid signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = req.body;
  console.log('[PAYSTACK] Webhook event:', event.event);

  if (event.event === 'charge.success') {
    const tx      = event.data;
    const userId  = tx.metadata?.user_id;
    const planKey = tx.metadata?.plan_key;

    if (!userId || !planKey) {
      console.warn('[PAYSTACK] Webhook — missing metadata in charge.success');
      return res.sendStatus(200);
    }

    const legalMeta = {
      agreedAt: tx.metadata?.legal_agreed_at || null,
      version:  tx.metadata?.legal_version || null
    };

    try {
      const result = await updateSubscription(userId, planKey, tx.reference, legalMeta, tx.authorization);
      console.log(`[PAYSTACK] Webhook — subscription activated: ${planKey} for ${userId} key=${result.licenceKey}`);

      // Send welcome email with licence key
      const custEmail = tx.customer?.email || tx.email;
      const custName  = tx.metadata?.custom_fields?.find(f => f.variable_name === 'name')?.value
                       || tx.customer?.first_name
                       || '';
      sendWelcomeEmail(custEmail, custName, result.plan, result.licenceKey, result.expiresAt)
        .then(r => {
          if (r.ok) console.log(`[PAYSTACK] Welcome email sent to ${custEmail}`);
          else       console.warn(`[PAYSTACK] Welcome email failed for ${custEmail}: ${r.error}`);
        });

    } catch (e) {
      console.error('[PAYSTACK] Webhook — update error:', e.message);
    }
  }

  // Always return 200 so Paystack doesn't retry
  res.sendStatus(200);
});

// ── GET /api/pay/plans ────────────────────────────────────────
// Returns plan info for the frontend
router.get('/api/pay/plans', (req, res) => {
  res.json({
    pro_monthly: { name: PLANS.pro_monthly.name, usd: 29, ghs: 420,   duration: '1 month' },
    pro_yearly:  { name: PLANS.pro_yearly.name,  usd: 199, ghs: 2900,  duration: '1 year'  },
    lifetime:    { name: PLANS.lifetime.name,    usd: 2400, ghs: 34916,  duration: 'forever' }
  });
});

module.exports = router;
