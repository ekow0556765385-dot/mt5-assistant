// telegram-store.js
// Lets each subscriber link their own Telegram chat to their account,
// so pattern/news/journal alerts can be sent to them individually
// instead of only to the owner's hardcoded chat_id.
//
// ── Add these columns once in Supabase SQL editor ──────────────────
// alter table subscriptions add column if not exists telegram_chat_id text;
// alter table subscriptions add column if not exists telegram_link_code text;
// alter table subscriptions add column if not exists telegram_link_expires timestamptz;

const axios = require('axios');
const { SUPABASE_URL, supabaseServiceHeaders } = require('./auth-middleware');

const LINK_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the /start

function generateCode() {
  return require('crypto').randomBytes(8).toString('hex'); // short enough for a Telegram deep link
}

// Called when the user clicks "Connect Telegram" in the dashboard.
async function createLinkCode(userId) {
  const code = generateCode();
  const expires = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();

  await axios.patch(
    `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}`,
    { telegram_link_code: code, telegram_link_expires: expires },
    { headers: supabaseServiceHeaders({ 'Content-Type': 'application/json' }) }
  );

  return code;
}

// Called from the Telegram bot's /start <code> handler.
// Matches the code to a user, saves their chat_id, clears the code.
async function linkChatIdToCode(code, chatId) {
  const { data } = await axios.get(
    `${SUPABASE_URL}/rest/v1/subscriptions?telegram_link_code=eq.${code}&select=user_id,telegram_link_expires`,
    { headers: supabaseServiceHeaders() }
  );

  if (!data || data.length === 0) return null; // unknown or already-used code
  const sub = data[0];
  if (sub.telegram_link_expires && new Date(sub.telegram_link_expires) < new Date()) return null; // expired

  await axios.patch(
    `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${sub.user_id}`,
    { telegram_chat_id: String(chatId), telegram_link_code: null, telegram_link_expires: null },
    { headers: supabaseServiceHeaders({ 'Content-Type': 'application/json' }) }
  );

  return sub.user_id;
}

// ── Pair entitlement ───────────────────────────────────────────────
// Free plans get 3 pairs, paid plans get all 6. This MUST agree with
// pairLimitFor() in app.js — it is the same rule, applied at send time
// rather than at read time.
// MUST match the EA's WatchPairs default (Mt5_tradingassistant v4.x,
// input string WatchPairs = "EURUSD,GBPUSD,USDJPY,XAUUSD,USDCHF,GBPJPY").
// This list previously carried AUDUSD and USDCAD, which the EA never
// sends, and omitted USDCHF and GBPJPY, which it does. So users could
// select two pairs that could never produce an alert — a free user
// picking both plus one real pair got a third of the alerts they were
// promised — while two genuinely covered pairs were invisible to
// everyone. If the EA's watchlist changes, change it here too.
const BW_ALL_PAIRS  = ['EURUSD','GBPUSD','USDJPY','XAUUSD','USDCHF','GBPJPY'];
const BW_FREE_LIMIT = 3;

// Is this subscription entitled to alerts right now? Mirrors
// accessState() in auth-middleware.js: an expired Pro row keeps
// status='active' and plan='pro', so filtering on those two alone lets a
// lapsed subscriber keep receiving alerts indefinitely. Grace counts as
// entitled, because during grace their access genuinely is still live.
const GRACE_DAYS = 3;
function alertsEntitled(row) {
  if (row.access_status && row.access_status !== 'active') return false;
  if (row.status !== 'active') return false;
  if (row.plan === 'lifetime') return true;          // no expiry
  if (row.plan !== 'pro' && row.plan !== 'free') return false;
  if (row.plan === 'free') return true;              // free tier has its own cap
  if (!row.expires_at) return true;
  const expires = Date.parse(row.expires_at);
  if (isNaN(expires)) return true;                   // unreadable date must not cut anyone off
  if (Date.now() <= expires) return true;
  const graceEnd = row.grace_until ? Date.parse(row.grace_until)
                                   : expires + GRACE_DAYS * 86400000;
  return Date.now() < graceEnd;
}

// Which pairs may this user receive alerts for?
//
// smc-route.js has imported this since it was written, but it was never
// exported — so `getWatchPairsForUser` was undefined, the call threw a
// TypeError, and the surrounding catch reported it as a generic
// "Per-user send failed". The result was that NO per-user confluence
// alert was ever delivered; only the owner's broadcast went out, which
// made the feature look like it was working.
//
// Returns null when the user should receive everything (no restriction),
// and an array when they are capped. smc-route treats null as "no filter".
async function getWatchPairsForUser(userId) {
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}` +
      `&select=plan,status,expires_at,grace_until,access_status,watch_pairs`,
      { headers: supabaseServiceHeaders() }
    );
    const row = data && data[0];
    if (!row) return [];                     // unknown account gets nothing
    if (!alertsEntitled(row)) return [];     // lapsed / suspended gets nothing

    const plan  = (row.plan || 'free').toLowerCase();
    const limit = (plan === 'pro' || plan === 'lifetime') ? BW_ALL_PAIRS.length : BW_FREE_LIMIT;

    // Same filter as GET /api/watch-pairs: drop anything no longer in the
    // live list, so a row still holding a retired pair cannot silently
    // shrink what its owner receives.
    const stored = Array.isArray(row.watch_pairs)
      ? row.watch_pairs.filter(p => BW_ALL_PAIRS.includes(p))
      : [];

    // Paid plans with no usable selection receive everything.
    if (!stored.length) {
      return limit >= BW_ALL_PAIRS.length ? null : BW_ALL_PAIRS.slice(0, limit);
    }
    return stored.slice(0, limit);
  } catch (e) {
    // A lookup failure must not silently mute someone's alerts, but it
    // must not hand a free account the full set either. Null = no filter
    // is the safer of the two only for the already-entitled, so fall back
    // to no filter and let the plan check upstream do its job.
    console.warn('[TELEGRAM-STORE] getWatchPairsForUser failed:', e.response?.data?.message || e.message);
    return null;
  }
}

// All entitled users with a linked chat — used to broadcast pattern
// detection and news alerts to everyone at once.
//
// The plan filter alone was not enough: an expired Pro subscription keeps
// plan='pro' and status='active' (nothing rewrites those at expiry), so
// lapsed users carried on receiving paid alerts. Expiry and grace are now
// evaluated in JS, because the rule has to match accessState() exactly and
// duplicating it as a PostgREST filter string would drift the first time
// either changed.
async function getAllLinkedChatIds() {
  const { data } = await axios.get(
    `${SUPABASE_URL}/rest/v1/subscriptions?telegram_chat_id=not.is.null&status=eq.active&plan=in.(pro,lifetime)` +
    `&select=telegram_chat_id,plan,status,expires_at,grace_until,access_status`,
    { headers: supabaseServiceHeaders() }
  );
  return (data || []).filter(alertsEntitled).map(r => r.telegram_chat_id);
}

// One specific user's chat_id — used for their own journal/trade-close alerts.
async function getChatIdForUser(userId) {
  const { data } = await axios.get(
    `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=telegram_chat_id`,
    { headers: supabaseServiceHeaders() }
  );
  return data && data[0] ? data[0].telegram_chat_id : null;
}

// Same lookup, but by licence key — the journal route only has a licence
// key at insert time, not a user_id directly (it resolves that via
// journal-store.js's getUserIdForLicenceKey first, so pass the user_id in).
module.exports = { createLinkCode, linkChatIdToCode, getAllLinkedChatIds, getChatIdForUser,
                   getWatchPairsForUser, alertsEntitled, BW_ALL_PAIRS, BW_FREE_LIMIT };
