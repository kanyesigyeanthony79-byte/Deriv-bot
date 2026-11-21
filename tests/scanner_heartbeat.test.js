"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHeartbeat } = require("../scanner_heartbeat");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deriv-heartbeat-"));
  return { dir, filePath: path.join(dir, "scanner_heartbeat.json") };
}

test("persists a successful scan with per-market and Telegram counters", () => {
  const f = fixture();
  let t = Date.parse("2026-11-18T18:00:00.000Z");
  const heartbeat = createHeartbeat({
    filePath: f.filePath, markets: ["Gold", "Jump 100"],
    now: () => new Date(t += 1000)
  });
  heartbeat.market("Gold", "success", { candles: 200 });
  heartbeat.signalDetected();
  heartbeat.telegram("new_signal", true);
  heartbeat.market("Jump 100", "success", { candles: 200 });
  const result = heartbeat.finish("success");
  const saved = JSON.parse(fs.readFileSync(f.filePath, "utf8"));
  assert.equal(result.status, "success");
  assert.equal(saved.marketsExpected, 2);
  assert.equal(saved.marketsAttempted, 2);
  assert.equal(saved.marketsSucceeded, 2);
  assert.equal(saved.signalsDetected, 1);
  assert.equal(saved.telegram.signalsDelivered, 1);
  assert.equal(saved.history.length, 1);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("records partial market failures and unavailable symbols separately", () => {
  const f = fixture();
  const heartbeat = createHeartbeat({ filePath: f.filePath, markets: ["A", "B", "C"] });
  heartbeat.market("A", "success");
  heartbeat.market("B", "error", { error: "feed timeout" });
  heartbeat.market("C", "unavailable");
  const saved = heartbeat.finish("partial");
  assert.equal(saved.marketsSucceeded, 1);
  assert.equal(saved.marketsFailed, 1);
  assert.equal(saved.marketsUnavailable, 1);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("records a fatal scanner failure and bounds persisted history to 50 runs", () => {
  const f = fixture();
  for (let i = 0; i < 52; i++) {
    const heartbeat = createHeartbeat({ filePath: f.filePath, markets: [] });
    heartbeat.finish("failed", new Error("connection failed"));
  }
  const saved = JSON.parse(fs.readFileSync(f.filePath, "utf8"));
  assert.equal(saved.status, "failed");
  assert.equal(saved.error, "connection failed");
  assert.equal(saved.history.length, 50);
  assert.equal(fs.existsSync(f.filePath + ".tmp"), false);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("keeps Telegram delivery failures separate from successful market scans and preserves rejection details", () => {
  const f = fixture();
  const heartbeat = createHeartbeat({ filePath: f.filePath, markets: ["Volatility 10"] });
  heartbeat.market("Volatility 10", "success", { candles: 199, signalFound: true });
  heartbeat.telegram("new_signal", false, { error: "Telegram delivery failed — Telegram HTTP 403: bot is not a member of the channel" });
  const result = heartbeat.finish("success");
  assert.equal(result.marketsSucceeded, 1);
  assert.equal(result.marketsFailed, 0);
  assert.equal(result.telegram.signalsFailed, 1);
  assert.match(result.telegram.lastError.message, /403/);
  const saved = JSON.parse(fs.readFileSync(f.filePath, "utf8"));
  assert.match(saved.history[0].telegram.lastError.message, /not a member/);
  fs.rmSync(f.dir, { recursive: true, force: true });
});
