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

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || 'sk_test_1a428985d54ea54ffbe742651b4154e2dd791ce3';
const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://nzazhjnbjolkvjpunqna.supabase.co';
const SUPABASE_ANON   = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56YXpoam5iam9sa3ZqcHVucW5hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3MDE1NDcsImV4cCI6MjA5ODI3NzU0N30.Wb7UnsRUpjlfOM14A1ZVSoT85z2usFquuKubIr_pJ1M';
const SUPABASE_SVC    = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56YXpoam5iam9sa3ZqcHVucW5hIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjcwMTU0NywiZXhwIjoyMDk4Mjc3NTQ3fQ.6iQqLhTyd8YjMrWmLTQIs8Ivv3ggXh2Fy_2fwQcU8FM';
const RAILWAY_URL     = (process.env.RAILWAY_URL || 'https://nurturing-magic-production-3169.up.railway.app').trim();
const SITE_URL        = (process.env.SITE_URL || 'https://blackwoodmt5.com').trim();

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
    amount_usd: 29900,  // $299.00 in cents
    amount_ghs: 435000, // GHS 4,350 in pesewas
    plan:       'lifetime',
    duration:   null,   // never expires
  }
};

// ── Generate licence key ──────────────────────────────────────
function generateLicenceKey() {
  return 'BW-' + crypto.randomBytes(12).toString('hex').toUpperCase();
}

// ── Update Supabase subscription ──────────────────────────────
async function updateSubscription(userId, planKey, paystackRef) {
  const planConfig = PLANS[planKey];
  if (!planConfig) throw new Error('Unknown plan: ' + planKey);

  if (!SUPABASE_SVC) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set on the server');
  }

  const licenceKey = generateLicenceKey();
  const expiresAt  = planConfig.duration
    ? new Date(Date.now() + planConfig.duration * 86400000).toISOString()
    : null;

  const payload = {
    plan:         planConfig.plan,
    plan_key:     planKey,
    status:       'active',
    paystack_ref: paystackRef,
    licence_key:  licenceKey,
    expires_at:   expiresAt,
    updated_at:   new Date().toISOString()
  };

  const headers = {
    Authorization:  `Bearer ${SUPABASE_SVC}`,
    apikey:         SUPABASE_SVC,
    'Content-Type': 'application/json',
    Prefer:         'return=representation'
  };

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
  const { planKey, currency } = req.body;
  const email  = req.user.email;
  const userId = req.user.id;

  if (!planKey) {
    return res.status(400).json({ error: 'planKey is required' });
  }

  const plan = PLANS[planKey];
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });

  const cur    = (currency || 'USD').toUpperCase();
  const amount = cur === 'GHS' ? plan.amount_ghs : plan.amount_usd;

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
    if (tx.status !== 'success') {
      console.warn('[PAYSTACK] Callback — payment not successful:', tx.status);
      return res.redirect(SITE_URL + '/?payment=failed');
    }

    const userId  = tx.metadata?.user_id;
    const planKey = tx.metadata?.plan_key;

    if (!userId || !planKey) {
      console.error('[PAYSTACK] Callback — missing metadata');
      return res.redirect(SITE_URL + '/?payment=failed');
    }

    const result = await updateSubscription(userId, planKey, reference);
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

    try {
      const result = await updateSubscription(userId, planKey, tx.reference);
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
    lifetime:    { name: PLANS.lifetime.name,    usd: 299, ghs: 4350,  duration: 'forever' }
  });
});

module.exports = router;
