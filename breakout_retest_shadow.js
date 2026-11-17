"use strict";
// Forward-only research journal for the frozen M5 breakout / M1 retest candidate.
// Observation only: no production signals, Telegram delivery, or order execution.

const SYNTHETIC_MARKETS = Object.freeze([
  "R_10", "R_25", "R_50", "R_75", "JD75", "JD100", "CRASH500", "BOOM500"
]);
const M1_SECONDS = 60;
const M5_SECONDS = 300;
const M15_SECONDS = 900;
const RANGE_LOOKBACK_M5 = 12;
const BREAKOUT_ATR_M5 = 0.10;
const RETEST_TOLERANCE_ATR_M5 = 0.20;
const M1_BODY_MIN = 0.35;
const M1_CLOSE_LOCATION_MIN = 0.60;
const CONFIRMATION_BARS_M1 = 10;
const STOP_LOOKBACK_M1 = 5;
const STOP_BUFFER_ATR_M1 = 0.10;
const MIN_STOP_ATR_M1 = 0.50;
const MAX_STOP_ATR_M1 = 3.00;
const TARGET_R = 2.0;
const HORIZON_M1 = 60;
const COOLDOWN_M1 = 4;
const MAX_SIGNALS = 2000;
const TERMINAL = new Set(["tp2_hit", "stopped", "ambiguous", "time_exit", "expired"]);

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const alpha = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, x) => sum + x, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * alpha + value * (1 - alpha);
  return value;
}

function atrSeries(candles, period = 14) {
  const out = Array(candles.length).fill(null);
  if (!Array.isArray(candles) || candles.length <= period) return out;
  const tr = Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], previous = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - previous.close), Math.abs(c.low - previous.close));
  }
  let value = tr.slice(1, period + 1).reduce((sum, x) => sum + x, 0) / period;
  out[period] = value;
  for (let i = period + 1; i < candles.length; i++) {
    value = (value * (period - 1) + tr[i]) / period;
    out[i] = value;
  }
  return out;
}

function validFrame(candles, seconds, minimum) {
  if (!Array.isArray(candles) || candles.length < minimum) return false;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c || ![c.epoch, c.open, c.high, c.low, c.close].every(Number.isFinite) ||
        c.high < Math.max(c.open, c.close, c.low) || c.low > Math.min(c.open, c.close) ||
        (i > 0 && c.epoch - candles[i - 1].epoch !== seconds)) return false;
  }
  return true;
}

function directionFeatures(candle, direction) {
  const range = candle.high - candle.low;
  if (!(range > 0)) return { body: 0, closeLocation: 0 };
  return {
    body: Math.abs(candle.close - candle.open) / range,
    closeLocation: direction === 1
      ? (candle.close - candle.low) / range
      : (candle.high - candle.close) / range
  };
}

function detectBreakout(m5, index, atr5) {
  if (!Array.isArray(m5) || index < RANGE_LOOKBACK_M5 || !(atr5 > 0)) return null;
  const candle = m5[index];
  const prior = m5.slice(index - RANGE_LOOKBACK_M5, index);
  const priorHigh = Math.max(...prior.map(x => x.high));
  const priorLow = Math.min(...prior.map(x => x.low));
  if (candle.close >= priorHigh + BREAKOUT_ATR_M5 * atr5) {
    return { direction: 1, boundary: priorHigh, atr5 };
  }
  if (candle.close <= priorLow - BREAKOUT_ATR_M5 * atr5) {
    return { direction: -1, boundary: priorLow, atr5 };
  }
  return null;
}

function findRetestConfirmation(m1, startIndex, setup, atr1Values) {
  if (!Array.isArray(m1) || startIndex < 3 || !setup) return null;
  const last = Math.min(startIndex + CONFIRMATION_BARS_M1, m1.length - 1);
  for (let j = startIndex; j < last; j++) {
    const candle = m1[j];
    const atr1 = atr1Values[j];
    if (!(atr1 > 0)) continue;
    const features = directionFeatures(candle, setup.direction);
    if (features.body < M1_BODY_MIN || features.closeLocation < M1_CLOSE_LOCATION_MIN) continue;
    const tolerance = RETEST_TOLERANCE_ATR_M5 * setup.atr5;
    const retested = setup.direction === 1
      ? candle.low <= setup.boundary + tolerance && candle.close > setup.boundary
      : candle.high >= setup.boundary - tolerance && candle.close < setup.boundary;
    if (retested && j + 1 < m1.length) return { triggerIndex: j, entryIndex: j + 1, atr1 };
  }
  return null;
}

function m15ContextAt(m15, setupCloseEpoch) {
  const closed = (m15 || []).filter(c => c.epoch + M15_SECONDS <= setupCloseEpoch);
  if (closed.length < 55) return "unknown";
  const closes = closed.map(c => c.close);
  const fast = ema(closes, 20);
  const slow = ema(closes, 50);
  const priorSlow = ema(closes.slice(0, -5), 50);
  if (![fast, slow, priorSlow].every(Number.isFinite)) return "unknown";
  if (fast > slow && slow > priorSlow) return "up";
  if (fast < slow && slow < priorSlow) return "down";
  return "neutral";
}

function createSignal(marketId, marketName, setup, m1, confirmation, context) {
  const j = confirmation.triggerIndex;
  const entryCandle = m1[confirmation.entryIndex];
  const recent = m1.slice(j - STOP_LOOKBACK_M1 + 1, j + 1);
  if (recent.length !== STOP_LOOKBACK_M1 || !(confirmation.atr1 > 0)) return null;
  const stopLoss = setup.direction === 1
    ? Math.min(...recent.map(x => x.low)) - STOP_BUFFER_ATR_M1 * confirmation.atr1
    : Math.max(...recent.map(x => x.high)) + STOP_BUFFER_ATR_M1 * confirmation.atr1;
  const entry = entryCandle.open;
  const riskDistance = setup.direction === 1 ? entry - stopLoss : stopLoss - entry;
  const riskAtr = riskDistance / confirmation.atr1;
  if (!(riskDistance > 0) || riskAtr < MIN_STOP_ATR_M1 || riskAtr > MAX_STOP_ATR_M1) return null;
  const tp2 = entry + setup.direction * TARGET_R * riskDistance;
  const setupCloseEpoch = setup.setupCloseEpoch;
  return {
    signalId: marketId + "-BREAKOUT_RETEST-" + setupCloseEpoch,
    strategyId: "M5_BREAKOUT_M1_RETEST",
    strategyLabel: "M5 breakout / M1 retest",
    marketId,
    market: marketName || marketId,
    direction: setup.direction === 1 ? "BUY" : "SELL",
    setupTimeframe: "M5",
    entryTimeframe: "M1",
    confirmationTimeframe: "M1",
    setupCloseEpoch,
    triggerEpoch: m1[j].epoch,
    entryCandleEpoch: entryCandle.epoch,
    entry,
    stopLoss,
    tp2,
    riskDistance,
    riskReward: { target: TARGET_R },
    contextM15: context,
    status: "pending",
    evaluationSource: "forward_shadow",
    lastProcessedEpoch: entryCandle.epoch - M1_SECONDS,
    outcomeCandles: 0,
    maxFavourableR: 0,
    maxAdverseR: 0,
    realizedR: null,
    createdAt: new Date((setupCloseEpoch) * 1000).toISOString()
  };
}

function updateSignalOutcome(signal, candles) {
  if (!signal || TERMINAL.has(signal.status)) return signal;
  const later = (candles || []).filter(c => c.epoch > Number(signal.lastProcessedEpoch || (signal.entryCandleEpoch - M1_SECONDS)));
  for (const candle of later) {
    if (candle.epoch < signal.entryCandleEpoch) continue;
    signal.outcomeCandles += 1;
    signal.lastProcessedEpoch = candle.epoch;
    const buy = signal.direction === "BUY";
    const favourable = buy ? candle.high - signal.entry : signal.entry - candle.low;
    const adverse = buy ? signal.entry - candle.low : candle.high - signal.entry;
    signal.maxFavourableR = Math.max(Number(signal.maxFavourableR || 0), favourable / signal.riskDistance);
    signal.maxAdverseR = Math.max(Number(signal.maxAdverseR || 0), adverse / signal.riskDistance);
    const stop = buy ? candle.low <= signal.stopLoss : candle.high >= signal.stopLoss;
    const target = buy ? candle.high >= signal.tp2 : candle.low <= signal.tp2;
    if (stop && target) {
      signal.status = "ambiguous";
      signal.exitEpoch = candle.epoch;
      signal.realizedR = null;
      break;
    }
    if (stop) {
      signal.status = "stopped";
      signal.exitEpoch = candle.epoch;
      signal.realizedR = -1;
      break;
    }
    if (target) {
      signal.status = "tp2_hit";
      signal.exitEpoch = candle.epoch;
      signal.realizedR = TARGET_R;
      break;
    }
    if (signal.outcomeCandles >= HORIZON_M1) {
      signal.status = "time_exit";
      signal.exitEpoch = candle.epoch;
      signal.realizedR = Number((((buy ? 1 : -1) * (candle.close - signal.entry)) / signal.riskDistance).toFixed(4));
      break;
    }
  }
  return signal;
}

function blankMarketState() {
  return {
    lastProcessedM5Epoch: null,
    pendingSetups: [],
    cooldownUntilEpoch: null,
    initializedAt: null,
    dataQuality: "warming",
    stats: { setupsDetected: 0, signalsGenerated: 0, riskRejected: 0, overlapSuppressed: 0, confirmationExpired: 0 }
  };
}

function summarizeBreakoutRetestJournal(journal) {
  const signals = journal?.signals || [];
  const terminal = signals.filter(s => TERMINAL.has(s.status));
  const target = terminal.filter(s => s.status === "tp2_hit").length;
  const stopped = terminal.filter(s => s.status === "stopped").length;
  const timeExit = terminal.filter(s => s.status === "time_exit").length;
  const ambiguous = terminal.filter(s => s.status === "ambiguous").length;
  const decisive = target + stopped;
  const realized = terminal.map(s => s.realizedR).filter(Number.isFinite);
  const markets = {};
  for (const id of SYNTHETIC_MARKETS) {
    const rows = signals.filter(s => s.marketId === id);
    const done = rows.filter(s => TERMINAL.has(s.status));
    const wins = done.filter(s => s.status === "tp2_hit").length;
    const losses = done.filter(s => s.status === "stopped").length;
    const rs = done.map(s => s.realizedR).filter(Number.isFinite);
    markets[id] = {
      signals: rows.length,
      resolved: done.length,
      pending: rows.filter(s => s.status === "pending").length,
      targetBeforeStop: wins,
      stopBeforeTarget: losses,
      ambiguous: done.filter(s => s.status === "ambiguous").length,
      timeExit: done.filter(s => s.status === "time_exit").length,
      targetRatePct: wins + losses ? Number((wins / (wins + losses) * 100).toFixed(1)) : null,
      averageRealizedR: rs.length ? Number((rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3)) : null,
      ...(journal?.markets?.[id]?.stats || {})
    };
  }
  return {
    mode: "forward_shadow_observation_only",
    strategy: "M5 breakout beyond prior 12-bar range; M1 retest confirmation; next-M1-open entry",
    marketsMonitored: Object.keys(journal?.markets || {}).length,
    signalsGenerated: signals.length,
    resolvedSignals: terminal.length,
    pendingSignals: signals.filter(s => s.status === "pending").length,
    targetBeforeStop: target,
    stopBeforeTarget: stopped,
    timeExit,
    ambiguous,
    targetRatePct: decisive ? Number((target / decisive * 100).toFixed(1)) : null,
    averageRealizedR: realized.length ? Number((realized.reduce((a, b) => a + b, 0) / realized.length).toFixed(3)) : null,
    markets,
    historicalHoldout: { targetRatePct: 50, targetBeforeStop: 13, stopBeforeTarget: 13, trades: 26, expectancyR: 0.5, assumedCostAdjustedExpectancyRAt010: 0.4 },
    note: "Research-only forward shadow. Historical M1-entry results are not the production M5/M15 signal rules. M15 context is recorded, not used as a directional filter. No Telegram alerts or MT5 execution."
  };
}

function updateBreakoutRetestJournal(priorJournal, markets, nowEpoch = Math.floor(Date.now() / 1000)) {
  const journal = priorJournal && priorJournal.version === 1 && Array.isArray(priorJournal.signals)
    ? priorJournal : { version: 1, updatedAt: null, markets: {}, signals: [] };
  journal.markets ||= {};
  const byId = new Map(journal.signals.map(s => [s.signalId, s]));

  for (const [marketId, market] of Object.entries(markets || {})) {
    if (!SYNTHETIC_MARKETS.includes(marketId)) continue;
    const frames = market.timeframes || {};
    const m1 = frames.M1 || [], m5 = frames.M5 || [], m15 = frames.M15 || [];
    const marketState = journal.markets[marketId] ||= blankMarketState();
    if (!validFrame(m1, M1_SECONDS, 65) || !validFrame(m5, M5_SECONDS, 20) || !validFrame(m15, M15_SECONDS, 55)) {
      marketState.dataQuality = "insufficient_or_discontinuous_candles";
      continue;
    }
    marketState.dataQuality = "ok";
    const atr1 = atrSeries(m1, 14);
    const atr5 = atrSeries(m5, 14);

    // Resolve already-open shadow observations before considering new entries.
    for (const signal of journal.signals.filter(s => s.marketId === marketId && s.status === "pending")) {
      updateSignalOutcome(signal, m1);
      if (TERMINAL.has(signal.status) && Number.isFinite(signal.exitEpoch)) {
        marketState.cooldownUntilEpoch = signal.exitEpoch + COOLDOWN_M1 * M1_SECONDS;
      }
    }

    // Start forward-only: do not turn old historical setups into new shadow signals.
    if (marketState.lastProcessedM5Epoch === null) {
      marketState.lastProcessedM5Epoch = m5[m5.length - 1].epoch;
      marketState.initializedAt = new Date(nowEpoch * 1000).toISOString();
      continue;
    }

    const newSetups = m5
      .map((c, index) => ({ c, index }))
      .filter(x => x.c.epoch > marketState.lastProcessedM5Epoch);
    for (const item of newSetups) {
      const { c, index } = item;
      const found = detectBreakout(m5, index, atr5[index]);
      if (!found) continue;
      const setupCloseEpoch = c.epoch + M5_SECONDS;
      const setup = {
        setupCloseEpoch,
        direction: found.direction,
        boundary: found.boundary,
        atr5: found.atr5,
        contextM15: m15ContextAt(m15, setupCloseEpoch)
      };
      marketState.pendingSetups.push(setup);
      marketState.stats.setupsDetected += 1;
    }
    marketState.lastProcessedM5Epoch = m5[m5.length - 1].epoch;

    const remaining = [];
    for (const setup of marketState.pendingSetups.sort((a, b) => a.setupCloseEpoch - b.setupCloseEpoch)) {
      const startIndex = m1.findIndex(c => c.epoch === setup.setupCloseEpoch);
      if (startIndex < 0) {
        if (m1[0].epoch > setup.setupCloseEpoch || m1[m1.length - 1].epoch >= setup.setupCloseEpoch + CONFIRMATION_BARS_M1 * M1_SECONDS) {
          marketState.stats.confirmationExpired += 1;
        } else remaining.push(setup);
        continue;
      }
      const confirmation = findRetestConfirmation(m1, startIndex, setup, atr1);
      if (!confirmation) {
        if (m1[m1.length - 1].epoch >= setup.setupCloseEpoch + (CONFIRMATION_BARS_M1 - 1) * M1_SECONDS) {
          marketState.stats.confirmationExpired += 1;
        } else remaining.push(setup);
        continue;
      }
      const entryEpoch = m1[confirmation.entryIndex].epoch;
      const active = journal.signals.some(s => s.marketId === marketId && s.status === "pending");
      if (active || (Number.isFinite(marketState.cooldownUntilEpoch) && entryEpoch <= marketState.cooldownUntilEpoch)) {
        marketState.stats.overlapSuppressed += 1;
        continue;
      }
      const signal = createSignal(marketId, market.marketName || market.market || marketId, setup, m1, confirmation, setup.contextM15);
      if (!signal) {
        marketState.stats.riskRejected += 1;
        continue;
      }
      if (!byId.has(signal.signalId)) {
        journal.signals.push(signal);
        byId.set(signal.signalId, signal);
        marketState.stats.signalsGenerated += 1;
      }
    }
    marketState.pendingSetups = remaining;
  }

  journal.updatedAt = new Date(nowEpoch * 1000).toISOString();
  journal.signals.sort((a, b) => b.entryCandleEpoch - a.entryCandleEpoch);
  journal.signals = journal.signals.slice(0, MAX_SIGNALS);
  journal.summary = summarizeBreakoutRetestJournal(journal);
  return journal;
}

module.exports = {
  SYNTHETIC_MARKETS, TERMINAL, ema, atrSeries, validFrame, directionFeatures,
  detectBreakout, findRetestConfirmation, m15ContextAt, createSignal,
  updateSignalOutcome, summarizeBreakoutRetestJournal, updateBreakoutRetestJournal
};
