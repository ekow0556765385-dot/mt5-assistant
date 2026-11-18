// ═══ TRADER INTERVIEWS ═══════════════════════════════════════════════════
// Saves each trader's Part A answers (who they are, and the agreement they
// ticked before creating the account) and their Part B result (can they read
// the dashboards). Stored in Supabase table trader_profiles - see the SQL in
// the deploy notes. Until that table exists every route answers
// { ready:false } and the site lets everyone through, so deploying this before
// the table cannot lock anyone out.
//
// Part A answers are kept exactly as first given: they are the record the
// daily and weekly reviews compare against, and the record shown if a trader
// later says the software does not work, so they are never overwritten.
const express = require('express');
const axios = require('axios');

// Part B's right answers. Must match BQ in bw-interviews.js (index.html and account.html).
const PART_B_KEY = { b1:1, b2:1, b3:0, b4:1, b5:1, b6:1, b7:1, b8:1, b9:1, b10:1, b11:1, b12:2 };
const PART_B_PASS = 10;
const PART_A_IDS = ['years','real','what','prop','lots','stop','risk','want','ret','afford','s1','s2','s3','s4'];

module.exports = function interviewsRoute({ requireAuth, SUPABASE_URL, supabaseServiceHeaders }) {
  const router = express.Router();
  const TABLE = `${SUPABASE_URL}/rest/v1/trader_profiles`;
  const headers = (extra) => Object.assign({ 'Content-Type': 'application/json' }, supabaseServiceHeaders(), extra || {});

  function tableMissing(e) {
    const r = e && e.response;
    if (!r) return false;
    const body = JSON.stringify(r.data || '');
    return r.status === 404 || /trader_profiles|does not exist|Could not find the table|PGRST205|42P01/i.test(body) && r.status >= 400 && r.status < 500;
  }
  async function getRow(userId) {
    const { data } = await axios.get(`${TABLE}?user_id=eq.${encodeURIComponent(userId)}&select=*`, { headers: headers() });
    return (data && data[0]) || null;
  }
  async function upsert(row) {
    await axios.post(`${TABLE}?on_conflict=user_id`, row,
      { headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }) });
  }
  function summary(row) {
    return {
      ready: true,
      partA: { done: !!(row && row.part_a), at: (row && row.part_a_at) || null },
      agreedAt: (row && row.agreed_at) || null,
      partB: {
        passed: !!(row && row.part_b_passed_at),
        at: (row && row.part_b_passed_at) || null,
        score: row && row.part_b_score != null ? row.part_b_score : null,
        attempts: (row && row.part_b_attempts) || 0,
      },
    };
  }

  // Where this account stands.
  router.get('/api/interviews/me', requireAuth, async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(summary(await getRow(req.user.id)));
    } catch (e) {
      if (tableMissing(e)) return res.json({ ready: false });
      console.error('[INTERVIEWS] me:', e.response ? JSON.stringify(e.response.data) : e.message);
      res.status(500).json({ error: 'Could not read your interview status.' });
    }
  });

  // Part A plus the agreement. Saved once; later attempts keep the original.
  router.post('/api/interviews/part-a', requireAuth, async (req, res) => {
    try {
      const b = req.body || {};
      const answers = b.answers;
      if (!answers || typeof answers !== 'object') return res.status(400).json({ error: 'Missing answers.' });
      if (b.agreed !== true || typeof b.ack !== 'string' || b.ack.length < 20) return res.status(400).json({ error: 'The agreement must be ticked.' });
      // Keep only the known questions, as short strings, so nothing odd is stored.
      const clean = {};
      PART_A_IDS.forEach(id => {
        const v = answers[id];
        if (Array.isArray(v)) clean[id] = v.slice(0, 6).map(x => String(x).slice(0, 120));
        else if (v != null) clean[id] = String(v).slice(0, 160);
      });
      if (Object.keys(clean).length < 12) return res.status(400).json({ error: 'Please answer every question.' });
      const facts = {};
      if (b.facts && typeof b.facts === 'object') Object.keys(b.facts).slice(0, 20).forEach(k => {
        const n = Number(b.facts[k]); if (isFinite(n)) facts[String(k).slice(0, 20)] = n;
      });

      const existing = await getRow(req.user.id);
      if (existing && existing.part_a) return res.json(Object.assign(summary(existing), { kept: true }));

      const now = new Date().toISOString();
      await upsert({
        user_id: req.user.id,
        part_a: { version: Number(b.version) || 1, answers: clean, facts, answered_at: typeof b.at === 'string' ? b.at.slice(0, 40) : null },
        part_a_at: now,
        agreed_at: now,
        agree_text: b.ack.slice(0, 400),
        updated_at: now,
      });
      res.json(summary(await getRow(req.user.id)));
    } catch (e) {
      if (tableMissing(e)) return res.json({ ready: false });
      console.error('[INTERVIEWS] part-a:', e.response ? JSON.stringify(e.response.data) : e.message);
      res.status(500).json({ error: 'Could not save your answers.' });
    }
  });

  // Part B. Scored here, from the answers, not from the score the page sends.
  router.post('/api/interviews/part-b', requireAuth, async (req, res) => {
    try {
      const given = (req.body && req.body.answers) || {};
      let score = 0;
      const kept = {};
      Object.keys(PART_B_KEY).forEach(id => {
        const v = Number(given[id]);
        if (isFinite(v)) { kept[id] = v; if (v === PART_B_KEY[id]) score++; }
      });
      const passed = score >= PART_B_PASS;
      const row = await getRow(req.user.id);
      const now = new Date().toISOString();
      const upd = {
        user_id: req.user.id,
        part_b_score: score,
        part_b_attempts: ((row && row.part_b_attempts) || 0) + 1,
        part_b_last: { answers: kept, score, total: Object.keys(PART_B_KEY).length, at: now },
        updated_at: now,
      };
      if (passed && !(row && row.part_b_passed_at)) upd.part_b_passed_at = now;
      // A later lower score never takes away a pass already earned.
      if (row && row.part_b_passed_at) upd.part_b_score = Math.max(score, row.part_b_score || 0);
      await upsert(upd);
      res.json({ passed: passed || !!(row && row.part_b_passed_at), score, total: Object.keys(PART_B_KEY).length });
    } catch (e) {
      if (tableMissing(e)) return res.json({ ready: false, passed: true });
      console.error('[INTERVIEWS] part-b:', e.response ? JSON.stringify(e.response.data) : e.message);
      res.status(500).json({ error: 'Could not save your result.' });
    }
  });

  return router;
};

// For the admin console: the full record for one account.
module.exports.readForAdmin = async function readForAdmin(SUPABASE_URL, supabaseServiceHeaders, userId) {
  try {
    const { data } = await axios.get(`${SUPABASE_URL}/rest/v1/trader_profiles?user_id=eq.${encodeURIComponent(userId)}&select=*`,
      { headers: supabaseServiceHeaders() });
    return { ready: true, row: (data && data[0]) || null };
  } catch (e) {
    const r = e && e.response;
    if (r && r.status >= 400 && r.status < 500) return { ready: false, row: null };
    throw e;
  }
};
