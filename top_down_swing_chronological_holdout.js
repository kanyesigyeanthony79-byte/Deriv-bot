"use strict";

// Chronological, research-only holdout for long-hold management policies.
// Policy selection is confined to an earlier training window. Validation entries
// begin only after the full 14-day training outcome horizon has elapsed.
const fs = require("node:fs");
const { SELECTED, POLICIES, simulatePolicy } = require("./top_down_swing_long_hold_replay");
const { evaluateTopDown } = require("./top_down_swing_engine");
const TF = { M5: 300, M15: 900, H1: 3600, H4: 14400, D1: 86400 };
const HORIZON = 14 * 86400;
const TRAIN_DAYS = 28;
const MIN_TRAIN_SCORED = 10;

function makeWindows(firstEligibleEpoch, lastEligibleDecisionEpoch, trainDays = TRAIN_DAYS, horizon = HORIZON) {
  if (![firstEligibleEpoch, lastEligibleDecisionEpoch, trainDays, horizon].every(Number.isFinite) ||
      trainDays <= 0 || horizon <= 0 || lastEligibleDecisionEpoch <= firstEligibleEpoch)
    throw new Error("Invalid chronological holdout window inputs.");
  const trainEnd = firstEligibleEpoch + trainDays * 86400;
  const validationStart = trainEnd + horizon;
  if (lastEligibleDecisionEpoch - validationStart < 7 * 86400)
    throw new Error("Insufficient history for a 28-day training window, 14-day embargo, and at least 7 validation days.");
  return {
    train: { startEpoch: firstEligibleEpoch, endEpoch: trainEnd },
    embargo: { startEpoch: trainEnd, endEpoch: validationStart },
    validation: { startEpoch: validationStart, endEpoch: lastEligibleDecisionEpoch }
  };
}

function summarizeResults(rows) {
  const scored = rows.filter(row => row.status === "scored");
  const avg = key => scored.length
    ? Number((scored.reduce((sum, row) => sum + row[key], 0) / scored.length).toFixed(4))
    : null;
  return {
    candidateCount: rows.length,
    scoredCount: scored.length,
    censoredCount: rows.filter(row => row.status === "censored").length,
    ambiguousCount: rows.filter(row => row.status === "ambiguous").length,
    averageR: avg("realisedR"),
    averageMfeR: avg("mfeR"),
    averageMaeR: avg("maeR"),
    averageDurationHours: avg("durationHours")
  };
}

function choosePolicy(trainingResults, minScored = MIN_TRAIN_SCORED) {
  const eligible = POLICIES.map(policy => ({ policy, ...trainingResults[policy] }))
    .filter(row => row && row.scoredCount >= minScored && Number.isFinite(row.averageR));
  eligible.sort((a, b) => b.averageR - a.averageR || POLICIES.indexOf(a.policy) - POLICIES.indexOf(b.policy));
  return eligible[0] ? eligible[0].policy : null;
}

function firstEligibleEpoch(frames) {
  const required = [["D1", 11], ["H4", 11], ["H1", 11], ["M15", 7], ["M5", 7]];
  const starts = required.map(([tf, index]) => {
    const candles = frames[tf] || [];
    if (candles.length <= index) throw new Error(`Insufficient ${tf} history for holdout warmup.`);
    return candles[index].epoch + TF[tf];
  });
  return Math.max(...starts);
}

function collectSignals(marketId, frames, variant, window, horizon) {
  const timeframe = variant === "H1_CONTROL" ? "H1" : variant === "M15_REFINED" ? "M15" : "M5";
  const seconds = TF[timeframe], m5 = frames.M5 || [];
  const latestDecision = (m5.length ? m5.at(-1).epoch + TF.M5 : 0) - horizon;
  const signals = [], seen = new Set();
  for (const bar of frames[timeframe] || []) {
    const decisionEpoch = bar.epoch + seconds;
    if (decisionEpoch < window.startEpoch || decisionEpoch >= window.endEpoch || decisionEpoch > latestDecision) continue;
    const signal = evaluateTopDown(marketId, frames, decisionEpoch, variant);
    if (signal.state !== "candidate") continue;
    const key = `${signal.entryEpoch}|${signal.direction}`;
    if (!seen.has(key)) { seen.add(key); signals.push(signal); }
  }
  return signals;
}

function runChronologicalHoldout(snapshot) {
  const output = {
    version: 1, generatedAt: snapshot.generatedAt || null, horizonDays: 14,
    trainingDays: TRAIN_DAYS, minimumTrainingScoredTrades: MIN_TRAIN_SCORED,
    scope: "chronological_policy_selection_and_later_holdout_research_only",
    assumptions: [
      "Each market and entry variant selects its management policy using only the earlier training window.",
      "The validation window starts after a full 14-day embargo, so training trade outcomes cannot overlap validation entries.",
      "Every scored validation trade has a complete 14-day M5 forward window.",
      "All five policies are reported on validation for transparency; only the training-selected policy is designated as selected.",
      "No spread, slippage, fees, latency or financing costs are modelled.",
      "This is historical research, not a profitability claim, live allowlist or execution authorization."
    ],
    markets: {}, summary: {}
  };

  for (const [marketId, variants] of Object.entries(SELECTED)) {
    const frames = snapshot.markets?.[marketId]?.timeframes || {};
    try {
      const m5 = frames.M5 || [];
      if (m5.length < 100) throw new Error("Insufficient M5 history.");
      const first = firstEligibleEpoch(frames);
      const last = m5.at(-1).epoch + TF.M5 - HORIZON;
      const windows = makeWindows(first, last);
      const marketResult = { state: "replayed", windows, variants: {} };
      for (const variant of variants) {
        const trainSignals = collectSignals(marketId, frames, variant, windows.train, HORIZON);
        const validationSignals = collectSignals(marketId, frames, variant, windows.validation, HORIZON);
        const training = {}, validation = {};
        for (const policy of POLICIES) {
          training[policy] = summarizeResults(trainSignals.map(signal => simulatePolicy(signal, frames, policy, HORIZON)));
          validation[policy] = summarizeResults(validationSignals.map(signal => simulatePolicy(signal, frames, policy, HORIZON)));
        }
        const selectedPolicy = choosePolicy(training);
        marketResult.variants[variant] = {
          trainingSignalCount: trainSignals.length, validationSignalCount: validationSignals.length,
          selectedPolicy, selectionStatus: selectedPolicy ? "selected_from_training_only" : "insufficient_training_sample",
          training, validation, selectedPolicyValidation: selectedPolicy ? validation[selectedPolicy] : null,
          fixedTargetValidation: validation.FIXED_2_5R,
          selectedMinusFixedAverageR: selectedPolicy && validation[selectedPolicy].averageR !== null && validation.FIXED_2_5R.averageR !== null
            ? Number((validation[selectedPolicy].averageR - validation.FIXED_2_5R.averageR).toFixed(4)) : null
        };
      }
      output.markets[marketId] = marketResult;
    } catch (error) {
      output.markets[marketId] = { state: "insufficient_history", reason: error.message };
    }
  }

  for (const variant of ["H1_CONTROL", "M15_REFINED", "M15_M5_REFINED"]) {
    const groups = [];
    for (const market of Object.values(output.markets)) {
      const item = market.state === "replayed" ? market.variants[variant] : null;
      if (item && item.selectedPolicy && item.selectedPolicyValidation?.scoredCount) groups.push(item);
    }
    const n = groups.reduce((sum, item) => sum + item.selectedPolicyValidation.scoredCount, 0);
    const weighted = key => n ? Number((groups.reduce((sum, item) =>
      sum + (item.selectedPolicyValidation[key] || 0) * item.selectedPolicyValidation.scoredCount, 0) / n).toFixed(4)) : null;
    output.summary[variant] = {
      marketVariantCount: groups.length, scoredCount: n,
      selectedPolicyAverageR: weighted("averageR"),
      selectedPolicyAverageDurationHours: weighted("averageDurationHours"),
      markets: Object.entries(output.markets)
        .filter(([, market]) => market.state === "replayed" && market.variants[variant])
        .map(([marketId, market]) => ({ market: marketId,
          selectedPolicy: market.variants[variant].selectedPolicy,
          validation: market.variants[variant].selectedPolicyValidation }))
    };
  }
  return output;
}

if (require.main === module) {
  const input = process.argv[2] || "top_down_swing_snapshot.json";
  const output = process.argv[3] || "top_down_swing_chronological_holdout.json";
  const result = runChronologicalHoldout(JSON.parse(fs.readFileSync(input, "utf8")));
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ output, summary: result.summary }, null, 2));
}
module.exports = { makeWindows, summarizeResults, choosePolicy, firstEligibleEpoch, collectSignals, runChronologicalHoldout };
