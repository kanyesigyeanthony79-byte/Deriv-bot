"use strict";
// Multi-timeframe analysis layer. This module is intentionally separate from hosted_scanner.js.
// Inputs must be completed candles, oldest first. It never places trades or sends alerts.
const { evaluate, DEF } = require("./engine");
const { classifyMarketRegime, validateCandleContinuity } = require("./market_quality");

const TIMEFRAMES = Object.freeze({
  M1: 60, M5: 300, M15: 900, H1: 3600, H4: 14400, D1: 86400, W1: 604800
});

// Category = intended trade horizon, not merely the chart used for entry.
// A lower-timeframe entry must agree with both higher-timeframe context checks.
const CATEGORIES = Object.freeze({
  SCALP: Object.freeze({ label: "Scalping", entry: "M1", confirmation: "M5", context: "M15", risk: "M15", targetHorizon: "M15", maxAgeSeconds: 30 * 60, stopAtr: 1.25, tp1R: 1.25, tp2R: 1.8 }),
  SHORT_TERM: Object.freeze({ label: "Short-term", entry: "M5", confirmation: "M15", context: "H1", risk: "H1", targetHorizon: "H1", maxAgeSeconds: 6 * 3600, stopAtr: 1.5, tp1R: 1.5, tp2R: 2.25 }),
  SWING: Object.freeze({ label: "Swing", entry: "H1", confirmation: "H4", context: "D1", risk: "H4", targetHorizon: "H4", maxAgeSeconds: 7 * 86400, stopAtr: 1.75, tp1R: 1.5, tp2R: 2.5 }),
  POSITION: Object.freeze({ label: "Position", entry: "H4", confirmation: "D1", context: "W1", risk: "D1", targetHorizon: "D1", maxAgeSeconds: 30 * 86400, stopAtr: 2, tp1R: 2, tp2R: 3 })
});

function validCandles(candles) {
  return Array.isArray(candles) && candles.length >= 2 &&
    candles.every((c, i) => c && Number.isFinite(c.epoch) &&
      [c.open, c.high, c.low, c.close].every(Number.isFinite) &&
      c.high >= c.low && c.high >= Math.max(c.open, c.close) &&
      c.low <= Math.min(c.open, c.close) &&
      (i === 0 || c.epoch > candles[i - 1].epoch));
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function atr(candles, period = 14) {
  if (candles.length <= period) return 0;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let value = ranges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < ranges.length; i++) value = (value * (period - 1) + ranges[i]) / period;
  return value;
}

function trendBias(candles) {
  if (!validCandles(candles) || candles.length < 51) return { state: "warming", direction: "NEUTRAL" };
  const closes = candles.map(c => c.close);
  const fast = ema(closes, 20);
  const slow = ema(closes, 50);
  const previousSlow = ema(closes.slice(0, -1), 50);
  const volatility = atr(candles, 14);
  if (!(volatility > 0) || !Number.isFinite(fast) || !Number.isFinite(slow) || !Number.isFinite(previousSlow)) {
    return { state: "flat", direction: "NEUTRAL" };
  }
  const direction = fast > slow ? "BUY" : fast < slow ? "SELL" : "NEUTRAL";
  const separationAtr = Math.abs(fast - slow) / volatility;
  const slopeAtr = (slow - previousSlow) / volatility * (direction === "BUY" ? 1 : -1);
  if (direction === "NEUTRAL" || separationAtr < 0.08 || slopeAtr <= 0) {
    return { state: "mixed", direction: "NEUTRAL", separationAtr, slopeAtr };
  }
  return { state: "aligned", direction, separationAtr, slopeAtr };
}

function makeLevels(entryPrice, riskCandles, direction, config) {
  const volatility = atr(riskCandles, 14);
  if (!(volatility > 0)) return null;
  const riskDistance = volatility * config.stopAtr;
  const digits = Math.max(2, Math.min(8, (String(entryPrice).split(".")[1] || "").length));
  const round = value => Number(value.toFixed(digits));
  return {
    entry: round(entryPrice),
    stopLoss: round(direction === "BUY" ? entryPrice - riskDistance : entryPrice + riskDistance),
    tp1: round(direction === "BUY" ? entryPrice + riskDistance * config.tp1R : entryPrice - riskDistance * config.tp1R),
    tp2: round(direction === "BUY" ? entryPrice + riskDistance * config.tp2R : entryPrice - riskDistance * config.tp2R),
    riskDistance: round(riskDistance),
    riskReward: { tp1: config.tp1R, tp2: config.tp2R }
  };
}

function evaluateCategory(marketId, marketName, category, candlesByTimeframe, entryIndex = null) {
  const config = CATEGORIES[category];
  if (!config) throw new Error("Unknown signal category: " + category);
  const rawEntryCandles = candlesByTimeframe[config.entry] || [];
  const chosenIndex = Number.isInteger(entryIndex) ? Math.min(entryIndex, rawEntryCandles.length - 1) : rawEntryCandles.length - 1;
  const entryCandles = rawEntryCandles.slice(0, chosenIndex + 1);
  const entryCandle = entryCandles[entryCandles.length - 1];
  const cutoffEpoch = entryCandle ? entryCandle.epoch + TIMEFRAMES[config.entry] : 0;
  const confirmationCandles = (candlesByTimeframe[config.confirmation] || []).filter(c => c.epoch + TIMEFRAMES[config.confirmation] <= cutoffEpoch);
  const contextCandles = (candlesByTimeframe[config.context] || []).filter(c => c.epoch + TIMEFRAMES[config.context] <= cutoffEpoch);
  const riskCandles = (candlesByTimeframe[config.risk] || []).filter(c => c.epoch + TIMEFRAMES[config.risk] <= cutoffEpoch);

  if (!validCandles(entryCandles) || entryCandles.length < 65 ||
      !validCandles(confirmationCandles) || confirmationCandles.length < 60 ||
      !validCandles(contextCandles) || contextCandles.length < (config.context === "W1" ? 51 : 60) ||
      !validCandles(riskCandles) || riskCandles.length < 20) {
    return { state: "warming", category, label: config.label, reason: "Waiting for sufficient completed candles across required timeframes." };
  }

  // Reject data gaps before indicators are trusted. Gold/USD weekend closures are exempted.
  const candlesUsed = { [config.entry]: entryCandles, [config.confirmation]: confirmationCandles, [config.context]: contextCandles, [config.risk]: riskCandles };
  for (const tf of [config.entry, config.confirmation, config.context, config.risk]) {
    const continuity = validateCandleContinuity(candlesUsed[tf] || [], TIMEFRAMES[tf], marketId);
    if (!continuity.valid) return { state: "data_gap", category, label: config.label, timeframe: tf, gaps: continuity.gaps.slice(0, 5), reason: "Missing candle intervals detected; indicators are withheld until data quality is restored." };
  }

  const confirmationRegime = classifyMarketRegime(confirmationCandles);
  const contextRegime = classifyMarketRegime(contextCandles);
  for (const [timeframe, regime] of [[config.confirmation, confirmationRegime], [config.context, contextRegime]]) {
    if (regime.state === "ranging" || regime.state === "high_volatility" || regime.state === "transitioning" || regime.state === "warming" || regime.state === "uncertain") {
      return { state: "market_filtered", category, label: config.label, timeframe, regime, reason: "Market conditions are not suitable for this trend-following setup." };
    }
  }

  const entryResult = evaluate(entryCandles);
  const confirmation = trendBias(confirmationCandles);
  const context = trendBias(contextCandles);
  if (entryResult.state !== "ok") {
    return { state: entryResult.state || "warming", category, label: config.label, reason: "Entry timeframe is not ready." };
  }
  if (entryResult.signal !== "BUY" && entryResult.signal !== "SELL") {
    return { state: "no_signal", category, label: config.label, reason: "Entry timeframe rules did not produce a signal.", score: entryResult.score };
  }
  if (confirmation.direction !== entryResult.signal || context.direction !== entryResult.signal) {
    return {
      state: "timeframe_conflict", category, label: config.label,
      direction: entryResult.signal, confirmationBias: confirmation.direction,
      contextBias: context.direction, confirmationRegime, contextRegime, reason: "Entry, confirmation and higher-timeframe context are not aligned."
    };
  }

  const levels = makeLevels(entryCandle.close, riskCandles, entryResult.signal, config);
  if (!levels) return { state: "warming", category, label: config.label, reason: "Risk timeframe ATR is unavailable." };

  return {
    state: "signal",
    signalId: marketId + "-" + category + "-" + entryCandle.epoch,
    marketId, market: marketName, category, categoryLabel: config.label,
    direction: entryResult.signal,
    entryTimeframe: config.entry,
    confirmationTimeframe: config.confirmation,
    contextTimeframe: config.context,
    riskTimeframe: config.risk,
    targetHorizon: config.targetHorizon,
    candleEpoch: entryCandle.epoch,
    entryCandleEpoch: entryCandle.epoch,
    score: entryResult.score,
    entryChecks: entryResult.checks,
    metrics: {
      entry: entryResult.metrics,
      confirmation: confirmation,
      context: context,
      riskAtr: atr(riskCandles, 14)
    },
    ...levels,
    maxAgeSeconds: config.maxAgeSeconds
  };
}

function evaluateAllCategories(marketId, marketName, candlesByTimeframe) {
  return Object.keys(CATEGORIES).map(category =>
    evaluateCategory(marketId, marketName, category, candlesByTimeframe)
  );
}

// Recover recent completed entry bars between scheduled scans. Higher-timeframe
// confirmation/context candles are cut off at each entry bar's close to avoid look-ahead.
function evaluateRecentSignals(marketId, marketName, candlesByTimeframe, recentBars = 6) {
  const found = [];
  for (const category of Object.keys(CATEGORIES)) {
    const entry = candlesByTimeframe[CATEGORIES[category].entry] || [];
    const start = Math.max(64, entry.length - Math.max(1, recentBars));
    for (let index = start; index < entry.length; index++) {
      const result = evaluateCategory(marketId, marketName, category, candlesByTimeframe, index);
      if (result.state === "signal") found.push(result);
    }
  }
  return found;
}

// Deriv candle history may be requested as daily candles and safely aggregated into
// completed UTC weeks. The current, incomplete week is deliberately excluded.
function aggregateWeeklyCandles(dailyCandles, nowEpoch = Math.floor(Date.now() / 1000)) {
  if (!validCandles(dailyCandles)) return [];
  const weeks = new Map();
  for (const candle of dailyCandles) {
    const date = new Date(candle.epoch * 1000);
    const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000;
    const daysSinceMonday = (date.getUTCDay() + 6) % 7;
    const weekStart = midnight - daysSinceMonday * 86400;
    const current = weeks.get(weekStart);
    if (!current) {
      weeks.set(weekStart, { epoch: weekStart, open: candle.open, high: candle.high, low: candle.low, close: candle.close });
    } else {
      current.high = Math.max(current.high, candle.high);
      current.low = Math.min(current.low, candle.low);
      current.close = candle.close;
    }
  }
  return [...weeks.values()]
    .filter(c => c.epoch + TIMEFRAMES.W1 <= nowEpoch)
    .sort((a, b) => a.epoch - b.epoch);
}

module.exports = {
  TIMEFRAMES, CATEGORIES, validCandles, trendBias, makeLevels, classifyMarketRegime, validateCandleContinuity,
  evaluateCategory, evaluateAllCategories, evaluateRecentSignals, aggregateWeeklyCandles
};
