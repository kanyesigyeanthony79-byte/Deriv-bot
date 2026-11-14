"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DemoExecutionManager, initializeBaselineFromVerifiedDemo } = require("../demo_execution_manager");

const NOW = Date.parse("2026-11-14T12:00:00Z");
function makeAdapter(overrides = {}) {
  const calls = [];
  return {
    calls,
    policy: { maxHoldingMinutes: 60 },
    async getAccountSnapshot() {
      return { mode: "demo", accountId: "VRTC123", currency: "USD", equity: 100,
        balance: 100, fetchedAtMs: NOW, openPositions: [], ...overrides.snapshot };
    },
    async closeContract(id, reason) { calls.push({ close: id, reason }); return { closed: true, contractId: id }; },
    async openPosition(args) { calls.push({ open: args }); return { opened: true, contractId: 77 }; }
  };
}
function makeStore(value = null) {
  let current = value;
  return { load: () => current, save: value => { current = value; }, get value() { return current; } };
}
const baseline = { date: "2026-11-14", dayStartEquity: 100, sessionPeakEquity: 100, accountId: "VRTC123" };

test("defaults to observe-only and never opens a trade", async () => {
  const adapter = makeAdapter();
  const manager = new DemoExecutionManager({ adapter, baselineStore: makeStore(baseline), allowedSymbols: ["R_50"] });
  const result = await manager.runCycle({});
  assert.equal(result.status, "observe_only");
  assert.equal(adapter.calls.some(c => c.open), false);
});

test("blocks entries when persistent baseline is missing", async () => {
  const adapter = makeAdapter();
  const manager = new DemoExecutionManager({
    adapter, baselineStore: makeStore(), allowedSymbols: ["R_50"],
    executionEnabled: true, positionManagementEnabled: true, exitEvaluator: async () => ({ exit: false }), strategyApprovalId: "approved-test",
    signalEvaluator: async () => ({ validated: true, completedCandlesOnly: true, strategyApprovalId: "approved-test", generatedAtMs: NOW, symbol: "R_50", direction: "BUY", duration: 5 })
  });
  const result = await manager.runCycle({});
  assert.equal(result.status, "observe_only");
  assert.equal(result.reason, "persistent_equity_baseline_not_initialized");
  assert.equal(adapter.calls.some(c => c.open), false);
});

test("rejects a research reversal candidate even when execution is explicitly enabled", async () => {
  const adapter = makeAdapter();
  const manager = new DemoExecutionManager({
    adapter, baselineStore: makeStore(baseline), allowedSymbols: ["R_50"],
    executionEnabled: true, positionManagementEnabled: true, exitEvaluator: async () => ({ exit: false }), strategyApprovalId: "approved-test",
    signalEvaluator: async () => ({ validated: true, completedCandlesOnly: true, strategyApprovalId: "approved-test",
      generatedAtMs: NOW, symbol: "R_50", direction: "BUY", duration: 5, experimentalReversal: true,
      source: "price_action_reversal_research" }),
    now: () => NOW
  });
  const result = await manager.runCycle({});
  assert.equal(result.status, "observe_only");
  assert.equal(result.reason, "experimental_reversal_engine_not_execution_approved");
  assert.equal(adapter.calls.some(c => c.open), false);
});

test("requires a validated completed-candle signal and applies account risk", async () => {
  const adapter = makeAdapter();
  const manager = new DemoExecutionManager({
    adapter, baselineStore: makeStore(baseline), allowedSymbols: ["R_50"],
    executionEnabled: true, positionManagementEnabled: true, exitEvaluator: async () => ({ exit: false }), strategyApprovalId: "approved-test",
    signalEvaluator: async () => ({ validated: true, completedCandlesOnly: true, strategyApprovalId: "approved-test", generatedAtMs: NOW, symbol: "R_50", direction: "BUY", duration: 5 }),
    now: () => NOW
  });
  const result = await manager.runCycle({});
  assert.equal(result.status, "executed_demo");
  assert.equal(adapter.calls.filter(c => c.open).length, 1);
  assert.equal(adapter.calls[0].open.contractType, "CALL");
});

test("rejects symbols outside the synthetic allowlist", async () => {
  const adapter = makeAdapter();
  const manager = new DemoExecutionManager({
    adapter, baselineStore: makeStore(baseline), allowedSymbols: ["R_50"],
    executionEnabled: true, positionManagementEnabled: true, exitEvaluator: async () => ({ exit: false }), strategyApprovalId: "approved-test",
    signalEvaluator: async () => ({ validated: true, completedCandlesOnly: true, strategyApprovalId: "approved-test", generatedAtMs: NOW, symbol: "frxXAUUSD", direction: "BUY", duration: 5 }),
    now: () => NOW
  });
  assert.equal((await manager.runCycle({})).reason, "candidate_symbol_or_direction_not_allowed");
  assert.equal(adapter.calls.some(c => c.open), false);
});

test("attempts an exit at the hard holding-time ceiling", async () => {
  const openedAt = NOW - 60 * 60 * 1000;
  const adapter = makeAdapter({ snapshot: { openPositions: [{ contractId: 9, openedAt, isValidToSell: true }] } });
  const manager = new DemoExecutionManager({ adapter, baselineStore: makeStore(baseline), allowedSymbols: ["R_50"], positionManagementEnabled: true, now: () => NOW });
  const result = await manager.runCycle({});
  assert.equal(result.actions[0].type, "EXIT_CONFIRMED");
  assert.equal(adapter.calls[0].close, 9);
});

test("updates session peak but does not reset baseline within the Uganda day", async () => {
  const store = makeStore(baseline);
  const adapter = makeAdapter({ snapshot: { equity: 105 } });
  const manager = new DemoExecutionManager({ adapter, baselineStore: store, allowedSymbols: ["R_50"], now: () => NOW });
  await manager.runCycle({});
  assert.equal(store.value.dayStartEquity, 100);
  assert.equal(store.value.sessionPeakEquity, 105);
});

test("baseline initialization refuses an account with open positions", async () => {
  const adapter = makeAdapter({ snapshot: { openPositions: [{ contractId: 1 }] } });
  await assert.rejects(() => initializeBaselineFromVerifiedDemo(adapter, makeStore(), () => NOW), /no_open_positions/);
});

test("rejects stale strategy candidates before requesting an order", async () => {
  const adapter = makeAdapter();
  const manager = new DemoExecutionManager({
    adapter, baselineStore: makeStore(baseline), allowedSymbols: ["R_50"],
    executionEnabled: true, positionManagementEnabled: true, exitEvaluator: async () => ({ exit: false }), strategyApprovalId: "approved-test", now: () => NOW,
    signalEvaluator: async () => ({ validated: true, completedCandlesOnly: true,
      strategyApprovalId: "approved-test", generatedAtMs: NOW - 61000, symbol: "R_50", direction: "BUY", duration: 5 })
  });
  const result = await manager.runCycle({});
  assert.equal(result.reason, "candidate_missing_or_stale_timestamp");
  assert.equal(adapter.calls.some(c => c.open), false);
});

test("blocks new entries if an existing exit cannot be confirmed", async () => {
  const adapter = makeAdapter({ snapshot: { openPositions: [{ contractId: 10,
    openedAt: NOW - 60 * 60 * 1000, isValidToSell: false }] } });
  const manager = new DemoExecutionManager({
    adapter, baselineStore: makeStore(baseline), allowedSymbols: ["R_50"],
    executionEnabled: true, positionManagementEnabled: true, exitEvaluator: async () => ({ exit: false }), strategyApprovalId: "approved-test", now: () => NOW,
    signalEvaluator: async () => ({ validated: true, completedCandlesOnly: true,
      strategyApprovalId: "approved-test", generatedAtMs: NOW, symbol: "R_50", direction: "BUY", duration: 5 })
  });
  const result = await manager.runCycle({});
  assert.equal(result.reason, "unresolved_exit_requires_reconciliation_before_new_entry");
  assert.equal(adapter.calls.some(c => c.open), false);
});

test("observe-only mode never closes an existing position", async () => {
  const adapter = makeAdapter({ snapshot: { openPositions: [{ contractId: 11,
    openedAt: NOW - 60 * 60 * 1000, isValidToSell: true }] } });
  const manager = new DemoExecutionManager({ adapter, baselineStore: makeStore(baseline), allowedSymbols: ["R_50"], now: () => NOW });
  const result = await manager.runCycle({});
  assert.equal(result.status, "observe_only");
  assert.equal(adapter.calls.some(c => c.close), false);
});

test("refuses to enable entries without a position exit policy", async () => {
  const adapter = makeAdapter();
  const manager = new DemoExecutionManager({
    adapter, baselineStore: makeStore(baseline), allowedSymbols: ["R_50"],
    executionEnabled: true, positionManagementEnabled: true,
    strategyApprovalId: "approved-test",
    signalEvaluator: async () => ({ validated: true, completedCandlesOnly: true,
      strategyApprovalId: "approved-test", generatedAtMs: NOW,
      symbol: "R_50", direction: "BUY", duration: 5 }),
    now: () => NOW
  });
  const result = await manager.runCycle({});
  assert.equal(result.reason, "position_management_and_exit_policy_required_before_entries");
  assert.equal(adapter.calls.some(c => c.open), false);
});
