"use strict";
// Development-only paired replay: PR9 baseline and PR11 candidate use the
// exact same saved, completed OHLC candles. This script is read-only.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const baseline = require("./test/fixtures/multi_timeframe_engine.baseline");
const candidate = require("./multi_timeframe_engine");
const { continuousSegments, validCandles } = require("./swing_historical_validation");

const MAX_HOLD_BARS = 7 * 86400 / candidate.TIMEFRAMES.M5;
const MINIMUM_BARS = { M5: MAX_HOLD_BARS + 65, M15: 60, H1: 65, H4: 51, D1: 60 };

function simulateOutcome(signal, candles, signalIndex, horizonBars = MAX_HOLD_BARS) {
  const end = signalIndex + horizonBars;
  if (end >= candles.length) return { status: "incomplete_window" };
  let tp1Seen = false;
  for (let i = signalIndex + 1; i <= end; i++) {
    const c = candles[i];
    const stop = signal.direction === "BUY" ? c.low <= signal.stopLoss : c.high >= signal.stopLoss;
    const tp1 = signal.direction === "BUY" ? c.high >= signal.tp1 : c.low <= signal.tp1;
    const tp2 = signal.direction === "BUY" ? c.high >= signal.tp2 : c.low <= signal.tp2;
    if (!tp1Seen) {
      if (stop && tp1) return { status: "ambiguous_sl_tp1_same_candle", barsHeld: i - signalIndex };
      if (stop) return { status: "stop_before_tp1", barsHeld: i - signalIndex };
      if (tp1) {
        tp1Seen = true;
        if (tp2) return { status: "tp2_after_tp1", barsHeld: i - signalIndex };
      }
    } else {
      if (stop && tp2) return { status: "ambiguous_sl_tp2_same_candle", barsHeld: i - signalIndex };
      if (tp2) return { status: "tp2_after_tp1", barsHeld: i - signalIndex };
      if (stop) return { status: "stop_after_tp1", barsHeld: i - signalIndex };
    }
  }
  return { status: tp1Seen ? "tp1_only_by_horizon" : "no_barrier_by_horizon", barsHeld: horizonBars };
}

function summarize(outcomes) {
  const counts = {};
  for (const item of outcomes) counts[item.status] = (counts[item.status] || 0) + 1;
  const resolved = outcomes.filter(item => item.status !== "incomplete_window");
  const tp1Reached = (counts.tp1_only_by_horizon || 0) + (counts.tp2_after_tp1 || 0) +
    (counts.stop_after_tp1 || 0) + (counts.ambiguous_sl_tp2_same_candle || 0);
  return {
    signals: outcomes.length,
    resolvedSignals: resolved.length,
    outcomes: counts,
    tp1Reached,
    tp1RateAmongResolved: resolved.length ? Number((tp1Reached / resolved.length).toFixed(4)) : null,
    tp2Reached: counts.tp2_after_tp1 || 0
  };
}

function compareSignalMaps(baseSignals, candidateSignals) {
  const baseIds = new Set(baseSignals.map(x => x.signalId));
  const candidateIds = new Set(candidateSignals.map(x => x.signalId));
  const common = [...baseIds].filter(id => candidateIds.has(id));
  const baseById = new Map(baseSignals.map(x => [x.signalId, x]));
  const candidateById = new Map(candidateSignals.map(x => [x.signalId, x]));
  const changed = common.filter(id => baseById.get(id).status !== candidateById.get(id).status);
  return {
    baselineOnly: [...baseIds].filter(id => !candidateIds.has(id)).length,
    candidateOnly: [...candidateIds].filter(id => !baseIds.has(id)).length,
    commonSignals: common.length,
    sameOutcome: common.length - changed.length,
    changedOutcome: changed.length,
    changedExamples: changed.slice(0, 20).map(id => ({
      signalId: id,
      baseline: baseById.get(id).status,
      candidate: candidateById.get(id).status
    }))
  };
}

function runVersion(engine, marketId, marketName, frames, applyCooldown) {
  const outcomes = [];
  const states = {};
  let replayedM5Bars = 0;
  for (const m5 of frames.m5Segments) {
    let lastSignalIndex = null;
    const lastMatureIndex = m5.length - MAX_HOLD_BARS - 1;
    replayedM5Bars += Math.max(0, lastMatureIndex - 63);
    const segmentFrames = { ...frames.higher, M5: m5 };
    for (let i = 64; i <= lastMatureIndex; i++) {
      const result = engine.evaluateCategory(marketId, marketName, "SWING", segmentFrames, i);
      states[result.state] = (states[result.state] || 0) + 1;
      if (result.state !== "signal") continue;
      if (applyCooldown && !engine.cooldownAllows(lastSignalIndex, i, 4)) continue;
      lastSignalIndex = i;
      outcomes.push({
        signalId: result.signalId,
        direction: result.direction,
        signalTime: new Date(result.candleEpoch * 1000).toISOString(),
        entry: result.entry,
        stopLoss: result.stopLoss,
        tp1: result.tp1,
        tp2: result.tp2,
        ...simulateOutcome(result, m5, i)
      });
    }
  }
  return { ...summarize(outcomes), replayedM5Bars, stateCounts: states, signals: outcomes };
}

function prepareFrames(raw) {
  const higher = {};
  const m5Segments = [];
  let ready = true;
  for (const [tf, granularity] of Object.entries(candidate.TIMEFRAMES)) {
    if (!MINIMUM_BARS[tf]) continue;
    const candles = raw[tf] || [];
    const segments = continuousSegments(candles, granularity);
    const usable = segments.filter(segment => validCandles(segment) && segment.length >= MINIMUM_BARS[tf]);
    if (!usable.length) ready = false;
    if (tf === "M5") m5Segments.push(...usable);
    else higher[tf] = usable[usable.length - 1] || [];
  }
  return ready && m5Segments.length ? { higher, m5Segments } : null;
}

function compareSnapshot(snapshot) {
  const results = {};
  for (const [marketId, market] of Object.entries(snapshot.markets || {})) {
    const frames = prepareFrames(market.frames || {});
    if (!frames) {
      results[marketId] = { marketName: market.marketName, status: "insufficient_or_discontinuous_snapshot" };
      continue;
    }
    const base = runVersion(baseline, marketId, market.marketName, frames, false);
    const next = runVersion(candidate, marketId, market.marketName, frames, true);
    results[marketId] = {
      marketName: market.marketName,
      status: "compared_on_identical_candles",
      baseline: { signals: base.signals, resolvedSignals: base.resolvedSignals, outcomes: base.outcomes,
        tp1Reached: base.tp1Reached, tp1RateAmongResolved: base.tp1RateAmongResolved,
        tp2Reached: base.tp2Reached, replayedM5Bars: base.replayedM5Bars, stateCounts: base.stateCounts },
      candidate: { signals: next.signals, resolvedSignals: next.resolvedSignals, outcomes: next.outcomes,
        tp1Reached: next.tp1Reached, tp1RateAmongResolved: next.tp1RateAmongResolved,
        tp2Reached: next.tp2Reached, replayedM5Bars: next.replayedM5Bars, stateCounts: next.stateCounts },
      signalSetComparison: compareSignalMaps(base.signals, next.signals),
      baselineSignals: base.signals,
      candidateSignals: next.signals
    };
  }
  const completed = Object.values(results).filter(x => x.status === "compared_on_identical_candles");
  const sumSignals = key => completed.reduce((n, x) => n + x[key].signals, 0);
  const allOutcomes = key => completed.reduce((acc, x) => {
    for (const [status, count] of Object.entries(x[key].outcomes)) acc[status] = (acc[status] || 0) + count;
    return acc;
  }, {});
  return {
    generatedAt: new Date().toISOString(),
    mode: "paired_historical_replay_same_candles",
    snapshotGeneratedAt: snapshot.generatedAt,
    sourceBranch: snapshot.sourceBranch,
    sourceHead: snapshot.sourceHead,
    snapshotSha256: crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    methodology: {
      baseline: "PR9 swing rules, no four-entry-bar cooldown",
      candidate: "PR11 swing pullback guards plus four-entry-bar cooldown",
      candleEquality: "Both versions consume the same completed M5/M15/H1/H4/D1 candle arrays from one snapshot.",
      outcomeRules: "Seven-day forward horizon; same-candle SL/TP contact marked ambiguous.",
      caveats: "Historical descriptive comparison only; no fees/slippage, no portfolio simulation, no claim of profitability."
    },
    summary: {
      marketsInSnapshot: Object.keys(snapshot.markets || {}).length,
      marketsCompared: completed.length,
      baselineSignals: sumSignals("baseline"),
      candidateSignals: sumSignals("candidate"),
      baselineOutcomes: allOutcomes("baseline"),
      candidateOutcomes: allOutcomes("candidate")
    },
    markets: results
  };
}

function main() {
  const input = path.join(__dirname, "swing_historical_snapshots.json");
  if (!fs.existsSync(input)) throw new Error("Missing swing_historical_snapshots.json; run the candle-collection replay first.");
  const snapshot = JSON.parse(fs.readFileSync(input, "utf8"));
  const result = compareSnapshot(snapshot);
  fs.writeFileSync(path.join(__dirname, "swing_identical_candle_comparison.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ event: "paired_swing_comparison_complete", summary: result.summary,
    markets: Object.fromEntries(Object.entries(result.markets).map(([id, item]) => [id, {
      status: item.status, baselineSignals: item.baseline?.signals, candidateSignals: item.candidate?.signals,
      outcomes: item.signalSetComparison
    }])) }));
  if (!result.summary.marketsCompared) process.exitCode = 1;
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(JSON.stringify({ event: "paired_swing_comparison_failed", message: error.message }));
    process.exitCode = 1;
  }
}
module.exports = { simulateOutcome, summarize, compareSignalMaps, prepareFrames, compareSnapshot };
