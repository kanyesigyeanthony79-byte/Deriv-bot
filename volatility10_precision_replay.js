"use strict";
// Volatility 10 precision-entry replay.
// Offline research only: no Telegram messages, API calls, orders, or execution queue access.
const fs = require("node:fs");
const path = require("node:path");
const { evaluate } = require("./engine");

const INPUT = path.join(__dirname, "lower_tf_research_candles.json");
const OUTPUT = path.join(__dirname, "volatility10_precision_replay_report.json");
const MARKET_ID = "R_10";
const SECONDS = Object.freeze({ M1: 60, M5: 300, M15: 900 });
const ENTRY_WINDOW_SECONDS = 15 * 60;
const OBSERVATION_SECONDS = 60 * 60;
const STRUCTURE_LOOKBACK = 5;
const ATR_BUFFER = 0.10;
const MAX_STOP_M15_ATR = 2.0;
const TARGET_R = 2.0;

function validCandle(c) {
  return c && [c.epoch, c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.high >= c.low && c.high >= Math.max(c.open, c.close) &&
    c.low <= Math.min(c.open, c.close);
}

function latestContinuousSegment(rows, timeframeSeconds) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error("Insufficient " + timeframeSeconds + "s candles.");
  for (let i = 0; i < rows.length; i++) {
    if (!validCandle(rows[i])) throw new Error("Invalid OHLC candle at index " + i + ".");
    if (i > 0 && rows[i].epoch <= rows[i - 1].epoch) throw new Error("Unsorted or duplicate candle epoch at index " + i + ".");
  }
  let start = rows.length - 1;
  while (start > 0 && rows[start].epoch - rows[start - 1].epoch === timeframeSeconds) start--;
  return rows.slice(start);
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return 0;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i], previous = candles[i - 1];
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }
  let value = ranges.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let i = period; i < ranges.length; i++) value = (value * (period - 1) + ranges[i]) / period;
  return value;
}

function lowerBound(rows, epoch) {
  let low = 0, high = rows.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (rows[mid].epoch < epoch) low = mid + 1;
    else high = mid;
  }
  return low;
}

function lastCompletedIndex(rows, timeframeSeconds, beforeOrAtEpoch) {
  let low = 0, high = rows.length - 1, answer = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (rows[mid].epoch + timeframeSeconds <= beforeOrAtEpoch) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return answer;
}

function trendAligned(rows, index, direction) {
  if (index < 20) return false;
  const closes = rows.slice(0, index + 1).map(c => c.close);
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  return direction === "BUY" ? fast > slow : fast < slow;
}

function findM5Trigger(candles, setupCloseEpoch, direction) {
  const start = lowerBound(candles, setupCloseEpoch);
  const endEpoch = setupCloseEpoch + ENTRY_WINDOW_SECONDS;
  for (let i = Math.max(25, start); i < candles.length - 1; i++) {
    const candle = candles[i];
    if (candle.epoch >= endEpoch) break;
    if (!trendAligned(candles, i, direction)) continue;

    const previous = candles[i - 1];
    const previousEma9 = ema(candles.slice(0, i).map(c => c.close), 9);
    const currentRows = candles.slice(0, i + 1);
    const currentEma9 = ema(currentRows.map(c => c.close), 9);
    const volatility = atr(currentRows, 14);
    if (!(volatility > 0)) continue;

    const confirmed = direction === "BUY"
      ? previous.close > previousEma9 &&
        candle.low <= currentEma9 + volatility * 0.15 &&
        candle.close > currentEma9 && candle.close > candle.open
      : previous.close < previousEma9 &&
        candle.high >= currentEma9 - volatility * 0.15 &&
        candle.close < currentEma9 && candle.close < candle.open;

    if (confirmed) return { index: i, candle, entryCandle: candles[i + 1], volatility };
  }
  return null;
}

function findM1Trigger(m1Candles, m5Candles, setupCloseEpoch, direction) {
  const start = lowerBound(m1Candles, setupCloseEpoch);
  const endEpoch = setupCloseEpoch + ENTRY_WINDOW_SECONDS;
  for (let i = Math.max(30, start); i < m1Candles.length - 1; i++) {
    const candle = m1Candles[i];
    if (candle.epoch >= endEpoch) break;

    const m5Index = lastCompletedIndex(m5Candles, SECONDS.M5, candle.epoch);
    if (m5Index < 20 || !trendAligned(m5Candles, m5Index, direction)) continue;

    const currentRows = m1Candles.slice(0, i + 1);
    const currentEma9 = ema(currentRows.map(c => c.close), 9);
    const volatility = atr(currentRows, 14);
    if (!(volatility > 0)) continue;

    const priorThree = m1Candles.slice(i - 3, i);
    if (priorThree.length !== 3) continue;
    const microSwing = direction === "BUY"
      ? Math.max(...priorThree.map(c => c.high))
      : Math.min(...priorThree.map(c => c.low));

    const confirmed = direction === "BUY"
      ? candle.low <= currentEma9 + volatility * 0.10 &&
        candle.close > currentEma9 && candle.close > candle.open &&
        candle.close > microSwing
      : candle.high >= currentEma9 - volatility * 0.10 &&
        candle.close < currentEma9 && candle.close < candle.open &&
        candle.close < microSwing;

    if (confirmed) return { index: i, candle, entryCandle: m1Candles[i + 1], volatility };
  }
  return null;
}

function structureStop(candles, triggerIndex, direction, entryPrice, volatility, setupAtr) {
  const recent = candles.slice(Math.max(0, triggerIndex - STRUCTURE_LOOKBACK + 1), triggerIndex + 1);
  if (recent.length !== STRUCTURE_LOOKBACK || !(volatility > 0) || !(setupAtr > 0)) {
    return { accepted: false, status: "invalid_risk", reason: "Insufficient stop structure or ATR." };
  }
  const buffer = volatility * ATR_BUFFER;
  const stopLoss = direction === "BUY"
    ? Math.min(...recent.map(c => c.low)) - buffer
    : Math.max(...recent.map(c => c.high)) + buffer;
  const riskDistance = Math.abs(entryPrice - stopLoss);
  const directionallyValid = direction === "BUY" ? stopLoss < entryPrice : stopLoss > entryPrice;
  if (!directionallyValid || !(riskDistance > 0) || !Number.isFinite(riskDistance)) {
    return { accepted: false, status: "invalid_risk", reason: "Entry is not on the safe side of the structure stop." };
  }
  const riskM15Atr = riskDistance / setupAtr;
  if (riskM15Atr > MAX_STOP_M15_ATR) {
    return { accepted: false, status: "wide_risk", riskDistance, riskM15Atr, stopLoss };
  }
  return { accepted: true, stopLoss, riskDistance, riskM15Atr };
}

function resolveOutcome(candles, entryIndex, direction, entryPrice, stopLoss, horizonEndEpoch, timeframeSeconds) {
  const riskDistance = Math.abs(entryPrice - stopLoss);
  if (!(riskDistance > 0)) return { status: "invalid_risk" };
  const target = entryPrice + (direction === "BUY" ? 1 : -1) * TARGET_R * riskDistance;
  let lastCandle = null;
  let barsObserved = 0;

  for (let i = entryIndex; i < candles.length && candles[i].epoch < horizonEndEpoch; i++) {
    const candle = candles[i];
    lastCandle = candle;
    barsObserved++;
    const stopTouched = direction === "BUY"
      ? candle.low <= stopLoss
      : candle.high >= stopLoss;
    const targetTouched = direction === "BUY"
      ? candle.high >= target
      : candle.low <= target;

    if (stopTouched && targetTouched) return { status: "ambiguous", barsObserved, outcomeEpoch: candle.epoch };
    if (stopTouched) return { status: "stop", r: -1, barsObserved, outcomeEpoch: candle.epoch };
    if (targetTouched) return { status: "target", r: TARGET_R, barsObserved, outcomeEpoch: candle.epoch };
  }

  if (!lastCandle || lastCandle.epoch + timeframeSeconds < horizonEndEpoch) {
    return { status: "censored", barsObserved };
  }
  const signedMove = direction === "BUY"
    ? lastCandle.close - entryPrice
    : entryPrice - lastCandle.close;
  return {
    status: "time_exit",
    r: signedMove / riskDistance,
    barsObserved,
    outcomeEpoch: lastCandle.epoch
  };
}

function simulateBaseline(m15Candles, setupIndex, direction, setupAtr) {
  const entryIndex = setupIndex + 1;
  const entryCandle = m15Candles[entryIndex];
  if (!entryCandle) return { status: "censored" };
  const riskDistance = setupAtr * 1.5;
  const stopLoss = direction === "BUY"
    ? entryCandle.open - riskDistance
    : entryCandle.open + riskDistance;
  return {
    ...resolveOutcome(
      m15Candles, entryIndex, direction, entryCandle.open, stopLoss,
      entryCandle.epoch + OBSERVATION_SECONDS, SECONDS.M15
    ),
    entry: entryCandle.open,
    stopLoss,
    riskM15Atr: 1.5
  };
}

function simulatePrecision(candles, timeframe, trigger, direction, setupAtr) {
  if (!trigger) return { status: "no_trigger" };
  const entryIndex = trigger.index + 1;
  const entryCandle = candles[entryIndex];
  if (!entryCandle) return { status: "censored" };
  const stop = structureStop(candles, trigger.index, direction, entryCandle.open, trigger.volatility, setupAtr);
  if (!stop.accepted) return stop;
  return {
    ...resolveOutcome(
      candles, entryIndex, direction, entryCandle.open, stop.stopLoss,
      entryCandle.epoch + OBSERVATION_SECONDS, SECONDS[timeframe]
    ),
    entry: entryCandle.open,
    stopLoss: stop.stopLoss,
    riskDistance: stop.riskDistance,
    riskM15Atr: stop.riskM15Atr,
    triggerEpoch: trigger.candle.epoch,
    entryEpoch: entryCandle.epoch
  };
}

function summarize(trades) {
  const counts = {};
  for (const item of trades) counts[item.trade.status] = (counts[item.trade.status] || 0) + 1;
  const resolved = trades.filter(item => ["target", "stop", "time_exit"].includes(item.trade.status));
  const returns = resolved.map(item => item.trade.r);
  const riskSamples = resolved.map(item => item.trade.riskM15Atr).filter(Number.isFinite);
  const pct = (n, d) => d ? Number((n / d * 100).toFixed(1)) : null;
  return {
    setups: trades.length,
    entryCoveragePct: pct(trades.length - (counts.no_trigger || 0) - (counts.censored || 0), trades.length),
    resolvedOutcomes: resolved.length,
    target: counts.target || 0,
    stop: counts.stop || 0,
    timeExit: counts.time_exit || 0,
    ambiguous: counts.ambiguous || 0,
    noTrigger: counts.no_trigger || 0,
    wideRiskRejected: counts.wide_risk || 0,
    invalidRiskRejected: counts.invalid_risk || 0,
    censored: counts.censored || 0,
    targetRatePct: pct(counts.target || 0, resolved.length),
    stopRatePct: pct(counts.stop || 0, resolved.length),
    expectancyR: returns.length
      ? Number((returns.reduce((sum, value) => sum + value, 0) / returns.length).toFixed(3))
      : null,
    averageStopDistanceM15ATR: riskSamples.length
      ? Number((riskSamples.reduce((sum, value) => sum + value, 0) / riskSamples.length).toFixed(3))
      : null
  };
}

function selectNonOverlappingSetups(setups) {
  const ordered = (Array.isArray(setups) ? setups : [])
    .slice()
    .sort((a, b) => a.setupCloseEpoch - b.setupCloseEpoch);
  const selected = [];
  let nextEligibleEpoch = -Infinity;
  for (const setup of ordered) {
    if (!Number.isFinite(setup.setupCloseEpoch) || setup.setupCloseEpoch < nextEligibleEpoch) continue;
    selected.push(setup);
    // Reserve the full 15-minute entry window plus one-hour outcome horizon.
    // This is deliberately conservative and common to M15, M5, and M1 methods.
    nextEligibleEpoch = setup.setupCloseEpoch + ENTRY_WINDOW_SECONDS + OBSERVATION_SECONDS;
  }
  return selected;
}

function summarizeMethods(setups, splitIndex) {
  const summarizeMethod = key => {
    const trades = setups.map(setup => ({ setup, trade: setup[key] }));
    return {
      all: summarize(trades),
      discovery: summarize(trades.slice(0, splitIndex)),
      validation: summarize(trades.slice(splitIndex))
    };
  };
  return {
    m15Baseline: summarizeMethod("baseline"),
    m5PrecisionEntry: summarizeMethod("m5"),
    m1PrecisionEntry: summarizeMethod("m1")
  };
}

function runReplay(archive, options = {}) {
  const marketId = options.marketId || MARKET_ID;
  const market = archive?.markets?.[marketId];
  if (!market?.timeframes) throw new Error("Missing research candles for " + marketId + ".");
  const m1 = latestContinuousSegment(market.timeframes.M1, SECONDS.M1);
  const m5 = latestContinuousSegment(market.timeframes.M5, SECONDS.M5);
  const m15 = latestContinuousSegment(market.timeframes.M15, SECONDS.M15);

  const commonStart = Math.max(m1[0].epoch, m5[0].epoch, m15[0].epoch);
  const commonEnd = Math.min(
    m1[m1.length - 1].epoch + SECONDS.M1,
    m5[m5.length - 1].epoch + SECONDS.M5,
    m15[m15.length - 1].epoch + SECONDS.M15
  );
  const setups = [];

  for (let i = 64; i < m15.length - 1; i++) {
    const setupCandle = m15[i];
    const setupCloseEpoch = setupCandle.epoch + SECONDS.M15;
    // Only compare setups with all three timeframes present and a full entry window + one-hour outcome window.
    if (setupCloseEpoch < commonStart ||
        setupCloseEpoch + ENTRY_WINDOW_SECONDS + OBSERVATION_SECONDS > commonEnd) continue;

    const signal = evaluate(m15.slice(0, i + 1));
    if (signal.state !== "ok" || !["BUY", "SELL"].includes(signal.signal)) continue;
    const setupAtr = Number(signal.metrics?.atr);
    if (!(setupAtr > 0)) continue;

    const baseline = simulateBaseline(m15, i, signal.signal, setupAtr);
    const m5Trigger = findM5Trigger(m5, setupCloseEpoch, signal.signal);
    const m1Trigger = findM1Trigger(m1, m5, setupCloseEpoch, signal.signal);

    setups.push({
      setupEpoch: setupCandle.epoch,
      setupCloseEpoch,
      direction: signal.signal,
      score: signal.score,
      baseline,
      m5: simulatePrecision(m5, "M5", m5Trigger, signal.signal, setupAtr),
      m1: simulatePrecision(m1, "M1", m1Trigger, signal.signal, setupAtr)
    });
  }

  const splitIndex = Math.ceil(setups.length / 2);
  const splitEpoch = setups[splitIndex]?.setupEpoch ?? null;
  const nonOverlappingSetups = selectNonOverlappingSetups(setups);
  const nonOverlappingSplitIndex = Math.ceil(nonOverlappingSetups.length / 2);
  const nonOverlappingSplitEpoch = nonOverlappingSetups[nonOverlappingSplitIndex]?.setupEpoch ?? null;

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: "offline_research_only",
    marketId,
    marketName: market.marketName || "Volatility 10 Index",
    dataCoverage: {
      commonStart: new Date(commonStart * 1000).toISOString(),
      commonEnd: new Date(commonEnd * 1000).toISOString(),
      commonHours: Number(((commonEnd - commonStart) / 3600).toFixed(2)),
      latestContinuousCandles: { M1: m1.length, M5: m5.length, M15: m15.length }
    },
    rules: {
      setup: "Existing production engine.evaluate rules on a completed M15 candle; direction is frozen at the M15 close.",
      m5Entry: "Within the following 15 minutes, require M5 EMA9/EMA21 alignment, a prior close on the trend side of EMA9, then an EMA9 touch/reclaim candle in the setup direction. Entry is next M5 open.",
      m1Entry: "Within the following 15 minutes, require the latest completed M5 EMA9/EMA21 alignment, then an M1 EMA9 touch/reclaim and a close beyond the prior three-candle micro swing. Entry is next M1 open.",
      stop: "Beyond the most recent five completed entry-timeframe candles, plus/minus 0.10 entry-timeframe ATR(14). Reject invalid risk and stops wider than 2.0 times setup M15 ATR.",
      baseline: "Next M15 open with the existing comparison baseline stop of 1.5 times M15 ATR.",
      exits: "All methods use a 2R target and a one-hour observation horizon. If stop and target are both touched in one OHLC candle, outcome is ambiguous. Unresolved trades are marked to market at the final candle close."
    },
    split: {
      method: "Chronological 50/50 discovery and validation split across eligible M15 setups. No parameter tuning is performed.",
      discoverySetups: splitIndex,
      validationSetups: setups.length - splitIndex,
      validationStartsAt: splitEpoch ? new Date(splitEpoch * 1000).toISOString() : null
    },
    results: summarizeMethods(setups, splitIndex),
    overlapSensitivity: {
      method: "Greedy chronological selection; each selected setup reserves its full 15-minute entry window plus one-hour outcome horizon before another setup may be selected.",
      selectedSetups: nonOverlappingSetups.length,
      excludedOverlappingSetups: setups.length - nonOverlappingSetups.length,
      split: {
        method: "Chronological 50/50 discovery and validation split within the non-overlapping subset.",
        discoverySetups: nonOverlappingSplitIndex,
        validationSetups: nonOverlappingSetups.length - nonOverlappingSplitIndex,
        validationStartsAt: nonOverlappingSplitEpoch ? new Date(nonOverlappingSplitEpoch * 1000).toISOString() : null
      },
      results: summarizeMethods(nonOverlappingSetups, nonOverlappingSplitIndex)
    },
    setups: setups.map(item => ({
      setupTime: new Date(item.setupEpoch * 1000).toISOString(),
      direction: item.direction,
      score: item.score,
      m15Baseline: item.baseline,
      m5Precision: item.m5,
      m1Precision: item.m1
    })),
    limitations: [
      "The latest common continuous M1/M5/M15 overlap is short; this is a pilot sample, not statistical validation.",
      "Primary results are per setup and may overlap; the separate overlap-sensitivity subset greedily reserves the full entry and outcome window, but is still a small pilot rather than a compounded portfolio simulation.",
      "Spread, slippage, commission, and execution latency are not modelled.",
      "OHLC data cannot establish the intrabar order when stop and target are both touched.",
      "No result from this report changes the live scanner, Telegram routing, or MT5 execution permissions."
    ]
  };
}

function main() {
  if (!fs.existsSync(INPUT)) throw new Error("Missing lower-timeframe archive: " + INPUT);
  const archive = JSON.parse(fs.readFileSync(INPUT, "utf8"));
  const report = runReplay(archive, { marketId: MARKET_ID });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({
    event: "volatility10_precision_replay_complete",
    marketId: report.marketId,
    dataCoverage: report.dataCoverage,
    eligibleSetups: report.setups.length,
    split: report.split,
    results: report.results
  }));
}

if (require.main === module) main();

module.exports = {
  runReplay,
  latestContinuousSegment,
  ema,
  atr,
  findM5Trigger,
  findM1Trigger,
  structureStop,
  resolveOutcome,
  summarize,
  selectNonOverlappingSetups,
  SECONDS
};
