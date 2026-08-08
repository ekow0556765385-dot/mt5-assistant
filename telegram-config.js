// telegram-config.js
// Single source of truth for the Blackwood Telegram bot.
//
// WHY THIS EXISTS: the token was hardcoded separately in app.js and in
// smc-route.js, and the two drifted. app.js was moved to the current
// Blackwood bot while smc-route.js kept the OLD, now-decommissioned bot —
// so every SMC confluence alert was being sent to a dead bot and silently
// swallowed by the `catch` in sendTelegram(). Pattern and news alerts (sent
// from app.js) arrived fine, which is why it looked like confluence itself
// was broken rather than its delivery.
//
// Any module that sends Telegram messages must require this file. Do not
// re-declare a token anywhere else.
//
// Both values can be overridden by environment variables, which is how they
// SHOULD be set in production — a bot token in source control is a
// credential leak, and anyone with it can read and send as your bot. Set
// TELEGRAM_BOT_TOKEN in Railway and rotate the token via @BotFather, since
// the old one has been committed to this repo.

const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN  || '8849142563:AAHOL16YSxzJ_KRgWvU5Fxq8o_bTGO6Ji3A';

// The owner's own ops chat — receives a copy of everything. Customer-facing
// sends resolve each subscriber's own chat_id via telegram-store.js.
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT || '770749859';

module.exports = { TELEGRAM_TOKEN, TELEGRAM_CHAT_ID };
