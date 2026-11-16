"use strict";
// Multi-timeframe collector and optional signal-only Telegram alert router.
// The MTF_TELEGRAM_ALERTS feature flag controls alert delivery; no order execution.
const fs = require("node:fs");
const path = require("node:path");
const { aggregateWeeklyCandles, validCandles, evaluateAllCategories, evaluateRecentSignals } = require("./multi_timeframe_engine");
const { updateJournal, summarizeJournal, dashboardSignalsForMarket } = require("./multi_timeframe_journal");
const { sendCandidateAlerts } = require("./multi_timeframe_alerts");
const { reviewSignal } = require("./signal_review");
const { updateStrategyJournal, summarizeStrategyJournal } = require("./strategy_comparison");
const { sendStrategyComparisonAlerts, sendDailyStrategyComparisonReport } = require("./strategy_comparison_alerts");
const { mergeCandleArchive, researchArchive } = require("./strategy_optimizer");

const PUBLIC = "wss://api.derivws.com/trading/v1/options/ws/public";
const MARKETS = [
  ["R_10", "Volatility 10 Index"], ["R_25", "Volatility 25 Index"],
  ["R_50", "Volatility 50 Index"], ["R_75", "Volatility 75 Index"],
  ["JD100", "Jump 100 Index"], ["frxXAUUSD", "Gold/USD"],
  ["CRASH500", "Crash 500 Index"], ["BOOM500", "Boom 500 Index"]
];
const FRAMES = [
  ["M1", 60, 1800], ["M5", 300, 240], ["M15", 900, 1000],
  ["H1", 3600, 240], ["H4", 14400, 240], ["D1", 86400, 520]
];
const OUTPUT = path.join(__dirname, "multi_timeframe_data.json");
const JOURNAL = path.join(__dirname, "multi_timeframe_journal.json");
const DASHBOARD = path.join(__dirname, "multi_timeframe_dashboard.json");
const REVIEW_DATA = path.join(__dirname, "signal_review_data.json");
const log = (event, details = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("Connection timed out")); }, 15000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      let nextId = 0;
      const pending = new Map();
      ws.addEventListener("message", ev => {
        let data;
        try { data = JSON.parse(String(ev.data)); } catch { return; }
        const entry = pending.get(data.req_id);
        if (!entry) return;
        pending.delete(data.req_id);
        clearTimeout(entry.timer);
        if (data.error) entry.reject(new Error(data.error.message || "Deriv API error"));
        else entry.resolve(data);
      });
      ws.addEventListener("close", () => {
        for (const [id, entry] of pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error("WebSocket closed before response"));
          pending.delete(id);
        }
      });
      resolve({
        ask(payload, timeoutMs = 25000) {
          return new Promise((res, rej) => {
            const id = ++nextId;
            const timer = setTimeout(() => { pending.delete(id); rej(new Error("Request timed out")); }, timeoutMs);
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ ...payload, req_id: id }));
          });
        },
        close() { try { ws.close(); } catch {} }
      });
    });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket connection error")); }, { once: true });
  });
}

async function fetchCandleHistory(client, symbol, granularity, count, now) {
  const byEpoch = new Map();
  let end = "latest";
  let remaining = Math.max(0, Number(count) || 0);
  const maxPages = Math.ceil(remaining / 1000);
  for (let page = 0; page < maxPages && remaining > 0; page++) {
    const requested = Math.min(1000, remaining);
    const pageRequest = {
      ticks_history: symbol, adjust_start_time: 1,
      count: page === 0 ? requested : requested + 1,
      end, granularity, style: "candles"
    };
    if (page > 0) pageRequest.start = Math.max(0, Number(end) - requested * granularity);
    const reply = await client.ask(pageRequest);
    const rows = normalizeCandles(reply.candles, granularity, now);
    if (!rows.length) break;
    for (const candle of rows) byEpoch.set(candle.epoch, candle);
    const earliest = rows[0].epoch;
    end = String(earliest);
    remaining = Math.max(0, count - byEpoch.size);
    if (rows.length < requested) break;
  }
  return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch).slice(-count);
}

const normalize = value => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
function resolveSymbol(list, fallback, name) {
  const exactName = list.find(x => normalize(x.underlying_symbol_name || x.display_name) === normalize(name));
  const exactCode = list.find(x => (x.underlying_symbol || x.symbol) === fallback);
  const found = exactName || exactCode;
  return found ? (found.underlying_symbol || found.symbol) : null;
}
function normalizeCandles(raw, granularity, now) {
  const candles = (raw || [])
    .map(c => ({ epoch: Number(c.epoch), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }))
    .filter(c => [c.epoch, c.open, c.high, c.low, c.close].every(Number.isFinite))
    .sort((a, b) => a.epoch - b.epoch)
    .filter(c => c.epoch + granularity <= now);
  return validCandles(candles) ? candles : [];
}

async function fetchLiveQuotes(client, markets, logFn = log) {
  const quotes = {};
  for (const [marketId, market] of Object.entries(markets || {})) {
    if (!market.symbol) continue;
    try {
      const reply = await client.ask({ ticks: market.symbol, subscribe: 0 }, 10000);
      const tick = reply.tick || {};
      const price = Number(tick.quote);
      if (Number.isFinite(price)) quotes[marketId] = { price, epoch: Number(tick.epoch) || null, symbol: market.symbol };
      else logFn("live_quote_invalid", { marketId, symbol: market.symbol });
    } catch (error) {
      logFn("live_quote_failed", { marketId, symbol: market.symbol, message: error.message });
    }
  }
  return quotes;
}
\nasync function main() {
  const client = await connect(PUBLIC);
  try {
    const timeReply = await client.ask({ time: 1 });
    const now = Number(timeReply.time) || Math.floor(Date.now() / 1000);
    let symbolsReply = await client.ask({ active_symbols: "brief" });
    let symbols = symbolsReply.active_symbols || [];
    const unresolved = MARKETS.filter(([id, name]) => !resolveSymbol(symbols, id, name));
    if (unresolved.length) {
      symbolsReply = await client.ask({ active_symbols: "full" });
      symbols = [...symbols, ...(symbolsReply.active_symbols || [])];
    }
    const output = {
      version: 1,
      generatedAt: new Date(now * 1000).toISOString(),
      generatedEpoch: now,
      mode: "observation_only",
      markets: {},
      errors: []
    };

    for (const [marketId, marketName] of MARKETS) {
      const symbol = resolveSymbol(symbols, marketId, marketName);
      if (!symbol) {
        const message = "Could not resolve active Deriv symbol.";
        output.errors.push({ marketId, marketName, message });
        log("symbol_not_confirmed", { marketId, marketName });
        continue;
      }
      const marketData = { marketId, marketName, symbol, timeframes: {}, errors: [] };
      // Fetch sequentially per market to avoid bursting the public API.
      for (const [tf, granularity, count] of FRAMES) {
        try {
          const candles = await fetchCandleHistory(client, symbol, granularity, count, now);
          marketData.timeframes[tf] = candles;
          if (candles.length < 60) {
            marketData.errors.push({ timeframe: tf, message: "Fewer than 60 completed candles available." });
          }
          log("timeframe_collected", { marketId, timeframe: tf, candles: candles.length });
        } catch (error) {
          marketData.timeframes[tf] = [];
          marketData.errors.push({ timeframe: tf, message: error.message });
          log("timeframe_collection_failed", { marketId, timeframe: tf, message: error.message });
        }
      }
      const daily = marketData.timeframes.D1 || [];
      const weekly = aggregateWeeklyCandles(daily, now);
      marketData.timeframes.W1 = weekly;
      if (weekly.length < 51) {
        marketData.errors.push({ timeframe: "W1", message: "Fewer than 51 completed weekly candles available; position signals will remain warming." });
      }
      // Generate observation-only candidates. No alerts or trade execution.
      marketData.signals = evaluateAllCategories(marketId, marketName, marketData.timeframes);
      marketData.recentSignals = evaluateRecentSignals(marketId, marketName, marketData.timeframes, 6);
      output.markets[marketId] = marketData;
    }

    const liveQuotes = await fetchLiveQuotes(client, output.markets);\n    log("live_quotes_collected", { available: Object.keys(liveQuotes).length, expected: Object.keys(output.markets).length });\n\n    const priorJournal = fs.existsSync(JOURNAL) ? JSON.parse(fs.readFileSync(JOURNAL, "utf8")) : { version: 1, signals: [] };
    const journal = updateJournal(priorJournal, output.markets, now);
    const strategyJournalPath = path.join(__dirname, "strategy_comparison_journal.json");
    const priorStrategyJournal = fs.existsSync(strategyJournalPath)
      ? JSON.parse(fs.readFileSync(strategyJournalPath, "utf8"))
      : { version: 1, updatedAt: null, markets: {}, signals: [] };
    const strategyJournal = updateStrategyJournal(priorStrategyJournal, output.markets, now);
    const persistStrategyJournal = current =>
      fs.writeFileSync(strategyJournalPath, JSON.stringify(current, null, 2) + "\n");
    const strategyShadowTelegram = await sendStrategyComparisonAlerts(
      strategyJournal, now, process.env, { log, persist: persistStrategyJournal, liveQuotes }
    );
    const strategyDailyTelegram = await sendDailyStrategyComparisonReport(
      strategyJournal, now, process.env, { log, persist: persistStrategyJournal, liveQuotes }
    );
    persistStrategyJournal(strategyJournal);
    output.strategyComparison = summarizeStrategyJournal(strategyJournal);
    output.strategyComparisonTelegram = { alerts: strategyShadowTelegram, dailyReport: strategyDailyTelegram };
    const researchArchivePath = path.join(__dirname, "strategy_research_candles.json");
    const researchReportPath = path.join(__dirname, "strategy_research_report.json");
    let priorResearchArchive = { version: 1, markets: {} };
    if (fs.existsSync(researchArchivePath)) {
      const savedArchive = fs.readFileSync(researchArchivePath, "utf8");
      try {
        priorResearchArchive = JSON.parse(savedArchive);
      } catch {
        const repairedArchive = savedArchive.endsWith(String.fromCharCode(92) + "n") ? savedArchive.slice(0, -2) : savedArchive;
        priorResearchArchive = JSON.parse(repairedArchive);
      }
    }
    const candleArchive = mergeCandleArchive(priorResearchArchive, output.markets);
    const researchReport = researchArchive(candleArchive);
    fs.writeFileSync(researchArchivePath, JSON.stringify(candleArchive, null, 2) + "\n");
    fs.writeFileSync(researchReportPath, JSON.stringify(researchReport, null, 2) + "\n");
    output.strategyResearch = researchReport;
    const alertSummary = await sendCandidateAlerts(output.markets, journal, now, process.env, {
      log, liveQuotes,
      persist: current => fs.writeFileSync(JOURNAL, JSON.stringify(current, null, 2) + "\n")
    });
    fs.writeFileSync(JOURNAL, JSON.stringify(journal, null, 2) + "\n");
    fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2) + "\n");
    const reviewRecords = journal.signals.filter(s => s.category !== "SWING" && (s.status === "pending" || s.status === "tp1_hit")).map(signal => {
      const market = output.markets[signal.marketId];
      return { signalId: signal.signalId, marketId: signal.marketId, market: signal.market, category: signal.category,
        direction: signal.direction, entry: signal.entry, stopLoss: signal.stopLoss, tp1: signal.tp1, tp2: signal.tp2, tp1Hit: Boolean(signal.tp1Hit), tp1Epoch: signal.tp1Epoch || null,
        entryTimeframe: signal.entryTimeframe, entryCandleEpoch: signal.entryCandleEpoch,
        review: market ? reviewSignal(signal, market.timeframes, now) : { signalId: signal.signalId, status: "INSUFFICIENT_DATA", headline: "REVIEW UNAVAILABLE", reason: "Market data unavailable." } };
    });
    fs.writeFileSync(REVIEW_DATA, JSON.stringify({ version: 1, generatedAt: output.generatedAt, generatedEpoch: now, advisoryOnly: true, reviews: reviewRecords }, null, 2) + "\n");
    const total = Object.values(output.markets).reduce((sum, m) =>
      sum + Object.values(m.timeframes).reduce((n, candles) => n + candles.length, 0), 0);
    const allSignals = Object.values(output.markets).flatMap(m => m.signals || []);
    const signalCounts = Object.fromEntries(["signal", "no_signal", "timeframe_conflict", "waiting_pullback", "warming", "market_filtered", "data_gap"].map(state =>
      [state, allSignals.filter(s => s.state === state).length]
    ));
    output.summary = { markets: Object.keys(output.markets).length, signalCounts, journal: summarizeJournal(journal), telegram: alertSummary };
    const dashboard = {
      version: 1, generatedAt: output.generatedAt, generatedEpoch: now,
      mode: alertSummary.enabled ? "signal_alerts_enabled" : "observation_only", summary: output.summary,
      strategyComparison: output.strategyComparison, strategyResearch: output.strategyResearch,
      markets: Object.values(output.markets).map(m => ({
        marketId: m.marketId, marketName: m.marketName, signals: dashboardSignalsForMarket(m),
        timeframeCounts: Object.fromEntries(Object.entries(m.timeframes).map(([tf, candles]) => [tf, candles.length])),
        errors: m.errors
      }))
    };
    fs.writeFileSync(DASHBOARD, JSON.stringify(dashboard, null, 2) + "\n");
    log("collection_complete", {
      markets: Object.keys(output.markets).length,
      candles: total,
      signalCounts,
      telegram: alertSummary,
      errors: output.errors.length + Object.values(output.markets).reduce((n, m) => n + m.errors.length, 0),
      output: "multi_timeframe_data.json"
    });
    if (Object.keys(output.markets).length !== MARKETS.length) process.exitCode = 1;
  } finally {
    client.close();
  }
}
if (require.main === module) main().catch(error => { log("collector_failed", { message: error.message }); process.exitCode = 1; });
module.exports = { fetchCandleHistory, normalizeCandles, fetchLiveQuotes };
