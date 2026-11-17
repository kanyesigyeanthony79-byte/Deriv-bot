"use strict";

// Phase 1 market-quality checks. These are filters, not win-probability estimates.
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
function classifyMarketRegime(candles, options = {}) {
  const minCandles = Number.isInteger(options.minCandles) ? options.minCandles : 70;
  const slopeLookback = Number.isInteger(options.slopeLookback) ? options.slopeLookback : 5;
  const requiredCandles = Math.max(minCandles, 50 + slopeLookback);
  if (!Array.isArray(candles) || candles.length < requiredCandles) {
    return { state: "warming", reason: "Need at least " + requiredCandles + " completed candles for regime analysis." };
  }
  const closes = candles.map(c => c.close);
  const fast = ema(closes, 20), slow = ema(closes, 50);
  const previousSlow = ema(closes.slice(0, -slopeLookback), 50);
  const currentAtr = atr(candles, 14);
  if (!(currentAtr > 0) || !Number.isFinite(fast) || !Number.isFinite(slow) || !Number.isFinite(previousSlow)) {
    return { state: "uncertain", reason: "Insufficient volatility or trend measurements." };
  }
  const recentRanges = [];
  for (let end = candles.length - 1; end >= Math.max(14, candles.length - 70); end--) {
    recentRanges.push(atr(candles.slice(0, end + 1), 14));
  }
  const baseline = recentRanges.filter(Number.isFinite).sort((a, b) => a - b);
  const medianAtr = baseline.length ? baseline[Math.floor(baseline.length / 2)] : currentAtr;
  const volatilityRatio = medianAtr > 0 ? currentAtr / medianAtr : 1;
  const separationAtr = Math.abs(fast - slow) / currentAtr;
  // Normalize the slope to a five-candle equivalent so shorter, explicitly
  // configured context windows remain comparable with the default filter.
  const slopeAtr = (slow - previousSlow) / currentAtr * (5 / slopeLookback);
  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const latestRangeAtr = Math.max(latest.high - latest.low, Math.abs(latest.high - previous.close), Math.abs(latest.low - previous.close)) / currentAtr;
  if (volatilityRatio >= 1.8 || latestRangeAtr >= 2.8) {
    return { state: "high_volatility", separationAtr, slopeAtr, volatilityRatio, latestRangeAtr, reason: "Volatility is unusually elevated; avoid treating ordinary trend alignment as a clean setup." };
  }
  if (separationAtr >= 0.15 && Math.abs(slopeAtr) >= 0.025 && Math.sign(fast - slow) === Math.sign(slopeAtr)) {
    return { state: "trending", direction: fast > slow ? "BUY" : "SELL", separationAtr, slopeAtr, volatilityRatio, latestRangeAtr, reason: "Trend separation and slope are aligned." };
  }
  if (separationAtr < 0.08 && Math.abs(slopeAtr) < 0.02) {
    return { state: "ranging", separationAtr, slopeAtr, volatilityRatio, latestRangeAtr, reason: "Trend separation and slope are too weak; market is likely ranging." };
  }
  return { state: "transitioning", direction: fast > slow ? "BUY" : fast < slow ? "SELL" : "NEUTRAL", separationAtr, slopeAtr, volatilityRatio, latestRangeAtr, reason: "Market is transitioning; trend conditions are not sufficiently clear." };
}

// Gold D1 data also omits selected exchange holidays.
function easterSundayUtc(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day) / 1000;
}
function isGoldMarketHolidayUtc(epoch) {
  const date = new Date(epoch * 1000);
  const month = date.getUTCMonth() + 1, day = date.getUTCDate();
  if ((month === 12 && day === 25) || (month === 1 && day === 1)) return true;
  const goodFriday = easterSundayUtc(date.getUTCFullYear()) - 2 * 86400;
  return Math.floor(epoch / 86400) === Math.floor(goodFriday / 86400);
}
function isGoldD1ClosureGap(fromEpoch, toEpoch) {
  const from = new Date(fromEpoch * 1000), to = new Date(toEpoch * 1000);
  if (from.getUTCHours() || from.getUTCMinutes() || from.getUTCSeconds() ||
      to.getUTCHours() || to.getUTCMinutes() || to.getUTCSeconds()) return false;
  const dayCount = (toEpoch - fromEpoch) / 86400;
  if (!Number.isInteger(dayCount) || dayCount < 2 || dayCount > 5) return false;
  for (let offset = 1; offset < dayCount; offset++) {
    const skippedEpoch = fromEpoch + offset * 86400;
    const weekday = new Date(skippedEpoch * 1000).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !isGoldMarketHolidayUtc(skippedEpoch)) return false;
  }
  return true;
}

// Flags missing bars while allowing the normal weekend closure for Gold/USD.
function validateCandleContinuity(candles, timeframeSeconds, marketId) {
  if (!Array.isArray(candles) || candles.length < 2 || !(timeframeSeconds > 0)) {
    return { valid: false, gaps: [], reason: "Insufficient candles to validate continuity." };
  }
  const gaps = [];
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].epoch - candles[i - 1].epoch;
    if (delta <= timeframeSeconds * 1.5) continue;
    const from = new Date(candles[i - 1].epoch * 1000);
    const to = new Date(candles[i].epoch * 1000);
    const isGold = marketId === "frxXAUUSD";
    const weekendClosure = isGold &&
      (from.getUTCDay() === 5 || from.getUTCDay() === 6 || from.getUTCDay() === 0) &&
      (to.getUTCDay() === 0 || to.getUTCDay() === 1) &&
      delta <= 72 * 3600 + timeframeSeconds;
    // Deriv's Gold feed has a short daily maintenance break around 22:00 UTC.
    // Allow only gaps that straddle that known window on the same UTC day;
    // arbitrary intraday gaps remain invalid. The wider duration accommodates
    // H1 bars whose opens naturally sit on either side of the one-hour break.
    const fromMinute = from.getUTCHours() * 60 + from.getUTCMinutes();
    const toMinute = to.getUTCHours() * 60 + to.getUTCMinutes();
    const dailyGoldHolidayClosure = isGold && timeframeSeconds === 86400 &&
      isGoldD1ClosureGap(candles[i - 1].epoch, candles[i].epoch);
    const dailyGoldSessionBreak = isGold &&
      from.getUTCFullYear() === to.getUTCFullYear() &&
      from.getUTCMonth() === to.getUTCMonth() &&
      from.getUTCDate() === to.getUTCDate() &&
      fromMinute >= 20 * 60 + 30 && fromMinute <= 22 * 60 + 15 &&
      toMinute >= 22 * 60 + 45 && toMinute <= 23 * 60 + 59 &&
      delta <= 3 * 3600 + timeframeSeconds;
    if (!weekendClosure && !dailyGoldSessionBreak && !dailyGoldHolidayClosure) gaps.push({ afterEpoch: candles[i - 1].epoch, beforeEpoch: candles[i].epoch, missingIntervals: Math.max(1, Math.round(delta / timeframeSeconds) - 1) });
  }
  return { valid: gaps.length === 0, gaps, reason: gaps.length ? "Missing candle intervals detected." : "Candle sequence is continuous." };
}
module.exports = { classifyMarketRegime, validateCandleContinuity };
