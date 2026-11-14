"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { makePolicy, assessNewPosition, positionsPastTimeLimit } = require("../account_risk");

const NOW = 1_800_000_000_000;
function account(overrides = {}) {
  return {
    mode: "demo", currency: "USD", balance: 100, equity: 100,
    dayStartEquity: 100, sessionPeakEquity: 100, fetchedAtMs: NOW,
    openPositions: [], ...overrides
  };
}

test("default policy is capped at five positions and sixty minutes", () => {
  const p = makePolicy();
  assert.equal(p.maxOpenPositions, 5);
  assert.equal(p.maxHoldingMinutes, 60);
  assert.equal(p.riskPerPositionPct, 0.5);
  assert.equal(p.maxOpenRiskPct, 2);
});

test("sizes a new position from current equity and per-position risk", () => {
  const result = assessNewPosition(account(), makePolicy(), NOW);
  assert.equal(result.allowed, true);
  assert.equal(result.stake, 0.5);
});

test("resizes down when account equity falls", () => {
  const result = assessNewPosition(account({ balance: 40, equity: 40, dayStartEquity: 40, sessionPeakEquity: 40 }), makePolicy(), NOW);
  assert.equal(result.allowed, true);
  assert.equal(result.stake, 0.2);
});

test("reserves risk for existing positions before allowing another", () => {
  const openPositions = [{ stake: 1 }, { stake: 0.5 }];
  const result = assessNewPosition(account({ openPositions }), makePolicy(), NOW);
  assert.equal(result.allowed, true);
  assert.equal(result.stake, 0.5);
  assert.equal(result.openRisk, 1.5);
});

test("blocks when five positions are already open", () => {
  const openPositions = Array.from({ length: 5 }, (_, i) => ({ contractId: String(i), stake: 0.1 }));
  assert.equal(assessNewPosition(account({ openPositions }), makePolicy(), NOW).reason, "maximum_open_positions_reached");
});

test("blocks stale, missing, or non-demo account snapshots", () => {
  assert.equal(assessNewPosition(account({ fetchedAtMs: NOW - 31_000 }), makePolicy(), NOW).reason, "account_snapshot_stale");
  assert.equal(assessNewPosition(account({ mode: "real" }), makePolicy(), NOW).reason, "demo_account_required");
  assert.equal(assessNewPosition(account({ openPositions: null }), makePolicy(), NOW).reason, "open_positions_unavailable");
});

test("blocks at daily loss and peak-to-current drawdown thresholds", () => {
  assert.equal(assessNewPosition(account({ equity: 97, balance: 97 }), makePolicy(), NOW).reason, "daily_loss_limit_reached");
  assert.equal(assessNewPosition(account({ equity: 104.5, balance: 104.5, dayStartEquity: 100, sessionPeakEquity: 110 }), makePolicy(), NOW).reason, "drawdown_pause_reached");
});

test("fails closed if any open position risk is unknown", () => {
  assert.equal(assessNewPosition(account({ openPositions: [{ contractId: "x" }] }), makePolicy(), NOW).reason, "open_position_risk_unknown");
});

test("hard caps reject unsafe overrides", () => {
  assert.throws(() => makePolicy({ riskPerPositionPct: 2 }), /hard safety cap/);
  assert.throws(() => makePolicy({ maxOpenPositions: 6 }), /hard safety cap|integer/);
  assert.throws(() => makePolicy({ maxHoldingMinutes: 61 }), /hard safety cap|integer/);
});

test("time-limit detector flags positions at or beyond sixty minutes", () => {
  const positions = [
    { contractId: "old", openedAt: NOW - 60 * 60 * 1000 },
    { contractId: "new", openedAt: NOW - 59 * 60 * 1000 }
  ];
  const due = positionsPastTimeLimit(positions, NOW, makePolicy());
  assert.deepEqual(due.map(x => x.contractId), ["old"]);
});
