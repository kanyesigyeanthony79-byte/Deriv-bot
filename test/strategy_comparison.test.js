"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  STRATEGIES, pullbackConfirmed, makeLevels, evaluateStrategy,
  updateSignalOutcome, updateStrategyJournal
} = require("../strategy_comparison");

function candles(count, step = 900, start = 1_700_000_000) {
  return Array.from({ length: count }, (_, i) => ({
    epoch: start + i * step,
    open: 100,
    high: 100.2,
    low: 99.8,
    close: 100
  }));
}

test("defines the three requested strategies", () => {
  assert.deepEqual(STRATEGIES.map(s => s.id), ["EMA20_50", "EMA9_21", "EMA20_50_PULLBACK"]);
});

test("all strategies wait for a common 65 completed M15 candles", () => {
  for (const strategy of STRATEGIES) {
    assert.equal(evaluateStrategy(candles(64), strategy.id).state, "warming");
  }
});

test("pullback confirmation requires a test of EMA20 and a directional rejection", () => {
  const rising = Array.from({ length: 70 }, (_, i) => {
    const close = 100 + i * 0.15;
    return { epoch: 1_700_000_000 + i * 900, open: close - 0.08, high: close + 0.12, low: close - 0.12, close };
  });
  const last = rising[rising.length - 1];
  const priorEmaApprox = last.close - 0.15;
  rising[rising.length - 1] = { ...last, open: priorEmaApprox - 0.1, low: priorEmaApprox - 0.2, close: priorEmaApprox + 0.2, high: priorEmaApprox + 0.25 };
  assert.equal(pullbackConfirmed(rising, "BUY"), true);
  assert.equal(pullbackConfirmed(rising, "SELL"), false);
});

test("all strategies use the same stop and target reward-risk model", () => {
  const history = candles(70);
  const a = makeLevels(100, history, "BUY");
  const b = makeLevels(100, history, "SELL");
  assert.equal(a.riskReward.tp1, 2);
  assert.equal(a.riskReward.tp2, 3);
  assert.ok(a.stopLoss < a.entry && a.tp1 > a.entry && a.tp2 > a.tp1);
  assert.ok(b.stopLoss > b.entry && b.tp1 < b.entry && b.tp2 < b.tp1);
});

test("outcome monitor records TP2 as +3R and a full stop as -1R", () => {
  const base = {
    direction: "BUY", entry: 100, stopLoss: 98, tp1: 104, tp2: 106,
    riskDistance: 2, entryCandleEpoch: 1_700_000_000,
    lastProcessedEpoch: 1_700_000_000, status: "pending",
    tp1Hit: false, tp2Hit: false, maxFavourableR: 0, outcomeCandles: 0
  };
  const target = { ...base };
  updateSignalOutcome(target, [{ epoch: 1_700_000_900, open: 100, high: 107, low: 99, close: 106 }], 1_700_001_000);
  assert.equal(target.status, "tp2_hit");
  assert.equal(target.realizedR, 3);

  const stopped = { ...base };
  updateSignalOutcome(stopped, [{ epoch: 1_700_000_900, open: 100, high: 101, low: 97, close: 98 }], 1_700_001_000);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.realizedR, -1);
});

test("shadow journal evaluates each common candle once and is idempotent", () => {
  const frame = candles(70);
  const market = { marketName: "Volatility 10 Index", timeframes: { M15: frame } };
  const first = updateStrategyJournal(null, { R_10: market }, 1_700_100_000);
  const second = updateStrategyJournal(first, { R_10: market }, 1_700_100_100);
  for (const strategy of STRATEGIES) {
    assert.equal(second.markets.R_10.strategies[strategy.id].barsEvaluated, 6);
    assert.equal(second.markets.R_10.strategies[strategy.id].noSignalBars, 6);
  }
  assert.equal(second.signals.length, 0);
  assert.equal(second.summary.timeframe, "M15");
  assert.equal(second.summary.mode, "shadow_observation_only");
});
