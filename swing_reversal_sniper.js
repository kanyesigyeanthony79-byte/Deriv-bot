"use strict";

// Experimental, read-only staged reversal-to-sniper swing entry.
// This module is not imported by the live scanner, Telegram router or execution.
const { TIMEFRAMES, validCandles } = require("./multi_timeframe_engine");

const CONFIG = Object.freeze({
  h4BreakoutLookback: 10,
  h4BreakoutAge: 3,
  h1BreakoutLookback: 10,
  h1BreakoutAge: 2,
  m15PullbackLookback: 5,
  m5TriggerLookback: 5,
  pullbackEmaDistanceAtr: 0.45,
  minTriggerBodyAtr: 0.12,
  maxTriggerRangeAtr: 1.35,
  stopBufferAtr: 0.2,
  maxStopAtrH4: 2.0,
  tp1R: 1.5,
  tp2R: 2.5,
  maxAgeSeconds: 7 * 86400
});

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return 0;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let value = ranges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < ranges.length; i++) value = (value * (period - 1) + ranges[i]) / period;
  return value;
}

function priorTrend(candles) {
  const closes = candles.map(c => c.close);
  const fast = ema(closes, 20), slow = ema(closes, 50);
  if (!Number.isFinite(fast) || !Number.isFinite(slow) || fast === slow) return "NEUTRAL";
  return fast > slow ? "BUY" : "SELL";
}

function completedAtOrBefore(candles, timeframe, cutoffEpoch) {
  const seconds = TIMEFRAMES[timeframe];
  return (candles || []).filter(c => c.epoch + seconds <= cutoffEpoch);
}

// Find a completed structural breakout in the most recent N bars. The
// breakout candle is compared only with bars that preceded it.
function recentBreakout(candles, direction, lookback, maxAge) {
  const first = Math.max(lookback, candles.length - maxAge);
  for (let i = candles.length - 1; i >= first; i--) {
    const prior = candles.slice(i - lookback, i);
    const c = candles[i];
    const level = direction === "BUY"
      ? Math.max(...prior.map(x => x.high))
      : Math.min(...prior.map(x => x.low));
    if (direction === "BUY" ? c.close > level : c.close < level) {
      return { index: i, epoch: c.epoch, level, close: c.close };
    }
  }
  return null;
}

function pullbackConfirmed(candles, direction) {
  if (!validCandles(candles) || candles.length < 25) return false;
  const closes = candles.map(c => c.close);
  const average = ema(closes, 20), volatility = atr(candles, 14);
  const last = candles[candles.length - 1];
  if (!(volatility > 0) || !Number.isFinite(average)) return false;
  const distance = Math.abs(last.close - average) / volatility;
  const body = Math.abs(last.close - last.open);
  if (distance > CONFIG.pullbackEmaDistanceAtr || body < volatility * 0.08 ||
      body > volatility * 0.9 || last.high - last.low > volatility * 1.6) return false;
  return direction === "BUY"
    ? last.close > last.open && last.close >= average
    : last.close < last.open && last.close <= average;
}

function sniperTrigger(candles, direction) {
  if (!validCandles(candles) || candles.length < 30) return null;
  const last = candles[candles.length - 1];
  const prior = candles.slice(-CONFIG.m5TriggerLookback - 1, -1);
  const volatility = atr(candles, 14);
  if (!(volatility > 0) || !prior.length) return null;
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;
  if (body < volatility * CONFIG.minTriggerBodyAtr || range > volatility * CONFIG.maxTriggerRangeAtr) return null;
  const level = direction === "BUY"
    ? Math.max(...prior.map(c => c.high))
    : Math.min(...prior.map(c => c.low));
  const confirmed = direction === "BUY"
    ? last.close > level && last.close > last.open
    : last.close < level && last.close < last.open;
  return confirmed ? { level, close: last.close, epoch: last.epoch } : null;
}

function evaluateSwingReversalSniper(marketId, marketName, candlesByTimeframe, entryIndex = null) {
  const rawM5 = candlesByTimeframe.M5 || [];
  const index = Number.isInteger(entryIndex) ? Math.min(entryIndex, rawM5.length - 1) : rawM5.length - 1;
  if (index < 0 || !rawM5[index]) return { state: "warming", reason: "No completed M5 candle is available." };

  const m5 = rawM5.slice(0, index + 1);
  const entryCandle = m5[m5.length - 1];
  const cutoff = entryCandle.epoch + TIMEFRAMES.M5;
  const frames = {
    M15: completedAtOrBefore(candlesByTimeframe.M15, "M15", cutoff),
    H1: completedAtOrBefore(candlesByTimeframe.H1, "H1", cutoff),
    H4: completedAtOrBefore(candlesByTimeframe.H4, "H4", cutoff),
    D1: completedAtOrBefore(candlesByTimeframe.D1, "D1", cutoff)
  };
  const required = { M5: 65, M15: 25, H1: 60, H4: 60, D1: 51 };
  const used = { ...frames, M5: m5 };
  for (const [tf, count] of Object.entries(required)) {
    if (!validCandles(used[tf]) || used[tf].length < count) {
      return { state: "warming", timeframe: tf, availableCandles: used[tf]?.length || 0, requiredCandles: count,
        reason: "Waiting for sufficient completed candles." };
    }
  }

  // Stage 1: H4 must break recent structure against its preceding EMA trend.
  const h4 = frames.H4;
  const h4Break = {};
  for (const direction of ["BUY", "SELL"]) {
    const found = recentBreakout(h4, direction, CONFIG.h4BreakoutLookback, CONFIG.h4BreakoutAge);
    if (found) {
      const precedingTrend = priorTrend(h4.slice(0, found.index));
      if (precedingTrend !== "NEUTRAL" && precedingTrend !== direction) h4Break[direction] = found;
    }
  }
  const directions = Object.keys(h4Break);
  if (directions.length !== 1) {
    return { state: "reversal_watch", reason: "Waiting for a fresh H4 structural break against the preceding H4 trend.",
      h4BiasBeforeBreak: priorTrend(h4.slice(0, -1)) };
  }
  const direction = directions[0];

  // Stage 2: H1 independently confirms the same structural direction.
  const h1Break = recentBreakout(frames.H1, direction, CONFIG.h1BreakoutLookback, CONFIG.h1BreakoutAge);
  if (!h1Break) return { state: "reversal_confirming", direction,
    h4BreakEpoch: h4Break[direction].epoch, reason: "H4 reversal detected; waiting for H1 structural confirmation." };

  // Stage 3: M15 must pull back and close with the new direction.
  if (!pullbackConfirmed(frames.M15, direction)) return { state: "pullback_wait", direction,
    h4BreakEpoch: h4Break[direction].epoch, h1BreakEpoch: h1Break.epoch,
    reason: "H4 and H1 agree; waiting for a controlled M15 pullback and directional rejection." };

  // Stage 4: M5 must break its local range with a decisive completed candle.
  const trigger = sniperTrigger(m5, direction);
  if (!trigger) return { state: "entry_armed", direction,
    h4BreakEpoch: h4Break[direction].epoch, h1BreakEpoch: h1Break.epoch,
    reason: "M15 pullback is confirmed; waiting for the M5 sniper trigger." };

  const m15 = frames.M15, m15Atr = atr(m15, 14), h4Atr = atr(h4, 14);
  const recent = m15.slice(-CONFIG.m15PullbackLookback);
  const rawStop = direction === "BUY"
    ? Math.min(...recent.map(c => c.low)) - m15Atr * CONFIG.stopBufferAtr
    : Math.max(...recent.map(c => c.high)) + m15Atr * CONFIG.stopBufferAtr;
  const entry = entryCandle.close;
  const risk = direction === "BUY" ? entry - rawStop : rawStop - entry;
  if (!(risk > 0) || !(h4Atr > 0) || risk > h4Atr * CONFIG.maxStopAtrH4) {
    return { state: "invalid_risk", direction, reason: "The M15 structural stop is invalid or too wide relative to H4 volatility." };
  }
  const digits = Math.max(2, Math.min(8, (String(entry).split(".")[1] || "").length));
  const round = n => Number(n.toFixed(digits));
  const stopLoss = round(rawStop);
  const riskDistance = round(risk);
  return {
    state: "signal", strategy: "SWING_REVERSAL_SNIPER",
    signalId: marketId + "-SWING-REVERSAL-SNIPER-" + entryCandle.epoch,
    marketId, market: marketName, category: "SWING", direction,
    entryTimeframe: "M5", confirmationTimeframe: "M15", setupTimeframe: "H1",
    trendTimeframes: ["H4", "D1"], riskTimeframe: "M15",
    candleEpoch: entryCandle.epoch, entryCandleEpoch: entryCandle.epoch,
    entry: round(entry), stopLoss, riskDistance,
    tp1: round(direction === "BUY" ? entry + risk * CONFIG.tp1R : entry - risk * CONFIG.tp1R),
    tp2: round(direction === "BUY" ? entry + risk * CONFIG.tp2R : entry - risk * CONFIG.tp2R),
    riskReward: { tp1: CONFIG.tp1R, tp2: CONFIG.tp2R },
    maxAgeSeconds: CONFIG.maxAgeSeconds,
    metrics: { h4Break: h4Break[direction], h1Break, m15Pullback: true, m5Trigger: trigger,
      d1Context: priorTrend(frames.D1), h4Atr, m15Atr }
  };
}

module.exports = { CONFIG, atr, completedAtOrBefore, recentBreakout, pullbackConfirmed, sniperTrigger, evaluateSwingReversalSniper };
