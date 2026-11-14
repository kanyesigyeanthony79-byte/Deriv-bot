"use strict";

// Experimental, read-only swing candidate. This module is deliberately not
// imported by the live scanner or alert router.
const { evaluate } = require("./engine");
const {
  TIMEFRAMES, validCandles, trendBias, makeLevels, swingPullbackConfirmed
} = require("./multi_timeframe_engine");
const { validateCandleContinuity } = require("./market_quality");

const CONFIG = Object.freeze({
  entry: "M5",
  confirmation: "M15",
  setup: "H1",
  trend: ["H4", "D1"],
  risk: "H4",
  stopAtr: 1.75,
  tp1R: 1.5,
  tp2R: 2.5,
  maxAgeSeconds: 7 * 86400
});

function completedAtOrBefore(candles, timeframe, cutoffEpoch) {
  const seconds = TIMEFRAMES[timeframe];
  return (candles || []).filter(c => c.epoch + seconds <= cutoffEpoch);
}

function evaluateRefinedSwing(marketId, marketName, candlesByTimeframe, entryIndex = null) {
  const rawM5 = candlesByTimeframe.M5 || [];
  const index = Number.isInteger(entryIndex)
    ? Math.min(entryIndex, rawM5.length - 1)
    : rawM5.length - 1;
  if (index < 0 || !rawM5[index]) {
    return { state: "warming", strategy: "SWING_H4_D1_M15_M5", reason: "No completed M5 entry candle is available." };
  }

  const m5 = rawM5.slice(0, index + 1);
  const entryCandle = m5[m5.length - 1];
  const cutoffEpoch = entryCandle.epoch + TIMEFRAMES.M5;
  const frames = {
    M15: completedAtOrBefore(candlesByTimeframe.M15, "M15", cutoffEpoch),
    H1: completedAtOrBefore(candlesByTimeframe.H1, "H1", cutoffEpoch),
    H4: completedAtOrBefore(candlesByTimeframe.H4, "H4", cutoffEpoch),
    D1: completedAtOrBefore(candlesByTimeframe.D1, "D1", cutoffEpoch)
  };

  const minimums = { M5: 65, M15: 25, H1: 65, H4: 51, D1: 51 };
  const used = { M5: m5, ...frames };
  for (const [timeframe, minimum] of Object.entries(minimums)) {
    if (!validCandles(used[timeframe]) || used[timeframe].length < minimum) {
      return {
        state: "warming", strategy: "SWING_H4_D1_M15_M5", timeframe,
        availableCandles: used[timeframe]?.length || 0, requiredCandles: minimum,
        reason: "Waiting for enough completed candles on every required timeframe."
      };
    }
  }

  for (const timeframe of Object.keys(used)) {
    const check = validateCandleContinuity(used[timeframe], TIMEFRAMES[timeframe], marketId);
    if (!check.valid) {
      return {
        state: "data_gap", strategy: "SWING_H4_D1_M15_M5", timeframe,
        gaps: check.gaps.slice(0, 5),
        reason: "A required timeframe contains missing candle intervals; no signal is produced."
      };
    }
  }

  // Higher-timeframe direction is established first. Both must independently
  // agree; a lower timeframe is never allowed to override them.
  const h4Bias = trendBias(frames.H4);
  const d1Bias = trendBias(frames.D1);
  if (h4Bias.direction === "NEUTRAL" || d1Bias.direction === "NEUTRAL" ||
      h4Bias.direction !== d1Bias.direction) {
    return {
      state: "timeframe_conflict", strategy: "SWING_H4_D1_M15_M5",
      h4Bias: h4Bias.direction, d1Bias: d1Bias.direction,
      reason: "H4 and D1 must have the same directional bias before a swing setup is considered."
    };
  }
  const direction = d1Bias.direction;

  // H1 is the setup timeframe, M15 is pullback confirmation, and M5 is the
  // final trigger. Every test uses only candles closed by the M5 close.
  const h1Setup = evaluate(frames.H1);
  if (h1Setup.state !== "ok" || h1Setup.signal !== direction) {
    return {
      state: "setup_not_confirmed", strategy: "SWING_H4_D1_M15_M5",
      direction, h1Bias: h1Setup.signal || "NEUTRAL",
      reason: "H1 must produce a valid setup in the H4/D1 direction."
    };
  }

  if (!swingPullbackConfirmed(frames.M15, direction)) {
    return {
      state: "waiting_m15_confirmation", strategy: "SWING_H4_D1_M15_M5",
      direction, h1Score: h1Setup.score,
      reason: "H1 setup is valid, but M15 has not completed a qualifying pullback and directional rejection."
    };
  }

  const m5Trigger = evaluate(m5);
  if (m5Trigger.state !== "ok" || m5Trigger.signal !== direction) {
    return {
      state: "waiting_m5_trigger", strategy: "SWING_H4_D1_M15_M5",
      direction, h1Score: h1Setup.score,
      m5Signal: m5Trigger.signal || "NOT_READY",
      reason: "M5 must independently trigger in the already-confirmed H4/D1/H1/M15 direction."
    };
  }

  const levels = makeLevels(entryCandle.close, frames.H4, direction, CONFIG);
  if (!levels) {
    return { state: "warming", strategy: "SWING_H4_D1_M15_M5", reason: "H4 ATR is unavailable for structural risk sizing." };
  }

  return {
    state: "signal",
    strategy: "SWING_H4_D1_M15_M5",
    signalId: marketId + "-SWING-H4D1-M15-M5-" + entryCandle.epoch,
    marketId, market: marketName, category: "SWING",
    direction,
    entryTimeframe: "M5",
    confirmationTimeframe: "M15",
    setupTimeframe: "H1",
    trendTimeframes: ["H4", "D1"],
    riskTimeframe: "H4",
    candleEpoch: entryCandle.epoch,
    entryCandleEpoch: entryCandle.epoch,
    score: m5Trigger.score,
    setupScore: h1Setup.score,
    entryChecks: m5Trigger.checks,
    metrics: {
      h4Bias, d1Bias,
      h1Setup: { score: h1Setup.score, checks: h1Setup.checks },
      m5Trigger: { score: m5Trigger.score, checks: m5Trigger.checks }
    },
    ...levels,
    maxAgeSeconds: CONFIG.maxAgeSeconds
  };
}

module.exports = { CONFIG, completedAtOrBefore, evaluateRefinedSwing };
