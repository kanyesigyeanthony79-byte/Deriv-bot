"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { priorityForMarket } = require("../priority_pairs");

test("R_50 is tagged as a research-priority pair with transparent metric context", () => {
  const priority = priorityForMarket("R_50");
  assert.equal(priority.tier, "RESEARCH_PRIORITY");
  assert.equal(priority.metricPct, 62.9);
  assert.equal(priority.metricName, "historical directional follow-through");
  assert.equal(priority.sampleBars, 1080);
  assert.match(priority.label, /PRIORITY PAIR/);
});

test("markets without greater-than-60 directional follow-through are not priority tagged", () => {
  for (const market of ["R_10", "R_25", "R_75", "JD100", "CRASH500", "BOOM500", "frxXAUUSD", "unknown"]) {
    assert.equal(priorityForMarket(market), null);
  }
});
