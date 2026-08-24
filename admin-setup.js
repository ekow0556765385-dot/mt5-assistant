#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// admin-setup.js — run ONCE locally to generate your admin env vars.
//
//   node admin-setup.js you@example.com
//
// Prints four values to paste into Railway. Nothing is written to
// disk and the password is never stored anywhere in plain text.
// Run it locally, not on the server — the password is typed here.
// ═══════════════════════════════════════════════════════════════

const crypto   = require('crypto');
const readline = require('readline');
const { hashPassword } = require('./admin-auth');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += B32[(value << (5 - bits)) & 31];
  return out;
}

const email = process.argv[2];
if (!email || !email.includes('@')) {
  console.error('Usage: node admin-setup.js you@example.com');
  process.exit(1);
}

function askHidden(q) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = c => {
      c = c + '';
      if ([ '\n', '\r', '\u0004' ].includes(c)) process.stdin.pause();
      else process.stdout.write('\x1b[2K\x1b[200D' + q + '*'.repeat(rl.line.length));
    };
    process.stdin.on('data', onData);
    rl.question(q, ans => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(ans);
    });
  });
}

(async () => {
  const pw = await askHidden('Choose an admin password: ');
  if (pw.length < 12) {
    console.error('\nToo short. Use at least 12 characters — this password guards every account on the platform.');
    process.exit(1);
  }
  const again = await askHidden('Type it again: ');
  if (pw !== again) { console.error('\nThey do not match.'); process.exit(1); }

  const totpSecret = base32Encode(crypto.randomBytes(20));
  const otpauth = `otpauth://totp/Blackwood%20Admin:${encodeURIComponent(email)}` +
                  `?secret=${totpSecret}&issuer=Blackwood&algorithm=SHA1&digits=6&period=30`;

  console.log(`
──────────────────────────────────────────────────────────────
Paste these into Railway → Variables, then redeploy.
──────────────────────────────────────────────────────────────

ADMIN_EMAIL=${email}
ADMIN_PASSWORD_HASH=${hashPassword(pw)}
ADMIN_TOTP_SECRET=${totpSecret}
ADMIN_SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}

──────────────────────────────────────────────────────────────
Add the authenticator BEFORE you redeploy, or you will be
locked out of your own console. In Google Authenticator, Authy,
1Password or similar, choose "enter a setup key" and use:

  Account:  Blackwood Admin (${email})
  Key:      ${totpSecret}
  Type:     Time based

Or scan this URL as a QR code:

  ${otpauth}

Write the key down somewhere offline. There is no recovery
path — losing it means editing the Railway variable to reset.
──────────────────────────────────────────────────────────────
`);
})();
