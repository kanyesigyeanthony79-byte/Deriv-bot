"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { latestCandidates, sendCandidateAlerts, ALERT_MAX_AGE_SECONDS } = require("../multi_timeframe_alerts");

function candidate(overrides = {}) {
  return {
    state: "signal", signalId: "R_50-SCALP-1000", marketId: "R_50", market: "Volatility 50 Index",
    category: "SCALP", categoryLabel: "Scalping", direction: "BUY",
    entryCandleEpoch: 1000, entry: 100, stopLoss: 98, tp1: 102, tp2: 103,
    ...overrides
  };
}
function fixture(candidates) {
  return {
    markets: { R_50: { signals: [], recentSignals: candidates } },
    journal: { version: 1, signals: candidates.map(s => ({ ...s, telegramStatus: null })) }
  };
}

test("latestCandidates keeps only the newest candidate per market and horizon", () => {
  const older = candidate({ signalId: "old", entryCandleEpoch: 900 });
  const newer = candidate({ signalId: "new", entryCandleEpoch: 1000 });
  const swing = candidate({ signalId: "swing", category: "SWING" });
  const found = latestCandidates({ R_50: { signals: [older], recentSignals: [newer, swing] } });
  assert.deepEqual(found.map(s => s.signalId).sort(), ["new", "swing"]);
});

test("feature flag off never calls Telegram", async () => {
  const { markets, journal } = fixture([candidate()]);
  let calls = 0;
  const result = await sendCandidateAlerts(markets, journal, 1010, {}, { fetchImpl: async () => { calls++; } });
  assert.equal(result.enabled, false);
  assert.equal(calls, 0);
});

test("recent candidate is sent once with its horizon in the market label", async () => {
  const { markets, journal } = fixture([candidate()]);
  const requests = [];
  const options = { fetchImpl: async (url, init) => {
    requests.push({ url, payload: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ success: true }) };
  }};
  const env = { MTF_TELEGRAM_ALERTS: "true", TELEGRAM_WORKER_URL: "https://worker.example", SIGNAL_API_KEY: "secret" };
  const first = await sendCandidateAlerts(markets, journal, 1010, env, options);
  const second = await sendCandidateAlerts(markets, journal, 1010, env, options);
  assert.equal(first.sent, 1);
  assert.equal(second.skipped, 1);
  assert.equal(requests.length, 1);
  assert.match(requests[0].payload.market, /Scalping/);
  assert.equal(requests[0].payload.event, "new_signal");
});

test("candidate outside the alert age window is not sent", async () => {
  const old = candidate({ entryCandleEpoch: 1000 });
  const { markets, journal } = fixture([old]);
  let calls = 0;
  const env = { MTF_TELEGRAM_ALERTS: "true", TELEGRAM_WORKER_URL: "https://worker.example", SIGNAL_API_KEY: "secret" };
  const result = await sendCandidateAlerts(markets, journal, 1000 + ALERT_MAX_AGE_SECONDS.SCALP + 1, env, {
    fetchImpl: async () => { calls++; }
  });
  assert.equal(result.stale, 1);
  assert.equal(calls, 0);
  assert.equal(journal.signals[0].telegramStatus, "stale");
});

test("uncertain delivery failure is recorded and not retried automatically", async () => {
  const { markets, journal } = fixture([candidate()]);
  let calls = 0;
  const env = { MTF_TELEGRAM_ALERTS: "true", TELEGRAM_WORKER_URL: "https://worker.example", SIGNAL_API_KEY: "secret" };
  const options = { fetchImpl: async () => { calls++; throw new Error("network timeout"); } };
  const first = await sendCandidateAlerts(markets, journal, 1010, env, options);
  const second = await sendCandidateAlerts(markets, journal, 1010, env, options);
  assert.equal(first.failed, 1);
  assert.equal(second.skipped, 1);
  assert.equal(calls, 1);
});
