"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { getDataDir } = require("./scanner_data_dir");
const DATA_DIR = getDataDir();

// Historical replay for M15 setup candidates with M15, M5 or M1 entry timing.
// Every method uses the same M15 ATR risk distance, 2R target, M1 outcome
// resolution and 60-minute horizon. Offline research only: no alerts/orders.
const { evaluate, DEF } = require("./engine");

const TF = Object.freeze({ M1: 60, M5: 300, M15: 900 });
const STOP_ATR_M15 = 1.5;
const TARGET_R = 2;
const HORIZON_SECONDS = 3600;
const MINIMUM = Object.freeze({ M1: 1440, M5: 500, M15: 400 });
const MIN_OVERLAP_HOURS = 24;
const METHODS = ["M15_NEXT_OPEN", "M5_EMA_PULLBACK", "M1_MICRO_BREAK"];

function validCandle(c) {
  return c && [c.epoch, c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close);
}
function continuous(rows, seconds) {
  return Array.isArray(rows) && rows.length > 1 &&
    rows.every((c, i) => validCandle(c) && c.epoch % seconds === 0 &&
      (i === 0 || c.epoch - rows[i - 1].epoch === seconds));
}
function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const alpha = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, x) => sum + x, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * alpha + value * (1 - alpha);
  return value;
}
function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return 0;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let value = tr.slice(0, period).reduce((sum, x) => sum + x, 0) / period;
  for (let i = period; i < tr.length; i++) value = (value * (period - 1) + tr[i]) / period;
  return value;
}
function latestContinuousSegment(rows, seconds) {
  if (!Array.isArray(rows) || !rows.length) return [];
  let start = rows.length - 1;
  while (start > 0 && rows[start].epoch - rows[start - 1].epoch === seconds) start--;
  return rows.slice(start);
}
function marketReady(stats) {
  if (!stats || !stats.frames) return false;
  return ["M1", "M5", "M15"].every(tf => {
    const f = stats.frames[tf];
    return f && f.latestSegmentCandles >= MINIMUM[tf] &&
      f.duplicateEpochs === 0 && f.invalidCandles === 0 && f.unalignedEpochs === 0;
  }) && Number(stats.commonOverlapHours) >= MIN_OVERLAP_HOURS;
}
function directionAtM15(history) {
  if (!Array.isArray(history) || history.length < 65) return null;
  const result = evaluate(history, DEF);
  return result && result.state === "ok" && ["BUY", "SELL"].includes(result.signal)
    ? result.signal : null;
}
function m5PullbackTrigger(rows, direction, afterEpoch, deadline) {
  for (let i = 64; i < rows.length; i++) {
    const c = rows[i];
    if (c.epoch < afterEpoch || c.epoch + TF.M5 > deadline) continue;
    const history = rows.slice(0, i + 1), closes = history.map(x => x.close);
    const fast = ema(closes, 9), slow = ema(closes, 21);
    const fastPrevious = ema(closes.slice(0, -1), 9), volatility = atr(history, 14);
    if (!(volatility > 0) || ![fast, slow, fastPrevious].every(Number.isFinite)) continue;
    const aligned = direction === "BUY"
      ? fast > slow && fast > fastPrevious : fast < slow && fast < fastPrevious;
    const reclaimed = direction === "BUY"
      ? c.low <= fast + volatility * 0.15 && c.close > fast && c.close > c.open
      : c.high >= fast - volatility * 0.15 && c.close < fast && c.close < c.open;
    if (aligned && reclaimed && i + 1 < rows.length) {
      return { triggerEpoch: c.epoch, entryEpoch: rows[i + 1].epoch, entry: rows[i + 1].open };
    }
  }
  return null;
}
function m5AlignedAt(rows, epoch, direction) {
  const history = rows.filter(c => c.epoch + TF.M5 <= epoch);
  if (history.length < 65) return false;
  const closes = history.map(x => x.close);
  const fast = ema(closes, 9), slow = ema(closes, 21);
  return direction === "BUY" ? fast > slow : fast < slow;
}
function m1MicroBreakTrigger(m1, m5, direction, afterEpoch, deadline) {
  for (let i = 64; i < m1.length; i++) {
    const c = m1[i];
    if (c.epoch < afterEpoch || c.epoch + TF.M1 > deadline) continue;
    if (!m5AlignedAt(m5, c.epoch + TF.M1, direction)) continue;
    const history = m1.slice(0, i + 1), closes = history.map(x => x.close);
    const fast = ema(closes, 9), volatility = atr(history, 14);
    if (!(volatility > 0) || !Number.isFinite(fast)) continue;
    const prior = m1.slice(i - 3, i);
    if (prior.length !== 3) continue;
    const pullback = direction === "BUY"
      ? c.low <= fast + volatility * 0.10 && c.close > fast && c.close > c.open
      : c.high >= fast - volatility * 0.10 && c.close < fast && c.close < c.open;
    const brokeMicroSwing = direction === "BUY"
      ? c.close > Math.max(...prior.map(x => x.high))
      : c.close < Math.min(...prior.map(x => x.low));
    if (pullback && brokeMicroSwing && i + 1 < m1.length) {
      return { triggerEpoch: c.epoch, entryEpoch: m1[i + 1].epoch, entry: m1[i + 1].open };
    }
  }
  return null;
}
function resolveCommonOutcome({ m1, entryEpoch, entry, direction, riskDistance, horizonEndEpoch }) {
  if (!(riskDistance > 0) || !Number.isFinite(entry)) return { status: "invalid_risk", realizedR: null };
  const stop = direction === "BUY" ? entry - riskDistance : entry + riskDistance;
  const target = direction === "BUY" ? entry + TARGET_R * riskDistance : entry - TARGET_R * riskDistance;
  const bars = m1.filter(c => c.epoch >= entryEpoch && c.epoch < horizonEndEpoch);
  if (!bars.length || bars[0].epoch !== entryEpoch) return { status: "incomplete_data", realizedR: null };
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i];
    if (i > 0 && c.epoch - bars[i - 1].epoch !== TF.M1) return { status: "data_gap", realizedR: null };
    const stopTouched = direction === "BUY" ? c.low <= stop : c.high >= stop;
    const targetTouched = direction === "BUY" ? c.high >= target : c.low <= target;
    if (stopTouched && targetTouched) return { status: "ambiguous", realizedR: null, exitEpoch: c.epoch };
    if (stopTouched) return { status: "stopped", realizedR: -1, exitEpoch: c.epoch };
    if (targetTouched) return { status: "target", realizedR: TARGET_R, exitEpoch: c.epoch };
  }
  if (bars.length * TF.M1 < HORIZON_SECONDS) return { status: "incomplete_data", realizedR: null };
  const last = bars[bars.length - 1];
  const signedMove = direction === "BUY" ? last.close - entry : entry - last.close;
  return {
    status: "time_exit",
    realizedR: Number((signedMove / riskDistance).toFixed(4)),
    exitEpoch: last.epoch + TF.M1
  };
}
function splitBounds(startEpoch, endEpoch) {
  const span = endEpoch - startEpoch;
  return {
    discovery: { start: startEpoch, end: startEpoch + span * 0.6 },
    validation: { start: startEpoch + span * 0.6, end: startEpoch + span * 0.8 },
    holdout: { start: startEpoch + span * 0.8, end: endEpoch }
  };
}
function blankStats() {
  return { setups: 0, entries: 0, noEntry: 0, outcomes: { target: 0, stopped: 0, ambiguous: 0, time_exit: 0, incomplete_data: 0, data_gap: 0 }, resolved: 0, averageGrossR: null, totalGrossR: 0 };
}
function summarizeTrades(trades, setupCount) {
  const result = blankStats();
  result.setups = setupCount;
  result.entries = trades.length;
  result.noEntry = Math.max(0, setupCount - trades.length);
  for (const t of trades) result.outcomes[t.outcome.status] = (result.outcomes[t.outcome.status] || 0) + 1;
  const realized = trades.map(t => t.outcome.realizedR).filter(Number.isFinite);
  result.resolved = realized.length;
  result.totalGrossR = Number(realized.reduce((sum, x) => sum + x, 0).toFixed(4));
  result.averageGrossR = realized.length ? Number((realized.reduce((sum, x) => sum + x, 0) / realized.length).toFixed(4)) : null;
  return result;
}
function replayMarket(marketId, market, bounds) {
  const segments = {
    M1: latestContinuousSegment(market.timeframes.M1, TF.M1),
    M5: latestContinuousSegment(market.timeframes.M5, TF.M5),
    M15: latestContinuousSegment(market.timeframes.M15, TF.M15)
  };
  const overlapStart = Math.max(...["M1", "M5", "M15"].map(tf => segments[tf][0]?.epoch ?? Infinity));
  const overlapEnd = Math.min(...["M1", "M5", "M15"].map(tf => (segments[tf].at(-1)?.epoch ?? -Infinity) + TF[tf]));
  const rows = Object.fromEntries(["M1", "M5", "M15"].map(tf => [
    tf, segments[tf].filter(c => c.epoch >= overlapStart && c.epoch + TF[tf] <= overlapEnd)
  ]));
  const m1 = rows.M1, m5 = rows.M5, m15 = rows.M15;
  if (!continuous(m1, TF.M1) || !continuous(m5, TF.M5) || !continuous(m15, TF.M15)) {
    return { marketId, status: "not_replayed_noncontinuous_common_overlap", methods: {} };
  }
  const setups = [];
  for (let i = 64; i < m15.length - 1; i++) {
    const history = m15.slice(0, i + 1), direction = directionAtM15(history);
    if (!direction) continue;
    const setup = m15[i], setupCloseEpoch = setup.epoch + TF.M15;
    const setupAtr = atr(history, 14);
    if (!(setupAtr > 0)) continue;
    setups.push({ setupEpoch: setupCloseEpoch, direction, setupAtr, m15EntryEpoch: setupCloseEpoch });
  }
  const results = {};
  for (const method of METHODS) {
    const trades = [];
    const counts = { discovery: 0, validation: 0, holdout: 0 };
    for (const setup of setups) {
      const split = Object.entries(bounds).find(([, b]) => setup.setupEpoch >= b.start && setup.setupEpoch < b.end);
      if (!split) continue;
      const [splitName, splitRange] = split;
      if (setup.setupEpoch + HORIZON_SECONDS > splitRange.end) continue;
      counts[splitName]++;
      let entry = null;
      if (method === "M15_NEXT_OPEN") {
        const candle = m15.find(c => c.epoch === setup.m15EntryEpoch);
        if (candle) entry = { triggerEpoch: setup.setupEpoch, entryEpoch: candle.epoch, entry: candle.open };
      } else if (method === "M5_EMA_PULLBACK") {
        entry = m5PullbackTrigger(m5, setup.direction, setup.setupEpoch, setup.setupEpoch + HORIZON_SECONDS);
      } else {
        entry = m1MicroBreakTrigger(m1, m5, setup.direction, setup.setupEpoch, setup.setupEpoch + HORIZON_SECONDS);
      }
      if (!entry || entry.entryEpoch + HORIZON_SECONDS > splitRange.end) continue;
      const riskDistance = setup.setupAtr * STOP_ATR_M15;
      const outcome = resolveCommonOutcome({
        m1, entryEpoch: entry.entryEpoch, entry: entry.entry, direction: setup.direction,
        riskDistance, horizonEndEpoch: entry.entryEpoch + HORIZON_SECONDS
      });
      trades.push({ setupEpoch: setup.setupEpoch, triggerEpoch: entry.triggerEpoch, entryEpoch: entry.entryEpoch, entry: entry.entry, direction: setup.direction, riskDistance, outcome });
    }
    results[method] = {
      discovery: summarizeTrades(trades.filter(t => t.setupEpoch >= bounds.discovery.start && t.setupEpoch < bounds.discovery.end), counts.discovery),
      validation: summarizeTrades(trades.filter(t => t.setupEpoch >= bounds.validation.start && t.setupEpoch < bounds.validation.end), counts.validation),
      holdout: summarizeTrades(trades.filter(t => t.setupEpoch >= bounds.holdout.start && t.setupEpoch < bounds.holdout.end), counts.holdout),
      trades
    };
  }
  return { marketId, status: "replayed", setupCandidates: setups.length, commonOverlapStartEpoch: overlapStart, commonOverlapEndEpoch: overlapEnd, splitBounds: bounds, methods: results };
}
function buildCommonAssumptionReplayReport(archive, readinessReport, generatedAt = new Date().toISOString()) {
  const markets = {};
  const focusMarket = readinessReport?.focusMarket || null;
  for (const [marketId, stats] of Object.entries(readinessReport?.markets || {})) {
    if (focusMarket && marketId !== focusMarket) {
      markets[marketId] = { status: "outside_focus", reason: "The current lower-timeframe research configuration is focused on " + focusMarket + "." };
      continue;
    }
    if (!marketReady(stats)) {
      markets[marketId] = { status: "not_ready", reason: "Requires continuous M1>=1440, M5>=500, M15>=400 candles, at least 24h common overlap, and zero invalid/duplicate/unaligned candles." };
      continue;
    }
    const market = archive?.markets?.[marketId];
    if (!market?.timeframes) {
      markets[marketId] = { status: "not_ready", reason: "Candle archive missing market/timeframe data." };
      continue;
    }
    const all = ["M1", "M5", "M15"].flatMap(tf => market.timeframes[tf] || []);
    const segments = {
      M1: latestContinuousSegment(market.timeframes.M1, TF.M1),
      M5: latestContinuousSegment(market.timeframes.M5, TF.M5),
      M15: latestContinuousSegment(market.timeframes.M15, TF.M15)
    };
    const start = Math.max(...["M1", "M5", "M15"].map(tf => segments[tf][0]?.epoch ?? Infinity));
    const end = Math.min(...["M1", "M5", "M15"].map(tf => (segments[tf].at(-1)?.epoch ?? -Infinity) + TF[tf]));
    const bounds = splitBounds(start, end);
    markets[marketId] = replayMarket(marketId, market, bounds);
  }
  const ready = Object.values(markets).filter(m => m.status === "replayed").length;
  return {
    version: 1,
    generatedAt,
    mode: ready ? "common_assumption_historical_replay" : "waiting_for_research_data_quality",
    assumptions: {
      setup: "M15 direction is generated from completed M15 candles using the existing engine default configuration.",
      entries: "Baseline enters at the next M15 open; M5 experiment enters at the next M5 open after EMA9/21 alignment and EMA9 pullback/reclaim; M1 experiment requires M5 EMA9/21 alignment plus an M1 EMA9 pullback and close beyond the prior three-candle micro swing, entering at the next M1 open.",
      commonRisk: "All methods use the same 1.5 x M15 ATR risk distance measured at the M15 setup close.",
      commonTarget: "Fixed 2R target for all methods.",
      commonExit: "All outcomes are resolved on M1 candles, with a 60-minute horizon and same-candle stop/target touches marked ambiguous.",
      costs: "No spread, commission or slippage assumptions are applied because broker-specific historical cost data is not part of this archive. Results are gross candle-based R, not executable or realised account returns.",
      splits: "Chronological 60% discovery, 20% validation and 20% holdout; one-hour embargo at each split boundary. Holdout is not used for tuning."
    },
    summary: {
      marketsConsidered: Object.keys(readinessReport?.markets || {}).length,
      focusMarket,
      marketsReplayed: ready,
      marketsWaiting: Object.values(markets).filter(m => m.status === "not_ready").length,
      marketsOutsideFocus: Object.values(markets).filter(m => m.status === "outside_focus").length
    },
    markets,
    interpretation: "Exploratory candle-based replay only. Small samples, especially in the holdout split, are not sufficient for strategy ranking or production promotion."
  };
}

function main() {
  const archivePath = path.join(DATA_DIR, "lower_tf_research_candles.json");
  const readinessPath = path.join(DATA_DIR, "lower_tf_entry_research_report.json");
  const outputPath = path.join(DATA_DIR, "lower_tf_common_assumption_replay_report.json");
  if (!fs.existsSync(archivePath) || !fs.existsSync(readinessPath)) {
    throw new Error("Lower-timeframe archive/readiness report is missing; replay was not run.");
  }
  const archive = JSON.parse(fs.readFileSync(archivePath, "utf8"));
  const readiness = JSON.parse(fs.readFileSync(readinessPath, "utf8"));
  const report = buildCommonAssumptionReplayReport(archive, readiness);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({
    event: "lower_tf_common_assumption_replay_completed",
    mode: report.mode,
    marketsConsidered: report.summary.marketsConsidered,
    marketsReplayed: report.summary.marketsReplayed,
    marketsWaiting: report.summary.marketsWaiting,
    output: outputPath
  }));
}
if (require.main === module) main();

module.exports = {
  TF, STOP_ATR_M15, TARGET_R, HORIZON_SECONDS, MINIMUM, METHODS,
  validCandle, continuous, latestContinuousSegment, ema, atr, marketReady, directionAtM15,
  m5PullbackTrigger, m1MicroBreakTrigger, resolveCommonOutcome,
  splitBounds, summarizeTrades, replayMarket, buildCommonAssumptionReplayReport
};
