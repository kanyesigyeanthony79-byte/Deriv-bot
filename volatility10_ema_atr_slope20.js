"use strict";

const PROVIDER_ID = "volatility10_ema_atr_slope20_v1";
const STRATEGY_VERSION = PROVIDER_ID;
const CANONICAL_MARKET_ID = "R_10";
const TIMEFRAME = "M1";
const BAR_SECONDS = 60;
const EMA_PERIODS = [12, 26, 100];
const ATR_PERIOD = 14;
const ATR_MEDIAN_BARS = 1000;
const SLOPE_LOOKBACK = 20;
const STOP_ATR_MULTIPLE = 3.0;
const TARGET_ATR_MULTIPLE = 3.0;
const MIN_OPPOSITE_CROSS_HOLD_BARS = 3;

function normalizeAlias(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
const R10_ALIASES = new Set([
  "r10", "volatility10", "volatility10index", "volatility10indexm1"
]);
function isVolatility10(value) {
  return R10_ALIASES.has(normalizeAlias(value));
}
function canonicalMarketId(value) {
  return isVolatility10(value) ? CANONICAL_MARKET_ID : null;
}

function ema(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  let current = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = current;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    current = alpha * values[i] + (1 - alpha) * current;
    out[i] = current;
  }
  return out;
}
function atrWilder(candles, period = ATR_PERIOD) {
  const tr = candles.map((c, i) => i === 0
    ? c.high - c.low
    : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)));
  const out = Array(candles.length).fill(null);
  if (candles.length < period) return out;
  let current = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = current;
  for (let i = period; i < tr.length; i++) {
    current = ((period - 1) * current + tr[i]) / period;
    out[i] = current;
  }
  return out;
}
function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function indicators(candles) {
  const closes = candles.map(c => c.close);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const ema100 = ema(closes, 100);
  const atr14 = atrWilder(candles, ATR_PERIOD);
  const atrMedian1000 = Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    if (i >= ATR_MEDIAN_BARS + ATR_PERIOD - 2) {
      const window = atr14.slice(i - ATR_MEDIAN_BARS + 1, i + 1);
      if (window.every(Number.isFinite)) atrMedian1000[i] = median(window);
    }
  }
  return { ema12, ema26, ema100, atr14, atrMedian1000 };
}
function validateCandle(c) {
  return c && Number.isFinite(Number(c.epoch)) &&
    [c.open, c.high, c.low, c.close].every(v => Number.isFinite(Number(v))) &&
    Number(c.low) <= Math.min(Number(c.open), Number(c.close)) &&
    Number(c.high) >= Math.max(Number(c.open), Number(c.close));
}
function qualifyDirection(bars, ind, i) {
  const p = i - 1, s = i - SLOPE_LOOKBACK;
  const required = [ind.ema12[i], ind.ema26[i], ind.ema100[i], ind.ema12[p],
    ind.ema26[p], ind.ema12[s], ind.ema26[s], ind.ema100[s],
    ind.atr14[i], ind.atrMedian1000[i]];
  if (!required.every(Number.isFinite)) return null;
  const crossUp = ind.ema12[i] > ind.ema26[i] && ind.ema12[p] <= ind.ema26[p];
  const crossDown = ind.ema12[i] < ind.ema26[i] && ind.ema12[p] >= ind.ema26[p];
  const atrPass = ind.atr14[i] >= ind.atrMedian1000[i];
  const longSlope = ind.ema12[i] > ind.ema12[s] && ind.ema26[i] > ind.ema26[s] && ind.ema100[i] > ind.ema100[s];
  const shortSlope = ind.ema12[i] < ind.ema12[s] && ind.ema26[i] < ind.ema26[s] && ind.ema100[i] < ind.ema100[s];
  if (crossUp && bars[i].close > ind.ema100[i] && longSlope && atrPass) return "LONG";
  if (crossDown && bars[i].close < ind.ema100[i] && shortSlope && atrPass) return "SHORT";
  return null;
}
function signalGate(signalEpoch, options = {}) {
  if (options.lastSignalEpoch === signalEpoch) return "duplicate_candle";
  if (options.activePosition) return "position_already_open";
  return null;
}
function createSignalRecord(direction, last, nextCandle, ind, i) {
  const entry = Number(nextCandle.open);
  const risk = STOP_ATR_MULTIPLE * ind.atr14[i];
  const signalEpoch = Number(last.epoch) + BAR_SECONDS;
  return {
    instrument: "Volatility 10 Index", marketId: CANONICAL_MARKET_ID, timeframe: TIMEFRAME, direction,
    signalTimestamp: new Date(signalEpoch * 1000).toISOString(), signalEpoch,
    strategyVersion: STRATEGY_VERSION, providerId: PROVIDER_ID,
    ema12: ind.ema12[i], ema26: ind.ema26[i], ema100: ind.ema100[i],
    atr14: ind.atr14[i], atrMedian1000: ind.atrMedian1000[i],
    referenceEntryPrice: entry, entryTimestamp: new Date(Number(nextCandle.epoch) * 1000).toISOString(),
    stopLoss: direction === "LONG" ? entry - risk : entry + risk,
    takeProfit: direction === "LONG" ? entry + risk : entry - risk,
    status: "PAPER", paper: true, live: false
  };
}
function evaluateSignal(completedCandles, nextCandle, options = {}) {
  if (!Array.isArray(completedCandles) || !completedCandles.length) {
    return { signal: null, reason: "warming_up" };
  }
  if (!completedCandles.every(validateCandle) || !validateCandle(nextCandle)) {
    return { signal: null, reason: "invalid_candles" };
  }
  const sorted = completedCandles.slice().sort((a, b) => a.epoch - b.epoch);
  let lastGap = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].epoch - sorted[i - 1].epoch !== BAR_SECONDS) lastGap = i;
  }
  const bars = sorted.slice(lastGap);
  if (bars.length < ATR_MEDIAN_BARS + ATR_PERIOD + SLOPE_LOOKBACK + 1) {
    return { signal: null, reason: "warming_up_after_gap" };
  }
  const last = bars[bars.length - 1];
  if (Number(nextCandle.epoch) !== Number(last.epoch) + BAR_SECONDS) return { signal: null, reason: "next_candle_not_aligned" };
  const ind = indicators(bars);
  const i = bars.length - 1;
  const p = i - 1;
  const s = i - SLOPE_LOOKBACK;
  const values = [ind.ema12[i], ind.ema26[i], ind.ema100[i], ind.ema12[p], ind.ema26[p],
    ind.ema12[s], ind.ema26[s], ind.ema100[s], ind.atr14[i], ind.atrMedian1000[i]];
  if (!values.every(Number.isFinite)) return { signal: null, reason: "indicator_warmup" };
  const direction = qualifyDirection(bars, ind, i);
  if (!direction) return { signal: null, reason: "conditions_not_met" };
  const signalEpoch = Number(last.epoch) + BAR_SECONDS;
  const signal = createSignalRecord(direction, last, nextCandle, ind, i);
  const gateReason = signalGate(signalEpoch, options);
  if (gateReason) return { signal: null, reason: gateReason };
  return { signal, reason: "signal" };
}
function evaluateExit(position, completedCandle, completedIndicators, candleIndex) {
  if (!position || !validateCandle(completedCandle)) return null;
  const heldBars = Number(candleIndex) - Number(position.entryIndex) + 1;
  if (position.direction === "LONG") {
    if (completedCandle.low <= position.stopLoss) return { reason: "STOP_LOSS", exitPrice: position.stopLoss };
    if (completedCandle.high >= position.takeProfit) return { reason: "TAKE_PROFIT", exitPrice: position.takeProfit };
    if (heldBars >= MIN_OPPOSITE_CROSS_HOLD &&
        completedIndicators.ema12[candleIndex] < completedIndicators.ema26[candleIndex] &&
        completedIndicators.ema12[candleIndex - 1] >= completedIndicators.ema26[candleIndex - 1]) {
      return { reason: "OPPOSITE_CROSS", exitPrice: completedCandle.close };
    }
  } else if (position.direction === "SHORT") {
    if (completedCandle.high >= position.stopLoss) return { reason: "STOP_LOSS", exitPrice: position.stopLoss };
    if (completedCandle.low <= position.takeProfit) return { reason: "TAKE_PROFIT", exitPrice: position.takeProfit };
    if (heldBars >= MIN_OPPOSITE_CROSS_HOLD &&
        completedIndicators.ema12[candleIndex] > completedIndicators.ema26[candleIndex] &&
        completedIndicators.ema12[candleIndex - 1] <= completedIndicators.ema26[candleIndex - 1]) {
      return { reason: "OPPOSITE_CROSS", exitPrice: completedCandle.close };
    }
  }
  return null;
}
module.exports = {
  PROVIDER_ID, STRATEGY_VERSION, CANONICAL_MARKET_ID, TIMEFRAME, BAR_SECONDS,
  ATR_MEDIAN_BARS, SLOPE_LOOKBACK, STOP_ATR_MULTIPLE, TARGET_ATR_MULTIPLE,
  MIN_OPPOSITE_CROSS_HOLD_BARS, normalizeAlias, isVolatility10, canonicalMarketId,
  ema, atrWilder, median, indicators, qualifyDirection, signalGate, createSignalRecord, evaluateSignal, evaluateExit
};
