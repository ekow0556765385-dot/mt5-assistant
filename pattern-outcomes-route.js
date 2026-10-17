// ═══════════════════════════════════════════════════════════════════
// pattern-outcomes-route.js — the Reliability tab's record, per ACCOUNT
//
// The Pattern Detector used to keep its "which patterns worked" log in the
// browser only, so a phone and a desktop each had their own half of the
// history. This keeps one copy per user on the server, and every device
// merges into it.
//
// Light on purpose:
//   - one small JSON file per user (at most 400 entries, ~60 KB), in the
//     same USER_DATA_DIR the math dashboard already uses
//   - the page reads it ONCE when it opens and writes only when its own
//     log changed, at most once a minute — not on the 5-second poll
//   - the file is held in memory after the first read, so a GET does not
//     touch the disk again
//   - a write from one user is ignored if it comes within 20 s of their
//     last one, so a buggy or duplicated tab cannot hammer the server
//
// Mount (app.js), after the requirePlan import:
//   require('./pattern-outcomes-route')(app, { requirePlan, USER_DATA_DIR });
// ═══════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 400;
const KEEP_MS = 31 * 24 * 3600 * 1000;    // the tab shows the last 30 days
const MIN_WRITE_GAP_MS = 20 * 1000;

module.exports = function mount(app, deps) {
  const requirePlan = deps.requirePlan;
  const DIR = deps.USER_DATA_DIR;
  const cache = new Map();      // userId -> entries[]
  const lastWrite = new Map();  // userId -> ms

  const safe = id => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const fileOf = id => path.join(DIR, 'pattern_outcomes_' + safe(id) + '.json');

  function load(id) {
    if (cache.has(id)) return cache.get(id);
    let list = [];
    try { list = JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    cache.set(id, list);
    return list;
  }

  // Only the fields the page uses, with the right types — nothing else is stored.
  function clean(x) {
    if (!x || typeof x !== 'object' || typeof x.k !== 'string' || !x.k) return null;
    const num = v => (v === null || v === undefined || !isFinite(+v)) ? null : +v;
    return {
      k: x.k.slice(0, 200), n: String(x.n || '').slice(0, 80), p: String(x.p || '').slice(0, 20),
      tf: String(x.tf || '').slice(0, 5), dir: x.dir === 'bull' ? 'bull' : 'bear',
      t: num(x.t), px: num(x.px), h1: num(x.h1), h4: num(x.h4)
    };
  }

  // Union by key. A resolved price (h1/h4) is never lost: if either side has it, keep it.
  function merge(a, b) {
    const by = new Map();
    a.concat(b).forEach(x => {
      const c = clean(x); if (!c || !c.t) return;
      const o = by.get(c.k);
      if (!o) { by.set(c.k, c); return; }
      if (o.h1 === null && c.h1 !== null) o.h1 = c.h1;
      if (o.h4 === null && c.h4 !== null) o.h4 = c.h4;
    });
    const cut = Date.now() - KEEP_MS;
    return Array.from(by.values()).filter(x => x.t >= cut)
      .sort((x, y) => x.t - y.t).slice(-MAX_ENTRIES);
  }

  app.get('/api/pattern-outcomes', requirePlan('pro'), (req, res) => {
    try { res.json({ entries: load(req.user.id) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/pattern-outcomes', requirePlan('pro'), (req, res) => {
    try {
      const id = req.user.id;
      const incoming = (req.body && Array.isArray(req.body.entries)) ? req.body.entries.slice(-MAX_ENTRIES) : null;
      if (!incoming) return res.status(400).json({ error: 'entries array required' });
      const now = Date.now();
      if (now - (lastWrite.get(id) || 0) < MIN_WRITE_GAP_MS)
        return res.json({ entries: load(id), skipped: true });
      lastWrite.set(id, now);
      const merged = merge(load(id), incoming);
      cache.set(id, merged);
      fs.writeFile(fileOf(id), JSON.stringify(merged), () => {});   // async: never blocks the server
      res.json({ entries: merged });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
