// ═══════════════════════════════════════════════════════════════
// reminders.js — automatic subscription notices.
//
// Runs once a day and creates in-app notices (and Telegram messages)
// for two things:
//
//   1. RENEWAL DUE — 3 days before expires_at.
//   2. CARD EXPIRING — the saved card expires before the next renewal,
//      so the charge will fail unless they update it.
//
// Wire into app.js:
//     const reminders = require('./reminders');
//     reminders.start({ sendTelegramToUser });
//
// Two things this is careful about:
//
// * IDEMPOTENT. A reminder is recorded in reminder_log with a cycle key
//   (user + kind + the renewal date it refers to). Re-running the job,
//   restarting the server, or deploying three times in an afternoon
//   cannot produce three notices — which matters, because a duplicated
//   "your payment failed" is alarming.
//
// * QUIET ON FAILURE. If Supabase is unreachable the job logs and gives
//   up until tomorrow. A reminder system must never take the app down.
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');
const cron  = require('node-cron');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;

const { sendLicenceReminder, sendSubscriptionReminder } = require('./email-service');

// Per-plan lead time. A monthly subscriber checked their card 27 days ago
// and 3 days is plenty; a yearly subscriber last thought about billing
// twelve months ago, so they get longer to react.
const RENEWAL_DAYS_BY_PLAN = { pro_monthly: 3, pro_yearly: 6 };
const RENEWAL_DAYS_DEFAULT = 3;
const RENEWAL_DAYS = Math.max(...Object.values(RENEWAL_DAYS_BY_PLAN)); // widest window to query
const CARD_DAYS    = 14;   // how far ahead to look for a card expiring

// MT5 licence key milestones (Lifetime plans only), days before expiry.
// 0 = expiry day itself. Each is sent at most once per term via
// reminder_log, so a missed day self-corrects on the next run instead of
// being lost, and a restart cannot re-send one.
const LICENCE_MILESTONES = [30, 14, 7, 1, 0];
const LICENCE_GRACE_DAYS = 14;

function renewalLeadDays(planKey) {
  return RENEWAL_DAYS_BY_PLAN[planKey] || RENEWAL_DAYS_DEFAULT;
}

function headers(extra = {}) {
  return { Authorization: `Bearer ${SUPABASE_SVC}`, apikey: SUPABASE_SVC, ...extra };
}
const dayKey = d => new Date(d).toISOString().slice(0, 10);

// ── message bodies ─────────────────────────────────────────────
// Written to be read in about two seconds, and to say plainly whether
// the reader needs to do anything.
function renewalBody(days, plan) {
  const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  return `Your Blackwood ${plan === 'pro' ? 'Pro' : plan} subscription renews ${when}. ` +
         `No action is needed if your saved payment method is still valid — ` +
         `you can check it under Billing on your account page.`;
}
function cardBody(month, year, renewsInDays) {
  const mm = String(month).padStart(2, '0');
  return `The card saved for your Blackwood subscription expires ${mm}/${String(year).slice(-2)}, ` +
         `before your next renewal ${renewsInDays <= 0 ? 'is due' : `in ${renewsInDays} days`}. ` +
         `The payment will fail unless you update it under Billing on your account page. ` +
         `Your access continues until then.`;
}

// ── has this exact reminder already gone out? ──────────────────
async function alreadySent(userId, kind, cycle) {
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/reminder_log` +
      `?user_id=eq.${userId}&kind=eq.${kind}&cycle=eq.${cycle}&select=id&limit=1`,
      { headers: headers(), timeout: 8000 }
    );
    return Array.isArray(data) && data.length > 0;
  } catch (e) {
    // If we cannot tell, do NOT send. A missed reminder is a small
    // problem; a duplicated payment warning is not.
    console.warn('[REMINDERS] could not check reminder_log, skipping:', e.response?.data?.message || e.message);
    return true;
  }
}

async function record(userId, kind, cycle) {
  await axios.post(`${SUPABASE_URL}/rest/v1/reminder_log`,
    { user_id: userId, kind, cycle },
    { headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), timeout: 8000 });
}

// ── who do we email? ───────────────────────────────────────────
// subscriptions holds only user_id, so the address comes from the auth
// admin API. Returns null on any failure — a reminder without a
// recipient is skipped, never guessed.
async function getUserEmail(userId) {
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/auth/v1/admin/users/${userId}`,
      { headers: headers(), timeout: 8000 }
    );
    return {
      email: data && data.email ? data.email : null,
      name: (data && data.user_metadata &&
             (data.user_metadata.full_name || data.user_metadata.first_name)) || ''
    };
  } catch (e) {
    console.warn(`[REMINDERS] could not look up email for user=${userId}:`, e.response?.data?.message || e.message);
    return { email: null, name: '' };
  }
}

// ── create the in-app notice ───────────────────────────────────
async function notify(userId, severity, body, expiresAt) {
  await axios.post(`${SUPABASE_URL}/rest/v1/messages`, {
    audience: 'user', audience_key: userId, severity, body,
    dismissible: true, expires_at: expiresAt, created_by: 'system'
  }, { headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), timeout: 8000 });
  if (typeof globalThis.bwNoticeCacheBust === 'function') globalThis.bwNoticeCacheBust();
}

// ── the daily sweep ────────────────────────────────────────────
async function sweep(deps = {}) {
  const { sendTelegramToUser } = deps;
  if (!SUPABASE_URL || !SUPABASE_SVC) {
    console.warn('[REMINDERS] Supabase is not configured — skipping');
    return { renewal: 0, card: 0 };
  }

  const now = Date.now();
  const horizon = new Date(now + Math.max(RENEWAL_DAYS, CARD_DAYS) * 86400000).toISOString();
  let rows;
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions` +
      `?select=user_id,plan,plan_key,status,access_status,expires_at,card_exp_month,card_exp_year,card_last4` +
      `&expires_at=not.is.null&expires_at=lte.${horizon}` +
      `&status=eq.active`,
      { headers: headers(), timeout: 12000 }
    );
    rows = data || [];
  } catch (e) {
    console.warn('[REMINDERS] could not read subscriptions:', e.response?.data?.message || e.message);
    return { renewal: 0, card: 0 };
  }

  let renewal = 0, card = 0;

  for (const s of rows) {
    // Lifetime plans never renew; suspended and banned accounts have a
    // bigger problem than a renewal date and should not be nagged.
    if (!s.expires_at || s.plan === 'lifetime') continue;
    if (s.access_status && s.access_status !== 'active') continue;

    const days = Math.ceil((Date.parse(s.expires_at) - now) / 86400000);
    const cycle = dayKey(s.expires_at);   // ties the reminder to THIS renewal

    // 1. renewal due — lead time depends on the plan: 3 days for
    // pro_monthly, 6 for pro_yearly. Legacy rows with no plan_key fall
    // back to 3, which is the old behaviour.
    const lead = renewalLeadDays(s.plan_key);
    if (days >= 0 && days <= lead) {
      if (!await alreadySent(s.user_id, 'renewal', cycle)) {
        try {
          await notify(s.user_id, 'warning', renewalBody(days, s.plan),
                       new Date(Date.parse(s.expires_at) + 86400000).toISOString());
          await record(s.user_id, 'renewal', cycle);
          if (sendTelegramToUser) {
            sendTelegramToUser(s.user_id, '⏳ ' + renewalBody(days, s.plan)).catch(() => {});
          }
          // Email last, and never awaited into the failure path above:
          // the notice is already recorded, so a Resend outage must not
          // cause the whole reminder to be retried and duplicated.
          getUserEmail(s.user_id).then(u => {
            if (u.email) sendSubscriptionReminder(u.email, u.name, s.plan_key, days, s.expires_at).catch(() => {});
          });
          renewal++;
          console.log(`[REMINDERS] renewal notice — user=${s.user_id} in ${days}d`);
        } catch (e) {
          console.warn('[REMINDERS] renewal notice failed:', e.response?.data?.message || e.message);
        }
      }
    }

    // 2. saved card expires before the renewal.
    // Cards die at the END of their stated month.
    if (s.card_exp_month && s.card_exp_year && days >= 0 && days <= CARD_DAYS) {
      const cardDead = new Date(Number(s.card_exp_year), Number(s.card_exp_month), 1).getTime();
      if (cardDead <= Date.parse(s.expires_at)) {
        if (!await alreadySent(s.user_id, 'card', cycle)) {
          try {
            await notify(s.user_id, 'warning', cardBody(s.card_exp_month, s.card_exp_year, days),
                         new Date(Date.parse(s.expires_at) + 86400000).toISOString());
            await record(s.user_id, 'card', cycle);
            if (sendTelegramToUser) {
              sendTelegramToUser(s.user_id, '💳 ' + cardBody(s.card_exp_month, s.card_exp_year, days)).catch(() => {});
            }
            card++;
            console.log(`[REMINDERS] card notice — user=${s.user_id} card ${s.card_exp_month}/${s.card_exp_year}`);
          } catch (e) {
            console.warn('[REMINDERS] card notice failed:', e.response?.data?.message || e.message);
          }
        }
      }
    }
  }

  if (renewal || card) console.log(`[REMINDERS] sent ${renewal} renewal, ${card} card`);
  return { renewal, card };
}

// ── MT5 LICENCE TERM SWEEP (Lifetime plans only) ───────────────
// Separate from sweep() above because the two look at different columns
// and mean different things. expires_at is PLATFORM access and never
// applies to Lifetime; licence_expires_at is the MT5 key term and only
// ever applies to Lifetime. Merging them would invite exactly the
// confusion the whole feature exists to avoid.
//
// Nothing here can affect access. This sweep only sends messages.
function licenceBody(state, daysLeft, dateStr) {
  if (state === 'lapsed') {
    return `Your MT5 licence key expired on ${dateStr} and the grace period has ended, so the Blackwood ` +
           `EA and indicators have stopped running in MetaTrader. Your platform access and dashboards are ` +
           `unaffected. Renew for $100/year on your account page — your existing key is restored.`;
  }
  if (state === 'grace') {
    return `Your MT5 licence key expired on ${dateStr}. ${daysLeft} day${daysLeft === 1 ? '' : 's'} of the ` +
           `14-day grace period remain, after which the EA and indicators will stop running in MetaTrader. ` +
           `Your platform access and dashboards are not affected either way.`;
  }
  const when = daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
  return `Your MT5 licence key expires ${when} (${dateStr}). Renew for $100/year to keep the EA and ` +
         `indicators running in MetaTrader. Your Lifetime platform access does not expire and is not affected.`;
}

async function sweepLicences(deps = {}) {
  const { sendTelegramToUser } = deps;
  if (!SUPABASE_URL || !SUPABASE_SVC) return { licence: 0 };

  let rows;
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions` +
      `?select=user_id,plan,status,access_status,licence_expires_at` +
      `&plan=eq.lifetime&status=eq.active&licence_expires_at=not.is.null`,
      { headers: headers(), timeout: 12000 }
    );
    rows = data || [];
  } catch (e) {
    console.warn('[REMINDERS] could not read licence terms:', e.response?.data?.message || e.message);
    return { licence: 0 };
  }

  const now = Date.now();
  let licence = 0;

  for (const s of rows) {
    if (s.access_status && s.access_status !== 'active') continue;

    const expiry = Date.parse(s.licence_expires_at);
    if (isNaN(expiry)) continue;

    const days  = Math.ceil((expiry - now) / 86400000);
    const cycle = dayKey(s.licence_expires_at);   // ties reminders to THIS term
    const dateStr = new Date(expiry).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });

    let kind = null, state = 'due', shownDays = days;

    if (days >= 0) {
      // Today's milestone is the SMALLEST one at or above the current day
      // count — and only that one is ever considered. Picking "the
      // smallest UNSENT one" instead looks equivalent but is not: an
      // account first seen at 12 days would send the 14-day notice, then
      // still see 30 as unsent the next day and send that too. One
      // milestone per day, decided by the calendar, not by the log.
      const due = [...LICENCE_MILESTONES].sort((a, b) => a - b).find(m => days <= m);
      if (due !== undefined && !await alreadySent(s.user_id, `licence_${due}`, cycle)) {
        kind = `licence_${due}`;
      }
    } else if (-days <= LICENCE_GRACE_DAYS) {
      state = 'grace';
      shownDays = LICENCE_GRACE_DAYS + days;   // grace days remaining
      if (!await alreadySent(s.user_id, 'licence_grace', cycle)) kind = 'licence_grace';
    } else {
      state = 'lapsed';
      shownDays = 0;
      if (!await alreadySent(s.user_id, 'licence_lapsed', cycle)) kind = 'licence_lapsed';
    }

    if (!kind) continue;

    const body = licenceBody(state, shownDays, dateStr);
    try {
      // Amber, not red, until the key has actually lapsed — the same
      // reasoning as the account page: this never threatens platform access.
      await notify(s.user_id, state === 'lapsed' ? 'warning' : 'info', body,
                   new Date(expiry + (LICENCE_GRACE_DAYS + 30) * 86400000).toISOString());
      await record(s.user_id, kind, cycle);
      if (sendTelegramToUser) {
        sendTelegramToUser(s.user_id, '🔑 ' + body).catch(() => {});
      }
      getUserEmail(s.user_id).then(u => {
        if (u.email) {
          sendLicenceReminder(u.email, u.name, {
            daysLeft: shownDays, state, expiresAt: s.licence_expires_at
          }).catch(() => {});
        }
      });
      licence++;
      console.log(`[REMINDERS] licence notice — user=${s.user_id} ${kind} (${days}d)`);
    } catch (e) {
      console.warn('[REMINDERS] licence notice failed:', e.response?.data?.message || e.message);
    }
  }

  if (licence) console.log(`[REMINDERS] sent ${licence} licence notice(s)`);
  return { licence };
}

// 09:00 UTC — late morning in Ghana, so a notice is seen the same day
// rather than sitting unread overnight.
function start(deps = {}) {
  cron.schedule('0 9 * * *', () => {
    sweep(deps).catch(e => console.warn('[REMINDERS] sweep failed:', e.message));
    sweepLicences(deps).catch(e => console.warn('[REMINDERS] licence sweep failed:', e.message));
  });
  console.log('[REMINDERS] daily sweep scheduled for 09:00 UTC');
}

module.exports = { start, sweep, sweepLicences, renewalBody, cardBody, licenceBody,
                   renewalLeadDays, RENEWAL_DAYS, RENEWAL_DAYS_BY_PLAN, CARD_DAYS,
                   LICENCE_MILESTONES, LICENCE_GRACE_DAYS };
