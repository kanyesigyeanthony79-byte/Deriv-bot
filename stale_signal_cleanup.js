"use strict";

// Retire only over-age signals whose market is no longer monitored by this scanner.
// R10 is deliberately excluded because its exclusive paper provider owns that lifecycle.
function cleanupUnmonitoredSignals({ state, journal, nowEpoch, monitoredMarketIds, excludedMarketIds = [], maxAgeSeconds, markExpired, log = () => {} }) {
  if (!state || !Array.isArray(state.activeSignals) || !journal || !Array.isArray(journal.signals)) {
    throw new TypeError("Valid signal state and journal are required");
  }
  const monitored = new Set(monitoredMarketIds || []);
  const excluded = new Set(excludedMarketIds || []);
  let changed = 0;
  for (const signal of state.activeSignals) {
    if (!signal || signal.closed || monitored.has(signal.marketId) || excluded.has(signal.marketId)) continue;
    const created = Number(signal.createdEpoch);
    if (!Number.isFinite(created) || nowEpoch - created <= maxAgeSeconds) continue;
    markExpired(journal, signal.signalId, null, "expired_after_24_hours_market_not_monitored");
    signal.closed = true;
    signal.closeReason = "expired_after_24_hours_market_not_monitored";
    changed++;
    log("unmonitored_signal_expired", { signalId: signal.signalId, market: signal.market, marketId: signal.marketId });
  }
  if (changed) state.activeSignals = state.activeSignals.filter(signal => !signal.closed);
  return changed;
}

module.exports = { cleanupUnmonitoredSignals };
