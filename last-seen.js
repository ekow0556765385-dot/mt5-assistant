// ═══════════════════════════════════════════════════════════════
// last-seen.js — when did this account last actually use Blackwood?
//
// The admin console previously answered this from the EA feed registry,
// which only knows about terminals. A free user has no EA, so they read
// "Never" no matter how often they signed in — and the in-memory
// registry was wiped on every deploy anyway.
//
// This records a real timestamp on the account row, so it survives
// restarts and covers everyone.
//
// Writing on every request would mean a database round trip per API
// call for a value read twice a day, so writes are throttled to one per
// user per THROTTLE_MS and the timestamp is kept in memory in between.
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;

const THROTTLE_MS = 5 * 60 * 1000;

// userId -> { lastWrite, lastSeen }
const memory = new Map();

function touch(userId) {
  if (!userId) return;
  const now = Date.now();
  const rec = memory.get(userId) || { lastWrite: 0, lastSeen: 0 };
  rec.lastSeen = now;
  memory.set(userId, rec);

  if (now - rec.lastWrite < THROTTLE_MS) return;
  rec.lastWrite = now;

  if (!SUPABASE_URL || !SUPABASE_SVC) return;
  // Fire and forget. Knowing when someone last signed in is never worth
  // slowing down or failing the request they are making.
  axios.patch(
    `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}`,
    { last_seen_at: new Date(now).toISOString() },
    { headers: { Authorization: `Bearer ${SUPABASE_SVC}`, apikey: SUPABASE_SVC,
                 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      timeout: 6000 }
  ).catch(e => {
    // A missing column should say so once, not once per request.
    if (!touch._warned) {
      touch._warned = true;
      console.warn('[LASTSEEN] could not record activity (is last_seen_at migrated?):',
                   e.response?.data?.message || e.message);
    }
  });
}

// In-memory value is fresher than the row between throttled writes.
function recent(userId) {
  return memory.get(userId)?.lastSeen || 0;
}

module.exports = { touch, recent, THROTTLE_MS };
