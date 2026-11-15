"use strict";
// Retain completed lower-timeframe candles for a separate M15-setup / M5-M1-entry
// research track. This module is observation-only: no alerts and no order execution.
const fs = require("node:fs");
const path = require("node:path");

const INPUT = path.join(__dirname, "multi_timeframe_data.json");
const ARCHIVE = path.join(__dirname, "lower_tf_research_candles.json");
const REPORT = path.join(__dirname, "lower_tf_entry_research_report.json");
const LIMITS = Object.freeze({ M1: 5000, M5: 2000, M15: 1200 });
const SECONDS = Object.freeze({ M1: 60, M5: 300, M15: 900 });
const MARKETS = ["R_10", "R_25", "R_50", "R_75", "JD100", "CRASH500", "BOOM500"];

function validCandle(c) {
  return c && [c.epoch, c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.high >= c.low && c.high >= Math.max(c.open, c.close) &&
    c.low <= Math.min(c.open, c.close);
}
function mergeLowerTimeframeArchive(prior, incoming) {
  const archive = prior && prior.version === 1
    ? prior : { version: 1, updatedAt: null, markets: {} };
  archive.markets ||= {};
  for (const [marketId, market] of Object.entries(incoming || {})) {
    const saved = archive.markets[marketId] ||= { marketName: market.marketName || marketId, timeframes: {} };
    saved.marketName = market.marketName || saved.marketName || marketId;
    saved.timeframes ||= {};
    for (const tf of Object.keys(LIMITS)) {
      const oldRows = saved.timeframes[tf] || [];
      const newRows = market.timeframes?.[tf] || [];
      const byEpoch = new Map();
      for (const c of oldRows.concat(newRows)) {
        if (!validCandle(c)) continue;
        byEpoch.set(Number(c.epoch), {
          epoch: Number(c.epoch), open: Number(c.open), high: Number(c.high),
          low: Number(c.low), close: Number(c.close)
        });
      }
      saved.timeframes[tf] = [...byEpoch.values()]
        .sort((a, b) => a.epoch - b.epoch).slice(-LIMITS[tf]);
    }
  }
  archive.updatedAt = new Date().toISOString();
  return archive;
}
function frameStats(rows, tf) {
  const data = Array.isArray(rows) ? rows : [];
  const diffs = data.slice(1).map((c, i) => c.epoch - data[i].epoch);
  return {
    candles: data.length,
    firstEpoch: data.length ? data[0].epoch : null,
    lastEpoch: data.length ? data[data.length - 1].epoch : null,
    expectedIntervalSeconds: SECONDS[tf],
    gaps: diffs.filter(d => d !== SECONDS[tf]).length,
    largestIntervalSeconds: diffs.length ? Math.max(...diffs) : null
  };
}
function buildReport(archive) {
  const markets = {};
  for (const id of MARKETS) {
    const m = archive.markets?.[id] || { timeframes: {} };
    const frames = {};
    for (const tf of Object.keys(LIMITS)) frames[tf] = frameStats(m.timeframes?.[tf], tf);
    const starts = Object.values(frames).map(x => x.firstEpoch).filter(Number.isFinite);
    const ends = Object.values(frames).map(x => x.lastEpoch).filter(Number.isFinite);
    const overlapStart = starts.length ? Math.max(...starts) : null;
    const overlapEnd = ends.length ? Math.min(...ends) : null;
    markets[id] = {
      marketName: m.marketName || id, frames,
      commonOverlapHours: Number.isFinite(overlapStart) && Number.isFinite(overlapEnd)
        ? Math.max(0, (overlapEnd - overlapStart) / 3600) : 0
    };
  }
  const readyMarkets = Object.values(markets).filter(m =>
    m.frames.M1.candles >= 1000 && m.frames.M5.candles >= 500 &&
    m.frames.M15.candles >= 400 && m.commonOverlapHours >= 24 &&
    m.frames.M1.gaps === 0 && m.frames.M5.gaps === 0 && m.frames.M15.gaps === 0
  ).length;
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: readyMarkets >= 3 ? "ready_for_lower_timeframe_replay" : "collecting_lower_timeframe_history",
    marketsReady: readyMarkets,
    marketsRequired: 3,
    markets,
    researchDesign: {
      setup: "Completed M15 candidate from the existing EMA strategy comparison; direction is frozen at the M15 close.",
      m5Entry: "After the setup close, wait for M5 EMA9/EMA21 alignment and an EMA9 pullback/reclaim candle; enter at the next M5 open.",
      m1Entry: "Require M5 EMA9/EMA21 alignment, then an M1 EMA9 pullback followed by a close beyond the prior three-candle micro swing; enter at the next M1 open.",
      stop: "Structure-based stop beyond the recent five completed entry-timeframe candles, with an ATR buffer. Reject entries with invalid or excessively wide risk; never force a smaller stop.",
      baseline: "Compare against the existing M15 next-open entry and 1.5 x M15 ATR stop.",
      outcomes: "Use identical 2R target and a one-hour observation horizon for the first comparison. Report target, stop, same-candle ambiguity, time exit, expectancy in R, stop distance in M15 ATR units, and signal coverage.",
      safeguards: [
        "Only completed candles; no future higher-timeframe candles may enter a trigger.",
        "No look-ahead: entry is the candle after the trigger candle.",
        "Keep markets separate and show per-market results.",
        "Use chronological discovery/validation/holdout splits; do not tune on holdout.",
        "Do not promote on a smaller stop alone; compare stop frequency and expectancy."
      ]
    },
    note: "This report audits retained data coverage only. No lower-timeframe backtest result is claimed until the overlap and sample requirements are met."
  };
}
function main() {
  if (!fs.existsSync(INPUT)) throw new Error("Missing collector output: " + INPUT);
  const latest = JSON.parse(fs.readFileSync(INPUT, "utf8"));
  let prior = { version: 1, markets: {} };
  if (fs.existsSync(ARCHIVE)) prior = JSON.parse(fs.readFileSync(ARCHIVE, "utf8"));
  const archive = mergeLowerTimeframeArchive(prior, latest.markets);
  const report = buildReport(archive);
  fs.writeFileSync(ARCHIVE, JSON.stringify(archive, null, 2) + "\n");
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({
    event: "lower_tf_research_archive_updated",
    markets: Object.keys(archive.markets).length,
    marketsReady: report.marketsReady,
    mode: report.mode,
    counts: Object.fromEntries(MARKETS.map(id => [id, {
      M1: report.markets[id].frames.M1.candles,
      M5: report.markets[id].frames.M5.candles,
      M15: report.markets[id].frames.M15.candles
    }]))
  }));
}
if (require.main === module) main();
module.exports = { mergeLowerTimeframeArchive, frameStats, buildReport, LIMITS, SECONDS };
