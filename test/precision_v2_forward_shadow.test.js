"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { updatePrecisionV2ForwardShadowJournal } = require("../precision_v2_forward_shadow");

function signal(id, createdEpoch, status = "pending", swingAtr = 0.8, emaSlopeAtr = 0.5) {
  return { signalId:id, marketId:"R_10", category:"SCALP", direction:"BUY", createdEpoch,
    entryCandleEpoch:createdEpoch, entry:100, stopLoss:99, tp1:101, tp2:102, status,
    metrics:{entry:{swingAtr,emaSlopeAtr},confirmation:{direction:"BUY"},context:{direction:"BUY"}} };
}
test("forward shadow excludes pre-start records and records filter admission", () => {
  const journal = updatePrecisionV2ForwardShadowJournal(null,
    {signals:[signal("old", 99), signal("new-pass", 101), signal("new-fail", 102, "pending", 0.2, 0.1)]}, 100);
  assert.deepEqual(journal.observations.map(x=>x.signalId), ["new-pass", "new-fail"]);
  assert.equal(journal.summary.variants.baseline.admitted, 2);
  assert.equal(journal.summary.variants.swingStructureOnly.admitted, 1);
  assert.equal(journal.summary.variants.trendSlopeOnly.admitted, 1);
});
test("forward shadow updates outcomes from the same baseline signal", () => {
  let journal = updatePrecisionV2ForwardShadowJournal(null,
    {signals:[signal("s1", 101)]}, 100);
  journal = updatePrecisionV2ForwardShadowJournal(journal,
    {signals:[signal("s1", 101, "tp2_hit")]}, 110);
  assert.equal(journal.summary.variants.baseline.tp2, 1);
  assert.equal(journal.summary.variants.swingStructureOnly.tp2, 1);
  assert.equal(journal.summary.variants.trendSlopeOnly.tp2, 1);
});
