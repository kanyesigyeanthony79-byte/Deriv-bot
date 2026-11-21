"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  admission, updateWeakCohortForwardShadowJournal
} = require("../weak_cohort_forward_shadow");

function signal(signalId, marketId, direction, category, status = "pending", telegramStatus = "sent", createdEpoch = 200) {
  return { signalId, marketId, direction, category, status, telegramStatus, createdEpoch, entry: 100, stopLoss: 95, tp1: 105, tp2: 110 };
}

test("four arms independently exclude R75 and BOOM500 while retaining control", () => {
  const rows = [
    signal("r75", "R_75", "BUY", "SHORT_TERM"),
    signal("boom", "BOOM500", "SELL", "SHORT_TERM"),
    signal("other", "R_10", "BUY", "SCALP"),
    signal("old", "JD100", "BUY", "SCALP")
  ];
  assert.deepEqual(admission(rows[0]), { control: true, r75Only: false, boom500Only: true, combined: false });
  assert.deepEqual(admission(rows[1]), { control: true, r75Only: true, boom500Only: false, combined: false });
  assert.deepEqual(admission(rows[2]), { control: true, r75Only: true, boom500Only: true, combined: true });
  assert.deepEqual(admission(rows[3]), { control: false, r75Only: false, boom500Only: false, combined: false });
});

test("starts at current epoch and excludes all pre-start historical records", () => {
  const journal = { signals: [
    signal("old", "R_75", "BUY", "SHORT_TERM", "stopped", "sent", 199),
    signal("new", "R_75", "BUY", "SHORT_TERM", "pending", "sent", 200)
  ] };
  const result = updateWeakCohortForwardShadowJournal(null, journal, 200);
  assert.equal(result.startedEpoch, 200);
  assert.deepEqual(result.observations.map(row => row.signalId), ["new"]);
  assert.equal(result.summary.arms.control.all.generated, 1);
  assert.equal(result.summary.arms.r75Only.all.generated, 0);
});

test("mirrors outcome and delivery updates without changing baseline journal", () => {
  const original = signal("new", "BOOM500", "SELL", "SHORT_TERM", "pending", "not_reported", 200);
  const journal = { signals: [original] };
  const first = updateWeakCohortForwardShadowJournal(null, journal, 200);
  original.status = "stopped";
  original.telegramStatus = "sent";
  const next = updateWeakCohortForwardShadowJournal(first, journal, 210);
  assert.equal(next.observations[0].status, "stopped");
  assert.equal(next.observations[0].telegramStatus, "sent");
  assert.equal(next.summary.arms.control.all.losses, 1);
  assert.equal(next.summary.arms.boom500Only.all.generated, 0);
  assert.equal(original.status, "stopped");
});
