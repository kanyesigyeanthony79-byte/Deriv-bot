"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  forwardSignalsNeedingDelivery, dailyStrategyRows, buildDailyStrategyMessage,
  sendStrategyComparisonAlerts
} = require("../strategy_comparison_alerts");

const signal = (overrides = {}) => ({
  signalId: "R_25-EMA20_50-1000", strategyId: "EMA20_50",
  strategyLabel: "EMA20/50 baseline", marketId: "R_25",
  market: "Volatility 25 Index", direction: "BUY",
  entryCandleEpoch: 1000, entry: 100, stopLoss: 90, tp1: 120, tp2: 130,
  status: "pending", evaluationSource: "forward_shadow", ...overrides
});
const env = {
  STRATEGY_COMPARISON_TELEGRAM_ALERTS: "true",
  TELEGRAM_WORKER_URL: "https://worker.example",
  SIGNAL_API_KEY: "test-key"
};
const fakeFetch = async (_url, options) => ({
  ok: true,
  json: async () => ({ success: true, payload: JSON.parse(options.body) })
});

test("only new forward-shadow signals are eligible for Telegram", () => {
  const journal = { signals: [
    signal(),
    signal({ signalId: "backfill", evaluationSource: "historical_backfill" }),
    signal({ signalId: "already-sent", telegramStatus: "sent" })
  ] };
  assert.deepEqual(forwardSignalsNeedingDelivery(journal).map(s => s.signalId), ["R_25-EMA20_50-1000"]);
});

test("sends a labelled shadow alert and records delivery to prevent duplicates", async () => {
  const journal = { signals: [signal()] };
  const result = await sendStrategyComparisonAlerts(journal, 1901, env, { fetchImpl: fakeFetch });
  assert.equal(result.sent, 1);
  assert.equal(journal.signals[0].telegramStatus, "sent");
  assert.match(journal.signals[0].telegramSentAt, /^1970-/);
  const again = await sendStrategyComparisonAlerts(journal, 1902, env, { fetchImpl: fakeFetch });
  assert.equal(again.sent, 0);
});

test("does not send stale shadow signals", async () => {
  const journal = { signals: [signal()] };
  const result = await sendStrategyComparisonAlerts(journal, 3000, env, { fetchImpl: fakeFetch });
  assert.equal(result.stale, 1);
  assert.equal(journal.signals[0].telegramStatus, "stale");
});

test("daily comparison keeps pending and ambiguous outcomes separate", () => {
  const dayEpoch = Math.floor(Date.parse("2026-11-15T12:00:00+03:00") / 1000);
  const journal = { signals: [
    signal({ entryCandleEpoch: dayEpoch, status: "tp2_hit", tp1Hit: true }),
    signal({ signalId: "loss", entryCandleEpoch: dayEpoch, status: "stopped" }),
    signal({ signalId: "open", entryCandleEpoch: dayEpoch, status: "pending" }),
    signal({ signalId: "ambiguous", entryCandleEpoch: dayEpoch, status: "ambiguous" })
  ] };
  const rows = dailyStrategyRows(journal, "2026-11-15");
  const baseline = rows.find(row => row.id === "EMA20_50");
  assert.equal(baseline.generated, 4);
  assert.equal(baseline.wins, 1);
  assert.equal(baseline.losses, 1);
  assert.equal(baseline.pending, 1);
  assert.equal(baseline.ambiguous, 1);
  assert.equal(baseline.tp2Rate, 50);
  const message = buildDailyStrategyMessage(journal, "2026-11-15");
  assert.match(message, /DEMO RESEARCH ONLY/);
  assert.match(message, /Pending: 1/);
});
