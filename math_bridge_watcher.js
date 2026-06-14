// ============================================================
// math_bridge_watcher.js
// Reads math_bridge_data.json written by MathReporter.mq5
// and POSTs it to Railway /api/math-trades
// 
// HOW TO USE:
// Add this require() into your existing mt5_bridge.js, OR
// run as a separate process: node math_bridge_watcher.js
// ============================================================

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const RAILWAY_URL  = process.env.RAILWAY_URL || 'https://nurturing-magic-production-3169.up.railway.app';
const ENDPOINT     = `${RAILWAY_URL}/api/math-trades`;
const POLL_MS      = 5000; // check every 5s

// MT5 common files path — same logic as your existing mt5_bridge.js
function getMT5CommonPath() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'MetaQuotes', 'Terminal', 'Common', 'Files'),
    'C:\\Users\\' + (process.env.USERNAME || '') + '\\AppData\\Roaming\\MetaQuotes\\Terminal\\Common\\Files',
    path.join(process.env.HOME || '', '.wine', 'drive_c', 'users', 'user',
              'AppData', 'Roaming', 'MetaQuotes', 'Terminal', 'Common', 'Files')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Fallback: same directory as this script
  return __dirname;
}

const MT5_COMMON = getMT5CommonPath();
const BRIDGE_FILE = path.join(MT5_COMMON, 'math_bridge_data.json');

let lastMtime   = 0;
let lastSentAt  = 0;
const MIN_INTERVAL_MS = 28000; // don't send more than once per 28s

console.log(`[MathBridge] Watching: ${BRIDGE_FILE}`);
console.log(`[MathBridge] POSTing to: ${ENDPOINT}`);

async function checkAndSend() {
  try {
    if (!fs.existsSync(BRIDGE_FILE)) return;

    const stat = fs.statSync(BRIDGE_FILE);
    const mtime = stat.mtimeMs;

    // Only send if file was modified since last check
    if (mtime <= lastMtime) return;

    // Rate limit
    const now = Date.now();
    if (now - lastSentAt < MIN_INTERVAL_MS) return;

    lastMtime = mtime;

    // Read and parse
    let raw = fs.readFileSync(BRIDGE_FILE, 'utf8');

    // Handle UTF-16 LE BOM that MT5 sometimes writes
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    if (raw.includes('\x00')) {
      // UTF-16 — decode properly
      const buf = fs.readFileSync(BRIDGE_FILE);
      raw = buf.toString('utf16le').replace(/^\uFEFF/, '');
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch(e) {
      console.error('[MathBridge] JSON parse error:', e.message);
      return;
    }

    if (!data || (!data.account && !data.closed_trades)) return;

    // POST to Railway
    const res = await axios.post(ENDPOINT, data, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });

    lastSentAt = Date.now();
    const info = res.data;
    console.log(`[MathBridge] Sent OK — closed: ${info.closed || 0}, new: ${info.new_trades || 0}`);

  } catch(e) {
    if (e.code === 'ECONNREFUSED') {
      console.warn('[MathBridge] Railway not reachable — will retry');
    } else {
      console.error('[MathBridge] Error:', e.message);
    }
  }
}

// Start polling
setInterval(checkAndSend, POLL_MS);
checkAndSend(); // immediate check on start

module.exports = { checkAndSend };
