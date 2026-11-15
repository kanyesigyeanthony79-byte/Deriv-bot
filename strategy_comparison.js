"use strict";
// Parallel strategy shadow journal. Uses completed M15 candles only.
// Observation/backtest only: no Telegram alerts and no order execution.
const { evaluate, DEF } = require("./engine");
const { validateCandleContinuity } = require("./market_quality");

const TIMEFRAME_SECONDS = 900;
const MAX_AGE_SECONDS = 24 * 60 * 60;
const STOP_ATR = 1.5;
const TP1_R = 2;
const TP2_R = 3;
const MAX_SIGNALS = 10000;

const STRATEGIES = Object.freeze([
  Object.freeze({ id: "EMA20_50", label: "EMA20/50 baseline", fast: 20, slow: 50, pullback: false }),
  Object.freeze({ id: "EMA9_21", label: "EMA9/21", fast: 9, slow: 21, pullback: false }),
  Object.freeze({ id: "EMA9_21_BODY_CLOSE", label: "EMA9/21 + body/close quality gate (shadow)", fast: 9, slow: 21, pullback: false, qualityFilter: true }),
  Object.freeze({ id: "EMA20_50_PULLBACK", label: "EMA20/50 + pullback", fast: 20, slow: 50, pullback: true })
]);

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

function pullbackConfirmed(candles, direction) {
  if (!Array.isArray(candles) || candles.length < 65 || !["BUY", "SELL"].includes(direction)) return false;
  const latest = candles[candles.length - 1];
  const volatility = atr(candles, 14);
  const ema20 = ema(candles.map(c => c.close), 20);
  if (!(volatility > 0) || !Number.isFinite(ema20)) return false;
  const body = Math.abs(latest.close - latest.open);
  if (body < volatility * 0.12) return false;
  if (direction === "BUY") {
    return latest.low <= ema20 + volatility * 0.25 &&
      latest.close > ema20 && latest.close > latest.open;
  }
  return latest.high >= ema20 - volatility * 0.25 &&
    latest.close < ema20 && latest.close < latest.open;
}

function makeLevels(entry, candles, direction) {
  const volatility = atr(candles, 14);
  if (!(volatility > 0)) return null;
  const riskDistance = volatility * STOP_ATR;
  const digits = Math.max(2, Math.min(8, (String(entry).split(".")[1] || "").length));
  const round = value => Number(value.toFixed(digits));
  return {
    entry: round(entry),
    stopLoss: round(direction === "BUY" ? entry - riskDistance : entry + riskDistance),
    tp1: round(direction === "BUY" ? entry + riskDistance * TP1_R : entry - riskDistance * TP1_R),
    tp2: round(direction === "BUY" ? entry + riskDistance * TP2_R : entry - riskDistance * TP2_R),
    riskDistance: round(riskDistance),
    riskReward: { tp1: TP1_R, tp2: TP2_R }
  };
}

function evaluateStrategy(candles, strategyId, marketId = "UNKNOWN", marketName = marketId) {
  const strategy = STRATEGIES.find(item => item.id === strategyId);
  if (!strategy) throw new Error("Unknown comparison strategy: " + strategyId);
  if (!Array.isArray(candles) || candles.length < 65) return { state: "warming" };
  const config = strategy.fast === 9 ? { ...DEF, emaF: 9, emaS: 21 } : DEF;
  const result = evaluate(candles, config);
  if (result.state !== "ok" || !["BUY", "SELL"].includes(result.signal)) {
    return { state: result.state === "ok" ? "no_signal" : result.state, reason: result.state === "ok" ? "Base indicator rules did not pass." : "Indicator history is not ready." };
  }
  if (strategy.pullback && !pullbackConfirmed(candles, result.signal)) {
    return { state: "no_signal", reason: "EMA20/50 trend passed, but no confirmed EMA20 pullback rejection." };
  }
  // Frozen research thresholds. This shadow variant deliberately keeps the existing
  // engine's EMA9/21 base checks and adds the body/close quality gate on top.
  // It is not yet a replacement for the production scanner or an order signal.
  if (strategy.qualityFilter) {
    const bodyRatio = Number(result.metrics?.bodyRatio);
    const closeLocation = Number(result.metrics?.closeLocation);
    if (!(bodyRatio >= 0.7360851)) {
      return { state: "no_signal", reason: "Quality gate rejected: candle body ratio below 0.7360851.", qualityChecks: { bodyRatio, closeLocation, bodyPassed: false, closePassed: closeLocation >= 0.9288402 } };
    }
    if (!(closeLocation >= 0.9288402)) {
      return { state: "no_signal", reason: "Quality gate rejected: direction-adjusted close location below 0.9288402.", qualityChecks: { bodyRatio, closeLocation, bodyPassed: true, closePassed: false } };
    }
  }
  const latest = candles[candles.length - 1];
  const levels = makeLevels(latest.close, candles, result.signal);
  if (!levels) return { state: "warming", reason: "ATR risk levels unavailable." };
  return {
    state: "signal",
    signalId: marketId + "-" + strategy.id + "-" + latest.epoch,
    strategyId: strategy.id,
    strategyLabel: strategy.label,
    marketId,
    market: marketName,
    timeframe: "M15",
    direction: result.signal,
    entryCandleEpoch: latest.epoch,
    createdAt: new Date((latest.epoch + TIMEFRAME_SECONDS) * 1000).toISOString(),
    score: result.score,
    metrics: { ...result.metrics, atr: atr(candles, 14) },
    checks: result.checks || [],
    ...levels,
    status: "pending",
    tp1Hit: false,
    tp2Hit: false,
    tp1Epoch: null,
    tp2Epoch: null,
    stopEpoch: null,
    lastProcessedEpoch: latest.epoch,
    outcomeCandles: 0,
    maxFavourableR: 0,
    realizedR: null
  };
}

function isTerminal(status) {
  return ["tp2_hit", "stopped", "stopped_after_tp1", "ambiguous", "expired"].includes(status);
}

function updateSignalOutcome(signal, candles, nowEpoch) {
  const later = candles.filter(c => c.epoch > Number(signal.lastProcessedEpoch || signal.entryCandleEpoch));
  for (const candle of later) {
    if (isTerminal(signal.status)) break;
    signal.outcomeCandles++;
    signal.lastProcessedEpoch = candle.epoch;
    const buy = signal.direction === "BUY";
    const favourable = buy ? candle.high - signal.entry : signal.entry - candle.low;
    if (Number.isFinite(favourable) && signal.riskDistance > 0) {
      signal.maxFavourableR = Math.max(Number(signal.maxFavourableR || 0), favourable / signal.riskDistance);
    }
    const stop = buy ? candle.low <= signal.stopLoss : candle.high >= signal.stopLoss;
    const tp1 = buy ? candle.high >= signal.tp1 : candle.low <= signal.tp1;
    const tp2 = buy ? candle.high >= signal.tp2 : candle.low <= signal.tp2;
    if (stop && (tp1 || tp2)) {
      signal.status = "ambiguous";
      signal.stopEpoch = candle.epoch;
      break;
    }
    if (stop) {
      signal.status = signal.tp1Hit ? "stopped_after_tp1" : "stopped";
      signal.stopEpoch = candle.epoch;
      signal.realizedR = signal.tp1Hit ? null : -1;
      break;
    }
    if (tp1 && !signal.tp1Hit) {
      signal.tp1Hit = true;
      signal.tp1Epoch = candle.epoch;
      signal.status = "tp1_hit";
    }
    if (tp2) {
      signal.tp1Hit = true;
      signal.tp2Hit = true;
      signal.tp1Epoch = signal.tp1Epoch || candle.epoch;
      signal.tp2Epoch = candle.epoch;
      signal.status = "tp2_hit";
      signal.realizedR = TP2_R;
      break;
    }
  }
  if (!isTerminal(signal.status) && nowEpoch - (signal.entryCandleEpoch + TIMEFRAME_SECONDS) > MAX_AGE_SECONDS) {
    signal.status = "expired";
  }
  return signal;
}

function blankStats() {
  return { barsEvaluated: 0, noSignalBars: 0, signalsGenerated: 0, firstEpoch: null, lastEpoch: null };
}

function summarizeStrategyJournal(journal) {
  const markets = {};
  const pct = (n, d) => d ? Number((n / d * 100).toFixed(1)) : null;
  for (const [marketId, marketStats] of Object.entries(journal.markets || {})) {
    markets[marketId] = {};
    for (const strategy of STRATEGIES) {
      const counters = marketStats.strategies?.[strategy.id] || blankStats();
      const signals = (journal.signals || []).filter(s => s.marketId === marketId && s.strategyId === strategy.id);
      const terminal = signals.filter(s => isTerminal(s.status));
      const tp1 = signals.filter(s => s.tp1Hit).length;
      const wins = signals.filter(s => s.tp1Hit && s.status !== "stopped_after_tp1" && s.status !== "ambiguous").length;
      const tp2 = signals.filter(s => s.status === "tp2_hit").length;
      const fullStops = signals.filter(s => s.status === "stopped").length;
      const stoppedAfterTp1 = signals.filter(s => s.status === "stopped_after_tp1").length;
      const stops = fullStops + stoppedAfterTp1;
      const expired = signals.filter(s => s.status === "expired").length;
      const ambiguous = signals.filter(s => s.status === "ambiguous").length;
      const realized = terminal.map(s => s.realizedR).filter(Number.isFinite);
      markets[marketId][strategy.id] = {
        label: strategy.label,
        ...counters,
        totalSignalsInJournal: signals.length,
        historicalBackfillSignals: signals.filter(s => !s.evaluationSource || s.evaluationSource === "historical_backfill").length,
        forwardShadowSignals: signals.filter(s => s.evaluationSource === "forward_shadow").length,
        resolvedSignals: terminal.length,
        pendingSignals: signals.filter(s => !isTerminal(s.status)).length,
        winRate: pct(wins, terminal.length),
        tp1HitRate: pct(tp1, terminal.length),
        tp2HitRate: pct(tp2, terminal.length),
        stopLossRate: pct(fullStops, terminal.length),
        stoppedAfterTP1Rate: pct(stoppedAfterTp1, terminal.length),
        anyStopRate: pct(stops, terminal.length),
        expiredRate: pct(expired, terminal.length),
        ambiguousRate: pct(ambiguous, terminal.length),
        noEntryRate: pct(counters.noSignalBars, counters.barsEvaluated),
        signalsPerDay: counters.barsEvaluated ? Number((counters.signalsGenerated / counters.barsEvaluated * 96).toFixed(2)) : 0,
        averageRealizedR: realized.length ? Number((realized.reduce((sum, value) => sum + value, 0) / realized.length).toFixed(2)) : null,
        realizedRObservations: realized.length
      };
    }
  }
  const totals = {};
  for (const strategy of STRATEGIES) {
    const rows = Object.values(markets).map(m => m[strategy.id]).filter(Boolean);
    const signals = (journal.signals || []).filter(s => s.strategyId === strategy.id);
    const terminal = signals.filter(s => isTerminal(s.status));
    const tp1 = signals.filter(s => s.tp1Hit).length;
    const wins = signals.filter(s => s.tp1Hit && s.status !== "stopped_after_tp1" && s.status !== "ambiguous").length;
    const tp2 = signals.filter(s => s.status === "tp2_hit").length;
    const fullStops = signals.filter(s => s.status === "stopped").length;
    const stoppedAfterTp1 = signals.filter(s => s.status === "stopped_after_tp1").length;
    const stops = fullStops + stoppedAfterTp1;
    const expired = signals.filter(s => s.status === "expired").length;
    const ambiguous = signals.filter(s => s.status === "ambiguous").length;
    const realized = terminal.map(s => s.realizedR).filter(Number.isFinite);
    const barsEvaluated = rows.reduce((sum, row) => sum + row.barsEvaluated, 0);
    const noSignalBars = rows.reduce((sum, row) => sum + row.noSignalBars, 0);
    totals[strategy.id] = {
      label: strategy.label,
      barsEvaluated,
      noSignalBars,
      noEntryRate: pct(noSignalBars, barsEvaluated),
      signalsGenerated: rows.reduce((sum, row) => sum + row.signalsGenerated, 0),
      historicalBackfillSignals: signals.filter(s => !s.evaluationSource || s.evaluationSource === "historical_backfill").length,
      forwardShadowSignals: signals.filter(s => s.evaluationSource === "forward_shadow").length,
      resolvedSignals: terminal.length,
      pendingSignals: signals.filter(s => !isTerminal(s.status)).length,
      winRate: pct(wins, terminal.length),
      tp1HitRate: pct(tp1, terminal.length),
      tp2HitRate: pct(tp2, terminal.length),
      stopLossRate: pct(fullStops, terminal.length),
      stoppedAfterTP1Rate: pct(stoppedAfterTp1, terminal.length),
      anyStopRate: pct(stops, terminal.length),
      expiredRate: pct(expired, terminal.length),
      ambiguousRate: pct(ambiguous, terminal.length),
      signalsPerDay: Number(rows.reduce((sum, row) => sum + row.signalsPerDay, 0).toFixed(2)),
      averageRealizedR: realized.length ? Number((realized.reduce((sum, value) => sum + value, 0) / realized.length).toFixed(2)) : null,
      realizedRObservations: realized.length
    };
  }
  return {
    version: 1,
    generatedAt: journal.updatedAt || null,
    timeframe: "M15",
    mode: "shadow_observation_only",
    riskModel: { stopAtr: STOP_ATR, tp1R: TP1_R, tp2R: TP2_R, maxAgeSeconds: MAX_AGE_SECONDS },
    winRateDefinition: "TP1 reached and not subsequently stopped; TP1 followed by a stop is excluded from wins and reported separately as stopped_after_tp1.",
    realizedRNote: "Average realized R includes only unambiguous TP2 (+3R) and full stop-loss (-1R) outcomes. stopped_after_tp1 is excluded until a partial-exit rule is explicitly defined.",
    sourceNote: "Historical backfill evaluates previously completed candles. Forward shadow signals are evaluated as new M15 candles close. These are analytical signals, not executed demo trades.",
    markets,
    totals
  };
}

function updateStrategyJournal(priorJournal, markets, nowEpoch = Math.floor(Date.now() / 1000)) {
  const journal = priorJournal && priorJournal.version === 1 && Array.isArray(priorJournal.signals)
    ? priorJournal
    : { version: 1, updatedAt: null, markets: {}, signals: [] };
  journal.markets ||= {};
  const byId = new Map(journal.signals.map(signal => [signal.signalId, signal]));

  for (const [marketId, market] of Object.entries(markets || {})) {
    const candles = market.timeframes?.M15 || [];
    if (!Array.isArray(candles) || candles.length < 65) continue;
    const continuity = validateCandleContinuity(candles, TIMEFRAME_SECONDS, marketId);
    if (!continuity.valid) {
      journal.markets[marketId] ||= { lastEvaluatedEpoch: null, strategies: {}, dataQuality: null };
      journal.markets[marketId].dataQuality = { status: "gap_detected", gaps: continuity.gaps.slice(0, 5), checkedAt: new Date(nowEpoch * 1000).toISOString() };
      continue;
    }

    const marketState = journal.markets[marketId] ||= { lastEvaluatedEpoch: null, strategies: {}, dataQuality: null };
    marketState.dataQuality = { status: "ok", checkedAt: new Date(nowEpoch * 1000).toISOString() };
    const cursor = Number(marketState.lastEvaluatedEpoch || 0);
    let firstNewIndex = candles.findIndex((c, index) => index >= 64 && c.epoch > cursor);
    if (firstNewIndex < 0) firstNewIndex = candles.length;
    for (let index = firstNewIndex; index < candles.length; index++) {
      const candle = candles[index];
      const history = candles.slice(0, index + 1);
      for (const strategy of STRATEGIES) {
        const stats = marketState.strategies[strategy.id] ||= blankStats();
        stats.barsEvaluated++;
        stats.firstEpoch ??= candle.epoch;
        stats.lastEpoch = candle.epoch;
        const result = evaluateStrategy(history, strategy.id, marketId, market.marketName || market.market || marketId);
        if (result.state === "signal") {
          if (!byId.has(result.signalId)) {
            result.evaluationSource = cursor > 0 ? "forward_shadow" : "historical_backfill";
            journal.signals.push(result);
            byId.set(result.signalId, result);
            stats.signalsGenerated++;
          }
        } else if (result.state === "no_signal") {
          stats.noSignalBars++;
        }
      }
      marketState.lastEvaluatedEpoch = candle.epoch;
    }

    for (const signal of journal.signals.filter(s => s.marketId === marketId && !isTerminal(s.status))) {
      updateSignalOutcome(signal, candles, nowEpoch);
    }
  }

  for (const signal of journal.signals) signal.evaluationSource ||= "historical_backfill";
  journal.updatedAt = new Date(nowEpoch * 1000).toISOString();
  journal.signals.sort((a, b) => b.entryCandleEpoch - a.entryCandleEpoch);
  journal.signals = journal.signals.slice(0, MAX_SIGNALS);
  journal.summary = summarizeStrategyJournal(journal);
  return journal;
}

module.exports = {
  STRATEGIES, ema, atr, pullbackConfirmed, makeLevels, evaluateStrategy,
  isTerminal, updateSignalOutcome, summarizeStrategyJournal, updateStrategyJournal
};
