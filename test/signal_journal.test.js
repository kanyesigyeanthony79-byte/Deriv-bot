"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { journalOutcome, reconcileJournalState, markExpired } = require("../signal_journal");

function fixture() {
  return { version: 1, signals: [
    { signalId: "active", status: "sent", tp1Hit: false, finalOutcome: null, events: [] },
    { signalId: "closed", status: "sent", tp1Hit: true, finalOutcome: "TP2", events: [] },
    { signalId: "lost", status: "sent", tp1Hit: false, finalOutcome: null, events: [] }
  ] };
}
const candle = { epoch: 123, open: 100, high: 103, low: 99, close: 102 };

test("journal outcome accepts a signal object or a signal ID string", () => {
  const journal = fixture();
  assert.equal(journalOutcome(journal, { signalId: "active" }, "TP1_HIT", candle, "2026-01-01T00:00:00Z"), true);
  assert.equal(journal.signals[0].tp1Hit, true);
  assert.equal(journal.signals[0].events.length, 1);
  assert.equal(journalOutcome(journal, "active", "TP2_HIT", candle, "2026-01-01T00:01:00Z"), true);
  assert.equal(journal.signals[0].finalOutcome, "TP2");
  assert.equal(journal.signals[0].tp2Hit, true);
});

test("stop outcome preserves whether TP1 was reached", () => {
  const journal = fixture();
  journalOutcome(journal, "active", "SL_HIT", candle);
  assert.equal(journal.signals[0].finalOutcome, "SL");
  journal.signals[0].tp1Hit = true;
  journalOutcome(journal, "active", "SL_HIT", candle);
  assert.equal(journal.signals[0].finalOutcome, "SL_AFTER_TP1");
});

test("restart reconciliation labels missing active state as unverified, not open", () => {
  const journal = fixture();
  const logs = [];
  const changed = reconcileJournalState(journal, { activeSignals: [{ signalId: "active", closed: false }] },
    (event, data) => logs.push({ event, data }));
  assert.equal(changed, 1);
  assert.equal(journal.signals[0].status, "sent");
  assert.equal(journal.signals[2].status, "state_missing");
  assert.equal(journal.signals[2].finalOutcome, "UNVERIFIED");
  assert.equal(journal.signals[1].finalOutcome, "TP2");
  assert.equal(logs.length, 1);
});

test("expiry is recorded locally even when no candle is available", () => {
  const journal = fixture();
  assert.equal(markExpired(journal, "lost", null, "expired_after_24_hours_no_recent_candle"), true);
  assert.equal(journal.signals[2].finalOutcome, "EXPIRED");
  assert.equal(journal.signals[2].statusReason, "expired_after_24_hours_no_recent_candle");
  assert.equal(journal.signals[2].events.length, 0);
});

test("unknown signal IDs do not create phantom journal rows", () => {
  const journal = fixture();
  assert.equal(journalOutcome(journal, "missing", "TP1_HIT", candle), false);
  assert.equal(journal.signals.length, 3);
});
