"use strict";

/**
 * Runs the existing signal cycle and the separate execution cycle independently.
 * Neither service's failure cancels or suppresses the other. This is an integration
 * contract only; production entrypoints must explicitly adopt it in a later,
 * separately reviewed change.
 */
async function runIndependentCycles({ signalCycle, executionCycle }) {
  if (typeof signalCycle !== "function" || typeof executionCycle !== "function") {
    throw new TypeError("signalCycle and executionCycle must both be functions");
  }

  const [signal, execution] = await Promise.allSettled([
    Promise.resolve().then(() => signalCycle()),
    Promise.resolve().then(() => executionCycle())
  ]);

  return {
    signal: summarize(signal),
    execution: summarize(execution)
  };
}

function summarize(result) {
  return result.status === "fulfilled"
    ? { status: "fulfilled", value: result.value }
    : {
        status: "rejected",
        error: result.reason instanceof Error ? result.reason.message : String(result.reason)
      };
}

module.exports = { runIndependentCycles };
