"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { nextBoundary } = require("../scanner_supervisor");

test("nextBoundary aligns to the next five-minute UTC boundary", () => {
  assert.equal(nextBoundary(Date.parse("2026-11-18T18:53:00Z")), Date.parse("2026-11-18T18:55:00Z"));
  assert.equal(nextBoundary(Date.parse("2026-11-18T18:55:00Z")), Date.parse("2026-11-18T19:00:00Z"));
});

test("nextBoundary handles times just before a boundary", () => {
  assert.equal(nextBoundary(Date.parse("2026-11-18T18:54:59.999Z")), Date.parse("2026-11-18T18:55:00Z"));
});

test("nextBoundary accepts a custom interval for deterministic testing", () => {
  assert.equal(nextBoundary(1050, 1000), 2000);
});
