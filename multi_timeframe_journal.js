"use strict";
// Separate observation journal for multi-timeframe candidates. Never touches production trade_journal.json.
const TERMINAL = new Set(["tp2_hit", "stopped", "stopped_after_tp1", "ambiguous", "expired"]);
function touchStatus(signal, candle) {
  const buy = signal.direction === "BUY";
  const stop = buy ? candle.low <= signal.stopLoss : candle.high >= signal.stopLoss;
  const tp1 = buy ? candle.high >= signal.tp1 : candle.low <= signal.tp1;
  const tp2 = buy ? candle.high >= signal.tp2 : candle.low <= signal.tp2;
  if (stop && (tp1 || tp2)) return "ambiguous";
  if (stop) return signal.tp1Hit ? "stopped_after_tp1" : "stopped";
  if (tp2) return "tp2_hit";
  if (tp1) return "tp1_hit";
  return null;
}
function updateJournal(journal, markets, nowEpoch) {
  const state = journal && journal.version === 1 && Array.isArray(journal.signals)
    ? journal : { version: 1, updatedAt: null, signals: [] };
  const byId = new Map(state.signals.map(s => [s.signalId, s]));
  for (const market of Object.values(markets || {})) {
    const candidates = (market.signals || []).filter(s => s.state === "signal" && s.signalId);
    for (const candidate of candidates) {
      if (!byId.has(candidate.signalId)) {
        const record = {
          ...candidate, status: "pending", createdEpoch: nowEpoch,
          tp1Hit: false, tp1Epoch: null, tp2Epoch: null, stopEpoch: null,
          lastProcessedEpoch: candidate.entryCandleEpoch, outcomeCandles: 0
        };
        state.signals.push(record);
        byId.set(record.signalId, record);
      }
    }
    for (const record of state.signals.filter(s => s.marketId === market.marketId && !TERMINAL.has(s.status))) {
      const frame = market.timeframes && market.timeframes[record.entryTimeframe] || [];
      const later = frame.filter(c => c.epoch > (record.lastProcessedEpoch ?? record.entryCandleEpoch));
      for (const candle of later) {
        if (TERMINAL.has(record.status)) break;
        record.outcomeCandles++;
        record.lastProcessedEpoch = candle.epoch;
        const hit = touchStatus(record, candle);
        if (hit === "ambiguous") {
          record.status = "ambiguous"; record.stopEpoch = candle.epoch;
        } else if (hit === "stopped" || hit === "stopped_after_tp1") {
          record.status = hit; record.stopEpoch = candle.epoch;
        } else if (hit === "tp2_hit") {
          record.status = hit; record.tp2Epoch = candle.epoch;
        } else if (hit === "tp1_hit" && !record.tp1Hit) {
          record.tp1Hit = true; record.tp1Epoch = candle.epoch; record.status = "tp1_hit";
        }
      }
      if (!TERMINAL.has(record.status) && nowEpoch - record.entryCandleEpoch > record.maxAgeSeconds) {
        record.status = "expired";
      }
    }
  }
  for (const record of state.signals) {
    if (!TERMINAL.has(record.status) && nowEpoch - record.entryCandleEpoch > record.maxAgeSeconds) record.status = "expired";
  }
  state.updatedAt = new Date(nowEpoch * 1000).toISOString();
  // Keep a bounded observation history; preserve newest records.
  state.signals.sort((a, b) => b.createdEpoch - a.createdEpoch);
  state.signals = state.signals.slice(0, 500);
  return state;
}
function summarizeJournal(journal) {
  const counts = {};
  for (const s of journal.signals || []) counts[s.status] = (counts[s.status] || 0) + 1;
  return counts;
}
module.exports = { TERMINAL, touchStatus, updateJournal, summarizeJournal };
