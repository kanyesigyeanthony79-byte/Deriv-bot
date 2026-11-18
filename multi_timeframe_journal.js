"use strict";
// Separate observation journal for multi-timeframe candidates. Never touches production trade_journal.json.
const TERMINAL = new Set(["tp2_hit", "stopped", "stopped_after_tp1", "ambiguous", "expired"]);
const ENTRY_TIMEFRAME_SECONDS = Object.freeze({ M1: 60, M5: 300, H1: 3600, H4: 14400 });
const DEFAULT_MAX_AGE_SECONDS = Object.freeze({ SCALP: 1800, SHORT_TERM: 21600, SWING: 604800, POSITION: 2592000 });

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

function applyLiveQuote(record, quote, nowEpoch) {
  if (!record || TERMINAL.has(record.status) || !quote) return record;
  const price = Number(quote.price);
  if (!Number.isFinite(price)) return record;
  const buy = record.direction === "BUY";
  if (record.direction !== "BUY" && record.direction !== "SELL") return record;
  const stop = buy ? price <= Number(record.stopLoss) : price >= Number(record.stopLoss);
  const tp1 = buy ? price >= Number(record.tp1) : price <= Number(record.tp1);
  const tp2 = buy ? price >= Number(record.tp2) : price <= Number(record.tp2);
  record.lastLivePrice = price;
  record.lastLiveQuoteEpoch = Number(quote.epoch) || nowEpoch;
  if (stop) {
    record.status = record.tp1Hit ? "stopped_after_tp1" : "stopped";
    record.stopEpoch = nowEpoch;
  } else if (tp2) {
    if (!record.tp1Hit) { record.tp1Hit = true; record.tp1Epoch = nowEpoch; }
    record.status = "tp2_hit";
    record.tp2Epoch = nowEpoch;
  } else if (tp1 && !record.tp1Hit) {
    record.tp1Hit = true;
    record.tp1Epoch = nowEpoch;
    record.status = "tp1_hit";
  }
  return record;
}

function updateJournal(journal, markets, nowEpoch, liveQuotes = {}) {
  const state = journal && journal.version === 1 && Array.isArray(journal.signals)
    ? journal : { version: 1, updatedAt: null, signals: [] };
  const byId = new Map(state.signals.map(s => [s.signalId, s]));
  // Backfill milestones for records resolved by older collector versions.
  for (const record of state.signals) {
    if (record.status === "tp2_hit" && !record.tp1Hit) {
      record.tp1Hit = true;
      record.tp1Epoch = record.tp1Epoch || record.tp2Epoch || record.lastProcessedEpoch || null;
    }
    if (record.status === "stopped_after_tp1") record.tp1Hit = true;
  }
  for (const market of Object.values(markets || {})) {
    const candidates = [...(market.signals || []), ...(market.recentSignals || [])].filter(s => s.state === "signal" && s.signalId);
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
        const favourablePrice = record.direction === "BUY" ? candle.high : candle.low;
        const favourablePoints = record.direction === "BUY"
          ? favourablePrice - record.entry : record.entry - favourablePrice;
        if (Number.isFinite(favourablePoints) && favourablePoints > Number(record.maxFavourablePoints || 0)) {
          record.maxFavourablePrice = favourablePrice;
          record.maxFavourablePoints = Number(favourablePoints.toFixed(8));
          record.maxFavourablePct = Number((favourablePoints / record.entry * 100).toFixed(5));
          record.maxFavourableEpoch = candle.epoch;
        }
        const hit = touchStatus(record, candle);
        if (hit === "ambiguous") {
          record.status = "ambiguous"; record.stopEpoch = candle.epoch;
        } else if (hit === "stopped" || hit === "stopped_after_tp1") {
          record.status = hit; record.stopEpoch = candle.epoch;
        } else if (hit === "tp2_hit") {
          if (!record.tp1Hit) { record.tp1Hit = true; record.tp1Epoch = candle.epoch; }
          record.status = hit; record.tp2Epoch = candle.epoch;
        } else if (hit === "tp1_hit" && !record.tp1Hit) {
          record.tp1Hit = true; record.tp1Epoch = candle.epoch; record.status = "tp1_hit";
        }
      }
      if (!TERMINAL.has(record.status)) applyLiveQuote(record, liveQuotes[record.marketId], nowEpoch);
      if (!TERMINAL.has(record.status) && nowEpoch - Number(record.entryCandleEpoch) > Number(record.maxAgeSeconds || DEFAULT_MAX_AGE_SECONDS[record.category] || 1800)) {
        record.status = "expired";
        record.expiredEpoch = nowEpoch;
      }
    }
  }
  for (const record of state.signals) {
    if (!TERMINAL.has(record.status)) {
      applyLiveQuote(record, liveQuotes[record.marketId], nowEpoch);
      if (!TERMINAL.has(record.status) && nowEpoch - Number(record.entryCandleEpoch) > Number(record.maxAgeSeconds || DEFAULT_MAX_AGE_SECONDS[record.category] || 1800)) {
        record.status = "expired";
        record.expiredEpoch = nowEpoch;
      }
    }
  }
  state.updatedAt = new Date(nowEpoch * 1000).toISOString();
  state.signals.sort((a, b) => b.createdEpoch - a.createdEpoch);
  // Never prune a Telegram-delivered signal while its outcome is unresolved.
  // Keep the newest 500 ordinary records plus every delivered, non-terminal record.
  const retainedDelivered = state.signals.filter(s => s.telegramStatus === "sent" && !TERMINAL.has(s.status));
  const retainedIds = new Set(retainedDelivered.map(s => s.signalId));
  const recent = state.signals.filter(s => !retainedIds.has(s.signalId)).slice(0, 500);
  state.signals = [...retainedDelivered, ...recent].sort((a, b) => b.createdEpoch - a.createdEpoch);
  return state;
}

function dashboardSignalsForMarket(market, journal, nowEpoch, liveQuotes = {}) {
  const marketId = market?.marketId;
  if (!marketId) return [];
  // The journal is the source of truth: older still-valid signals may no longer
  // appear in the scanner's short recent-candidate window.
  return (journal?.signals || []).filter(record =>
    record.marketId === marketId && ["pending", "tp1_hit"].includes(record.status)
  ).flatMap(record => {
    const maxAge = Number(record.maxAgeSeconds || DEFAULT_MAX_AGE_SECONDS[record.category] || 1800);
    if (!Number.isFinite(Number(nowEpoch)) || Number(nowEpoch) - Number(record.entryCandleEpoch) > maxAge) return [];
    const quote = liveQuotes[marketId];
    const quoteEpoch = Number(quote?.epoch);
    const quoteAge = Number(nowEpoch) - quoteEpoch;
    if (!Number.isFinite(Number(quote?.price)) || !Number.isFinite(quoteEpoch) || quoteAge < -60 || quoteAge > 300) return [];
    const price = Number(quote.price);
    const buy = record.direction === "BUY";
    if (record.direction !== "BUY" && record.direction !== "SELL") return [];
    if (buy ? price <= Number(record.stopLoss) || price >= Number(record.tp2)
      : price >= Number(record.stopLoss) || price <= Number(record.tp2)) return [];
    return [{ ...record, state: "signal", currentPrice: price, quoteEpoch }];
  });
}
function summarizeJournal(journal) {
  const counts = {};
  for (const s of journal.signals || []) counts[s.status] = (counts[s.status] || 0) + 1;
  return counts;
}
module.exports = { TERMINAL, touchStatus, applyLiveQuote, updateJournal, summarizeJournal, dashboardSignalsForMarket };
