"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanupUnmonitoredSignals } = require("../stale_signal_cleanup");
const { markExpired } = require("../signal_journal");

const DAY = 24 * 60 * 60;
const now = 1795435200;

function fixture() {
  return {
    state: { activeSignals: [
      { signalId: "GOLD-OLD", marketId: "frxXAUUSD", market: "Gold/USD", createdEpoch: now - 3 * DAY, closed: false },
      { signalId: "JUMP-RECENT", marketId: "JD100", market: "Jump 100", createdEpoch: now - 10 * 3600, closed: false },
      { signalId: "R10-OLD", marketId: "R_10", market: "Volatility 10", createdEpoch: now - 3 * DAY, closed: false },
      { signalId: "ALREADY-CLOSED", marketId: "frxXAUUSD", market: "Gold/USD", createdEpoch: now - 4 * DAY, closed: true }
    ] },
    journal: { signals: ["GOLD-OLD", "JUMP-RECENT", "R10-OLD", "ALREADY-CLOSED"].map(signalId => ({
      signalId, status: "sent", finalOutcome: null, events: []
    })) }
  };
}

test("expires over-24-hour signals only for markets no longer monitored", () => {
  const f = fixture();
  const logs = [];
  const changed = cleanupUnmonitoredSignals({
    ...f, nowEpoch: now, monitoredMarketIds: ["JD100", "R_10"],
    excludedMarketIds: ["R_10"], maxAgeSeconds: DAY,
    markExpired, log: (event, details) => logs.push({ event, details })
  });
  assert.equal(changed, 1);
  assert.deepEqual(f.state.activeSignals.map(s => s.signalId), ["JUMP-RECENT", "R10-OLD"]);
  assert.equal(f.journal.signals[0].finalOutcome, "EXPIRED");
  assert.equal(f.journal.signals[0].statusReason, "expired_after_24_hours_market_not_monitored");
  assert.equal(f.journal.signals[0].events.length, 0, "no candle means no fabricated price event");
  assert.equal(f.journal.signals[1].finalOutcome, null, "recent monitored signal remains open");
  assert.equal(f.journal.signals[2].finalOutcome, null, "R10 lifecycle remains with exclusive provider");
  assert.equal(f.journal.signals[3].finalOutcome, null, "already closed records are untouched");
  assert.equal(logs.length, 1);
});

test("does nothing when all active markets are monitored or age is within limit", () => {
  const f = fixture();
  const changed = cleanupUnmonitoredSignals({
    ...f, nowEpoch: now, monitoredMarketIds: ["frxXAUUSD", "JD100", "R_10"],
    excludedMarketIds: ["R_10"], maxAgeSeconds: DAY, markExpired
  });
  assert.equal(changed, 0);
  assert.equal(f.state.activeSignals.length, 4);
});
