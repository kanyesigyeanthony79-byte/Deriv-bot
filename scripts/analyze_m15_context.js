"use strict";

// Descriptive M15 context screen; not a trade simulator or profitability test.
const fs = require("node:fs");
const path = require("node:path");

const inputDir = process.argv[2] || path.join(__dirname, "..", "research", "data");
const outputPath = process.argv[3] || null;
const HORIZON = 16; // 16 x M15 = four hours
const WARMUP = 60;
const EDGE_BUFFER = 32; // same terminal buffer in both chronological splits

function ema(values, period) {
  const alpha = 2 / (period + 1);
  let current = values[0];
  return values.map(value => (current = value * alpha + current * (1 - alpha)));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(bars, from, to, e20, e50, atr) {
  const outcomes = [];
  for (let i = from; i < to; i++) {
    const close = bars[i].close;
    const side = e20[i] > e50[i] && close > e20[i]
      ? 1
      : e20[i] < e50[i] && close < e20[i] ? -1 : 0;
    if (!side || !Number.isFinite(atr[i]) || atr[i] <= 0) continue;
    outcomes.push(side * (bars[i + HORIZON].close - close) / atr[i]);
  }
  return {
    samples: outcomes.length,
    medianAtrMove: median(outcomes),
    positivePct: outcomes.length
      ? 100 * outcomes.filter(value => value > 0).length / outcomes.length
      : null
  };
}

function analyze(file) {
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const bars = payload.frames?.M15;
  if (!Array.isArray(bars) || bars.length < WARMUP + EDGE_BUFFER + 10) {
    throw new Error(`${path.basename(file)} has insufficient M15 history.`);
  }
  if (payload.coverage?.M15?.complete !== true || payload.coverage.M15.gapCount !== 0) {
    throw new Error(`${payload.market} M15 is not fully contiguous; refusing analysis.`);
  }
  const closes = bars.map(bar => Number(bar.close));
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const tr = bars.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    const previous = closes[i - 1];
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previous), Math.abs(bar.low - previous));
  });
  const atr = Array(bars.length).fill(null);
  for (let i = 13; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - 13; j <= i; j++) sum += tr[j];
    atr[i] = sum / 14;
  }
  const split = Math.floor(bars.length / 2);
  const end = bars.length - EDGE_BUFFER;
  return {
    market: payload.market,
    bars: bars.length,
    firstEpoch: bars[0].epoch,
    lastEpoch: bars[bars.length - 1].epoch,
    full: summarize(bars, WARMUP, end, e20, e50, atr),
    firstHalf: summarize(bars, WARMUP, split - EDGE_BUFFER, e20, e50, atr),
    secondHalf: summarize(bars, split, end, e20, e50, atr)
  };
}

const files = fs.readdirSync(inputDir)
  .filter(name => name.endsWith(".json") && name !== "capture-summary.json")
  .sort();
if (!files.length) throw new Error(`No market JSON files found in ${inputDir}`);
const results = files.map(name => analyze(path.join(inputDir, name)));
const output = {
  method: "EMA20/EMA50 M15 context; signed close movement 16 bars later divided by ATR14",
  horizonBars: HORIZON,
  horizonMinutes: HORIZON * 15,
  results
};
const rendered = JSON.stringify(output, null, 2) + "\n";
if (outputPath) fs.writeFileSync(outputPath, rendered);
else process.stdout.write(rendered);
