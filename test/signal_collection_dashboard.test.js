"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const html = fs.readFileSync(path.join(__dirname, "..", "signal-collection.html"), "utf8");

test("100-signal collection covers all 18 markets including the 1-second indices", () => {
  for (const id of ["R_10", "JD75", "1HZ10V", "1HZ75V"]) assert.ok(html.includes('["' + id + '"'), "missing market " + id);
  assert.ok(html.includes("const COLLECTION_TARGET=MARKETS.length*100"));
});

test("collection page tolerates an empty or unavailable optional journal without hiding other sources", () => {
  assert.ok(html.includes('if(!raw.trim())throw new Error("file is empty")'));
  assert.ok(html.includes('return {label,kind,signals:[],error:url+" · "+error.message}'));
  assert.ok(html.includes("PARTIAL DATA:"));
  assert.ok(html.includes("deliveryError"));
});

test("collection page inline JavaScript parses", () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0, "no inline collection script found");
  for (const match of scripts) assert.doesNotThrow(() => new Function(match[1]));
});
