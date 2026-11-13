// ═══════════════════════════════════════════════════════════════
// email-service.js — Resend email delivery for Blackwood
// Place in same folder as app.js
//
// Nov 2026 redesign: every email shares ONE layout (buildEmail below) —
// dark page, the Blackwood logo centred above the name, a status pill,
// a centred headline, the message, a details box, and a centred pill
// button. The logo is built into this file and travels INSIDE each email,
// so it is never fetched from the website and shows the moment the email
// opens.
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');

// No fallback key: a real credential once sat here in source. Accepts a
// couple of spellings, because a mismatched name fails silently (no mail).
const RESEND_API_KEY = process.env.RESEND_API_KEY
                    || process.env.RESEND_KEY
                    || process.env.RESEND_APIKEY
                    || null;

// NOT fatal: paystack-route.js requires this module at load, so throwing
// here would take payments and the dashboard down with email.
if (!RESEND_API_KEY) {
  console.error(
    '[EMAIL] DISABLED — RESEND_API_KEY is not set.\n' +
    '  Set it in Railway -> Variables (exact name: RESEND_API_KEY), then redeploy.\n' +
    '  The server will run normally, but no email will be delivered until it is set.'
  );
}
function emailDisabled(tag) {
  console.warn(`[EMAIL] ${tag} not sent — RESEND_API_KEY is not configured.`);
  return { ok: false, error: 'Email is not configured on this server (RESEND_API_KEY missing)' };
}

const FROM_EMAIL    = process.env.FROM_EMAIL || 'Blackwood <noreply@blackwoodmt5.com>';
const SITE_URL      = (process.env.SITE_URL || 'https://blackwoodmt5.com').trim();
const SUPPORT_EMAIL = (process.env.SUPPORT_EMAIL || '').trim();
// Every dashboard link uses APP_URL. The old Railway address
// (nurturing-magic-…up.railway.app) used to be the fallback for the
// welcome email's button, which made it pass through that address first.
const APP_URL       = (process.env.APP_URL || 'https://app.blackwoodmt5.com').trim();

// Anything a customer typed is escaped before it goes into an email.
function escHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const PLAN_NAMES = {
  pro:             'Pro',
  pro_monthly:     'Pro Monthly',
  pro_yearly:      'Pro Yearly',
  lifetime:        'Lifetime',
  licence_renewal: 'MT5 Licence Renewal'
};
const planName = p => PLAN_NAMES[p] || escHtml(p || 'Pro');
const fmtDate  = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
// Paystack amounts arrive in the smallest unit (cents / pesewas).
function fmtMoney(amount, currency) {
  const n = Number(amount);
  if (!isFinite(n) || n <= 0) return null;
  const cur = String(currency || 'USD').toUpperCase();
  const v = (n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur === 'USD' ? '$' + v : cur === 'GHS' ? 'GH₵' + v : cur + ' ' + v;
}

// ── The logo, built in ─────────────────────────────────────────
// The white pine-tree mark, 89×96 px, ~10 KB. Sent as an inline (cid:)
// attachment with every email, so no mail app has to download it.
const LOGO_CID = 'bw-logo';
const LOGO_B64 = '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';
const LOGO_ATTACHMENT = { filename: 'blackwood-logo.png', content: LOGO_B64, content_id: LOGO_CID };

// ── Layout ─────────────────────────────────────────────────────
const C = { page: '#09090e', card: '#101017', panel: '#16161f', line: '#25252f',
            text: '#eceae0', soft: '#a6a49c', faint: '#75736d' };
const F = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
// Status pill colours: ok = good news, info = information,
// warn = needs attention, bad = something has stopped.
const TONE = {
  ok:   { bg: '#123328', edge: 'rgba(120,240,190,.38)', grad: '#11402f,#1a5a43,#11402f', text: '#7ff0c2', glow: 'rgba(23,169,122,.18)' },
  warn: { bg: '#33270f', edge: 'rgba(240,200,120,.38)', grad: '#3f2f10,#5a4318,#3f2f10', text: '#f2c66d', glow: 'rgba(201,130,10,.18)' },
  bad:  { bg: '#331414', edge: 'rgba(240,130,130,.38)', grad: '#401515,#5a1d1d,#401515', text: '#ff9a98', glow: 'rgba(224,80,79,.18)' },
  info: { bg: '#14213a', edge: 'rgba(140,180,250,.38)', grad: '#15264a,#1d3463,#15264a', text: '#a9c6ff', glow: 'rgba(91,141,239,.18)' }
};
const NOTE_EDGE = { ok: '#17a97a', warn: '#c9820a', bad: '#e0504f' };

// o: { status, tone, title, name, paras[], block, cta, ctaUrl, ctaNote, internal }
// paras / block are trusted HTML built in this file; anything a customer
// typed must be escaped by the caller before it gets here.
function buildEmail(o) {
  const T = TONE[o.tone || 'ok'];
  const pill = o.status ? `
    <tr><td align="center" style="padding:28px 24px 0">
      <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 auto"><tr>
        <td bgcolor="${T.bg}" style="border-radius:999px;border:1px solid ${T.edge};background:${T.bg};background-image:linear-gradient(180deg,rgba(255,255,255,.16) 0%,rgba(255,255,255,.04) 48%,rgba(0,0,0,.10) 100%),linear-gradient(90deg,${T.grad});box-shadow:inset 0 1px 0 rgba(255,255,255,.28),inset 0 -1px 0 rgba(0,0,0,.25),0 6px 18px ${T.glow}">
          <div style="padding:10px 22px;font:600 14px/1 ${F};color:${T.text};white-space:nowrap">${o.status}</div>
        </td></tr></table>
    </td></tr>` : '';
  const cta = o.cta ? `
    <tr><td align="center" style="padding:14px 36px 8px;text-align:center">
      <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 auto"><tr>
        <td bgcolor="#e9e7df" style="border-radius:999px;border:1px solid rgba(255,255,255,.75);background:#e9e7df;background-image:linear-gradient(180deg,#ffffff 0%,#f1efe8 45%,#d9d6cc 100%);box-shadow:inset 0 1px 0 #ffffff,inset 0 -2px 4px rgba(0,0,0,.10),0 8px 22px rgba(255,255,255,.10),0 2px 6px rgba(0,0,0,.45)">
          <a href="${o.ctaUrl}" style="display:inline-block;padding:14px 34px;font:600 15px/1 ${F};color:#09090e;text-decoration:none;border-radius:999px">${o.cta}</a>
        </td></tr></table>
      ${o.ctaNote ? `<p style="margin:12px 0 0;font:13px/1.5 ${F};color:${C.faint};text-align:center">${o.ctaNote}</p>` : ''}
    </td></tr>` : '';
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="only light">
<meta name="supported-color-schemes" content="only light">
</head>
<body style="margin:0;padding:0;background:${C.page}" bgcolor="${C.page}">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${C.page}" bgcolor="${C.page}">
<tr><td align="center" style="padding:32px 14px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px">
    <tr><td align="center" style="padding:8px 4px 26px;text-align:center">
      <img src="cid:${LOGO_CID}" alt="" width="52" height="56" style="display:block;margin:0 auto 12px;width:52px;height:56px;border:0;outline:none;text-decoration:none">
      <div style="font:700 18px/1 ${F};letter-spacing:.18em;color:${C.text};padding-left:.18em">BLACKWOOD</div>
    </td></tr>
  </table>
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;background:${C.card};border:1px solid ${C.line};border-radius:12px" bgcolor="${C.card}">
    ${pill}
    <tr><td style="padding:28px 36px 0;font-family:${F}">
      <h1 style="margin:0 0 22px;font-size:24px;line-height:1.35;font-weight:700;color:${C.text};text-align:center">${o.title}</h1>
      <p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:${C.text}">Hi ${escHtml(o.name) || 'there'},</p>
      ${(o.paras || []).map(p => `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:${C.soft}">${p}</p>`).join('')}
    </td></tr>
    ${o.block || ''}
    ${cta}
    <tr><td style="padding:26px 36px 32px;font:14px/1.65 ${F};color:${C.soft}">
      ${o.internal ? 'Sent to you as the Blackwood administrator.'
                   : 'Questions? Send us a message from the Messages tab on your account page.<br>The Blackwood team'}
    </td></tr>
  </table>
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px">
    <tr><td style="padding:22px 4px;font:12px/1.7 ${F};color:${C.faint}">
      ${o.internal ? '' : 'You are receiving this email because you have a Blackwood account.<br>'}
      Blackwood LLC, Accra, Ghana<br>
      <a href="${SITE_URL}" style="color:${C.soft}">${SITE_URL.replace(/^https?:\/\//, '')}</a>&nbsp;&nbsp;&nbsp;<a href="${SITE_URL}/account" style="color:${C.soft}">Account settings</a>
    </td></tr>
  </table>
</td></tr></table>
</body>
</html>`;
}

// A details box: optional licence key on top, then label / value rows.
function details(rows, key) {
  rows = (rows || []).filter(r => r && r[1]);
  const keyRows = key ? `
      <tr><td colspan="2" style="padding:16px 18px 8px;font:13px/1.4 ${F};color:${C.faint}">Your licence key</td></tr>
      <tr><td colspan="2" style="padding:0 18px 16px">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border:1px solid #c9820a;border-radius:6px;background:#0b0b11" bgcolor="#0b0b11"><tr>
          <td align="center" style="padding:14px 12px;font:700 16px/1.5 Menlo,Consolas,'Courier New',monospace;color:#e0a43a;letter-spacing:.04em;word-break:break-all">${escHtml(key)}</td>
        </tr></table>
      </td></tr>` : '';
  const body = rows.map((r, i) => {
    const bt = (key || i) ? `border-top:1px solid ${C.line};` : '';
    return `<tr><td style="padding:12px 18px;${bt}font:14px/1.4 ${F};color:${C.faint}">${r[0]}</td>` +
           `<td align="right" style="padding:12px 18px;${bt}font:600 14px/1.4 ${F};color:${C.text}">${r[1]}</td></tr>`;
  }).join('');
  if (!keyRows && !body) return '';
  return `<tr><td style="padding:6px 36px 20px">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${C.panel};border:1px solid ${C.line};border-radius:8px" bgcolor="${C.panel}">${keyRows}${body}</table>
  </td></tr>`;
}
function steps(list) {
  return `<tr><td style="padding:0 36px 10px;font-family:${F}">
    <p style="margin:0 0 10px;font-size:15px;font-weight:700;color:${C.text}">Next steps</p>
    <table cellpadding="0" cellspacing="0" role="presentation" width="100%">${list.map((s, i) => `
      <tr><td style="width:34px;vertical-align:top;padding:1px 0 12px"><div style="width:22px;height:22px;border-radius:50%;background:#c9820a;color:#ffffff;font:700 12px/22px ${F};text-align:center">${i + 1}</div></td>
          <td style="padding:0 0 12px;font:15px/1.6 ${F};color:${C.soft}">${s}</td></tr>`).join('')}
    </table></td></tr>`;
}
function note(text, tone) {
  return `<tr><td style="padding:0 36px 16px">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${C.panel};border-left:3px solid ${NOTE_EDGE[tone || 'ok']};border-radius:4px" bgcolor="${C.panel}">
      <tr><td style="padding:13px 16px;font:14px/1.65 ${F};color:${C.soft}">${text}</td></tr></table>
  </td></tr>`;
}
const b = t => `<b style="color:${C.text}">${t}</b>`;
const SETUP = [
  'Download the Blackwood EA from your account page and attach it to a chart in MetaTrader 5.',
  `Paste your licence key into the EA's ${b('LicenceKey')} input.`,
  'Open your dashboard. Data appears within a minute of the EA running.'
];
const ACCOUNT = () => `${SITE_URL}/account`;
const MESSAGES = () => `${SITE_URL}/account#messages`;

// ── Sending ────────────────────────────────────────────────────
async function sendResend(toEmail, subject, html, tag, replyTo) {
  if (!RESEND_API_KEY) return emailDisabled(tag);
  if (!toEmail) return { ok: false, error: 'No recipient email' };
  try {
    const { data } = await axios.post(
      'https://api.resend.com/emails',
      { from: FROM_EMAIL, to: [toEmail], subject, html,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(html.includes('cid:' + LOGO_CID) ? { attachments: [LOGO_ATTACHMENT] } : {}) },
      { headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 12000 }
    );
    console.log(`[EMAIL] ${tag} sent to ${toEmail} — id: ${data.id}`);
    return { ok: true, id: data.id };
  } catch (e) {
    console.error(`[EMAIL] ${tag} failed:`, e.response?.data || e.message);
    return { ok: false, error: e.response?.data?.message || e.message };
  }
}

// ── Welcome, new purchase ──────────────────────────────────────
// opts (optional): { amount, currency } from Paystack.
async function sendWelcomeEmail(toEmail, name, plan, licenceKey, expiresAt, licenceExpiresAt, opts) {
  const isLifetime = String(plan).startsWith('lifetime');
  const paid = fmtMoney(opts && opts.amount, opts && opts.currency);
  const html = buildEmail(isLifetime ? {
    status: 'Your Lifetime access is active', title: 'Welcome to Blackwood', name,
    paras: ['Thank you for buying Blackwood Lifetime. Your platform access is permanent, and your licence key is below.'],
    block: details([['Plan', 'Lifetime'], ['Amount paid', paid], ['Platform access', 'Never expires'],
                    ['MT5 licence valid until', licenceExpiresAt ? fmtDate(licenceExpiresAt) : null]], licenceKey) +
      note('The licence key runs the EA and indicators in MetaTrader 5 and is renewed yearly for $100. Renewal is never charged automatically, and your dashboards stay open either way.') +
      steps(SETUP),
    cta: 'Open your dashboard', ctaUrl: `${APP_URL}/dashboard`, ctaNote: 'You may be asked to sign in first.'
  } : {
    status: `Your ${planName(plan)} plan is active`, title: 'Welcome to Blackwood', name,
    paras: ['Thank you for subscribing to Blackwood. Your payment has been received and your licence key is below.'],
    block: details([['Plan', planName(plan)], ['Amount paid', paid],
                    ['Next renewal', expiresAt ? fmtDate(expiresAt) : null]], licenceKey) + steps(SETUP),
    cta: 'Open your dashboard', ctaUrl: `${APP_URL}/dashboard`, ctaNote: 'You may be asked to sign in first.'
  });
  return sendResend(toEmail, isLifetime ? 'Welcome to Blackwood Lifetime' : `Your Blackwood ${planName(plan)} plan is active`,
                    html, 'welcome email');
}

// ── Plan renewed (a repeat payment on an existing Pro plan) ─────
async function sendPlanRenewed(toEmail, name, plan, expiresAt, opts) {
  const paid = fmtMoney(opts && opts.amount, opts && opts.currency);
  const html = buildEmail({
    status: 'Payment received', title: 'Your plan has been renewed', name,
    paras: [`Thank you. Your ${planName(plan)} plan has been renewed. Your licence key has not changed, so there is nothing to update in MetaTrader 5.`],
    block: details([['Plan', planName(plan)], ['Amount paid', paid],
                    ['Next renewal', expiresAt ? fmtDate(expiresAt) : null]]),
    cta: 'Open your dashboard', ctaUrl: `${APP_URL}/dashboard`
  });
  return sendResend(toEmail, `Your Blackwood ${planName(plan)} plan has been renewed`, html, 'plan renewed');
}

// ── MT5 licence renewed (Lifetime) ─────────────────────────────
async function sendLicenceRenewed(toEmail, name, opts) {
  const { licenceExpiresAt, amount, currency } = opts || {};
  const html = buildEmail({
    status: 'Payment received', title: 'Your MT5 licence has been renewed', name,
    paras: ['Your payment has been received and your MT5 licence is renewed for 12 months. Your licence key has not changed, so there is nothing to reinstall.',
            'If the EA or indicators had stopped, reload them in MetaTrader 5.'],
    block: details([['Renewal', 'MT5 licence, 12 months'], ['Amount paid', fmtMoney(amount, currency)],
                    ['Valid until', licenceExpiresAt ? fmtDate(licenceExpiresAt) : null]]) +
      note('Your Lifetime platform access does not expire and was not affected. Renewals are never charged automatically.'),
    cta: 'View your account', ctaUrl: ACCOUNT()
  });
  return sendResend(toEmail, 'Your Blackwood MT5 licence has been renewed', html, 'licence renewed');
}

// ── MT5 licence reminders (Lifetime) ───────────────────────────
// state: 'due' (before expiry) | 'grace' | 'lapsed'
async function sendLicenceReminder(toEmail, name, opts) {
  const { daysLeft, state, expiresAt } = opts || {};
  const dateStr = fmtDate(expiresAt);
  const graceEnd = fmtDate(new Date(Date.parse(expiresAt) + 14 * 86400000));
  const unaffected = note('Your Lifetime platform access is not affected. Your dashboards and data stay open whatever happens to this key.');
  let o, subject;
  if (state === 'lapsed') {
    subject = 'Your Blackwood MT5 licence has expired';
    o = { tone: 'bad', status: 'Licence expired', title: 'The EA and indicators have stopped',
      paras: ['The grace period for your MT5 licence has ended, so the Blackwood EA and indicators have stopped running in MetaTrader 5.',
              'Renewing costs $100 for 12 months and restores your existing key. There is nothing to reinstall.'],
      block: details([['Expired', dateStr], ['Renewal', '$100 for 12 months']]) + unaffected };
  } else if (state === 'grace') {
    const d = `${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
    subject = 'Action needed: your Blackwood MT5 licence has expired';
    o = { tone: 'warn', status: `${d} of grace remaining`, title: 'Your MT5 licence has expired',
      paras: [`Your MT5 licence expired on ${dateStr}. You are in the 14-day grace period, and ${d} of it remain.`,
              'When it ends, the EA and indicators will stop running in MetaTrader 5. Renewing keeps your existing key.'],
      block: details([['Expired', dateStr], ['Grace ends', graceEnd], ['Renewal', '$100 for 12 months']]) + unaffected };
  } else if (daysLeft === 0) {
    subject = 'Your Blackwood MT5 licence expires today';
    o = { tone: 'warn', status: 'Expires today', title: 'Your MT5 licence expires today',
      paras: ['The 12-month licence for the Blackwood EA and indicators ends today. A 14-day grace period follows, after which they stop running in MetaTrader 5.',
              'Renewing costs $100 for 12 months and keeps your existing key.'],
      block: details([['Licence ends', dateStr], ['Grace period', '14 days']]) + unaffected };
  } else {
    const d = `${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
    subject = `Your Blackwood MT5 licence expires in ${d}`;
    o = { tone: 'info', status: `Expires in ${d}`, title: 'Your MT5 licence expires soon',
      paras: [`The 12-month licence for the Blackwood EA and indicators ends on ${dateStr}.`,
              'Renewing costs $100 for 12 months and keeps your existing key. Renewing early adds 12 months to the current end date.'],
      block: details([['Licence ends', dateStr], ['Renewal', '$100 for 12 months']]) + unaffected };
  }
  return sendResend(toEmail, subject, buildEmail({ ...o, name, cta: 'Renew your licence', ctaUrl: ACCOUNT() }), 'licence reminder');
}

// ── Subscription renewal reminder (Pro monthly / yearly) ───────
async function sendSubscriptionReminder(toEmail, name, planKey, daysLeft, expiresAt) {
  const label = planKey === 'pro_yearly' ? 'Pro Yearly' : 'Pro Monthly';
  const when  = daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
  const html = buildEmail({
    tone: 'info', status: `Renews ${when}`, title: 'Your plan renews soon', name,
    paras: ['This is a reminder that your Blackwood subscription renews soon. No action is needed if your saved payment method is still valid.'],
    block: details([['Plan', label], ['Renewal date', fmtDate(expiresAt)]]),
    cta: 'Manage billing', ctaUrl: ACCOUNT(),
    ctaNote: 'If your card has changed, update it under Billing so the payment goes through.'
  });
  return sendResend(toEmail, `Your Blackwood ${label} plan renews ${when}`, html, 'renewal reminder');
}

// ── Licence sharing notice (sent by hand from the admin console) ─
// stage: 'warning' | 'blocked'. Says what kind of thing was seen, never how
// it was measured.
async function sendSharingNotice(toEmail, name, opts) {
  const blocked = (opts || {}).stage === 'blocked';
  const html = buildEmail(blocked ? {
    tone: 'bad', status: 'Dashboard paused', title: 'Your dashboard has been paused', name,
    paras: ['Your licence key is issued for one trader. We have seen it used in a way that looks like more than one trader, so access to the Pro dashboard is paused while we review it.',
            `${b('Your EA, indicators and Telegram alerts are still running')}, so any open trades remain covered. Nothing has been cancelled or charged.`,
            "If there is an explanation, such as a VPS, a second machine of your own or a prop-firm account in a company's name, send us a message and we will look at it quickly."],
    block: note('This pauses dashboard access only. Your subscription and licence key remain active, and it can be reversed.', 'warn'),
    cta: 'Open Messages', ctaUrl: MESSAGES()
  } : {
    tone: 'warn', status: 'Notice only, nothing restricted', title: 'A note about your licence key', name,
    paras: ['Your Blackwood licence key is issued for one trader. We have recently seen it used in a way we would like to check, for instance with a MetaTrader account in a different name, or on more machines than one trader usually runs.',
            'If those are all yours, such as a company, joint or prop-firm account or your own VPS, there is nothing to worry about. You are welcome to send us a message so we can note it on your account.',
            'Sharing a licence key with another trader is not permitted under the Software Licence.'],
    block: note('No action has been taken on your account. This message is a courtesy so nothing comes as a surprise later.'),
    cta: 'Open Messages', ctaUrl: MESSAGES()
  });
  return sendResend(toEmail, blocked ? 'Your Blackwood dashboard has been paused' : 'A note about your Blackwood licence key',
                    html, 'sharing notice', SUPPORT_EMAIL || null);
}

// ── Legacy reminder, kept so older callers still work ──────────
async function sendExpiryReminder(toEmail, name, plan, daysLeft) {
  return sendSubscriptionReminder(toEmail, name, plan === 'pro_yearly' ? 'pro_yearly' : 'pro_monthly',
                                  daysLeft, new Date(Date.now() + daysLeft * 86400000));
}

// ── Messages & Inbox ───────────────────────────────────────────
// kind: 'reply' | 'waiting' | 'reminder' | 'resolved' | 'autoclosed' | 'restored'
// Never includes what anyone wrote — only that there is something to look at.
async function sendSupportUpdate(toEmail, name, opts) {
  const { kind, subject } = opts || {};
  const about = subject ? `&ldquo;${escHtml(subject)}&rdquo;` : 'your message';
  const K = {
    reply:      { mail: 'We have replied to your message', tone: 'info', status: 'New reply', title: 'We have replied to your message',
                  paras: [`There is a reply waiting for you about ${about}.`, 'You can read it, and reply with screenshots or PDFs, from the Messages tab on your account page.'] },
    waiting:    { mail: 'We need something from you', tone: 'warn', status: 'Waiting for you', title: 'We need something from you',
                  paras: [`To keep going with ${about}, we need a little more from you.`, 'Our message on your account page explains what would help. Screenshots and PDFs can be attached to your reply.'] },
    reminder:   { mail: 'A quick reminder about your message', tone: 'warn', status: 'Still waiting for you', title: 'We are still waiting to hear from you',
                  paras: [`We asked for a little more information about ${about} a few days ago and have not heard back yet.`, 'When you have a moment, reply from the Messages tab. If we do not hear back, we will close the conversation in a few days; you can still reopen it for a week after that.'] },
    resolved:   { mail: 'Your message has been resolved', tone: 'ok', status: 'Resolved', title: 'Your message has been resolved',
                  paras: [`We have marked ${about} as resolved.`, 'If anything is still not right, start a new message from your account page and we will pick it up.'] },
    autoclosed: { mail: 'We have closed your conversation', tone: 'info', status: 'Closed after 7 days', title: 'We have closed your conversation',
                  paras: [`We had not heard back about ${about} for a week, so we have closed it.`, 'Nothing is lost. If you still need help, reopen it from the Messages tab within the next 7 days.'] },
    restored:   { mail: 'Your review is complete', tone: 'ok', status: 'Dashboard available again', title: 'Your review is complete', cta: 'Open your account',
                  paras: ['Thank you for your patience while we reviewed your licence. Our checks are complete and everything is in order, so your Pro Dashboard is available again.'] }
  }[kind];
  if (!K) return { ok: false, error: 'Unknown support email kind' };
  const html = buildEmail({ tone: K.tone, status: K.status, title: K.title, name, paras: K.paras,
                            cta: K.cta || 'Open Messages', ctaUrl: MESSAGES() });
  return sendResend(toEmail, K.mail, html, 'support ' + kind, SUPPORT_EMAIL || null);
}

// ── Access withdrawn (ban / suspension) ────────────────────────
async function sendAccessNotice(toEmail, name, opts) {
  const { status, reason } = opts || {};
  const banned = status === 'banned';
  if (!banned && status !== 'suspended') return { ok: false, error: 'Only for bans and suspensions' };
  const html = buildEmail({
    tone: 'bad', status: banned ? 'Licence withdrawn' : 'Access suspended',
    title: banned ? 'Your licence has been withdrawn' : 'Your access is suspended', name,
    paras: [
      reason ? `${b('Reason:')} ${escHtml(reason)}` : 'We have withdrawn access to your account.',
      (banned ? 'Your licence key has stopped working on every terminal, and the Pro dashboard is closed.'
              : 'Your licence key and the Pro dashboard are paused for now.') +
        ' Your account, billing history and data are all still there, and you can still sign in.',
      'If you believe this is a mistake, send us a message and tell us what we should know. Screenshots and documents can be attached.'
    ],
    block: note('Every decision like this is reviewed by a person, and appeals are read.'),
    cta: 'Open Messages', ctaUrl: MESSAGES()
  });
  return sendResend(toEmail, banned ? 'Your Blackwood licence has been withdrawn' : 'Your Blackwood access is suspended',
                    html, 'access ' + status, SUPPORT_EMAIL || null);
}

// ── To you: Team chat ──────────────────────────────────────────
// kind: 'new' | 'reminder'   where: 'private' | 'team'
async function sendTeamAlert(toEmail, opts) {
  const { kind, who, where } = opts || {};
  const place = where === 'team' ? 'in the Team room' : 'privately';
  const reminder = kind === 'reminder';
  const w = escHtml(who || 'An agent');
  const html = buildEmail({
    internal: true, name: 'Assan',
    tone: reminder ? 'warn' : 'info',
    status: reminder ? 'Unanswered for 15 minutes' : `Team chat, ${where === 'team' ? 'Team room' : 'private'}`,
    title: reminder ? 'A question is still waiting for you' : `${w} asked you something`,
    paras: [reminder ? `${w} asked you something ${place} about 15 minutes ago, and it has not been answered yet.`
                     : `${w} sent you a message ${place}. Reply when it suits you, or take over the customer's conversation from there.`],
    cta: 'Open Team chat', ctaUrl: `${APP_URL}/admin#team-chat`
  });
  return sendResend(toEmail, reminder ? 'Reminder: a Team chat question is waiting' : `${who || 'An agent'} asked you something`,
                    html, 'team ' + (kind || 'new'));
}

// ── To you: a customer started a conversation ──────────────────
async function sendSupportAlert(opts) {
  if (!SUPPORT_EMAIL) return { ok: false, error: 'SUPPORT_EMAIL not set' };
  const { subject, topic, fromEmail } = opts || {};
  const TOPIC = { licence: 'Licence review', billing: 'Billing', technical: 'Technical help', other: 'Something else' };
  const html = buildEmail({
    internal: true, name: 'Assan', tone: topic === 'licence' ? 'warn' : 'info',
    status: TOPIC[topic] || 'Something else', title: 'New message in your Inbox',
    paras: [b(escHtml(subject || '(no subject)')), `From ${escHtml(fromEmail || 'a customer')}.`],
    cta: 'Open the Inbox', ctaUrl: `${APP_URL}/admin`
  });
  return sendResend(SUPPORT_EMAIL, `New message: ${String(subject || '').slice(0, 80)}`, html, 'support alert');
}

module.exports = { sendWelcomeEmail, sendPlanRenewed, sendExpiryReminder, sendLicenceReminder, sendLicenceRenewed,
                   sendSubscriptionReminder, sendSharingNotice, sendSupportUpdate, sendSupportAlert,
                   sendAccessNotice, sendTeamAlert,
                   buildEmail };   // exported for previews and tests
