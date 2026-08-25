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

const RENEWAL_DAYS = 3;    // days before expiry to warn
const CARD_DAYS    = 14;   // how far ahead to look for a card expiring

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
      `?select=user_id,plan,status,access_status,expires_at,card_exp_month,card_exp_year,card_last4` +
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

    // 1. renewal due
    if (days >= 0 && days <= RENEWAL_DAYS) {
      if (!await alreadySent(s.user_id, 'renewal', cycle)) {
        try {
          await notify(s.user_id, 'warning', renewalBody(days, s.plan),
                       new Date(Date.parse(s.expires_at) + 86400000).toISOString());
          await record(s.user_id, 'renewal', cycle);
          if (sendTelegramToUser) {
            sendTelegramToUser(s.user_id, '⏳ ' + renewalBody(days, s.plan)).catch(() => {});
          }
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

// 09:00 UTC — late morning in Ghana, so a notice is seen the same day
// rather than sitting unread overnight.
function start(deps = {}) {
  cron.schedule('0 9 * * *', () => sweep(deps).catch(e => console.warn('[REMINDERS] sweep failed:', e.message)));
  console.log('[REMINDERS] daily sweep scheduled for 09:00 UTC');
}

module.exports = { start, sweep, renewalBody, cardBody, RENEWAL_DAYS, CARD_DAYS };
