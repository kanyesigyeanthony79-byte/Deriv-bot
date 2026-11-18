"use strict";
// Keeps the existing one-shot, signal-only scanner running on an always-on host.
// Runs immediately, then on UTC five-minute boundaries. Never overlaps scans.
const { spawn } = require("node:child_process");

const INTERVAL_MS = 5 * 60 * 1000;
let child = null;
let stopping = false;
let timer = null;

function nextBoundary(now = Date.now(), interval = INTERVAL_MS) {
  return (Math.floor(now / interval) + 1) * interval;
}

function runScan() {
  return new Promise(resolve => {
    if (stopping) return resolve();
    console.log(JSON.stringify({ time: new Date().toISOString(), event: "supervisor_scan_start" }));
    child = spawn(process.execPath, ["hosted_scanner.js"], {
      cwd: __dirname,
      env: process.env,
      stdio: "inherit"
    });
    child.once("error", error => {
      console.error(JSON.stringify({ time: new Date().toISOString(), event: "supervisor_child_error", message: error.message }));
      child = null;
      resolve();
    });
    child.once("close", (code, signal) => {
      console.log(JSON.stringify({
        time: new Date().toISOString(),
        event: "supervisor_scan_exit",
        code,
        signal
      }));
      child = null;
      resolve();
    });
  });
}

function wait(ms) {
  return new Promise(resolve => {
    timer = setTimeout(() => {
      timer = null;
      resolve();
    }, Math.max(0, ms));
  });
}

async function main() {
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    event: "supervisor_started",
    intervalMs: INTERVAL_MS,
    schedule: "immediate_then_UTC_five_minute_boundaries"
  }));
  while (!stopping) {
    await runScan();
    if (stopping) break;
    const next = nextBoundary();
    await wait(next - Date.now());
  }
  console.log(JSON.stringify({ time: new Date().toISOString(), event: "supervisor_stopped" }));
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ time: new Date().toISOString(), event: "supervisor_shutdown", signal }));
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (child && child.exitCode === null) child.kill("SIGTERM");
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = { nextBoundary };
if (require.main === module) {
  main().catch(error => {
    console.error(JSON.stringify({ time: new Date().toISOString(), event: "supervisor_fatal", message: error.message }));
    process.exitCode = 1;
  });
}
