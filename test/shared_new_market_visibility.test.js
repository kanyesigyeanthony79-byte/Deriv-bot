"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MARKETS } = require("../research_shadow_telegram_collector");

test("1-second indices are members of the shared research collector", () => {
  const ids = new Set(MARKETS.map(([id]) => id));
  assert.ok(ids.has("1HZ10V"));
  assert.ok(ids.has("1HZ75V"));
});

test("New Markets dashboard exposes both 1-second indices", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const section = html.slice(html.indexOf('id="new-markets-system"'));
  assert.match(section, /\["1HZ10V","Volatility 10 \(1s\) Index"\]/);
  assert.match(section, /\["1HZ75V","Volatility 75 \(1s\) Index"\]/);
  assert.match(section, /\["MARKETS IN THIS TAB",String\(ids\.length\)\]/);
});
