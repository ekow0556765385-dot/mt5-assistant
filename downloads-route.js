// ── /api/downloads — gated file delivery for Pro subscribers ──────
//
// Add this block to app.js, near your other protected routes.
// Requires requireAuth + requirePlan (already imported from
// ./auth-middleware at the top of app.js) and the Supabase service
// client already used elsewhere (SUPABASE_URL, supabaseServiceHeaders).
//
// SETUP REQUIRED before this works:
// 1. In Supabase Storage, create a PRIVATE bucket named "downloads"
//    (private = no public URL, only reachable via signed URL).
// 2. Upload the compiled .ex5 files (never .mq5 source) plus the
//    bridge watcher and instruction docs, using the exact keys in
//    DOWNLOAD_CATALOG below.
// 3. This route mints a short-lived signed URL per click — nothing
//    is ever cached or reused; every request checks live subscription
//    status against Supabase, not a cached session value.

const axios = require('axios'); // already required elsewhere in app.js

// ── Catalog of downloadable files ──────────────────────────────────
// `path` is the object key inside the "downloads" bucket.
// `audience` filters what the frontend shows:
//   "all"     -> every Pro subscriber
//   "bridge"  -> only users on file-bridge brokers (Exness etc.)
const DOWNLOAD_CATALOG = [
  { id: 'ea',            name: 'Blackwood MT5 Assistant (EA)',        path: 'ea/Mt5_tradingassistant_v3.91.ex5',              audience: 'all'    },
  { id: 'structure',     name: 'Structure Signal Indicator',          path: 'indicators/StructureSignal2.ex5',                audience: 'all'    },
  { id: 'smc',           name: 'Smart Money Concepts Indicator',      path: 'indicators/SmartMoneyConceptsIndicator.ex5',     audience: 'all'    },
  { id: 'patterns',      name: 'Pattern Detector v4',                 path: 'indicators/PatternDetector_v4.ex5',              audience: 'all'    },
  { id: 'candles',       name: 'Candle Pattern Indicator',            path: 'indicators/CandlePatternIndicator.ex5',          audience: 'all'    },
  { id: 'journal',       name: 'Journal Reporter (EA)',               path: 'ea/JournalReporter.ex5',                         audience: 'all'    },
  { id: 'math',          name: 'Math Reporter (EA)',                  path: 'ea/MathReporter.ex5',                           audience: 'all'    },
  { id: 'bridge-watcher',name: 'File Bridge Watcher (Exness/etc.)',   path: 'bridge/mt5_bridge_watcher.exe',                  audience: 'bridge' },
  { id: 'setup-guide',   name: 'Setup Guide (PDF)',                   path: 'docs/setup-guide.pdf',                           audience: 'all'    },
  { id: 'dashboard-guide', name: 'Dashboard Guide (PDF)',             path: 'docs/dashboard-guide.pdf',                       audience: 'all'    },
];

// GET /api/downloads — list what this subscriber can see (no file
// content yet, just the catalog filtered to what applies to them).
// Frontend renders a button per entry; each button click hits
// /api/downloads/:id below to get an actual signed URL.
app.get('/api/downloads', requireAuth, requirePlan('pro'), (req, res) => {
  // audience is currently just "all" vs "bridge" — if you want to only
  // show the bridge watcher to Exness users specifically, store their
  // detected broker on the user record and filter here. For now this
  // shows everything and lets the setup guide explain who needs what.
  res.json({ files: DOWNLOAD_CATALOG.map(({ id, name, audience }) => ({ id, name, audience })) });
});

// GET /api/downloads/:id — mint a short-lived signed URL for one file.
// Live subscription check happens here, on every single click — this
// is what makes a downgrade take effect immediately and a re-subscribe
// restore access immediately, with no separate on/off step anywhere.
app.get('/api/downloads/:id', requireAuth, async (req, res) => {
  const entry = DOWNLOAD_CATALOG.find(f => f.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Unknown file' });

  try {
    // Live plan check — NOT cached, NOT read from the JWT/session.
    // requirePlan('pro') as middleware would work too, but doing it
    // explicitly here makes the "checked live, every click" behavior
    // visible rather than implicit in a shared middleware.
    const { data: subRows } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${req.user.id}&select=plan,status`,
      { headers: supabaseServiceHeaders() }
    );
    const sub = subRows && subRows[0];
    if (!sub || sub.plan !== 'pro' || sub.status !== 'active') {
      return res.status(403).json({ error: 'Pro subscription required for downloads' });
    }

    // Mint a signed URL against the private "downloads" bucket.
    // 300 seconds is plenty for a browser to actually fetch the file
    // after receiving the URL, short enough that a copied link is
    // useless a few minutes later.
    const { data: signed } = await axios.post(
      `${SUPABASE_URL}/storage/v1/object/sign/downloads/${entry.path}`,
      { expiresIn: 300 },
      { headers: supabaseServiceHeaders({ 'Content-Type': 'application/json' }) }
    );

    if (!signed || !signed.signedURL) {
      console.error('[DOWNLOADS] Failed to sign URL for', entry.path);
      return res.status(500).json({ error: 'Could not generate download link' });
    }

    console.log(`[DOWNLOADS] Signed URL issued: user=${req.user.id} file=${entry.id}`);
    res.json({ url: `${SUPABASE_URL}/storage/v1${signed.signedURL}` });

  } catch (e) {
    console.error('[DOWNLOADS] Error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Server error' });
  }
});
