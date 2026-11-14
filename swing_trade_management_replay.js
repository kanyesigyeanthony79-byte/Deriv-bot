"use strict";

// Read-only historical lifecycle replay for the advisory trade manager.
const { TIMEFRAMES } = require("./multi_timeframe_engine");
const { evaluateTradeManagement, favorableR } = require("./swing_trade_management");

const DEFAULTS = Object.freeze({ maxHoldBars: 2016, lookbackBars: 120, partialFraction: 0.5 });

function completedTail(candles, timeframe, cutoffEpoch, limit) {
  const seconds = TIMEFRAMES[timeframe];
  let low = 0, high = candles.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (candles[mid].epoch + seconds <= cutoffEpoch) low = mid + 1;
    else high = mid;
  }
  return candles.slice(Math.max(0, low - limit), low);
}

function combineR(partialTaken, partialR, finalR, partialFraction) {
  return partialTaken
    ? partialR * partialFraction + finalR * (1 - partialFraction)
    : finalR;
}

function simulateManagedOutcome(signal, candlesByTimeframe, signalIndex, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const m5 = candlesByTimeframe.M5 || [];
  if (!Number.isInteger(signalIndex) || signalIndex < 0 || signalIndex >= m5.length) {
    return { status: "invalid_entry_index", realizedR: null };
  }
  const position = {
    marketId: signal.marketId,
    direction: signal.direction,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    tp1: signal.tp1,
    tp2: signal.tp2,
    riskDistance: signal.riskDistance,
    partialTaken: false
  };
  let partialR = null;
  let stopState = "initial";
  const actions = {};
  const finalIndex = Math.min(m5.length - 1, signalIndex + config.maxHoldBars);

  for (let index = signalIndex + 1; index <= finalIndex; index++) {
    const current = m5[index];
    const cutoff = current.epoch + TIMEFRAMES.M5;
    const frames = {
      M5: m5.slice(Math.max(0, index - config.lookbackBars + 1), index + 1)
    };
    for (const timeframe of ["M15", "H1", "H4", "D1"]) {
      frames[timeframe] = completedTail(candlesByTimeframe[timeframe] || [], timeframe, cutoff, config.lookbackBars);
    }

    const advice = evaluateTradeManagement({ position, candlesByTimeframe: frames });
    actions[advice.action] = (actions[advice.action] || 0) + 1;
    const barsHeld = index - signalIndex;
    const partialRealized = position.partialTaken === true;

    if (advice.action === "WAIT_FOR_DATA") {
      return { status: "data_unavailable", barsHeld, realizedR: null, partialTaken: partialRealized,
        partialR, stopState, managementActions: actions, blockedTimeframe: advice.timeframe };
    }
    if (advice.action === "AMBIGUOUS_BARRIER") {
      return { status: "ambiguous_barrier", barsHeld, realizedR: null, partialTaken: partialRealized,
        partialR, stopState, managementActions: actions };
    }
    if (advice.action === "PARTIAL_PROFIT" || advice.action === "PARTIAL_PROFIT_EARLY") {
      position.partialTaken = true;
      partialR = advice.action === "PARTIAL_PROFIT"
        ? favorableR(position, position.tp1)
        : advice.favorableR;
      if (Number.isFinite(advice.suggestedStopLoss)) {
        position.stopLoss = advice.suggestedStopLoss;
        stopState = "break_even";
      }
      continue;
    }
    if (advice.action === "MOVE_TO_BREAK_EVEN" || advice.action === "TRAIL_PROTECT_PROFIT") {
      position.stopLoss = advice.suggestedStopLoss;
      stopState = advice.action === "MOVE_TO_BREAK_EVEN" ? "break_even" : "trailing";
      continue;
    }
    if (advice.action === "EXIT_EARLY") {
      const exitR = advice.favorableR;
      return { status: "early_exit", barsHeld, exitPrice: advice.currentPrice, exitR,
        realizedR: combineR(partialRealized, partialR, exitR, config.partialFraction),
        partialTaken: partialRealized, partialR, stopState, managementActions: actions };
    }
    if (advice.action === "EXIT_AT_SL") {
      const exitR = favorableR(position, position.stopLoss);
      const status = stopState === "break_even" ? (partialRealized ? "break_even_after_partial" : "break_even_exit")
        : stopState === "trailing" ? "trailing_stop_exit" : "stop_loss";
      return { status, barsHeld, exitPrice: position.stopLoss, exitR,
        realizedR: combineR(partialRealized, partialR, exitR, config.partialFraction),
        partialTaken: partialRealized, partialR, stopState, managementActions: actions };
    }
    if (advice.action === "CLOSE_REMAINDER") {
      const exitR = favorableR(position, position.tp2);
      return { status: "tp2_exit", barsHeld, exitPrice: position.tp2, exitR,
        realizedR: combineR(partialRealized, partialR, exitR, config.partialFraction),
        partialTaken: partialRealized, partialR, stopState, managementActions: actions };
    }
  }

  const end = m5[finalIndex];
  const exitR = favorableR(position, end.close);
  const fullWindow = finalIndex - signalIndex === config.maxHoldBars;
  return { status: fullWindow ? "horizon_exit" : "incomplete_window",
    barsHeld: finalIndex - signalIndex, exitPrice: end.close, exitR,
    realizedR: combineR(position.partialTaken, partialR, exitR, config.partialFraction),
    partialTaken: position.partialTaken, partialR, stopState, managementActions: actions };
}


function simulateFixedPlanOutcome(signal, candlesByTimeframe, signalIndex, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const candles = candlesByTimeframe.M5 || [];
  if (!Number.isInteger(signalIndex) || signalIndex < 0 || signalIndex >= candles.length) {
    return { status: "invalid_entry_index", realizedR: null };
  }
  const position = {
    direction: signal.direction,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    riskDistance: signal.riskDistance
  };
  const finalIndex = Math.min(candles.length - 1, signalIndex + config.maxHoldBars);
  let partialTaken = false;
  let partialR = null;

  for (let index = signalIndex + 1; index <= finalIndex; index++) {
    const candle = candles[index];
    const stop = signal.direction === "BUY" ? candle.low <= signal.stopLoss : candle.high >= signal.stopLoss;
    const tp1 = signal.direction === "BUY" ? candle.high >= signal.tp1 : candle.low <= signal.tp1;
    const tp2 = signal.direction === "BUY" ? candle.high >= signal.tp2 : candle.low <= signal.tp2;
    const barsHeld = index - signalIndex;

    if (!partialTaken) {
      if (stop && tp1) return { status: "ambiguous_barrier", barsHeld, realizedR: null };
      if (stop) return { status: "stop_before_tp1", barsHeld, exitR: -1, realizedR: -1, partialTaken: false };
      if (tp1) {
        partialTaken = true;
        partialR = favorableR(position, signal.tp1);
        if (tp2) {
          const finalR = favorableR(position, signal.tp2);
          return { status: "tp2_exit", barsHeld, exitR: finalR,
            realizedR: combineR(true, partialR, finalR, config.partialFraction), partialTaken, partialR };
        }
      }
    } else {
      if (stop && tp2) return { status: "ambiguous_barrier", barsHeld, realizedR: null, partialTaken, partialR };
      if (tp2) {
        const finalR = favorableR(position, signal.tp2);
        return { status: "tp2_exit", barsHeld, exitR: finalR,
          realizedR: combineR(true, partialR, finalR, config.partialFraction), partialTaken, partialR };
      }
      if (stop) {
        return { status: "stop_after_tp1", barsHeld, exitR: -1,
          realizedR: combineR(true, partialR, -1, config.partialFraction), partialTaken, partialR };
      }
    }
  }

  const end = candles[finalIndex];
  const exitR = favorableR(position, end.close);
  const fullWindow = finalIndex - signalIndex === config.maxHoldBars;
  return { status: fullWindow ? (partialTaken ? "tp1_only_by_horizon" : "horizon_exit") : "incomplete_window",
    barsHeld: finalIndex - signalIndex, exitPrice: end.close, exitR,
    realizedR: combineR(partialTaken, partialR, exitR, config.partialFraction),
    partialTaken, partialR };
}

function summarizeManaged(results) {
  const outcomes = {};
  for (const result of results) outcomes[result.status] = (outcomes[result.status] || 0) + 1;
  const scored = results.filter(result => Number.isFinite(result.realizedR));
  const winners = scored.filter(result => result.realizedR > 0);
  const losers = scored.filter(result => result.realizedR < 0);
  const grossProfit = winners.reduce((sum, result) => sum + result.realizedR, 0);
  const grossLoss = Math.abs(losers.reduce((sum, result) => sum + result.realizedR, 0));
  return {
    signals: results.length,
    scoredSignals: scored.length,
    outcomes,
    averageRealizedR: scored.length
      ? Number((scored.reduce((sum, result) => sum + result.realizedR, 0) / scored.length).toFixed(4))
      : null,
    averageBarsHeld: scored.length
      ? Number((scored.reduce((sum, result) => sum + result.barsHeld, 0) / scored.length).toFixed(1))
      : null,
    winRate: scored.length ? Number((winners.length / scored.length).toFixed(4)) : null,
    profitFactor: grossLoss ? Number((grossProfit / grossLoss).toFixed(4)) : (grossProfit ? "infinite" : null),
    averageWinningR: winners.length ? Number((grossProfit / winners.length).toFixed(4)) : null,
    averageLosingR: losers.length ? Number((losers.reduce((sum, result) => sum + result.realizedR, 0) / losers.length).toFixed(4)) : null,
    averageWinningHoldBars: winners.length ? Number((winners.reduce((sum, result) => sum + result.barsHeld, 0) / winners.length).toFixed(1)) : null,
    longestWinningHoldBars: winners.length ? Math.max(...winners.map(result => result.barsHeld)) : null
  };
}

module.exports = { DEFAULTS, completedTail, simulateFixedPlanOutcome, simulateManagedOutcome, summarizeManaged };
