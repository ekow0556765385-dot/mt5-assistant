// ═══════════════════════════════════════════════════════════════
// email-service.js — Resend email delivery for Blackwood
// Place in same folder as app.js
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');

// No fallback key. The value that used to sit here was a real Resend
// credential committed to source — and not even the one in production,
// so it could have been abused indefinitely without anything looking
// wrong. Same rule paystack-route.js already follows: a missing
// credential must stop the server, not let it run on a secret anyone
// holding this file can read.
// Accepts a couple of spellings, because the cost of a mismatched
// variable name here is silent (no mail) rather than obvious.
const RESEND_API_KEY = process.env.RESEND_API_KEY
                    || process.env.RESEND_KEY
                    || process.env.RESEND_APIKEY
                    || null;

// NOT fatal. An earlier version threw here, which took the whole server
// down: paystack-route.js requires this module at load, so a missing mail
// key killed payments, licence validation and the dashboard along with it.
// Email is not load-bearing — it must be able to fail on its own.
//
// Still no hardcoded fallback key. The old one was a real credential in
// source, and not even the one in production, so it could have been abused
// indefinitely with nothing looking wrong.
if (!RESEND_API_KEY) {
  console.error(
    '[EMAIL] DISABLED — RESEND_API_KEY is not set.\n' +
    '  Set it in Railway -> Variables (exact name: RESEND_API_KEY), then redeploy.\n' +
    '  The server will run normally, but welcome emails, licence reminders\n' +
    '  and renewal notices will NOT be delivered until it is set.'
  );
}

// Every sender goes through this. Returns a clear, logged refusal instead
// of throwing, so a caller that does not check the result cannot crash.
function emailDisabled(tag) {
  console.warn(`[EMAIL] ${tag} not sent — RESEND_API_KEY is not configured.`);
  return { ok: false, error: 'Email is not configured on this server (RESEND_API_KEY missing)' };
}
const FROM_EMAIL      = process.env.FROM_EMAIL      || 'Blackwood <noreply@blackwoodmt5.com>';
const SITE_URL        = (process.env.SITE_URL || 'https://blackwoodmt5.com').trim();
// Where customer replies should go. Emails are sent from a noreply
// address, so without this a "reply to this email" instruction sends a
// paying customer's explanation nowhere. Set SUPPORT_EMAIL on Railway;
// when it is not set, the wording points to the website instead of
// promising a reply that would never arrive.
const SUPPORT_EMAIL   = (process.env.SUPPORT_EMAIL || '').trim();
const APP_URL         = (process.env.APP_URL || 'https://app.blackwoodmt5.com').trim();

// Anything a customer typed — their name, a message subject — is escaped
// before it goes into an email. Names come from the account page, where a
// customer can type anything, and before this every email inserted the
// name raw: a name containing HTML went out under Blackwood's name. A
// normal name reads exactly the same escaped.
function escHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const RAILWAY_URL     = (process.env.RAILWAY_URL || 'https://nurturing-magic-production-3169.up.railway.app').trim();

// ── Plan display names ─────────────────────────────────────────
// Keyed on plan_key where possible so Monthly and Yearly read differently;
// bare 'pro'/'lifetime' still resolve, for older callers and legacy rows.
const PLAN_NAMES = {
  pro:             'Pro',
  pro_monthly:     'Pro Monthly',
  pro_yearly:      'Pro Yearly',
  lifetime:        'Lifetime',
  licence_renewal: 'MT5 Licence Renewal'
};

// ── Build the welcome email HTML ───────────────────────────────
function buildWelcomeEmail(name, plan, licenceKey, expiresAt, licenceExpiresAt) {
  const planName = PLAN_NAMES[plan] || plan;
  const isLifetime = String(plan).startsWith('lifetime');
  const d = v => new Date(v).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });

  // Lifetime used to read a flat "never expires". That is true of the
  // PLATFORM and false of the MT5 licence key, which carries its own
  // 12-month term at $100/year (Software Licence s.4). Saying only the
  // first half is how a customer ends up surprised a year later, so both
  // are stated here — the good news first, because it is the bigger one.
  const expiryLine = isLifetime
    ? `<p style="color:#c9820a;font-size:13px;margin:4px 0 0;font-weight:600">Platform access — never expires</p>` +
      (licenceExpiresAt
        ? `<p style="color:#9a9890;font-size:12.5px;margin:6px 0 0;line-height:1.6">This key runs the EA and indicators inside MetaTrader 5 and is licensed for 12 months, until <strong style="color:#eceae0">${d(licenceExpiresAt)}</strong>. Renewal is $100/year and is never charged automatically. Your dashboards stay open either way.</p>`
        : '')
    : (expiresAt
        ? `<p style="color:#9a9890;font-size:13px;margin:4px 0 0">Renews / expires: ${d(expiresAt)}</p>`
        : '');

  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="only light">
<meta name="supported-color-schemes" content="only light">
</head>
<body style="margin:0;padding:0;background:#09090e;font-family:'Segoe UI',Arial,sans-serif" bgcolor="#09090e">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#09090e;padding:40px 20px" bgcolor="#09090e">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#09090e" bgcolor="#09090e">

      <!-- Header -->
        <tr><td align="center" style="padding:32px 32px 0;text-align:center">
          <!-- Logo ABOVE the wordmark, centred, 44px (was 30px beside it).
               Embedded in the email itself, so it shows the moment
               the email opens instead of popping in after a fetch. -->
          <img src="cid:bw-logo" alt="Blackwood" width="44" height="44"
               style="display:block;margin:0 auto 10px;border:0;outline:none;text-decoration:none;width:44px;height:44px">
          <span style="font-size:17px;font-weight:800;letter-spacing:.08em;color:#eceae0;text-transform:uppercase">Blackwood</span>
        </td></tr>

        <!-- Success banner -->
        <tr><td style="padding:24px 32px 0">
          <div style="background:rgba(23,169,122,.12);border:1px solid rgba(23,169,122,.3);border-radius:8px;padding:16px 20px;text-align:center">
            <div style="font-size:24px;margin-bottom:6px">🎉</div>
            <div style="color:#17a97a;font-size:16px;font-weight:700">Welcome to Blackwood ${planName}!</div>
            <div style="color:#9a9890;font-size:13px;margin-top:4px">Your subscription is now active</div>
          </div>
        </td></tr>

        <!-- Greeting -->
        <tr><td style="padding:24px 32px 0">
          <p style="color:#eceae0;font-size:15px;line-height:1.6;margin:0">Hi ${escHtml(name) || 'there'},</p>
          <p style="color:#9a9890;font-size:14px;line-height:1.7;margin:12px 0 0">
            ${isLifetime
      ? `Thank you for buying Blackwood Lifetime. Your platform access is permanent, and your MT5 Assistant dashboard and licence key are ready below.`
      : `Thank you for subscribing to Blackwood ${planName}. Your MT5 Assistant dashboard and licence key are ready below.`}
          </p>
        </td></tr>

        <!-- Licence key box -->
        <tr><td style="padding:24px 32px 0">
          <div style="background:#0f0f16;border:1px solid #2e2e3e;border-radius:8px;padding:20px">
            <div style="color:#72706a;font-size:11px;text-transform:uppercase;letter-spacing:.1em;font-weight:700;margin-bottom:8px">Your Licence Key</div>
            <div style="background:#09090e;border:1px solid #c9820a;border-radius:6px;padding:14px 16px;text-align:center">
              <code style="color:#c9820a;font-size:16px;font-weight:700;letter-spacing:.05em;font-family:'Courier New',monospace">${licenceKey}</code>
            </div>
            ${expiryLine}
          </div>
        </td></tr>

        <!-- Instructions -->
        <tr><td style="padding:24px 32px 0">
          <div style="color:#72706a;font-size:11px;text-transform:uppercase;letter-spacing:.1em;font-weight:700;margin-bottom:12px">Getting Started</div>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding-bottom:14px;vertical-align:top;width:28px"><div style="width:20px;height:20px;background:#c9820a;border-radius:50%;color:#fff;font-size:11px;font-weight:700;text-align:center;line-height:20px">1</div></td>
                <td style="padding-bottom:14px;color:#eceae0;font-size:13px;line-height:1.6">Download the MT5 Assistant EA and attach it to any chart in MetaTrader 5</td></tr>
            <tr><td style="padding-bottom:14px;vertical-align:top"><div style="width:20px;height:20px;background:#c9820a;border-radius:50%;color:#fff;font-size:11px;font-weight:700;text-align:center;line-height:20px">2</div></td>
                <td style="padding-bottom:14px;color:#eceae0;font-size:13px;line-height:1.6">Paste your licence key into the <strong>LicenceKey</strong> input field when attaching the EA</td></tr>
            <tr><td style="padding-bottom:0;vertical-align:top"><div style="width:20px;height:20px;background:#c9820a;border-radius:50%;color:#fff;font-size:11px;font-weight:700;text-align:center;line-height:20px">3</div></td>
                <td style="padding-bottom:0;color:#eceae0;font-size:13px;line-height:1.6">Open your Pro Dashboard below to see live signals, patterns and analysis</td></tr>
          </table>
        </td></tr>

        <!-- CTA button -->
        <tr><td style="padding:28px 32px 0;text-align:center">
          <a href="${RAILWAY_URL}/dashboard" style="display:inline-block;background:#c9820a;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:14px 32px;border-radius:6px">Open your Pro Dashboard →</a>
        </td></tr>

        <!-- Support -->
        <tr><td style="padding:28px 32px 0">
          <p style="color:#72706a;font-size:12px;line-height:1.7;margin:0;text-align:center">
            Questions? Reply to this email or reach us on Telegram <strong style="color:#9a9890">@BlackwoodTrading</strong>
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:32px 32px 28px;border-top:1px solid #22222e;margin-top:24px">
          <p style="color:#72706a;font-size:11px;text-align:center;margin:0">© 2026 Blackwood LLC · Accra, Ghana</p>
          <p style="color:#72706a;font-size:11px;text-align:center;margin:6px 0 0">
            <a href="${SITE_URL}" style="color:#72706a;text-decoration:underline">${SITE_URL.replace('https://','')}</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Send welcome email via Resend ──────────────────────────────
async function sendWelcomeEmail(toEmail, name, plan, licenceKey, expiresAt, licenceExpiresAt) {
  if (!RESEND_API_KEY) return emailDisabled('welcome email');
  if (!toEmail) {
    console.warn('[EMAIL] No recipient email — skipping send');
    return { ok: false, error: 'No recipient email' };
  }

  const { html, attachments } = await withLogo(buildWelcomeEmail(name, plan, licenceKey, expiresAt, licenceExpiresAt));
  const planName = PLAN_NAMES[plan] || plan;

  try {
    const { data } = await axios.post(
      'https://api.resend.com/emails',
      {
        from:    FROM_EMAIL,
        to:      [toEmail],
        subject: `🎉 Welcome to Blackwood ${planName} — your licence key inside`,
        html,
        ...(attachments ? { attachments } : {})
      },
      {
        headers: {
          Authorization:  `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`[EMAIL] Sent to ${toEmail} — Resend id: ${data.id}`);
    return { ok: true, id: data.id };

  } catch (e) {
    console.error('[EMAIL] Send failed:', e.response?.data || e.message);
    return { ok: false, error: e.response?.data?.message || e.message };
  }
}

// ── Shared shell for notice emails ─────────────────────────────
// Same dark table layout, logo header and footer as the welcome email,
// so a reminder looks like it came from the same place. Kept separate
// from buildWelcomeEmail() rather than refactoring it — that template is
// live and working, and this change should not be able to break it.
function buildNoticeEmail(opts) {
  const accent = opts.accent || '#c9820a';
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="only light">
<meta name="supported-color-schemes" content="only light">
</head>
<body style="margin:0;padding:0;background:#09090e;font-family:'Segoe UI',Arial,sans-serif" bgcolor="#09090e">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#09090e;padding:40px 20px" bgcolor="#09090e">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#09090e" bgcolor="#09090e">

        <tr><td align="center" style="padding:32px 32px 0;text-align:center">
          <!-- Logo ABOVE the wordmark, centred, 44px (was 30px beside it).
               Embedded in the email itself, so it shows the moment
               the email opens instead of popping in after a fetch. -->
          <img src="cid:bw-logo" alt="Blackwood" width="44" height="44"
               style="display:block;margin:0 auto 10px;border:0;outline:none;text-decoration:none;width:44px;height:44px">
          <span style="font-size:17px;font-weight:800;letter-spacing:.08em;color:#eceae0;text-transform:uppercase">Blackwood</span>
        </td></tr>

        <tr><td style="padding:24px 32px 0">
          <div style="background:rgba(201,130,10,.12);border:1px solid ${accent}55;border-radius:8px;padding:16px 20px;text-align:center">
            <div style="color:${accent};font-size:16px;font-weight:700">${opts.headline}</div>
            ${opts.subhead ? `<div style="color:#9a9890;font-size:13px;margin-top:4px">${opts.subhead}</div>` : ''}
          </div>
        </td></tr>

        <tr><td style="padding:24px 32px 0">
          <p style="color:#eceae0;font-size:15px;line-height:1.6;margin:0">Hi ${escHtml(opts.name) || 'there'},</p>
          ${opts.paragraphs.map(t => `<p style="color:#9a9890;font-size:14px;line-height:1.7;margin:12px 0 0">${t}</p>`).join('')}
        </td></tr>

        ${opts.reassurance ? `
        <tr><td style="padding:20px 32px 0">
          <div style="background:#0f0f16;border:1px solid #22222e;border-left:3px solid #17a97a;border-radius:6px;padding:14px 16px">
            <p style="color:#9a9890;font-size:13px;line-height:1.65;margin:0">${opts.reassurance}</p>
          </div>
        </td></tr>` : ''}

        <tr><td style="padding:28px 32px 0;text-align:center">
          <a href="${opts.ctaUrl}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:14px 32px;border-radius:6px">${opts.ctaLabel}</a>
        </td></tr>

        <tr><td style="padding:28px 32px 0">
          <p style="color:#72706a;font-size:12px;line-height:1.7;margin:0;text-align:center">
            Questions? Reply to this email or reach us on Telegram <strong style="color:#9a9890">@BlackwoodTrading</strong>
          </p>
        </td></tr>

        <tr><td style="padding:32px 32px 28px;border-top:1px solid #22222e">
          <p style="color:#72706a;font-size:11px;text-align:center;margin:0">© 2026 Blackwood LLC · Accra, Ghana</p>
          <p style="color:#72706a;font-size:11px;text-align:center;margin:6px 0 0">
            <a href="${SITE_URL}" style="color:#72706a;text-decoration:underline">${SITE_URL.replace('https://','')}</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── The logo, embedded ──────────────────────────────────────────
// It used to be a link to the website, so every email arrived without it
// and the mail app fetched it on opening (Gmail through its own image
// proxy) — the pause before the logo appeared. Now the image travels
// inside the email as an inline (cid:) attachment and shows immediately.
//
// The server fetches the logo once and keeps it in memory. It does NOT
// hand Resend the address to fetch: Resend fetches after accepting the
// email, and if that fetch fails the email fails silently. If the logo
// cannot be fetched here, the email falls back to the linked logo it has
// always used — it is never lost over a picture.
const LOGO_URL = 'https://blackwoodmt5.com/logo-white.png';
const LOGO_CID = 'bw-logo';
let logoB64 = null, logoTriedAt = 0;
async function logoContent() {
  if (logoB64) return logoB64;
  if (Date.now() - logoTriedAt < 10 * 60 * 1000) return null;   // retry at most every 10 min
  logoTriedAt = Date.now();
  try {
    const r = await axios.get(LOGO_URL, { responseType: 'arraybuffer', timeout: 5000 });
    const type = String(r.headers && r.headers['content-type'] || '');
    const buf = Buffer.from(r.data);
    // Only a real, small image is embedded. Anything else — an error page,
    // a redirect to HTML, something huge — and the link is used instead.
    if (/^image\//.test(type) && buf.length > 0 && buf.length < 200 * 1024) logoB64 = buf.toString('base64');
    else console.warn('[EMAIL] logo fetch returned', type || 'no type', buf.length, 'bytes — using the linked logo');
  } catch (e) {
    console.warn('[EMAIL] could not fetch the logo — using the linked logo:', e.message);
  }
  return logoB64;
}

// Every route that sends a template with the logo goes through this, so
// no email can reference an embedded logo that was never attached — which
// would show as a broken image. (The welcome email sends on its own route,
// and would have done exactly that.)
async function withLogo(html) {
  if (!html.includes('cid:' + LOGO_CID)) return { html, attachments: undefined };
  const b64 = await logoContent();
  if (b64) return { html, attachments: [{ filename: 'blackwood-logo.png', content: b64, content_id: LOGO_CID }] };
  return { html: html.split('cid:' + LOGO_CID).join(LOGO_URL), attachments: undefined };  // fallback: linked logo
}

async function sendResend(toEmail, subject, html, tag, replyTo) {
  if (!RESEND_API_KEY) return emailDisabled(tag);
  if (!toEmail) return { ok: false, error: 'No recipient email' };
  let attachments;
  ({ html, attachments } = await withLogo(html));
  try {
    const { data } = await axios.post(
      'https://api.resend.com/emails',
      // reply_to only when asked for, so every existing email is sent
      // exactly as it was before.
      { from: FROM_EMAIL, to: [toEmail], subject, html,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(attachments ? { attachments } : {}) },
      { headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 12000 }
    );
    console.log(`[EMAIL] ${tag} sent to ${toEmail} — id: ${data.id}`);
    return { ok: true, id: data.id };
  } catch (e) {
    console.error(`[EMAIL] ${tag} failed:`, e.response?.data || e.message);
    return { ok: false, error: e.response?.data?.message || e.message };
  }
}

const fmtDate = d => new Date(d).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });

// ── MT5 licence key reminder (Lifetime plans only) ─────────────
// state: 'due' (before expiry) | 'grace' | 'lapsed'
// The reassurance block is NOT optional in any state. This email is the
// single most likely place for a Lifetime customer to conclude their
// platform access is being taken away, which it never is.
async function sendLicenceReminder(toEmail, name, opts) {
  const { daysLeft, state, expiresAt } = opts;
  const dateStr = fmtDate(expiresAt);
  const acct = `${SITE_URL}/account`;

  let headline, subhead, subject, paragraphs, accent = '#c9820a';

  if (state === 'lapsed') {
    accent   = '#e0504f';
    headline = 'Your MT5 licence key has expired';
    subhead  = `Expired ${dateStr}`;
    subject  = 'Your Blackwood MT5 licence key has expired';
    paragraphs = [
      `The grace period has ended, so the Blackwood Expert Advisor and indicators have stopped running in MetaTrader 5.`,
      `Renewing costs <strong style="color:#eceae0">$100 for 12 months</strong> and restores your existing licence key — you will not need to reinstall anything or re-enter a new key.`
    ];
  } else if (state === 'grace') {
    headline = 'Your MT5 licence key expired — grace period';
    subhead  = `${daysLeft} day${daysLeft === 1 ? '' : 's'} of grace remaining`;
    subject  = `Action needed: your Blackwood MT5 licence key expired`;
    paragraphs = [
      `Your MT5 licence key expired on ${dateStr}. There is a 14-day grace period, and <strong style="color:#eceae0">${daysLeft} day${daysLeft === 1 ? '' : 's'}</strong> of it remain.`,
      `When it ends, the Expert Advisor and indicators will stop running in MetaTrader 5. Renewing costs $100 for 12 months and keeps your existing key.`
    ];
  } else {
    headline = daysLeft === 0
      ? 'Your MT5 licence key expires today'
      : `Your MT5 licence key expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
    subhead  = `Term ends ${dateStr}`;
    subject  = daysLeft === 0
      ? 'Your Blackwood MT5 licence key expires today'
      : `Your Blackwood MT5 licence key expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
    paragraphs = [
      `The 12-month licence for the Blackwood Expert Advisor and indicators ends on ${dateStr}.`,
      `Renewing costs <strong style="color:#eceae0">$100 for 12 months</strong> and keeps your existing licence key, so nothing needs reinstalling. Renewing early adds 12 months to the date above rather than restarting from today.`
    ];
  }

  const html = buildNoticeEmail({
    name, accent, headline, subhead, paragraphs,
    reassurance: 'Your Lifetime platform access is not affected. Your dashboards, analysis modules and data stay open whatever happens to this key — the licence covers only the Expert Advisor and indicators running inside MetaTrader 5.',
    ctaUrl: acct,
    ctaLabel: 'Renew your licence →'
  });

  return sendResend(toEmail, subject, html, 'licence reminder');
}

// ── Subscription renewal reminder (Pro monthly / yearly) ───────
async function sendSubscriptionReminder(toEmail, name, planKey, daysLeft, expiresAt) {
  const isYearly = planKey === 'pro_yearly';
  const label = isYearly ? 'Pro Yearly' : 'Pro Monthly';
  const when  = daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;

  const html = buildNoticeEmail({
    name,
    headline: `Your Blackwood ${label} plan renews ${when}`,
    subhead:  `Renews ${fmtDate(expiresAt)}`,
    paragraphs: [
      `This is a reminder that your ${label} subscription renews ${when}.`,
      `No action is needed if your saved payment method is still valid. If it has changed, update it under Billing on your account page so the charge does not fail.`
    ],
    ctaUrl: `${SITE_URL}/account`,
    ctaLabel: 'Open Billing →'
  });

  return sendResend(toEmail, `Your Blackwood ${label} plan renews ${when}`, html, 'renewal reminder');
}

// ── Licence sharing notice ─────────────────────────────────────
// Sent by hand from the admin console, never automatically.
//
// Rewritten for the new scoring. The old copy quoted "N different
// MetaTrader account numbers", and account count is no longer what is
// scored — a trader running eight prop challenges is not sharing. It now
// says what kind of thing was seen, and deliberately NOT how it was
// measured: naming fingerprints or thresholds is a guide to avoiding them.
//
// The tone stays measured. The likeliest explanation is still a
// customer's own second machine, and accusing a paying customer over a
// VPS costs far more than asking politely.
//
// stage: 'warning' (first notice, nothing restricted)
//        'blocked' (dashboard paused)
// opts.accounts is still accepted from older callers and ignored.
async function sendSharingNotice(toEmail, name, opts) {
  const { stage } = opts || {};
  const isBlocked = stage === 'blocked';
  // Into Messages, where screenshots and documents can be attached and
  // the customer can follow progress — not a reply to an email address,
  // and never off to the website.
  const contact = `send us a message from the <strong style="color:#eceae0">Messages</strong> tab on your account page`;

  const html = buildNoticeEmail({
    name,
    accent:   isBlocked ? '#e0504f' : '#c9820a',
    headline: isBlocked ? 'Your Blackwood dashboard has been paused'
                        : 'A note about your Blackwood licence key',
    subhead:  isBlocked ? 'While we review how your licence is being used'
                        : 'This is a notice, not a restriction',
    paragraphs: isBlocked ? [
      `Your Blackwood licence key is issued for one trader. We've seen it used in a way that looks like more than one trader, so access to the Pro dashboard is paused while we take a look.`,
      `<strong style="color:#eceae0">Your EA, indicators and Telegram alerts are all still running</strong>, so any open trades remain fully covered. Nothing has been cancelled or charged.`,
      `If there's an explanation &mdash; a VPS, a second machine of your own, a prop-firm account in a company's name &mdash; ${contact} and we'll look at it quickly. We would much rather sort this out than lose you as a customer.`
    ] : [
      // Watch can be reached two ways: a second holder name, OR more
      // machines than one trader usually runs under a single name. Saying
      // only "a different name" would accuse the second kind of customer
      // of something that did not happen.
      `Your Blackwood licence key is issued for one trader. We've recently seen it used in a way we'd like to check &mdash; for instance with a MetaTrader account held in a different name, or on more machines than one trader usually runs.`,
      `If that's all yours &mdash; a joint, company, spouse's or prop-firm account, or your own VPS &mdash; there is nothing to worry about and nothing has been restricted. You're welcome to ${contact} so we can note it on your account.`,
      `Sharing a licence key with another trader isn't permitted under the Software Licence.`
    ],
    reassurance: isBlocked
      ? 'This pauses dashboard access only. Your subscription and licence key remain active, and it is reversible.'
      : 'No action has been taken on your account. This message is a courtesy so nothing comes as a surprise later.',
    ctaUrl:   `${SITE_URL}/account#messages`,
    ctaLabel: 'Open Messages →'
  });

  return sendResend(
    toEmail,
    isBlocked ? 'Your Blackwood dashboard has been paused'
              : 'A note about your Blackwood licence key',
    html,
    'sharing notice',
    SUPPORT_EMAIL || null
  );
}

// ── Send a simple renewal/expiry reminder (used later if needed) ──
async function sendExpiryReminder(toEmail, name, plan, daysLeft) {
  if (!RESEND_API_KEY) return emailDisabled('expiry reminder');
  if (!toEmail) return { ok: false, error: 'No recipient email' };

  try {
    const { data } = await axios.post(
      'https://api.resend.com/emails',
      {
        from:    FROM_EMAIL,
        to:      [toEmail],
        subject: `⏰ Your Blackwood ${PLAN_NAMES[plan] || plan} plan renews in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
        html: `
          <div style="font-family:Arial,sans-serif;background:#09090e;padding:40px;color:#eceae0">
            <h2 style="color:#c9820a">Blackwood</h2>
            <p>Hi ${escHtml(name) || 'there'}, your ${PLAN_NAMES[plan] || plan} subscription renews in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.</p>
            <p>Manage your subscription at <a href="${SITE_URL}" style="color:#c9820a">${SITE_URL}</a></p>
          </div>`
      },
      { headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[EMAIL] Reminder sent to ${toEmail} — id: ${data.id}`);
    return { ok: true, id: data.id };
  } catch (e) {
    console.error('[EMAIL] Reminder failed:', e.response?.data || e.message);
    return { ok: false, error: e.message };
  }
}


// ── Messages & Inbox ───────────────────────────────────────────
// Sent when you act on a conversation. Deliberately short, and never
// includes what anyone wrote — the conversation lives on the account
// page, where attachments and history sit together. The email only says
// there is something to look at.
//
// kind: 'reply' | 'waiting' | 'resolved' | 'restored'
async function sendSupportUpdate(toEmail, name, opts) {
  const { kind, subject } = opts || {};
  const about = subject ? `&ldquo;${escHtml(subject)}&rdquo;` : 'your message';
  const C = {
    reply: {
      mail: 'We have replied to your message',
      headline: 'We have replied to your message', subhead: 'Blackwood support',
      paragraphs: [`There is a reply waiting for you about ${about}.`,
                   'You can read it, and reply with screenshots or PDFs if that helps, from the Messages tab on your account page.'],
      cta: 'Open Messages →', accent: '#c9820a' },
    waiting: {
      mail: 'We need something from you',
      headline: 'We need something from you', subhead: 'So we can carry on',
      paragraphs: [`To keep going with ${about}, we need a little more from you.`,
                   'Our message on your account page explains what would help. Screenshots and PDFs can be attached straight to your reply.'],
      cta: 'Open Messages →', accent: '#c9820a' },
    resolved: {
      mail: 'Your message has been resolved',
      headline: 'Your message has been resolved', subhead: 'Blackwood support',
      paragraphs: [`We have marked ${about} as resolved.`,
                   'If anything is still not right, start a new message from your account page and we will pick it up.'],
      cta: 'Open Messages →', accent: '#17a97a' },
    reminder: {
      mail: 'A quick reminder about your message',
      headline: 'We are still waiting to hear from you', subhead: 'A friendly reminder',
      paragraphs: [`We asked for a little more information about ${about} a few days ago, and have not heard back yet.`,
                   'When you have a moment, reply from the Messages tab on your account page — screenshots and PDFs can be attached. If we do not hear back, we will close the conversation in a few days; you can still reopen it for a week after that.'],
      cta: 'Open Messages →', accent: '#c9820a' },
    autoclosed: {
      mail: 'We have closed your conversation',
      headline: 'We have closed your conversation', subhead: 'No reply for 7 days',
      paragraphs: [`We had not heard back about ${about} for a week, so we have closed it to keep things tidy.`,
                   'Nothing is lost. If you still need help, reopen it from the Messages tab within the next 7 days and we will pick it straight back up.'],
      cta: 'Open Messages →', accent: '#9a9890' },
    restored: {
      mail: 'Your review is complete',
      headline: 'Your review is complete', subhead: 'Your Pro Dashboard is available again',
      paragraphs: ['Thank you for your patience while we reviewed your licence. Our checks are complete and everything is in order, so your Pro Dashboard is available again.',
                   'Sign in to your account page to continue.'],
      cta: 'Open your account →', accent: '#17a97a' }
  }[kind];
  if (!C) return { ok: false, error: 'Unknown support email kind' };
  const html = buildNoticeEmail({
    name, accent: C.accent, headline: C.headline, subhead: C.subhead, paragraphs: C.paragraphs,
    ctaUrl: `${SITE_URL}/account#messages`, ctaLabel: C.cta
  });
  return sendResend(toEmail, C.mail, html, 'support ' + kind, SUPPORT_EMAIL || null);
}

// ── Access withdrawn ─────────────────────────────────────────────
// Sent automatically when you ban or suspend a customer. Before this,
// nothing was emailed: someone banned by mistake saw only their EA stop
// working, with no idea why or where to turn. It carries the reason you
// typed — already written for them to read — and points to Messages,
// which still works for them, so an appeal lands in your Inbox.
//
// status: 'banned' | 'suspended'
async function sendAccessNotice(toEmail, name, opts) {
  const { status, reason } = opts || {};
  const banned = status === 'banned';
  if (!banned && status !== 'suspended') return { ok: false, error: 'Only for bans and suspensions' };
  const html = buildNoticeEmail({
    name, accent: '#e0504f',
    headline: banned ? 'Your Blackwood licence has been withdrawn' : 'Your Blackwood access is suspended',
    subhead: banned ? 'Your licence key no longer works' : 'Your licence key is not working while this is in place',
    paragraphs: [
      reason ? `<strong style="color:#eceae0">Reason:</strong> ${escHtml(reason)}` : 'We have withdrawn access to your account.',
      banned ? 'Your licence key has stopped working on every terminal, and the Pro dashboard is closed.'
             : 'Your licence key and the Pro dashboard are paused for now.',
      'Your account, billing history and data are all still there, and you can still sign in.',
      'If you believe this is a mistake, send us a message from the <strong style="color:#eceae0">Messages</strong> tab on your account page and tell us what we should know — screenshots and documents can be attached.'
    ],
    reassurance: 'Every decision like this is reviewed by a person, and appeals are read.',
    ctaUrl: `${SITE_URL}/account#messages`, ctaLabel: 'Open Messages →'
  });
  return sendResend(toEmail,
    banned ? 'Your Blackwood licence has been withdrawn' : 'Your Blackwood access is suspended',
    html, 'access ' + status, SUPPORT_EMAIL || null);
}

// To YOU, when a customer starts a conversation — so a licence review
// does not sit unseen until you next open the console. Only sent when
// SUPPORT_EMAIL is set; there is nowhere else sensible to send it.
async function sendSupportAlert(opts) {
  if (!SUPPORT_EMAIL) return { ok: false, error: 'SUPPORT_EMAIL not set' };
  const { subject, topic, fromEmail } = opts || {};
  const TOPIC = { licence: 'Licence review', billing: 'Billing', technical: 'Technical help', other: 'Something else' };
  const html = buildNoticeEmail({
    name: null, accent: topic === 'licence' ? '#e0504f' : '#5b8def',
    headline: 'New message in your Inbox', subhead: TOPIC[topic] || 'Something else',
    paragraphs: [`<strong style="color:#eceae0">${escHtml(subject || '(no subject)')}</strong>`,
                 `From ${escHtml(fromEmail || 'a customer')}.`],
    ctaUrl: `${APP_URL}/admin`, ctaLabel: 'Open the Inbox →'
  });
  return sendResend(SUPPORT_EMAIL, `New message: ${String(subject || '').slice(0, 80)}`, html, 'support alert');
}

module.exports = { sendWelcomeEmail, sendExpiryReminder, sendLicenceReminder, sendSubscriptionReminder, sendSharingNotice,
                   sendSupportUpdate, sendSupportAlert, sendAccessNotice };
