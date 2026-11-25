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

test("100-signal collection includes all shared research markets in an 18-market target", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "signal-collection.html"), "utf8");
  const script = html.slice(html.indexOf("<script>"));
  assert.match(script, /\["1HZ10V","Volatility 10 \(1s\) Index"\]/);
  assert.match(script, /\["1HZ75V","Volatility 75 \(1s\) Index"\]/);
  assert.match(script, /\["JD75","Jump 75 Index"\]/);
  const { MARKETS } = require("../research_shadow_telegram_collector");
  for (const [id] of MARKETS) assert.ok(script.includes('["'+id+'"'), "collection register missing "+id);
  assert.match(script, /const COLLECTION_TARGET=MARKETS\.length\*100/);
  assert.match(script, /completed\+" \/ "\+MARKETS\.length/);
  assert.match(html, /18 markets × 100 signals/);
});
