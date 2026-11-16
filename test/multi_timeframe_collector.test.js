"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchCandleHistory } = require("../multi_timeframe_collector");

function makeCandles(start, count) {
  return Array.from({ length: count }, (_, i) => {
    const open = 100 + (start + i) * 0.001;
    const close = open + 0.01;
    return { epoch: start + i, open, high: close + 0.01, low: open - 0.01, close };
  });
}

test("paginates M1 history beyond the 1,000-candle page size without gaps or duplicates", async () => {
  const requests = [];
  const client = {
    async ask(request) {
      requests.push(request);
      if (requests.length === 1) return { candles: makeCandles(1000, 1000) };
      if (requests.length === 2) return { candles: makeCandles(200, 800) };
      throw new Error("Unexpected extra history request");
    }
  };
  const rows = await fetchCandleHistory(client, "R_10", 60, 1800, 5000);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].count, 1000);
  assert.equal(requests[0].end, "latest");
  assert.equal(requests[1].count, 800);
  assert.equal(requests[1].end, "999");
  assert.equal(rows.length, 1800);
  assert.equal(rows[0].epoch, 200);
  assert.equal(rows.at(-1).epoch, 1999);
  assert.equal(new Set(rows.map(c => c.epoch)).size, 1800);
  assert.ok(rows.slice(1).every((c, i) => c.epoch - rows[i].epoch === 1));
});

test("stops paging when the API returns no earlier candles", async () => {
  let calls = 0;
  const client = { async ask() { calls++; return { candles: makeCandles(1000, 1000) }; } };
  const rows = await fetchCandleHistory(client, "R_10", 60, 1800, 5000);
  assert.equal(calls, 2);
  assert.equal(rows.length, 1000);
});
