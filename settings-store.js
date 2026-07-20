// settings-store.js
// Cross-device storage for the Trading Math Dashboard's Tool 01/02/03/06
// settings, keyed to the logged-in Supabase user. Mirrors journal-store.js's
// pattern: direct Supabase REST calls with the service role key, so it works
// the same way on Railway for every user without extra client setup.

const axios = require('axios');
const { SUPABASE_URL, supabaseServiceHeaders } = require('./auth-middleware');

const TABLE = 'user_math_settings';

// Returns the saved settings object for this user, or {} if none saved yet.
async function getSettingsForUser(userId) {
  const { data } = await axios.get(
    `${SUPABASE_URL}/rest/v1/${TABLE}?user_id=eq.${userId}&select=settings`,
    { headers: supabaseServiceHeaders() }
  );
  if (!data || !data.length) return {};
  return data[0].settings || {};
}

// Upserts (insert-or-update) this user's settings row.
async function saveSettingsForUser(userId, settings) {
  await axios.post(
    `${SUPABASE_URL}/rest/v1/${TABLE}`,
    { user_id: userId, settings, updated_at: new Date().toISOString() },
    {
      headers: {
        ...supabaseServiceHeaders(),
        'Prefer': 'resolution=merge-duplicates' // upsert on user_id primary key
      }
    }
  );
}

module.exports = { getSettingsForUser, saveSettingsForUser };
