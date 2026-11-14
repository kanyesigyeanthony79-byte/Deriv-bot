"use strict";

// Research-only public candle capture. No authentication, account access, or orders.
const fs = require("node:fs");
const path = require("node:path");

const ENDPOINT = "wss://api.derivws.com/trading/v1/options/ws/public";
const MARKETS = ["R_10", "R_25", "R_50", "R_75", "JD100", "CRASH500", "BOOM500"];
const FRAMES = [60, 300, 900];
const DAYS = Number(process.env.REPLAY_DAYS || 14);
const PAGE_SIZE = 5000;
const OUT = path.join(__dirname, "..", "research", "data");

if (!Number.isInteger(DAYS) || DAYS < 7 || DAYS > 30) {
  throw new Error("REPLAY_DAYS must be an integer from 7 to 30.");
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ENDPOINT);
    const pending = new Map();
    let nextId = 0;
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("Public Deriv WebSocket connection timed out."));
    }, 20000);

    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      ws.addEventListener("message", event => {
        let data;
        try { data = JSON.parse(String(event.data)); } catch { return; }
        const id = data.req_id;
        if (!pending.has(id)) return;
        const item = pending.get(id);
        pending.delete(id);
        clearTimeout(item.timer);
        if (data.error) item.reject(new Error(data.error.message || "Deriv API error"));
        else item.resolve(data);
      });
      ws.addEventListener("close", () => {
        for (const item of pending.values()) {
          clearTimeout(item.timer);
          item.reject(new Error("Deriv WebSocket closed during candle capture."));
        }
        pending.clear();
      });
      resolve({
        ask(payload) {
          return new Promise((res, rej) => {
            const req_id = ++nextId;
            const timer = setTimeout(() => {
              pending.delete(req_id);
              rej(new Error("Deriv candle request timed out."));
            }, 30000);
            pending.set(req_id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ ...payload, req_id }));
          });
        },
        close() { try { ws.close(); } catch {} }
      });
    });
    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Could not connect to Deriv public market-data endpoint."));
    }, { once: true });
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function validateCoverage(candles, symbol, granularity, startEpoch, snapshotEpoch) {
  const firstExpected = Math.ceil(startEpoch / granularity) * granularity;
  const lastExpected = Math.floor(snapshotEpoch / granularity) * granularity - granularity;
  if (lastExpected < firstExpected) {
    throw new Error(`No completed ${symbol} M${granularity / 60} candles in requested window.`);
  }

  const expectedCount = Math.floor((lastExpected - firstExpected) / granularity) + 1;
  const actualEpochs = new Set(candles.map(candle => candle.epoch));
  const missing = [];
  for (let epoch = firstExpected; epoch <= lastExpected; epoch += granularity) {
    if (!actualEpochs.has(epoch)) missing.push(epoch);
  }

  if (missing.length > 0 || candles.length !== expectedCount) {
    const examples = missing.slice(0, 8).map(epoch => new Date(epoch * 1000).toISOString());
    throw new Error(
      `Incomplete ${symbol} M${granularity / 60} coverage: ${candles.length}/${expectedCount} candles; ` +
      `${missing.length} missing intervals. First gaps: ${examples.join(", ") || "count mismatch"}`
    );
  }

  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].epoch - candles[i - 1].epoch;
    if (delta !== granularity) {
      throw new Error(
        `Non-contiguous ${symbol} M${granularity / 60} candles at ` +
        `${new Date(candles[i - 1].epoch * 1000).toISOString()} and ` +
        `${new Date(candles[i].epoch * 1000).toISOString()} (gap ${delta}s).`
      );
    }
  }

  return { expectedCount, gapCount: missing.length, firstEpoch: firstExpected, lastEpoch: lastExpected };
}

async function fetchFrame(client, symbol, granularity, startEpoch, snapshotEpoch) {
  const firstExpected = Math.ceil(startEpoch / granularity) * granularity;
  const lastExpected = Math.floor(snapshotEpoch / granularity) * granularity - granularity;
  const byEpoch = new Map();

  // Request explicit, non-overlapping time windows. This avoids relying on
  // server-side backward-cursor behavior, which previously left an initial gap.
  for (let chunkStart = firstExpected; chunkStart <= lastExpected;) {
    const chunkEnd = Math.min(
      chunkStart + (PAGE_SIZE - 1) * granularity,
      lastExpected
    );
    const expectedInChunk = Math.floor((chunkEnd - chunkStart) / granularity) + 1;
    const reply = await client.ask({
      ticks_history: symbol,
      style: "candles",
      granularity,
      count: expectedInChunk,
      start: chunkStart,
      end: String(chunkEnd),
      adjust_start_time: 1
    });
    if (!Array.isArray(reply.candles) || reply.candles.length === 0) {
      throw new Error(
        `Empty ${symbol} M${granularity / 60} response for requested window ` +
        `${new Date(chunkStart * 1000).toISOString()} to ${new Date(chunkEnd * 1000).toISOString()}.`
      );
    }

    for (const raw of reply.candles) {
      const epoch = Number(raw.epoch);
      const candle = {
        epoch,
        open: Number(raw.open),
        high: Number(raw.high),
        low: Number(raw.low),
        close: Number(raw.close),
        complete: epoch + granularity <= snapshotEpoch
      };
      if (!Number.isFinite(epoch) ||
          ![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) ||
          candle.high < Math.max(candle.open, candle.close) ||
          candle.low > Math.min(candle.open, candle.close) ||
          candle.high < candle.low) {
        throw new Error(`Invalid OHLC candle returned for ${symbol} M${granularity / 60}.`);
      }
      if (epoch % granularity !== 0) {
        throw new Error(`Unaligned candle timestamp returned for ${symbol} M${granularity / 60}: ${epoch}.`);
      }
      if (epoch >= chunkStart && epoch <= chunkEnd && epoch + granularity <= snapshotEpoch) {
        byEpoch.set(epoch, candle);
      }
    }

    console.log(
      `${symbol} M${granularity / 60} window ${new Date(chunkStart * 1000).toISOString()}: ` +
      `${reply.candles.length}/${expectedInChunk} returned`
    );
    chunkStart = chunkEnd + granularity;
    await sleep(250);
  }

  const candles = [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
  const coverage = validateCoverage(candles, symbol, granularity, startEpoch, snapshotEpoch);
  return { candles, coverage };
}

async function main() {
  const snapshotEpoch = Math.floor(Date.now() / 1000);
  const startEpoch = snapshotEpoch - DAYS * 86400;
  fs.mkdirSync(OUT, { recursive: true });
  const client = await connect();
  try {
    const symbolsReply = await client.ask({ active_symbols: "brief" });
    const active = new Set((symbolsReply.active_symbols || []).map(item => item.underlying_symbol || item.symbol).filter(Boolean));
    for (const market of MARKETS) {
      if (!active.has(market)) throw new Error(`Market ${market} was not confirmed in active_symbols.`);
      const frames = {};
      const coverage = {};
      for (const granularity of FRAMES) {
        const frame = `M${granularity / 60}`;
        const result = await fetchFrame(client, market, granularity, startEpoch, snapshotEpoch);
        frames[frame] = result.candles;
        coverage[frame] = result.coverage;
        console.log(`${market} ${frame}: ${result.candles.length}/${result.coverage.expectedCount} candles; gaps=0`);
      }
      const payload = {
        schemaVersion: 2,
        market,
        source: "Deriv public ticks_history candles",
        endpoint: ENDPOINT,
        capturedAt: new Date(snapshotEpoch * 1000).toISOString(),
        requestedDays: DAYS,
        startEpoch,
        snapshotEpoch,
        coverage,
        frames
      };
      fs.writeFileSync(path.join(OUT, `${market}.json`), JSON.stringify(payload, null, 2) + "\n");
    }
  } finally {
    client.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
