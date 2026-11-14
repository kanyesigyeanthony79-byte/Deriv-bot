"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchCandleHistory } = require("../top_down_swing_backfill");

test("historical candle fetch pages backwards until requested coverage is reached", async () => {
  const calls = [];
  const page = epochs => epochs.map((epoch, i) => ({
    epoch, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i
  }));
  const client = { async ask(request) {
    calls.push(request);
    if (request.end === "latest") return { candles: page([600, 900]) };
    if (request.end === "599") return { candles: page([0, 300]) };
    return { candles: [] };
  }};
  const result = await fetchCandleHistory(client, "R_25", 300, 4, 10000, 2);
  assert.deepEqual(result.map(c => c.epoch), [0, 300, 600, 900]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].end, "599");
});

test("history fetch stops safely when the API returns no older candles", async () => {
  let calls = 0;
  const client = { async ask() {
    calls++;
    return { candles: calls === 1 ? [
      {epoch:600,open:100,high:101,low:99,close:100},
      {epoch:900,open:100,high:101,low:99,close:100}
    ] : [] };
  }};
  const result = await fetchCandleHistory(client, "R_25", 300, 5, 10000, 2);
  assert.equal(result.length, 2);
  assert.equal(calls, 2);
});
