// patternDetector.js
// Detects candlestick patterns on an array of candles
// Each candle: { o, h, l, c, t }  (t = timestamp/label)
// Returns array of pattern objects

function detectPatterns(candles, timeframe) {
  const results = [];
  if (!Array.isArray(candles)) return results;

  // Accept either key style. This function reads o/h/l/c, but /api/candles
  // was fed time/open/high/low/close by the EA, which made every comparison
  // NaN — so that whole feed detected nothing and failed silently. The EA
  // now sends short keys, and this keeps any older terminal working rather
  // than quietly returning an empty array.
  if (candles.length && candles[0] && candles[0].o === undefined && candles[0].open !== undefined) {
    candles = candles.map(k => ({
      o: k.open, h: k.high, l: k.low, c: k.close,
      t: k.time !== undefined ? k.time : k.t
    }));
  }

  const n = candles.length;
  if (n < 3) return results;

  // ── Size floors, derived from the data ────────────────────────────
  // These were absolute price constants (0.0003 / 0.0008 / 0.0005), which
  // only ever made sense on a 5-digit FX pair. On USDJPY (0.001 point) they
  // were ~10x too loose and on XAUUSD (0.01 point) ~100x too loose, so the
  // "is this candle big enough to mean anything" guard never actually fired
  // — the dashboard reported Dojis and Hammers on candles the chart
  // indicator correctly ignored. Scaling off the pair's own average range
  // keeps the original EURUSD behaviour while making every other instrument
  // behave the same way, and matches the _Point-scaled guards the
  // CandlePatternIndicator uses on the chart.
  let rangeSum = 0, rangeCount = 0;
  for (let k = 0; k < n; k++) {
    const r = candles[k].h - candles[k].l;
    if (r > 0) { rangeSum += r; rangeCount++; }
  }
  const avgRange = rangeCount ? rangeSum / rangeCount : 0;
  const MIN_DOJI_RANGE  = avgRange * 0.25;
  const MIN_WICK_RANGE  = avgRange * 0.65;
  const MIN_SPIN_RANGE  = avgRange * 0.40;

  // Only scan the last 3 closed candles — avoids re-detecting historical patterns
  // The last candle in the array is the current forming candle so we skip it
  const startIdx = Math.max(2, n - 4);

  for (let i = startIdx; i < n - 1; i++) {
    const c  = candles[i];
    const p1 = candles[i - 1];
    const p2 = candles[i - 2];

    const body   = Math.abs(c.c - c.o);
    const range  = c.h - c.l;
    const upperW = c.h - Math.max(c.c, c.o);
    const lowerW = Math.min(c.c, c.o) - c.l;
    const bull   = c.c > c.o;
    const bear   = c.c < c.o;

    if (range === 0) continue;

    // ── Doji ──────────────────────────────────────────────────────
    if (body < range * 0.05 && range > MIN_DOJI_RANGE) {
      results.push(pat(i, 'Doji', 'neutral', 'reversal', 72, timeframe,
        'Indecision candle. Watch for directional break on next candle.'));
      continue;
    }

    // ── Hammer ────────────────────────────────────────────────────
    if (lowerW > body * 2 && upperW < body * 0.4 && range > MIN_WICK_RANGE) {
      const afterDowntrend = p1.c < p2.c;
      if (afterDowntrend) {
        results.push(pat(i, 'Hammer', 'bullish', 'reversal', 82, timeframe,
          'Long lower wick after decline. Bullish reversal signal.'));
        continue;
      } else {
        results.push(pat(i, 'Hanging Man', 'bearish', 'reversal', 75, timeframe,
          'Same shape as Hammer but after rally. Bearish warning.'));
        continue;
      }
    }

    // ── Shooting Star ─────────────────────────────────────────────
    if (upperW > body * 2 && lowerW < body * 0.4 && range > MIN_WICK_RANGE) {
      const afterUptrend = p1.c > p2.c;
      if (afterUptrend) {
        results.push(pat(i, 'Shooting Star', 'bearish', 'reversal', 80, timeframe,
          'Long upper wick after rally. Bearish reversal at top.'));
        continue;
      } else {
        results.push(pat(i, 'Inverted Hammer', 'bullish', 'reversal', 72, timeframe,
          'Long upper wick after decline. Potential bullish reversal with confirmation.'));
        continue;
      }
    }

    // ── Marubozu Bullish ──────────────────────────────────────────
    if (bull && upperW < body * 0.04 && lowerW < body * 0.04 && body > range * 0.9) {
      results.push(pat(i, 'Marubozu ↑', 'bullish', 'continuation', 86, timeframe,
        'Full bullish body, no wicks. Strong buying pressure.'));
      continue;
    }

    // ── Marubozu Bearish ──────────────────────────────────────────
    if (bear && upperW < body * 0.04 && lowerW < body * 0.04 && body > range * 0.9) {
      results.push(pat(i, 'Marubozu ↓', 'bearish', 'continuation', 86, timeframe,
        'Full bearish body, no wicks. Strong selling pressure.'));
      continue;
    }

    // ── Bullish Engulfing ─────────────────────────────────────────
    if (bull && p1.c < p1.o && c.o <= p1.c && c.c >= p1.o) {
      results.push(pat(i, 'Bullish Engulfing', 'bullish', 'reversal', 90, timeframe,
        'Bullish candle fully engulfs prior bearish candle. Strong reversal.'));
      continue;
    }

    // ── Bearish Engulfing ─────────────────────────────────────────
    if (bear && p1.c > p1.o && c.o >= p1.c && c.c <= p1.o) {
      results.push(pat(i, 'Bearish Engulfing', 'bearish', 'reversal', 90, timeframe,
        'Bearish candle fully engulfs prior bullish candle. Strong reversal.'));
      continue;
    }

    // ── Morning Star ──────────────────────────────────────────────
    const p1Body = Math.abs(p1.c - p1.o);
    const p1Range = p1.h - p1.l;
    const p1Doji = p1Body < p1Range * 0.15;
    if (p2.c < p2.o && p1Doji && bull && c.c > (p2.o + p2.c) / 2) {
      results.push(pat(i, 'Morning Star', 'bullish', 'reversal', 88, timeframe,
        '3-candle bottom reversal. Bearish → indecision → bullish confirmation.'));
      continue;
    }

    // ── Evening Star ──────────────────────────────────────────────
    if (p2.c > p2.o && p1Doji && bear && c.c < (p2.o + p2.c) / 2) {
      results.push(pat(i, 'Evening Star', 'bearish', 'reversal', 88, timeframe,
        '3-candle top reversal. Bullish → indecision → bearish confirmation.'));
      continue;
    }

    // ── Bullish Harami ────────────────────────────────────────────
    if (p1.c < p1.o && bull && c.h < p1.o && c.l > p1.c) {
      results.push(pat(i, 'Bullish Harami', 'bullish', 'reversal', 70, timeframe,
        'Small bullish candle inside large bearish. Potential reversal forming.'));
      continue;
    }

    // ── Bearish Harami ────────────────────────────────────────────
    if (p1.c > p1.o && bear && c.h < p1.c && c.l > p1.o) {
      results.push(pat(i, 'Bearish Harami', 'bearish', 'reversal', 70, timeframe,
        'Small bearish candle inside large bullish. Potential reversal forming.'));
      continue;
    }

    // ── Inside Bar ────────────────────────────────────────────────
    if (c.h < p1.h && c.l > p1.l) {
      results.push(pat(i, 'Inside Bar', 'neutral', 'continuation', 72, timeframe,
        'Range inside prior candle. Consolidation — breakout pending.'));
      continue;
    }

    // ── Spinning Top (tightened — body < 15% range, wicks must be significant) ──
    if (body < range * 0.15 &&
        upperW > range * 0.25 && lowerW > range * 0.25 &&
        Math.abs(upperW - lowerW) < range * 0.1 &&
        range > MIN_SPIN_RANGE) {
      results.push(pat(i, 'Spinning Top', 'neutral', 'continuation', 72, timeframe,
        'Small body, near-equal significant wicks. Indecision at key level.'));
      continue;
    }
  }

  // ── Age each pattern ──────────────────────────────────────────────
  // pat() stamps barsAgo: 0 because it has no view of the array length, so
  // every pattern used to arrive claiming to be on the current bar. That made
  // the freshness buckets (Recent 0-2 / Mid 3-8 / Stale 9+) and the Trading
  // Brain's "maximum pattern age" filter inert — nothing could ever read as
  // stale, so stale patterns were being sent for analysis as if fresh.
  // The last element of the array is the forming candle, so bar (n-1) is
  // "0 bars ago" and each earlier index is one bar older.
  const currentIdx = n - 1;
  for (const r of results) r.barsAgo = currentIdx - r.index;

  // Return detected patterns — already scoped to last 3 closed candles
  return results.reverse();
}

function pat(index, name, direction, type, confidence, timeframe, desc) {
  return {
    name,
    direction,
    type,
    confidence,
    timeframe,
    desc,
    barsAgo: 0,
    index
  };
}

module.exports = { detectPatterns };
