"use strict";

// Research-only comparison of initial stop placement for identical M15 swing entries.
// No alerts, orders, live allowlists or broker stop changes.
const fs = require("node:fs");
const { atr, confirmedPivots } = require("./top_down_swing_engine");
const { simulatePolicy } = require("./top_down_swing_long_hold_replay");
const { makeWindows, firstEligibleEpoch, collectSignals } = require("./top_down_swing_chronological_holdout");

const METHODS = Object.freeze({
  H4_HYBRID: "H4_HYBRID",
  M15_STRUCTURAL: "M15_STRUCTURAL",
  M15_ATR_1_5: "M15_ATR_1_5"
});
const MARKETS = ["R_10", "R_25", "R_50"];
const HORIZON = 14 * 86400;

function completedFrames(frames, decisionEpoch) {
  const seconds = { M15: 900, H1: 3600, H4: 14400 };
  return Object.fromEntries(Object.entries(seconds).map(([tf, duration]) => [
    tf, (frames[tf] || []).filter(c => c.epoch + duration <= decisionEpoch)
  ]));
}

function deriveStop(signal, frames, method) {
  if (!Object.values(METHODS).includes(method)) throw new Error("Unknown stop method: " + method);
  if (method === METHODS.H4_HYBRID) {
    const riskDistance = Math.abs(signal.entry - signal.stopLoss);
    return riskDistance > 0 ? { stopLoss: signal.stopLoss, riskDistance, source: "existing_H4_structural_invalidation" } : null;
  }
  const closed = completedFrames(frames, signal.decisionEpoch);
  const m15 = closed.M15;
  const volatility = atr(m15);
  if (!(volatility > 0)) return null;
  let stopLoss;
  if (method === METHODS.M15_ATR_1_5) {
    const distance = volatility * 1.5;
    stopLoss = signal.direction === "BUY" ? signal.entry - distance : signal.entry + distance;
  } else {
    const pivots = confirmedPivots(m15, "M15", signal.decisionEpoch);
    const pivot = signal.direction === "BUY" ? pivots.lows.at(-1) : pivots.highs.at(-1);
    if (!pivot) return null;
    const buffer = volatility * 0.25;
    stopLoss = signal.direction === "BUY" ? pivot.price - buffer : pivot.price + buffer;
    if ((signal.direction === "BUY" && stopLoss >= signal.entry) ||
        (signal.direction === "SELL" && stopLoss <= signal.entry)) return null;
  }
  const riskDistance = Math.abs(signal.entry - stopLoss);
  if (!(riskDistance > 0) || !Number.isFinite(riskDistance)) return null;
  return { stopLoss, riskDistance, source: method };
}

function scoreMethod(signals, frames, method) {
  const rows = [];
  let unavailableStopCount = 0;
  for (const signal of signals) {
    const stop = deriveStop(signal, frames, method);
    if (!stop) { unavailableStopCount++; continue; }
    const adjusted = { ...signal, stopLoss: stop.stopLoss, riskDistance: stop.riskDistance };
    rows.push(simulatePolicy(adjusted, frames, "FIXED_2_5R", HORIZON));
  }
  const scored = rows.filter(row => row.status === "scored");
  const average = key => scored.length
    ? Number((scored.reduce((sum, row) => sum + row[key], 0) / scored.length).toFixed(4))
    : null;
  return {
    inputSignalCount: signals.length,
    usableStopCount: rows.length,
    unavailableStopCount,
    scoredCount: scored.length,
    censoredCount: rows.filter(row => row.status === "censored").length,
    ambiguousCount: rows.filter(row => row.status === "ambiguous").length,
    averageR: average("realisedR"),
    averageMfeR: average("mfeR"),
    averageMaeR: average("maeR"),
    averageDurationHours: average("durationHours")
  };
}

function compareWindow(marketId, frames, window) {
  const signals = collectSignals(marketId, frames, "M15_REFINED", window, HORIZON);
  return {
    signalCount: signals.length,
    methods: Object.fromEntries(Object.values(METHODS).map(method => [
      method, scoreMethod(signals, frames, method)
    ]))
  };
}

function runM15StopExperiment(snapshot) {
  const report = {
    version: 1,
    generatedAt: snapshot.generatedAt || null,
    scope: "m15_entry_initial_stop_comparison_research_only",
    entryVariant: "M15_REFINED",
    outcomePolicy: "FIXED_2_5R_PER_METHOD",
    trainingDays: 28,
    embargoDays: 14,
    outcomeHorizonDays: 14,
    methods: Object.values(METHODS),
    fixedParameters: {
      M15_STRUCTURAL: "Last confirmed M15 swing pivot plus/minus 0.25 M15 ATR buffer.",
      M15_ATR_1_5: "1.5 times completed M15 ATR from entry.",
      H4_HYBRID: "Existing H4 structural invalidation and buffer from the unchanged entry engine."
    },
    assumptions: [
      "Every stop method is tested on the same M15_REFINED entry candidates within each market and time window.",
      "Only candles completed by the entry decision timestamp are used to derive the initial stop.",
      "The 2.5R target is recalculated from each method's own initial risk distance.",
      "Stop/target collisions within one M5 candle are counted as ambiguous.",
      "Only complete 14-day M5 forward outcomes are scored.",
      "No spread, slippage, fees, latency or financing costs are modelled.",
      "No stop is moved after entry in this experiment; this isolates initial stop placement.",
      "Research only: no profitability claim, live allowlist, alerts or execution authorization."
    ],
    markets: {},
    summary: {}
  };
  for (const marketId of MARKETS) {
    const frames = snapshot.markets?.[marketId]?.timeframes || {};
    try {
      const m5 = frames.M5 || [];
      if (m5.length < 100) throw new Error("Insufficient M5 history.");
      const first = firstEligibleEpoch(frames);
      const last = m5.at(-1).epoch + 300 - HORIZON;
      const windows = makeWindows(first, last);
      report.markets[marketId] = {
        state: "replayed",
        windows,
        training: compareWindow(marketId, frames, windows.train),
        validation: compareWindow(marketId, frames, windows.validation)
      };
    } catch (error) {
      report.markets[marketId] = { state: "insufficient_history", reason: error.message };
    }
  }
  for (const method of Object.values(METHODS)) {
    report.summary[method] = {};
    for (const period of ["training", "validation"]) {
      const parts = Object.values(report.markets)
        .filter(market => market.state === "replayed")
        .map(market => market[period].methods[method]);
      const n = parts.reduce((sum, part) => sum + part.scoredCount, 0);
      const weighted = key => n
        ? Number((parts.reduce((sum, part) => sum + (part[key] || 0) * part.scoredCount, 0) / n).toFixed(4))
        : null;
      report.summary[method][period] = {
        marketCount: parts.length,
        inputSignalCount: parts.reduce((sum, part) => sum + part.inputSignalCount, 0),
        usableStopCount: parts.reduce((sum, part) => sum + part.usableStopCount, 0),
        scoredCount: n,
        unavailableStopCount: parts.reduce((sum, part) => sum + part.unavailableStopCount, 0),
        censoredCount: parts.reduce((sum, part) => sum + part.censoredCount, 0),
        ambiguousCount: parts.reduce((sum, part) => sum + part.ambiguousCount, 0),
        averageR: weighted("averageR"),
        averageMfeR: weighted("averageMfeR"),
        averageMaeR: weighted("averageMaeR"),
        averageDurationHours: weighted("averageDurationHours")
      };
    }
  }
  return report;
}

if (require.main === module) {
  const input = process.argv[2] || "top_down_swing_snapshot.json";
  const output = process.argv[3] || "top_down_swing_m15_stop_report.json";
  const report = runM15StopExperiment(JSON.parse(fs.readFileSync(input, "utf8")));
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, summary: report.summary }, null, 2));
}

module.exports = { METHODS, completedFrames, deriveStop, scoreMethod, compareWindow, runM15StopExperiment };
