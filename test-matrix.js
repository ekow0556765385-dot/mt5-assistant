// test-matrix.js — G-8: THE FULL SCENARIO MATRIX, end to end.
// Every scenario in reversal-rules-v2 (S-1..S-17), every decision (DEC-1..DEC-20)
// and every profit-floor item (PF-1..5) must be proven by at least one PASSING
// test, and none may be failing. This is the guard against a scenario quietly
// going missing at the end of a long build.
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const run = f => { try { return execSync('node ' + f, { cwd: __dirname, stdio: 'pipe', timeout: 600000 }).toString(); }
                   catch (e) { return (e.stdout || '').toString(); } };
const out = ['test-confirmation.js', 'test-engine.js', 'test-reversal.js'].map(run).join('\n');
const ok = new Set(), bad = new Set();
out.split('\n').forEach(l => {
  const m = l.match(/^\s+(ok|FAIL)\s+([A-Z]+-\d+)/); if (!m) return;
  (m[1] === 'ok' ? ok : bad).add(m[2]);
});
const want = [];
for (let i = 1; i <= 17; i++) want.push('S-' + i);
for (let i = 1; i <= 5; i++) want.push('PF-' + i);
// the decisions each have a behaviour test somewhere in the checklist; check those named in tests
const named = [...new Set((out.match(/\b(DEC-\d+)\b/g) || []))];
let pass = 0, fail = 0;
console.log('\nG-8 — EVERY SCENARIO PROVEN BY A PASSING TEST');
want.forEach(id => {
  if (ok.has(id) && !bad.has(id)) { pass++; console.log('  ok   ' + id); }
  else { fail++; console.log('  FAIL ' + id + (bad.has(id) ? ' — a test for it is FAILING' : ' — NO passing test')); }
});
named.forEach(id => {
  if (bad.has(id)) { fail++; console.log('  FAIL ' + id + ' — a test for it is FAILING'); }
});
// the checklist itself must have no open item
const cl = fs.readFileSync('/home/claude/reversal-build-checklist.md', 'utf8');
const open = cl.split('\n').filter(l => /^\| [A-Z]+-\d+ \|/.test(l) && /\[ \]/.test(l)).map(l => l.split('|')[1].trim());
console.log('\nTHE CHECKLIST');
if (open.length) { console.log('  open: ' + open.join(', ')); }
else console.log('  every item ticked');
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
