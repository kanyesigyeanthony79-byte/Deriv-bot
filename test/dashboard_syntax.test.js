"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const html = fs.readFileSync(require("node:path").join(__dirname, "..", "index.html"), "utf8");

test("dashboard replaces the retired MTF page with the exclusive R10 paper view", () => {
  for (const id of ["r10Refresh", "r10Status", "r10Metrics", "r10Signals", "r10Positions", "r10Health"]) {
    assert.ok(html.includes('id="' + id + '"'), "missing dashboard element: " + id);
  }
  assert.ok(html.includes("volatility10_ema_atr_slope20_v1"), "R10 provider identity must be visible and validated");
  assert.ok(html.includes("volatility10_paper_journal.json"), "dashboard must read the independent R10 journal");
  assert.ok(html.includes("lastEvaluationReason"), "dashboard must expose scanner decision diagnostics");
  assert.ok(!html.includes('const MTF_URL="./multi_timeframe_dashboard.json"'), "dashboard must not fetch the retired MTF snapshot");
  assert.ok(!html.includes('data-system-view="multi-timeframe"'), "retired MTF dashboard view must remain absent");
  assert.ok(html.includes('data-system-view="r10"'), "R10 must remain directly accessible");
});

test("dashboard inline JavaScript parses", () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0, "no inline dashboard script found");
  for (const match of scripts) assert.doesNotThrow(() => new Function(match[1]));
});

test("promoted production panel loads real state and reports scanner health", () => {
  for (const id of ["promotedMetrics", "promotedStatus", "promotedRefresh", "promotedRefreshTime", "promotedSignals", "activeTabCount", "validTabCount", "strongTabCount"]) {
    assert.ok(html.includes('id="' + id + '"'), "missing promoted panel element: " + id);
  }
  for (const source of ["signal_state.json", "trade_journal.json", "scanner_heartbeat.json"]) {
    assert.ok(html.includes(source), "promoted panel must read " + source);
  }
  assert.ok(html.includes("async function refreshPromotedSystem()"), "promoted panel refresh function must exist");
  assert.ok(html.includes("setInterval(refreshPromotedSystem, 60000)"), "promoted panel must auto-refresh");
  assert.ok(html.includes("setPromotedSignalFilter"), "promoted signal filters must be wired");
  assert.ok(html.includes("PROMOTED_FRESH_SECONDS"), "stale active quotes must be excluded");
});

test("promoted production panel loads real state and reports scanner health", () => {
  for (const id of ["promotedMetrics", "promotedStatus", "promotedRefresh", "promotedRefreshTime", "promotedSignals", "activeTabCount", "validTabCount", "strongTabCount"]) {
    assert.ok(html.includes('id="' + id + '"'), "missing promoted panel element: " + id);
  }
  for (const source of ["signal_state.json", "trade_journal.json", "scanner_heartbeat.json"]) {
    assert.ok(html.includes(source), "promoted panel must read " + source);
  }
  assert.ok(html.includes("function refreshPromotedSystem()"), "promoted panel refresh function must exist");
  assert.ok(html.includes("setInterval(refreshPromotedSystem, 60000)"), "promoted panel must auto-refresh");
  assert.ok(html.includes("setPromotedSignalFilter"), "promoted signal filters must be wired");
  assert.ok(html.includes("PRICE CHECK STALE"), "stale quotes must be visibly distinguished");
});
