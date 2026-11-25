"use strict";

// Price-event lifecycle for original M15 signals. There is intentionally no
// wall-clock expiry: only pre-entry TP1/SL invalidation or post-entry TP/SL
// completion can close a signal.
function evaluateSignalCandle(signal, candle) {
  const buy = String(signal.direction).toUpperCase() === "BUY";
  const entryTouched = buy ? candle.high >= signal.entry : candle.low <= signal.entry;
  const tp1Touched = buy ? candle.high >= signal.tp1 : candle.low <= signal.tp1;
  const tp2Touched = buy ? candle.high >= signal.tp2 : candle.low <= signal.tp2;
  const slTouched = buy ? candle.low <= signal.stopLoss : candle.high >= signal.stopLoss;

  if (!signal.entryTriggered) {
    if (!entryTouched) {
      if (tp1Touched) return { action: "EXPIRED_TP1_BEFORE_ENTRY" };
      if (slTouched) return { action: "EXPIRED_SL_BEFORE_ENTRY" };
      return { action: "WAIT" };
    }
    if (slTouched && tp1Touched) return { action: "AMBIGUOUS" };
    if (slTouched) return { action: "SL_HIT" };
    if (tp2Touched) return { action: "TP1_HIT", alsoTp2: true };
    if (tp1Touched) return { action: "TP1_HIT" };
    return { action: "ENTRY_TRIGGERED" };
  }

  if (slTouched && (tp1Touched || tp2Touched)) return { action: "AMBIGUOUS" };
  if (slTouched) return { action: "SL_HIT" };
  if (tp2Touched) return { action: "TP2_HIT" };
  if (tp1Touched && !signal.tp1Hit) return { action: "TP1_HIT" };
  return { action: "WAIT" };
}

module.exports = { evaluateSignalCandle };
