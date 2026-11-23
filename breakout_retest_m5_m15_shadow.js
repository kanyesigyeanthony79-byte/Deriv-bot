"use strict";
// Forward-only M5 execution / M15 directional-confirmation breakout-retest shadow.
// Isolated from production signals, Telegram delivery and all MT5 execution.

const SYNTHETIC_MARKETS = Object.freeze([
  "R_25", "R_50", "R_75", "JD75", "JD100", "CRASH500", "BOOM500"
]);
const M5_SECONDS = 300;
const M15_SECONDS = 900;
const RANGE_LOOKBACK_M5 = 12;
const BREAKOUT_ATR_M5 = 0.10;
const RETEST_TOLERANCE_ATR_M5 = 0.20;
const M5_BODY_MIN = 0.35;
const M5_CLOSE_LOCATION_MIN = 0.60;
const CONFIRMATION_BARS_M5 = 6;
const STOP_LOOKBACK_M5 = 5;
const STOP_BUFFER_ATR_M5 = 0.10;
const MIN_STOP_ATR_M5 = 0.50;
const MAX_STOP_ATR_M5 = 3.00;
const TARGET_R = 2.0;
const HORIZON_M5 = 12;
const COOLDOWN_M5 = 4;
const MAX_SIGNALS = 2000;
const TERMINAL = new Set(["tp2_hit", "stopped", "ambiguous", "time_exit"]);

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
        c.epoch % seconds !== 0 || (i > 0 && c.epoch - candles[i - 1].epoch !== seconds)) return false;
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

function m15ContextAt(m15, setupCloseEpoch) {
  // Only M15 candles that were fully closed at the M5 setup close are allowed.
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

function findM5RetestConfirmation(m5, startIndex, setup, atr5Values) {
  if (!Array.isArray(m5) || startIndex < 1 || !setup) return null;
  const last = Math.min(startIndex + CONFIRMATION_BARS_M5, m5.length - 1);
  for (let j = startIndex; j < last; j++) {
    const candle = m5[j];
    const atr5 = atr5Values[j];
    if (!(atr5 > 0)) continue;
    const features = directionFeatures(candle, setup.direction);
    if (features.body < M5_BODY_MIN || features.closeLocation < M5_CLOSE_LOCATION_MIN) continue;
    const tolerance = RETEST_TOLERANCE_ATR_M5 * setup.atr5;
    const retested = setup.direction === 1
      ? candle.low <= setup.boundary + tolerance && candle.close > setup.boundary
      : candle.high >= setup.boundary - tolerance && candle.close < setup.boundary;
    if (retested && j + 1 < m5.length) return { triggerIndex: j, entryIndex: j + 1, atr5 };
  }
  return null;
}

function createSignal(marketId, marketName, setup, m5, confirmation) {
  const j = confirmation.triggerIndex;
  const entryCandle = m5[confirmation.entryIndex];
  const recent = m5.slice(j - STOP_LOOKBACK_M5 + 1, j + 1);
  if (recent.length !== STOP_LOOKBACK_M5 || !(confirmation.atr5 > 0)) return null;
  const stopLoss = setup.direction === 1
    ? Math.min(...recent.map(x => x.low)) - STOP_BUFFER_ATR_M5 * confirmation.atr5
    : Math.max(...recent.map(x => x.high)) + STOP_BUFFER_ATR_M5 * confirmation.atr5;
  const entry = entryCandle.open;
  const riskDistance = setup.direction === 1 ? entry - stopLoss : stopLoss - entry;
  const riskAtr = riskDistance / confirmation.atr5;
  if (!(riskDistance > 0) || riskAtr < MIN_STOP_ATR_M5 || riskAtr > MAX_STOP_ATR_M5) return null;
  const tp2 = entry + setup.direction * TARGET_R * riskDistance;
  const productionTp1 = entry + setup.direction * 1.5 * riskDistance;
  const productionTp2 = entry + setup.direction * 3.0 * riskDistance;
  return {
    signalId: marketId + "-BREAKOUT_RETEST_M5_M15-" + setup.setupCloseEpoch,
    strategyId: "M5_BREAKOUT_M5_RETEST_M15_CONFIRM",
    strategyLabel: "M5 breakout / M5 retest / M15 confirmation",
    marketId,
    market: marketName || marketId,
    direction: setup.direction === 1 ? "BUY" : "SELL",
    setupTimeframe: "M5",
    entryTimeframe: "M5",
    confirmationTimeframe: "M15",
    m15ContextAtBreakout: setup.m15Context,
    m15ContextAtEntry: setup.m15ContextAtEntry,
    setupCloseEpoch: setup.setupCloseEpoch,
    triggerEpoch: m5[j].epoch,
    entryCandleEpoch: entryCandle.epoch,
    entry,
    stopLoss,
    tp2,
    productionTp1,
    productionTp2,
    riskDistance,
    riskAtr: Number(riskAtr.toFixed(3)),
    riskReward: { comparisonTarget: TARGET_R, productionTp1: 1.5, productionTp2: 3.0 },
    status: "pending",
    productionStatus: "pending",
    productionTp1Hit: false,
    productionTp1Epoch: null,
    productionLastProcessedEpoch: entryCandle.epoch - M5_SECONDS,
    productionOutcomeCandles: 0,
    productionRealizedR: null,
    productionBookedPartialR: 0,
    evaluationSource: "forward_shadow",
    lastProcessedEpoch: entryCandle.epoch - M5_SECONDS,
    outcomeCandles: 0,
    maxFavourableR: 0,
    maxAdverseR: 0,
    realizedR: null,
    createdAt: new Date(setup.setupCloseEpoch * 1000).toISOString()
  };
}

const PRODUCTION_TERMINAL = new Set([
  "tp2_hit", "stopped_before_tp1", "stopped_after_tp1", "ambiguous",
  "ambiguous_after_tp1", "time_exit"
]);

function updateComparisonOutcome(signal, candles) {
  if (TERMINAL.has(signal.status)) return;
  const later = (candles || []).filter(c =>
    c.epoch > Number(signal.lastProcessedEpoch || (signal.entryCandleEpoch - M5_SECONDS))
  );
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
    if (signal.outcomeCandles >= HORIZON_M5) {
      signal.status = "time_exit";
      signal.exitEpoch = candle.epoch;
      signal.realizedR = Number((((buy ? 1 : -1) * (candle.close - signal.entry)) / signal.riskDistance).toFixed(4));
      break;
    }
  }
}

function updateProductionManagementOutcome(signal, candles) {
  if (PRODUCTION_TERMINAL.has(signal.productionStatus)) return;
  const later = (candles || []).filter(c =>
    c.epoch > Number(signal.productionLastProcessedEpoch || (signal.entryCandleEpoch - M5_SECONDS))
  );
  for (const candle of later) {
    if (candle.epoch < signal.entryCandleEpoch) continue;
    signal.productionOutcomeCandles += 1;
    signal.productionLastProcessedEpoch = candle.epoch;
    const buy = signal.direction === "BUY";
    const stop = buy ? candle.low <= signal.stopLoss : candle.high >= signal.stopLoss;
    const tp1 = buy ? candle.high >= signal.productionTp1 : candle.low <= signal.productionTp1;
    const tp2 = buy ? candle.high >= signal.productionTp2 : candle.low <= signal.productionTp2;

    if (!signal.productionTp1Hit) {
      if (stop && (tp1 || tp2)) {
        signal.productionStatus = "ambiguous";
        signal.productionExitEpoch = candle.epoch;
        signal.productionRealizedR = null;
        break;
      }
      if (stop) {
        signal.productionStatus = "stopped_before_tp1";
        signal.productionExitEpoch = candle.epoch;
        signal.productionRealizedR = -1;
        break;
      }
      if (tp2) {
        // TP1 and TP2 were both crossed within one M5 candle; do not assume path.
        signal.productionStatus = "ambiguous";
        signal.productionExitEpoch = candle.epoch;
        signal.productionRealizedR = null;
        break;
      }
      if (tp1) {
        signal.productionTp1Hit = true;
        signal.productionTp1Epoch = candle.epoch;
        signal.productionBookedPartialR = 1.0; // 2/3 positions x +1.5R
      }
    } else {
      if (stop && tp2) {
        signal.productionStatus = "ambiguous_after_tp1";
        signal.productionExitEpoch = candle.epoch;
        signal.productionRealizedR = null;
        break;
      }
      if (stop) {
        signal.productionStatus = "stopped_after_tp1";
        signal.productionExitEpoch = candle.epoch;
        signal.productionRealizedR = Number((2 / 3 * 1.5 + 1 / 3 * -1).toFixed(4));
        break;
      }
      if (tp2) {
        signal.productionStatus = "tp2_hit";
        signal.productionExitEpoch = candle.epoch;
        signal.productionRealizedR = Number((2 / 3 * 1.5 + 1 / 3 * 3).toFixed(4));
        break;
      }
    }

    if (signal.productionOutcomeCandles >= HORIZON_M5) {
      const marketR = ((buy ? 1 : -1) * (candle.close - signal.entry)) / signal.riskDistance;
      signal.productionStatus = "time_exit";
      signal.productionExitEpoch = candle.epoch;
      signal.productionRealizedR = Number((signal.productionTp1Hit ? 1 + marketR / 3 : marketR).toFixed(4));
      break;
    }
  }
}

function updateSignalOutcome(signal, candles) {
  if (!signal) return signal;
  updateComparisonOutcome(signal, candles);
  updateProductionManagementOutcome(signal, candles);
  return signal;
}

function blankMarketState() {
  return {
    lastProcessedM5Epoch: null,
    pendingSetups: [],
    cooldownUntilEpoch: null,
    initializedAt: null,
    dataQuality: "warming",
    stats: {
      setupsDetected: 0, m15Confirmed: 0, m15Rejected: 0, m15ReconfirmRejected: 0, signalsGenerated: 0,
      riskRejected: 0, overlapSuppressed: 0, confirmationExpired: 0
    }
  };
}

function summarizeJournal(journal) {
  const signals = journal?.signals || [];
  const terminal = signals.filter(s => TERMINAL.has(s.status));
  const targets = terminal.filter(s => s.status === "tp2_hit").length;
  const stops = terminal.filter(s => s.status === "stopped").length;
  const timeExit = terminal.filter(s => s.status === "time_exit").length;
  const ambiguous = terminal.filter(s => s.status === "ambiguous").length;
  const decisive = targets + stops;
  const realized = terminal.map(s => s.realizedR).filter(Number.isFinite);
  const productionTerminal = signals.filter(s => PRODUCTION_TERMINAL.has(s.productionStatus));
  const productionRealized = productionTerminal.map(s => s.productionRealizedR).filter(Number.isFinite);
  const productionTp1Hits = signals.filter(s => s.productionTp1Hit).length;
  const productionTp2Hits = productionTerminal.filter(s => s.productionStatus === "tp2_hit").length;
  const productionStoppedBeforeTp1 = productionTerminal.filter(s => s.productionStatus === "stopped_before_tp1").length;
  const productionStoppedAfterTp1 = productionTerminal.filter(s => s.productionStatus === "stopped_after_tp1").length;
  const productionAmbiguous = productionTerminal.filter(s => s.productionStatus === "ambiguous" || s.productionStatus === "ambiguous_after_tp1").length;
  const productionTimeExit = productionTerminal.filter(s => s.productionStatus === "time_exit").length;
  const markets = {};
  for (const id of SYNTHETIC_MARKETS) {
    const rows = signals.filter(s => s.marketId === id);
    const done = rows.filter(s => TERMINAL.has(s.status));
    const productionDone = rows.filter(s => PRODUCTION_TERMINAL.has(s.productionStatus));
    const wins = done.filter(s => s.status === "tp2_hit").length;
    const losses = done.filter(s => s.status === "stopped").length;
    const rs = done.map(s => s.realizedR).filter(Number.isFinite);
    markets[id] = {
      dataQuality: journal?.markets?.[id]?.dataQuality || "not_collected",
      setupsDetected: journal?.markets?.[id]?.stats?.setupsDetected || 0,
      m15Confirmed: journal?.markets?.[id]?.stats?.m15Confirmed || 0,
      m15Rejected: journal?.markets?.[id]?.stats?.m15Rejected || 0,
      m15ReconfirmRejected: journal?.markets?.[id]?.stats?.m15ReconfirmRejected || 0,
      signals: rows.length,
      resolved: done.length,
      pending: rows.filter(s => s.status === "pending").length,
      targetBeforeStop: wins,
      stopBeforeTarget: losses,
      ambiguous: done.filter(s => s.status === "ambiguous").length,
      timeExit: done.filter(s => s.status === "time_exit").length,
      targetRatePct: wins + losses ? Number((wins / (wins + losses) * 100).toFixed(1)) : null,
      averageRealizedR: rs.length ? Number((rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3)) : null,
      riskRejected: journal?.markets?.[id]?.stats?.riskRejected || 0,
      overlapSuppressed: journal?.markets?.[id]?.stats?.overlapSuppressed || 0,
      productionTp1Hits: rows.filter(s => s.productionTp1Hit).length,
      productionResolved: productionDone.length,
      productionPending: rows.filter(s => s.productionStatus === "pending").length,
      productionTp2Hits: productionDone.filter(s => s.productionStatus === "tp2_hit").length,
      productionStoppedBeforeTp1: productionDone.filter(s => s.productionStatus === "stopped_before_tp1").length,
      productionStoppedAfterTp1: productionDone.filter(s => s.productionStatus === "stopped_after_tp1").length,
      productionAverageRealizedR: (() => { const v = productionDone.map(s => s.productionRealizedR).filter(Number.isFinite); return v.length ? Number((v.reduce((x, y) => x + y, 0) / v.length).toFixed(3)) : null; })()
    };
  }
  return {
    mode: "forward_shadow_observation_only",
    strategy: "M5 breakout beyond prior 12 M5 candles; only aligned, fully closed M15 EMA20/50 trend; M5 retest confirmation; next-M5-open entry",
    marketsMonitored: Object.keys(journal?.markets || {}).length,
    m15ConfirmedSetups: Object.values(journal?.markets || {}).reduce((n, m) => n + (m.stats?.m15Confirmed || 0), 0),
    m15RejectedSetups: Object.values(journal?.markets || {}).reduce((n, m) => n + (m.stats?.m15Rejected || 0), 0),
    m15ReconfirmRejected: Object.values(journal?.markets || {}).reduce((n, m) => n + (m.stats?.m15ReconfirmRejected || 0), 0),
    signalsGenerated: signals.length,
    resolvedSignals: terminal.length,
    pendingSignals: signals.filter(s => s.status === "pending").length,
    targetBeforeStop: targets,
    stopBeforeTarget: stops,
    timeExit,
    ambiguous,
    targetRatePct: decisive ? Number((targets / decisive * 100).toFixed(1)) : null,
    averageRealizedR: realized.length ? Number((realized.reduce((a, b) => a + b, 0) / realized.length).toFixed(3)) : null,
    markets,
    productionManagementSimulation: {
      entriesPerSignal: 3,
      tp1R: 1.5,
      tp2R: 3.0,
      tp1Hits: productionTp1Hits,
      tp2Hits: productionTp2Hits,
      resolvedSignals: productionTerminal.length,
      pendingSignals: signals.filter(s => s.productionStatus === "pending").length,
      stoppedBeforeTp1: productionStoppedBeforeTp1,
      stoppedAfterTp1: productionStoppedAfterTp1,
      ambiguous: productionAmbiguous,
      timeExit: productionTimeExit,
      averageRealizedR: productionRealized.length ? Number((productionRealized.reduce((x, y) => x + y, 0) / productionRealized.length).toFixed(3)) : null,
      realizedObservations: productionRealized.length,
      weighting: "Two equal-sized entries close at +1.5R; the third closes at +3R or stop. Weighted basket R is +2R at TP2 and +0.667R if the runner stops after TP1."
    },
    comparisonModel: {
      targetR: TARGET_R,
      horizonMinutes: HORIZON_M5 * M5_SECONDS / 60,
      note: "Same single 2R target and one-hour horizon as the M1 research candidate for entry comparison. A separate outcome stream simulates the approved three-entry TP1 1.5R / TP2 3R management."
    },
    productionCompatibility: {
      entry: "M5",
      confirmation: "M15",
      minimumRewardRisk: 2,
      productionTargetManagement: "TP1 1.5R on first two entries; TP2 3R on third entry",
      productionStatus: "not_enabled; management outcomes simulated only"
    },
    note: "No Telegram alerts, no production signal routing, and no MT5 execution. M15 direction must be confirmed by the last fully closed M15 candle; incomplete M15 candles are excluded."
  };
}

function updateJournal(priorJournal, markets, nowEpoch = Math.floor(Date.now() / 1000)) {
  const journal = priorJournal && priorJournal.version === 1 && Array.isArray(priorJournal.signals)
    ? priorJournal : { version: 1, updatedAt: null, markets: {}, signals: [] };
  journal.markets ||= {};
  const byId = new Map(journal.signals.map(s => [s.signalId, s]));

  for (const [marketId, market] of Object.entries(markets || {})) {
    if (!SYNTHETIC_MARKETS.includes(marketId)) continue;
    const frames = market.timeframes || {};
    const m5 = frames.M5 || [], m15 = frames.M15 || [];
    const state = journal.markets[marketId] ||= blankMarketState();
    if (!validFrame(m5, M5_SECONDS, 65) || !validFrame(m15, M15_SECONDS, 55)) {
      state.dataQuality = "insufficient_or_discontinuous_candles";
      continue;
    }
    state.dataQuality = "ok";
    const atr5 = atrSeries(m5, 14);

    // Resolve open observations first so no market has overlapping shadow trades.
    for (const signal of journal.signals.filter(s => s.marketId === marketId &&
      (s.status === "pending" || s.productionStatus === "pending"))) {
      updateSignalOutcome(signal, m5);
      if (TERMINAL.has(signal.status) && PRODUCTION_TERMINAL.has(signal.productionStatus)) {
        const finalExitEpoch = Math.max(Number(signal.exitEpoch || 0), Number(signal.productionExitEpoch || 0));
        if (finalExitEpoch > 0) state.cooldownUntilEpoch = finalExitEpoch + COOLDOWN_M5 * M5_SECONDS;
      }
    }

    // Forward-only start. Historical candles are not silently counted as new signals.
    if (state.lastProcessedM5Epoch === null) {
      state.lastProcessedM5Epoch = m5[m5.length - 1].epoch;
      state.initializedAt = new Date(nowEpoch * 1000).toISOString();
      continue;
    }

    const newBars = m5.map((c, index) => ({ c, index }))
      .filter(x => x.c.epoch > state.lastProcessedM5Epoch);
    for (const item of newBars) {
      const { c, index } = item;
      const breakout = detectBreakout(m5, index, atr5[index]);
      if (!breakout) continue;
      const setupCloseEpoch = c.epoch + M5_SECONDS;
      const m15Context = m15ContextAt(m15, setupCloseEpoch);
      state.stats.setupsDetected += 1;
      if ((breakout.direction === 1 && m15Context !== "up") ||
          (breakout.direction === -1 && m15Context !== "down")) {
        state.stats.m15Rejected += 1;
        continue;
      }
      state.stats.m15Confirmed += 1;
      state.pendingSetups.push({
        setupCloseEpoch,
        direction: breakout.direction,
        boundary: breakout.boundary,
        atr5: breakout.atr5,
        m15Context
      });
    }
    state.lastProcessedM5Epoch = m5[m5.length - 1].epoch;

    const remaining = [];
    for (const setup of state.pendingSetups.sort((a, b) => a.setupCloseEpoch - b.setupCloseEpoch)) {
      const startIndex = m5.findIndex(c => c.epoch === setup.setupCloseEpoch);
      if (startIndex < 0) {
        if (m5[0].epoch > setup.setupCloseEpoch ||
            m5[m5.length - 1].epoch >= setup.setupCloseEpoch + CONFIRMATION_BARS_M5 * M5_SECONDS) {
          state.stats.confirmationExpired += 1;
        } else remaining.push(setup);
        continue;
      }
      const confirmation = findM5RetestConfirmation(m5, startIndex, setup, atr5);
      if (!confirmation) {
        if (m5[m5.length - 1].epoch >= setup.setupCloseEpoch + (CONFIRMATION_BARS_M5 - 1) * M5_SECONDS) {
          state.stats.confirmationExpired += 1;
        } else remaining.push(setup);
        continue;
      }
      const entryEpoch = m5[confirmation.entryIndex].epoch;
      const active = journal.signals.some(s => s.marketId === marketId &&
        (s.status === "pending" || s.productionStatus === "pending"));
      if (active || (Number.isFinite(state.cooldownUntilEpoch) && entryEpoch <= state.cooldownUntilEpoch)) {
        state.stats.overlapSuppressed += 1;
        continue;
      }
      const entryM15Context = m15ContextAt(m15, m5[confirmation.triggerIndex].epoch + M5_SECONDS);
      if ((setup.direction === 1 && entryM15Context !== "up") ||
          (setup.direction === -1 && entryM15Context !== "down")) {
        state.stats.m15ReconfirmRejected += 1;
        continue;
      }
      const signal = createSignal(marketId, market.marketName || market.market || marketId,
        { ...setup, m15ContextAtEntry: entryM15Context }, m5, confirmation);
      if (!signal) {
        state.stats.riskRejected += 1;
        continue;
      }
      if (!byId.has(signal.signalId)) {
        journal.signals.push(signal);
        byId.set(signal.signalId, signal);
        state.stats.signalsGenerated += 1;
      }
    }
    state.pendingSetups = remaining;
  }

  journal.updatedAt = new Date(nowEpoch * 1000).toISOString();
  journal.signals.sort((a, b) => b.entryCandleEpoch - a.entryCandleEpoch);
  journal.signals = journal.signals.slice(0, MAX_SIGNALS);
  journal.summary = summarizeJournal(journal);
  return journal;
}

module.exports = {
  SYNTHETIC_MARKETS, TERMINAL, ema, atrSeries, validFrame, directionFeatures,
  detectBreakout, m15ContextAt, findM5RetestConfirmation, createSignal,
  updateSignalOutcome, summarizeJournal, updateJournal
};
