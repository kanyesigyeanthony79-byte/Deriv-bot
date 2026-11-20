"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { MARKETS, resolveSymbol, fetchCandleHistory, fetchLiveQuotes, fetchMt5TradeLedger, summarizeMt5TradeLedger } = require("../multi_timeframe_collector");

function makeCandles(start, count) {
  return Array.from({ length: count }, (_, i) => {
    const open = 100 + (start + i) * 0.001;
    const close = open + 0.01;
    return { epoch: start + i * 60, open, high: close + 0.01, low: open - 0.01, close };
  });
}

test("includes Deriv Gold/USD (frxXAUUSD) in the observation-only market scanner", () => {
  assert.ok(MARKETS.some(([id]) => id === "frxXAUUSD"));
  assert.equal(resolveSymbol([
    { underlying_symbol: "frxXAUUSD", underlying_symbol_name: "Gold/USD" }
  ], "frxXAUUSD", "Gold (XAUUSD)"), "frxXAUUSD");
});

test("includes Deriv Jump 75 (JD75) in the observation-only market scanner", () => {
  assert.ok(MARKETS.some(([id, name]) => id === "JD75" && name === "Jump 75 Index"));
  assert.equal(resolveSymbol([
    { underlying_symbol: "JD75", underlying_symbol_name: "Jump 75 Index" }
  ], "JD75", "Jump 75 Index"), "JD75");
});

test("paginates M1 history beyond the 1,000-candle page size without gaps or duplicates", async () => {
  const requests = [];
  const client = {
    async ask(request) {
      requests.push(request);
      if (requests.length === 1) return { candles: makeCandles(1000 * 60, 999) };
      if (requests.length === 2) return { candles: makeCandles(199 * 60, 802) };
      throw new Error("Unexpected extra history request");
    }
  };
  const rows = await fetchCandleHistory(client, "R_10", 60, 1800, 200000);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].count, 1000);
  assert.equal(requests[0].end, "latest");
  assert.equal(requests[1].count, 802);
  assert.equal(requests[1].start, 199 * 60);
  assert.equal(requests[1].end, String(1000 * 60));
  assert.equal(rows.length, 1800);
  assert.equal(rows[0].epoch, 199 * 60);
  assert.equal(rows.at(-1).epoch, 119940);
  assert.equal(new Set(rows.map(c => c.epoch)).size, 1800);
  assert.ok(rows.slice(1).every((c, i) => c.epoch - rows[i].epoch === 60));
});

test("stops paging when the API returns no earlier candles", async () => {
  let calls = 0;
  const client = { async ask() { calls++; return { candles: calls === 1 ? makeCandles(1000 * 60, 1000) : [] }; } };
  const rows = await fetchCandleHistory(client, "R_10", 60, 1800, 200000);
  assert.equal(calls, 2);
  assert.equal(rows.length, 1000);
});

test("fetches one-shot live Deriv quotes without opening tick subscriptions", async () => {
  const requests=[];
  const client={async ask(request){requests.push(request);return {tick:{quote:123.45,epoch:4567}};}};
  const quotes=await fetchLiveQuotes(client,{R_50:{symbol:"R_50"}});
  assert.deepEqual(requests,[{ticks:"R_50"}]);
  assert.equal(quotes.R_50.price,123.45);
  assert.equal(quotes.R_50.epoch,4567);
});

test("MT5 trade ledger stays disabled unless explicitly enabled", async () => {
  let called = false;
  const result = await fetchMt5TradeLedger({}, () => {}, async () => { called = true; });
  assert.equal(called, false);
  assert.equal(result.enabled, false);
  assert.equal(result.connected, false);
});

test("fetches broker-confirmed MT5 trade records through the authenticated Worker route", async () => {
  let request;
  const trade = { signalId: "R_50-SCALP-123", status: "TP1_HIT_RUNNER_OPEN", closedEntries: 2, openEntries: 1, tp1Complete: true, allClosed: false, realizedProfit: 4.25 };
  const result = await fetchMt5TradeLedger({
    MT5_TRADE_REPORTING_ENABLED: "true",
    TELEGRAM_WORKER_URL: "https://worker.example/",
    SIGNAL_API_KEY: "test-key"
  }, () => {}, async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ success: true, trades: [trade] }) };
  });
  assert.equal(request.url, "https://worker.example/mt5/trades");
  assert.equal(request.options.headers["X-API-Key"], "test-key");
  assert.equal(result.connected, true);
  assert.deepEqual(result.trades, [trade]);
});

test("summarizes actual MT5 basket states and realized net profit separately", () => {
  const summary = summarizeMt5TradeLedger({ enabled: true, connected: true, trades: [
    { status: "TP1_HIT_RUNNER_OPEN", closedEntries: 2, openEntries: 1, tp1Complete: true, allClosed: false, realizedProfit: 4.25 },
    { status: "CLOSED_TP2", closedEntries: 3, openEntries: 0, tp1Complete: true, allClosed: true, realizedProfit: 8.75 },
    { status: "SL_HIT", closedEntries: 3, openEntries: 0, tp1Complete: false, allClosed: true, realizedProfit: -15.10 }
  ] });
  assert.equal(summary.tradeBaskets, 3);
  assert.equal(summary.openBaskets, 1);
  assert.equal(summary.closedBaskets, 2);
  assert.equal(summary.tp1Confirmed, 2);
  assert.equal(summary.realizedNetProfit, -2.10);
});
