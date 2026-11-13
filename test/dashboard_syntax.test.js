"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const html = fs.readFileSync(require("node:path").join(__dirname, "..", "index.html"), "utf8");

test("dashboard includes the four-horizon controls and journal", () => {
  for (const id of ["multi-timeframe", "mtfCategory", "mtfMarket", "mtfSignals", "mtfJournal"]) {
    assert.ok(html.includes('id="' + id + '"'), "missing dashboard element: " + id);
  }
});

test("dashboard inline JavaScript parses", () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0, "no inline dashboard script found");
  for (const match of scripts) assert.doesNotThrow(() => new Function(match[1]));
});
