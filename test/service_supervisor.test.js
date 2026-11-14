"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runIndependentCycles } = require("../service_supervisor");

test("signal cycle still runs and succeeds when execution is offline", async () => {
  let signalCalls = 0;
  const result = await runIndependentCycles({
    signalCycle: async () => { signalCalls += 1; return { alertsDelivered: 2 }; },
    executionCycle: async () => { throw new Error("demo connection unavailable"); }
  });
  assert.equal(signalCalls, 1);
  assert.deepEqual(result.signal, { status: "fulfilled", value: { alertsDelivered: 2 } });
  assert.deepEqual(result.execution, { status: "rejected", error: "demo connection unavailable" });
});

test("execution cycle still runs when signal delivery fails", async () => {
  let executionCalls = 0;
  const result = await runIndependentCycles({
    signalCycle: async () => { throw new Error("Telegram unavailable"); },
    executionCycle: async () => { executionCalls += 1; return { positionsManaged: 1 }; }
  });
  assert.equal(executionCalls, 1);
  assert.deepEqual(result.signal, { status: "rejected", error: "Telegram unavailable" });
  assert.deepEqual(result.execution, { status: "fulfilled", value: { positionsManaged: 1 } });
});

test("both cycles are started even if one rejects immediately", async () => {
  const started = [];
  await runIndependentCycles({
    signalCycle: async () => { started.push("signals"); throw new Error("signal failure"); },
    executionCycle: async () => { started.push("execution"); return "ok"; }
  });
  assert.deepEqual(started.sort(), ["execution", "signals"]);
});

test("invalid cycle configuration fails closed", async () => {
  await assert.rejects(
    runIndependentCycles({ signalCycle: async () => true }),
    /must both be functions/
  );
});
