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
const RESEND_API_KEY = process.env.RESEND_API_KEY;
if (!RESEND_API_KEY) {
  console.error(
    '[EMAIL] FATAL — RESEND_API_KEY is not set.\n' +
    '  Set it in Railway -> Variables, then redeploy.\n' +
    '  Welcome emails, licence reminders and renewal notices cannot send without it.'
  );
  throw new Error('email-service: RESEND_API_KEY is not set');
}
const FROM_EMAIL      = process.env.FROM_EMAIL      || 'Blackwood <noreply@blackwoodmt5.com>';
const SITE_URL        = (process.env.SITE_URL || 'https://blackwoodmt5.com').trim();
const RAILWAY_URL     = (process.env.RAILWAY_URL || 'https://nurturing-magic-production-3169.up.railway.app').trim();

// ── Plan display names ─────────────────────────────────────────
const PLAN_NAMES = {
  pro:      'Pro',
  lifetime: 'Lifetime'
};

// ── Build the welcome email HTML ───────────────────────────────
function buildWelcomeEmail(name, plan, licenceKey, expiresAt) {
  const planName = PLAN_NAMES[plan] || plan;
  const expiryLine = expiresAt
    ? `<p style="color:#9a9890;font-size:13px;margin:4px 0 0">Renews / expires: ${new Date(expiresAt).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}</p>`
    : `<p style="color:#c9820a;font-size:13px;margin:4px 0 0;font-weight:600">Lifetime access — never expires</p>`;

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
        <tr><td style="padding:32px 32px 0">
          <table role="presentation" width="100%" style="border-collapse:collapse">
            <tr>
              <td style="width:33%;text-align:left;vertical-align:middle">
                <img src="https://blackwoodmt5.com/logo-white.png" alt="Blackwood" width="30" height="30" style="display:block">
              </td>
              <td style="width:34%;text-align:center;vertical-align:middle">
                <span style="font-size:17px;font-weight:800;letter-spacing:.08em;color:#eceae0;text-transform:uppercase">Blackwood</span>
              </td>
              <td style="width:33%"></td>
            </tr>
          </table>
        </tr></td>

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
          <p style="color:#eceae0;font-size:15px;line-height:1.6;margin:0">Hi ${name || 'there'},</p>
          <p style="color:#9a9890;font-size:14px;line-height:1.7;margin:12px 0 0">
            Thank you for subscribing to Blackwood ${planName}. Your MT5 Assistant dashboard and licence key are ready below.
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
async function sendWelcomeEmail(toEmail, name, plan, licenceKey, expiresAt) {
  if (!toEmail) {
    console.warn('[EMAIL] No recipient email — skipping send');
    return { ok: false, error: 'No recipient email' };
  }

  const html = buildWelcomeEmail(name, plan, licenceKey, expiresAt);
  const planName = PLAN_NAMES[plan] || plan;

  try {
    const { data } = await axios.post(
      'https://api.resend.com/emails',
      {
        from:    FROM_EMAIL,
        to:      [toEmail],
        subject: `🎉 Welcome to Blackwood ${planName} — your licence key inside`,
        html
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

        <tr><td style="padding:32px 32px 0">
          <table role="presentation" width="100%" style="border-collapse:collapse">
            <tr>
              <td style="width:33%;text-align:left;vertical-align:middle">
                <img src="https://blackwoodmt5.com/logo-white.png" alt="Blackwood" width="30" height="30" style="display:block">
              </td>
              <td style="width:34%;text-align:center;vertical-align:middle">
                <span style="font-size:17px;font-weight:800;letter-spacing:.08em;color:#eceae0;text-transform:uppercase">Blackwood</span>
              </td>
              <td style="width:33%"></td>
            </tr>
          </table>
        </td></tr>

        <tr><td style="padding:24px 32px 0">
          <div style="background:rgba(201,130,10,.12);border:1px solid ${accent}55;border-radius:8px;padding:16px 20px;text-align:center">
            <div style="color:${accent};font-size:16px;font-weight:700">${opts.headline}</div>
            ${opts.subhead ? `<div style="color:#9a9890;font-size:13px;margin-top:4px">${opts.subhead}</div>` : ''}
          </div>
        </td></tr>

        <tr><td style="padding:24px 32px 0">
          <p style="color:#eceae0;font-size:15px;line-height:1.6;margin:0">Hi ${opts.name || 'there'},</p>
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

async function sendResend(toEmail, subject, html, tag) {
  if (!toEmail) return { ok: false, error: 'No recipient email' };
  try {
    const { data } = await axios.post(
      'https://api.resend.com/emails',
      { from: FROM_EMAIL, to: [toEmail], subject, html },
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
  const acct = `${SITE_URL}/account.html`;

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
    ctaUrl: `${SITE_URL}/account.html`,
    ctaLabel: 'Open Billing →'
  });

  return sendResend(toEmail, `Your Blackwood ${label} plan renews ${when}`, html, 'renewal reminder');
}

// ── Send a simple renewal/expiry reminder (used later if needed) ──
async function sendExpiryReminder(toEmail, name, plan, daysLeft) {
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
            <p>Hi ${name || 'there'}, your ${PLAN_NAMES[plan] || plan} subscription renews in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.</p>
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

module.exports = { sendWelcomeEmail, sendExpiryReminder, sendLicenceReminder, sendSubscriptionReminder };
