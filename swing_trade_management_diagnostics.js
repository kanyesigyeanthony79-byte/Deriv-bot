"use strict";

// Retrospective diagnostics only. These metrics describe the full path after
// the entry and must never be used as inputs to a live decision.
function favorableR(signal, price) {
  const risk = Number(signal.riskDistance) > 0
    ? Number(signal.riskDistance)
    : signal.direction === "BUY" ? signal.entry - signal.stopLoss : signal.stopLoss - signal.entry;
  if (!(risk > 0)) return null;
  return signal.direction === "BUY" ? (price - signal.entry) / risk : (signal.entry - price) / risk;
}

function pathExtremes(signal, candles) {
  let mfe = 0, mae = 0;
  let timeTo1R = null;
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const favorablePrice = signal.direction === "BUY" ? candle.high : candle.low;
    const adversePrice = signal.direction === "BUY" ? candle.low : candle.high;
    const favorable = favorableR(signal, favorablePrice);
    const adverse = favorableR(signal, adversePrice);
    if (Number.isFinite(favorable)) mfe = Math.max(mfe, favorable);
    if (Number.isFinite(adverse)) mae = Math.min(mae, adverse);
    if (timeTo1R === null && favorable >= 1) timeTo1R = i + 1;
  }
  return { maxFavorableR: Number(mfe.toFixed(4)), maxAdverseR: Number(mae.toFixed(4)), timeTo1R };
}

function diagnoseTradePath(signal, candles, signalIndex, outcome, options = {}) {
  const maxHoldBars = Number.isInteger(options.maxHoldBars) ? options.maxHoldBars : 2016;
  if (!Array.isArray(candles) || !candles.length || !Number.isInteger(signalIndex) ||
      signalIndex < 0 || signalIndex >= candles.length || !outcome ||
      !Number.isInteger(outcome.barsHeld) || outcome.barsHeld < 1) {
    return { diagnosticStatus: "insufficient_path_data" };
  }
  const endIndex = Math.min(candles.length - 1, signalIndex + outcome.barsHeld);
  const heldPath = candles.slice(signalIndex + 1, endIndex + 1);
  if (!heldPath.length) return { diagnosticStatus: "insufficient_path_data" };
  const held = pathExtremes(signal, heldPath);
  const exitR = Number.isFinite(outcome.exitR) ? outcome.exitR
    : Number.isFinite(outcome.realizedR) ? outcome.realizedR : null;
  const result = {
    diagnosticStatus: "measured",
    maxFavorableR: held.maxFavorableR,
    maxAdverseR: held.maxAdverseR,
    timeTo1RBars: held.timeTo1R,
    peakToExitGivebackR: exitR === null ? null : Number((held.maxFavorableR - exitR).toFixed(4)),
    barsHeld: heldPath.length
  };

  if (outcome.status === "early_exit") {
    const horizonEnd = Math.min(candles.length - 1, signalIndex + maxHoldBars);
    const postExitPath = candles.slice(endIndex + 1, horizonEnd + 1);
    const post = pathExtremes(signal, postExitPath);
    const tp1 = signal.direction === "BUY"
      ? postExitPath.some(c => c.high >= signal.tp1)
      : postExitPath.some(c => c.low <= signal.tp1);
    const tp2 = signal.direction === "BUY"
      ? postExitPath.some(c => c.high >= signal.tp2)
      : postExitPath.some(c => c.low <= signal.tp2);
    const originalStop = signal.direction === "BUY"
      ? postExitPath.some(c => c.low <= signal.stopLoss)
      : postExitPath.some(c => c.high >= signal.stopLoss);
    result.afterEarlyExit = {
      barsObserved: postExitPath.length,
      maxFavorableR: post.maxFavorableR,
      maxAdverseR: post.maxAdverseR,
      reachedOriginalTP1: tp1,
      reachedOriginalTP2: tp2,
      reachedOriginalStop: originalStop,
      fullHorizonObserved: endIndex === signalIndex + maxHoldBars ||
        (postExitPath.length === maxHoldBars - outcome.barsHeld)
    };
  }
  return result;
}

module.exports = { diagnoseTradePath, pathExtremes };
