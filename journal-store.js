// journal-store.js
// Reads/writes trade journal entries in Supabase via the REST API —
// same pattern as auth-middleware.js (axios + SUPABASE_SERVICE_ROLE_KEY),
// no extra @supabase/supabase-js dependency needed.
//
// ── Supabase table (run once in the Supabase SQL editor) ──────────
// create table trade_journal (
//   id           bigint generated always as identity primary key,
//   user_id      uuid references auth.users(id),
//   ticket       bigint not null,
//   symbol       text,
//   direction    text,
//   volume       numeric,
//   open_price   numeric,
//   close_price  numeric,
//   open_time    timestamptz,
//   close_time   timestamptz,
//   profit       numeric,
//   swap         numeric,
//   commission   numeric,
//   total_pl     numeric,
//   pips         numeric,
//   sl           numeric,
//   tp           numeric,
//   session      text,
//   comment      text,
//   magic        bigint,
//   created_at   timestamptz default now(),
//   unique(user_id, ticket)          -- prevents duplicate rows if EA retries
// );
// create index on trade_journal (user_id, close_time desc);

const axios = require('axios');
// Reuse the same resolved values (and format-aware header helper)
// auth-middleware.js already uses successfully elsewhere, instead of
// duplicating Supabase key logic here.
const { SUPABASE_URL, SUPABASE_SERVICE, supabaseServiceHeaders } = require('./auth-middleware');

function restHeaders(extra = {}) {
  return supabaseServiceHeaders(extra);
}

// Look up which (active) user a licence key belongs to.
// Mirrors the same status/expiry logic as validateKey() in auth-middleware.js.
async function getUserIdForLicenceKey(licenceKey) {
  if (!licenceKey) return null;
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?licence_key=eq.${licenceKey}&select=user_id,status,plan,expires_at`,
      { headers: restHeaders() }
    );
    if (!data || data.length === 0) return null;
    const sub = data[0];
    if (sub.status !== 'active') return null;
    if (sub.plan === 'pro' && sub.expires_at && new Date(sub.expires_at) < new Date()) return null;
    return sub.user_id;
  } catch (e) {
    console.error('[JOURNAL] getUserIdForLicenceKey failed:', e.response?.data || e.message);
    return null;
  }
}

async function insertTrade(trade, userId) {
  const row = {
    user_id: userId,
    ticket: trade.ticket,
    symbol: trade.symbol,
    direction: trade.direction,
    volume: trade.volume,
    open_price: trade.openPrice,
    close_price: trade.closePrice,
    open_time: trade.openTime,
    close_time: trade.closeTime,
    profit: trade.profit,
    swap: trade.swap,
    commission: trade.commission,
    total_pl: trade.totalPL,
    pips: trade.pips,
    sl: trade.sl,
    tp: trade.tp,
    session: trade.session,
    comment: trade.comment,
    magic: trade.magic,
  };

  // on_conflict + Prefer: resolution=merge-duplicates = upsert via PostgREST,
  // guards against the EA retrying the same closed trade twice.
  const { data } = await axios.post(
    `${SUPABASE_URL}/rest/v1/trade_journal?on_conflict=user_id,ticket`,
    row,
    {
      headers: restHeaders({
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      }),
    }
  );
  return data[0];
}

async function getTradesForUser(userId, { limit = 200 } = {}) {
  const { data } = await axios.get(
    `${SUPABASE_URL}/rest/v1/trade_journal?user_id=eq.${userId}&select=*&order=close_time.desc&limit=${limit}`,
    { headers: restHeaders() }
  );
  return data;
}

module.exports = { getUserIdForLicenceKey, insertTrade, getTradesForUser };
