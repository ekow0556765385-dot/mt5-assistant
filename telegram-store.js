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

// All active Pro/Lifetime users with a linked chat — used to broadcast
// pattern detection and news alerts to everyone at once.
async function getAllLinkedChatIds() {
  const { data } = await axios.get(
    `${SUPABASE_URL}/rest/v1/subscriptions?telegram_chat_id=not.is.null&status=eq.active&plan=in.(pro,lifetime)&select=telegram_chat_id`,
    { headers: supabaseServiceHeaders() }
  );
  return (data || []).map(r => r.telegram_chat_id);
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
module.exports = { createLinkCode, linkChatIdToCode, getAllLinkedChatIds, getChatIdForUser };
