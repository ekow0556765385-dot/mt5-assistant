/* ══════════════════════════════════════════════════════════════════
   mfb-check.js — find out WHY the MyFxBook merge produced nothing

   Run it on the server, next to app.js:
       node mfb-check.js

   It answers four questions in order, and stops at the first failure:
     1. does the page respond at all?
     2. does the response contain a calendar, or is it a JS shell?
     3. do any rows survive the HIGH filter?
     4. do currency, time and title all parse?

   Guessing at step 3 when the answer is step 2 wastes a day, which is
   why this prints the evidence rather than a verdict.
   ══════════════════════════════════════════════════════════════════ */
const axios = require('axios');

const URL = 'https://www.myfxbook.com/forex-economic-calendar';

(async () => {
  console.log('--- 1. fetching', URL);
  let html;
  try {
    const r = await axios.get(URL, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BlackwoodMT5/1.0; +https://blackwoodmt5.com)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      validateStatus: () => true
    });
    console.log('    status :', r.status);
    console.log('    type   :', r.headers['content-type']);
    console.log('    bytes  :', String(r.data).length);
    if (r.status !== 200) {
      console.log('\n>> STOP: they did not serve the page. A 403 means the request was');
      console.log('   refused; a 3xx means it moved. Nothing downstream can work.');
      return;
    }
    html = String(r.data);
  } catch (e) {
    console.log('    FAILED :', e.message);
    console.log('\n>> STOP: the server could not reach them at all — DNS, egress');
    console.log('   firewall or timeout. Check the host can make outbound requests.');
    return;
  }

  console.log('\n--- 2. is the calendar IN the html, or rendered by javascript?');
  const trCount = (html.match(/<tr\b/gi) || []).length;
  const tdCount = (html.match(/<td\b/gi) || []).length;
  const hasCcy  = /\b(USD|EUR|GBP|JPY|CHF)\b/.test(html);
  const hasHigh = /high/i.test(html);
  console.log('    <tr> tags        :', trCount);
  console.log('    <td> tags        :', tdCount);
  console.log('    currency codes   :', hasCcy);
  console.log('    the word "high"  :', hasHigh);
  if (trCount < 5 || tdCount < 10) {
    console.log('\n>> STOP: there is no table in the delivered html.');
    console.log('   MyFxBook builds that calendar in the BROWSER, so the server');
    console.log('   receives an empty shell. A plain fetch can never see it.');
    console.log('   Options, cheapest first:');
    console.log('     a) find the XHR their page calls and request that directly');
    console.log('     b) render the page headlessly (playwright) before parsing');
    console.log('     c) drop the second calendar and curate a named event list');
    return;
  }

  console.log('\n--- 3. rows that look like calendar rows');
  const trs = html.split(/<tr\b/i).slice(1);
  const CCY = /\b(USD|EUR|GBP|JPY|CHF|AUD|CAD|NZD)\b/;
  let withCcy = 0, withHigh = 0;
  const samples = [];
  for (const tr of trs) {
    const cells = (tr.match(/<td[\s\S]*?<\/td>/gi) || [])
      .map(c => c.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    if (cells.length < 4) continue;
    const line = cells.join(' | ');
    if (!CCY.test(line)) continue;
    withCcy++;
    if (/high/i.test(line) || /impact-high|sprite-high/i.test(tr)) {
      withHigh++;
      if (samples.length < 4) samples.push({ cells, raw: tr.slice(0, 260) });
    }
  }
  console.log('    rows with a currency :', withCcy);
  console.log('    of those, HIGH       :', withHigh);
  if (!withCcy) {
    console.log('\n>> STOP: rows exist but none carry a currency code. Their column');
    console.log('   layout has changed — send me one raw <tr> and I will re-aim it.');
    return;
  }
  if (!withHigh) {
    console.log('\n>> STOP: rows parse, but none are marked HIGH by the current test.');
    console.log('   They probably mark impact with an icon class rather than the');
    console.log('   word. Print a row below and I will match on the class instead.');
    console.log('   sample row:', trs.find(t => CCY.test(t)).slice(0, 300));
    return;
  }

  console.log('\n--- 4. do the three required fields parse?');
  samples.forEach((s, i) => {
    console.log(`\n  row ${i + 1}: ${s.cells.join(' | ').slice(0, 150)}`);
    const c = CCY.exec(s.cells.join(' | '));
    const attr = /data-(?:timestamp|event-date|date)="(\d{9,13})"/i.exec(s.raw);
    const d = /\b([A-Z][a-z]{2})\s+(\d{1,2})\b/.exec(s.cells.join(' | '));
    const t = /\b(\d{1,2}):(\d{2})\b/.exec(s.cells.join(' | '));
    const title = s.cells.find(x =>
      x.length > 5 && /[A-Za-z]{3}/.test(x) && !CCY.test(x) &&
      !/^[A-Z][a-z]{2}\s+\d{1,2}$/.test(x) && !/^\d{1,2}:\d{2}$/.test(x) &&
      !/^-?[\d.,]+\s*[KMB%]?$/.test(x) && !/^(high|medium|low)$/i.test(x));
    console.log('    currency :', c ? c[1] : 'NOT FOUND');
    console.log('    time     :', attr ? 'data attribute ' + attr[1]
                                : (d && t) ? `${d[1]} ${d[2]} ${t[1]}:${t[2]}` : 'NOT FOUND');
    console.log('    title    :', title || 'NOT FOUND');
  });

  console.log('\n--- verdict');
  console.log('    If all three fields read on every row above, the parser works and');
  console.log('    the problem is downstream — check the app.js logs for');
  console.log('    "[NEWS] MyFxBook:".  If any says NOT FOUND, paste that row to me.');
})();
