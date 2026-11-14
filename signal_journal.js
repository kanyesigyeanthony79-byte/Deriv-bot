"use strict";

// Pure signal-journal transitions shared by the hosted scanner and unit tests.
function signalIdOf(signalOrId) {
  return typeof signalOrId === "string" ? signalOrId : signalOrId && signalOrId.signalId;
}

function journalOutcome(journal, signalOrId, outcome, candle, observedAt = new Date().toISOString()) {
  const signalId = signalIdOf(signalOrId);
  if (!signalId || !journal || !Array.isArray(journal.signals)) return false;
  const entry = journal.signals.find(item => item.signalId === signalId);
  if (!entry) return false;
  entry.events = Array.isArray(entry.events) ? entry.events : [];
  if (candle) {
    entry.events.push({
      outcome,
      observedAt,
      candleEpoch: candle.epoch,
      candle: { open: candle.open, high: candle.high, low: candle.low, close: candle.close }
    });
  }
  if (outcome === "TP1_HIT") entry.tp1Hit = true;
  if (outcome === "TP2_HIT") { entry.tp2Hit = true; entry.finalOutcome = "TP2"; }
  if (outcome === "SL_HIT") entry.finalOutcome = entry.tp1Hit ? "SL_AFTER_TP1" : "SL";
  if (outcome === "AMBIGUOUS") entry.finalOutcome = "AMBIGUOUS";
  if (outcome === "EXPIRED") entry.finalOutcome = "EXPIRED";
  return true;
}

function updateFavourableMovement(journal, signalOrId, candle) {
  const signalId = signalIdOf(signalOrId);
  if (!signalId || !journal || !Array.isArray(journal.signals) || !candle) return false;
  const entry = journal.signals.find(item => item.signalId === signalId);
  if (!entry || !Number.isFinite(Number(entry.entry))) return false;
  const direction = String(entry.direction || "").toUpperCase();
  if (direction !== "BUY" && direction !== "SELL") return false;
  const price = direction === "BUY" ? Number(candle.high) : Number(candle.low);
  if (!Number.isFinite(price)) return false;
  const points = direction === "BUY" ? price - Number(entry.entry) : Number(entry.entry) - price;
  if (!(points > Number(entry.maxFavourablePoints || 0))) return true;
  entry.maxFavourablePrice = price;
  entry.maxFavourablePoints = Number(points.toFixed(8));
  entry.maxFavourablePct = Number((points / Number(entry.entry) * 100).toFixed(5));
  entry.maxFavourableEpoch = Number(candle.epoch);
  return true;
}

function reconcileJournalState(journal, state, log = () => {}) {
  if (!journal || !Array.isArray(journal.signals)) return 0;
  const activeIds = new Set(((state && state.activeSignals) || [])
    .filter(signal => signal && !signal.closed)
    .map(signal => signal.signalId));
  let changed = 0;
  for (const entry of journal.signals) {
    if (entry.status === "sent" && !entry.finalOutcome && !activeIds.has(entry.signalId)) {
      entry.status = "state_missing";
      entry.statusReason = "signal_missing_from_active_state_on_restart";
      entry.finalOutcome = "UNVERIFIED";
      changed++;
      log("signal_state_missing", { signalId: entry.signalId, market: entry.market });
    }
  }
  return changed;
}

function markExpired(journal, signalId, candle, reason, observedAt = new Date().toISOString()) {
  const found = journalOutcome(journal, signalId, "EXPIRED", candle, observedAt);
  const entry = journal && Array.isArray(journal.signals)
    ? journal.signals.find(item => item.signalId === signalId) : null;
  if (entry) {
    entry.finalOutcome = "EXPIRED";
    if (reason) entry.statusReason = reason;
  }
  return found;
}

module.exports = { journalOutcome, reconcileJournalState, markExpired, updateFavourableMovement };
