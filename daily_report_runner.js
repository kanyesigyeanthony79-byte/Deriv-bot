"use strict";

// Independent scheduled delivery for the previous Uganda calendar day's report.
// This runner does not connect to the market scanner or request market data.
const fs = require("node:fs");
const path = require("node:path");
const { dailySummary, deliverDailyReport, previousUgandaDay } = require("./daily_summary");
const { createDerivDemoReadOnlySnapshot } = require("./scripts/demo_readonly_account_snapshot");

const ROOT = __dirname;
const JOURNAL_FILE = path.join(ROOT, "trade_journal.json");
const MTF_FILE = path.join(ROOT, "multi_timeframe_journal.json");
const MARKETS = [
  ["R_10", "Volatility 10 Index"],
  ["R_25", "Volatility 25 Index"],
  ["R_50", "Volatility 50 Index"],
  ["R_75", "Volatility 75 Index"],
  ["JD100", "Jump 100 Index"],
  ["frxXAUUSD", "Gold/USD"],
  ["CRASH500", "Crash 500 Index"],
  ["BOOM500", "Boom 500 Index"]
];

const log = (event, details = {}) => console.log(JSON.stringify({
  time: new Date().toISOString(), event, ...details
}));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

async function postTelegram(payload) {
  const workerUrl = process.env.TELEGRAM_WORKER_URL;
  const apiKey = process.env.SIGNAL_API_KEY;
  if (!workerUrl || !apiKey) throw new Error("telegram_worker_secrets_missing");
  const url = new URL(workerUrl);
  if (url.protocol !== "https:") throw new Error("telegram_worker_url_must_use_https");

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success !== true) {
    throw new Error(result.error || ("telegram_worker_http_" + response.status));
  }
  return result;
}

async function readDemoSnapshot() {
  if (!process.env.DERIV_TOKEN || !process.env.DERIV_ACCOUNT_ID) {
    return { status: "not_configured" };
  }
  try {
    const snapshot = await createDerivDemoReadOnlySnapshot({
      token: process.env.DERIV_TOKEN,
      accountId: process.env.DERIV_ACCOUNT_ID,
      appId: process.env.DERIV_APP_ID
    });
    return { status: "ok", ...snapshot };
  } catch (error) {
    log("demo_account_snapshot_failed", {
      reason: String(error.message || "read_only_snapshot_failed").slice(0, 100)
    });
    return { status: "unavailable" };
  }
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Kampala", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(new Date(now * 1000));
  const [hour, minute] = clock.split(":").map(Number);
  if (hour * 60 + minute < 15) {
    log("daily_report_not_due", { ugandaTime: clock });
    return;
  }

  const journal = readJson(JOURNAL_FILE, { version: 1, signals: [], dailyReports: {} });
  if (!Array.isArray(journal.signals)) journal.signals = [];
  if (!journal.dailyReports || typeof journal.dailyReports !== "object") journal.dailyReports = {};

  const reportDay = previousUgandaDay(now);
  if (journal.dailyReports[reportDay]?.delivered === true) {
    log("daily_report_already_delivered", { day: reportDay });
    return;
  }

  const mtfJournal = readJson(MTF_FILE, { signals: [] });
  const mtfSignals = Array.isArray(mtfJournal.signals) ? mtfJournal.signals : [];
  const summary = dailySummary(journal.signals, reportDay, MARKETS, mtfSignals);
  const accountSnapshot = await readDemoSnapshot();

  try {
    const delivery = await deliverDailyReport(summary, accountSnapshot, postTelegram);
    journal.dailyReports[reportDay] = {
      attemptedAt: new Date(now * 1000).toISOString(),
      delivered: true,
      telegramConfirmed: true,
      stats: summary,
      accountSnapshot: accountSnapshot.status === "ok" ? {
        status: "ok", mode: accountSnapshot.mode, accountId: accountSnapshot.accountId,
        currency: accountSnapshot.currency, balance: accountSnapshot.balance,
        equityEstimate: accountSnapshot.equityEstimate,
        openContracts: accountSnapshot.openPositions.length,
        fetchedAt: accountSnapshot.fetchedAt,
        ordersPlaced: 0
      } : { status: accountSnapshot.status }
    };
    fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2) + "\n");
    log("daily_report_delivered", {
      day: reportDay, generated: summary.generated, sent: summary.sent,
      wins: summary.wins, losses: summary.losses, winRate: summary.winRate,
      telegramConfirmed: delivery.delivered === true,
      accountSnapshotStatus: accountSnapshot.status
    });
  } catch (error) {
    log("daily_report_delivery_failed", {
      day: reportDay, reason: String(error.message || "delivery_failed").slice(0, 160),
      retry: "The next scheduled run will retry because no delivered marker was written."
    });
    throw error;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error("DAILY REPORT RUN FAILED: " + String(error.message || "unknown_error"));
    process.exitCode = 1;
  });
}

module.exports = { readJson, postTelegram, readDemoSnapshot, main };
