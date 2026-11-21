"use strict";

const fs = require("node:fs");
const path = require("node:path");

let runSequence = 0;

function createHeartbeat({ filePath, markets, now = () => new Date() }) {
  if (!filePath) throw new Error("heartbeat filePath is required");
  const startedAt = now().toISOString();
  const record = {
    schemaVersion: 1,
    runId: startedAt + "#" + (++runSequence),
    status: "running",
    startedAt,
    completedAt: null,
    durationMs: null,
    marketsExpected: markets.length,
    marketsAttempted: 0,
    marketsSucceeded: 0,
    marketsFailed: 0,
    marketsUnavailable: 0,
    signalsDetected: 0,
    telegram: { signalsDelivered: 0, signalsFailed: 0, outcomesDelivered: 0, outcomesFailed: 0, lastError: null },
    marketResults: []
  };

  function persist() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let history = [];
    try {
      const previous = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (Array.isArray(previous.history)) history = previous.history;
    } catch {}
    const snapshot = { ...record, telegram: { ...record.telegram }, marketResults: [...record.marketResults] };
    const historyEntry = { runId: snapshot.runId, status: snapshot.status, startedAt: snapshot.startedAt,
      completedAt: snapshot.completedAt, marketsExpected: snapshot.marketsExpected,
      marketsAttempted: snapshot.marketsAttempted, marketsSucceeded: snapshot.marketsSucceeded,
      marketsFailed: snapshot.marketsFailed, marketsUnavailable: snapshot.marketsUnavailable,
      signalsDetected: snapshot.signalsDetected, telegram: snapshot.telegram };
    const output = JSON.stringify({ ...snapshot, history: [...history.filter(x => x.runId !== record.runId), historyEntry].slice(-50) }, null, 2) + "\n";
    const tempPath = filePath + ".tmp";
    fs.writeFileSync(tempPath, output);
    fs.renameSync(tempPath, filePath);
  }

  function market(name, status, details = {}) {
    const previous = record.marketResults.find(x => x.market === name);
    if (!previous) record.marketsAttempted++;
    if (previous) {
      if (previous.status === "success") record.marketsSucceeded--;
      if (previous.status === "error") record.marketsFailed--;
      if (previous.status === "unavailable") record.marketsUnavailable--;
      Object.assign(previous, { status, ...details, updatedAt: now().toISOString() });
    } else {
      record.marketResults.push({ market: name, status, ...details, updatedAt: now().toISOString() });
    }
    if (status === "success") record.marketsSucceeded++;
    if (status === "error") record.marketsFailed++;
    if (status === "unavailable") record.marketsUnavailable++;
    persist();
  }

  function signalDetected() { record.signalsDetected++; persist(); }
  function telegram(kind, success, details = {}) {
    const key = kind === "new_signal"
      ? (success ? "signalsDelivered" : "signalsFailed")
      : (success ? "outcomesDelivered" : "outcomesFailed");
    record.telegram[key]++;
    if (!success && details.error) {
      record.telegram.lastError = {
        event: kind,
        message: String(details.error).slice(0, 400),
        at: now().toISOString()
      };
    }
    persist();
  }
  function finish(status = "success", error = null) {
    record.status = status;
    record.completedAt = now().toISOString();
    record.durationMs = Math.max(0, Date.parse(record.completedAt) - Date.parse(record.startedAt));
    if (error) record.error = String(error.message || error).slice(0, 240);
    persist();
    return { ...record, telegram: { ...record.telegram }, marketResults: [...record.marketResults] };
  }

  persist();
  return { record, market, signalDetected, telegram, finish };
}

module.exports = { createHeartbeat };
