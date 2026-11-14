"use strict";

// Research-only entry-quality filter comparison. No alerts, orders or broker changes.
const fs = require("node:fs");
const { SELECTED, simulatePolicy } = require("./top_down_swing_long_hold_replay");
const { makeWindows, firstEligibleEpoch, collectSignals } = require("./top_down_swing_chronological_holdout");

const FILTERS = Object.freeze({
  BASELINE: () => true,
  D1_ALIGNED: signal => signal.d1Alignment === "aligned",
  RISK_ATR_MAX_2_5: signal => Number.isFinite(signal.riskInAtr) && signal.riskInAtr <= 2.5,
  D1_ALIGNED_AND_RISK_ATR_MAX_2_5: signal =>
    signal.d1Alignment === "aligned" && Number.isFinite(signal.riskInAtr) && signal.riskInAtr <= 2.5
});

function filterSignals(signals, filterName) {
  const predicate = FILTERS[filterName];
  if (!predicate) throw new Error("Unknown entry-quality filter: " + filterName);
  return signals.filter(predicate);
}

function scoreSignals(signals, frames) {
  const rows = signals.map(signal => simulatePolicy(signal, frames, "FIXED_2_5R"));
  const scored = rows.filter(row => row.status === "scored");
  return {
    candidateCount: signals.length,
    scoredCount: scored.length,
    censoredCount: rows.filter(row => row.status === "censored").length,
    ambiguousCount: rows.filter(row => row.status === "ambiguous").length,
    averageR: scored.length ? Number((scored.reduce((sum, row) => sum + row.realisedR, 0) / scored.length).toFixed(4)) : null,
    averageMfeR: scored.length ? Number((scored.reduce((sum, row) => sum + row.mfeR, 0) / scored.length).toFixed(4)) : null,
    averageDurationHours: scored.length ? Number((scored.reduce((sum, row) => sum + row.durationHours, 0) / scored.length).toFixed(2)) : null
  };
}

function compareWindow(marketId, frames, variant, window) {
  const raw = collectSignals(marketId, frames, variant, window, 14 * 86400);
  return Object.fromEntries(Object.keys(FILTERS).map(name => {
    const filtered = filterSignals(raw, name);
    return [name, { retainedSignalCount: filtered.length, retentionRate: raw.length ?
      Number((filtered.length / raw.length).toFixed(4)) : null,
      ...scoreSignals(filtered, frames) }];
  }));
}

function runEntryQualityExperiment(snapshot) {
  const output = {
    version: 1,
    generatedAt: snapshot.generatedAt || null,
    scope: "chronological_entry_quality_filter_research_only",
    trainingDays: 28,
    embargoDays: 14,
    outcomeHorizonDays: 14,
    outcomePolicy: "FIXED_2_5R",
    filters: Object.keys(FILTERS),
    assumptions: [
      "Only closed-candle H4/H1 swing context and existing M15/M5 entry triggers are used.",
      "Filter thresholds are fixed before validation; validation results do not select or retune filters.",
      "Training entries are followed by a full 14-day outcome horizon before validation begins.",
      "Only complete 14-day M5 outcomes are scored; ambiguous stop/target candles remain excluded and counted.",
      "No spread, slippage, fees, latency or financing costs are modelled.",
      "Research only: no profitability claim, live allowlist, alerts or execution authorization."
    ],
    markets: {},
    summary: {}
  };
  for (const [marketId, variants] of Object.entries(SELECTED)) {
    const frames = snapshot.markets?.[marketId]?.timeframes || {};
    try {
      const m5 = frames.M5 || [];
      if (m5.length < 100) throw new Error("Insufficient M5 history.");
      const first = firstEligibleEpoch(frames);
      const last = m5.at(-1).epoch + 300 - 14 * 86400;
      const windows = makeWindows(first, last);
      const result = { state: "replayed", windows, variants: {} };
      for (const variant of variants) {
        result.variants[variant] = {
          training: compareWindow(marketId, frames, variant, windows.train),
          validation: compareWindow(marketId, frames, variant, windows.validation)
        };
      }
      output.markets[marketId] = result;
    } catch (error) {
      output.markets[marketId] = { state: "insufficient_history", reason: error.message };
    }
  }
  for (const variant of ["H1_CONTROL", "M15_REFINED", "M15_M5_REFINED"]) {
    const rows = Object.values(output.markets)
      .filter(market => market.state === "replayed" && market.variants[variant]);
    output.summary[variant] = {};
    for (const filter of Object.keys(FILTERS)) {
      const combine = period => {
        const parts = rows.map(row => row.variants[variant][period][filter]);
        const n = parts.reduce((sum, part) => sum + part.scoredCount, 0);
        return {
          marketVariantCount: parts.length,
          candidateCount: parts.reduce((sum, part) => sum + part.candidateCount, 0),
          scoredCount: n,
          averageR: n ? Number((parts.reduce((sum, part) => sum + (part.averageR || 0) * part.scoredCount, 0) / n).toFixed(4)) : null,
          averageMfeR: n ? Number((parts.reduce((sum, part) => sum + (part.averageMfeR || 0) * part.scoredCount, 0) / n).toFixed(4)) : null
        };
      };
      output.summary[variant][filter] = { training: combine("training"), validation: combine("validation") };
    }
  }
  return output;
}

if (require.main === module) {
  const input = process.argv[2] || "top_down_swing_snapshot.json";
  const output = process.argv[3] || "top_down_swing_entry_quality_report.json";
  const report = runEntryQualityExperiment(JSON.parse(fs.readFileSync(input, "utf8")));
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, summary: report.summary }, null, 2));
}
module.exports = { FILTERS, filterSignals, scoreSignals, compareWindow, runEntryQualityExperiment };
