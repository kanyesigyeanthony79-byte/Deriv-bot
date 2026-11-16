"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchCandleHistory, fetchLiveQuotes } = require("../multi_timeframe_collector");

function makeCandles(start, count) {
  return Array.from({ length: count }, (_, i) => {
    const open = 100 + (start + i) * 0.001;
    const close = open + 0.01;
    return { epoch: start + i * 60, open, high: close + 0.01, low: open - 0.01, close };
  });
}

test("paginates M1 history beyond the 1,000-candle page size without gaps or duplicates", async () => {
  const requests = [];
  const client = {
    async ask(request) {
      requests.push(request);
      if (requests.length === 1) return { candles: makeCandles(1000 * 60, 1000) };
      if (requests.length === 2) return { candles: makeCandles(200 * 60, 801) };
      throw new Error("Unexpected extra history request");
    }
  };
  const rows = await fetchCandleHistory(client, "R_10", 60, 1800, 200000);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].count, 1000);
  assert.equal(requests[0].end, "latest");
  assert.equal(requests[1].count, 801);
  assert.equal(requests[1].start, 200 * 60);
  assert.equal(requests[1].end, String(1000 * 60));
  assert.equal(rows.length, 1800);
  assert.equal(rows[0].epoch, 200 * 60);
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
