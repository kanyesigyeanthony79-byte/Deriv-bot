"use strict";
// Retain completed lower-timeframe candles for a separate M15-setup / M5-M1-entry
// research track. This module is observation-only: no alerts and no order execution.
const fs = require("node:fs");
const path = require("node:path");
const { getDataDir } = require("./scanner_data_dir");
const DATA_DIR = getDataDir();

const INPUT = path.join(DATA_DIR, "multi_timeframe_data.json");
const ARCHIVE = path.join(DATA_DIR, "lower_tf_research_candles.json");
const REPORT = path.join(DATA_DIR, "lower_tf_entry_research_report.json");
const LIMITS = Object.freeze({ M1: 5000, M5: 2000, M15: 1200 });
const SECONDS = Object.freeze({ M1: 60, M5: 300, M15: 900 });
const MARKETS = ["R_10", "R_25", "R_50", "R_75", "JD75", "JD100", "CRASH500", "BOOM500"];

const BACKFILL_M5_COUNT = 1000;
const PUBLIC = "wss://api.derivws.com/trading/v1/options/ws/public";

function normalizeBackfillCandles(raw, now) {
  return (Array.isArray(raw) ? raw : [])
    .map(c => ({ epoch: Number(c.epoch), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }))
    .filter(c => validCandle(c) && c.epoch % SECONDS.M5 === 0 && c.epoch + SECONDS.M5 <= now)
    .sort((a, b) => a.epoch - b.epoch)
    .filter((c, i, rows) => i === 0 || c.epoch !== rows[i - 1].epoch);
}

function candlesFromTickHistory(history, gap, now) {
  const times = Array.isArray(history?.times) ? history.times : [];
  const prices = Array.isArray(history?.prices) ? history.prices : [];
  const buckets = new Map();
  for (let index = 0; index < Math.min(times.length, prices.length); index += 1) {
    const epoch = Number(times[index]);
    const price = Number(prices[index]);
    if (!Number.isFinite(epoch) || !Number.isFinite(price) ||
        epoch < gap.start || epoch >= gap.end + SECONDS.M5) continue;
    const candleEpoch = Math.floor(epoch / SECONDS.M5) * SECONDS.M5;
    if (candleEpoch < gap.start || candleEpoch > gap.end) continue;
    const candle = buckets.get(candleEpoch);
    if (!candle) {
      buckets.set(candleEpoch, { epoch: candleEpoch, open: price, high: price, low: price, close: price });
    } else {
      candle.high = Math.max(candle.high, price);
      candle.low = Math.min(candle.low, price);
      candle.close = price;
    }
  }
  return [...buckets.values()].sort((a, b) => a.epoch - b.epoch)
    .filter(c => validCandle(c) && c.epoch + SECONDS.M5 <= now);
}

function findM5Gaps(rows) {
  const data = (Array.isArray(rows) ? rows : [])
    .filter(c => validCandle(c) && Number(c.epoch) % SECONDS.M5 === 0)
    .sort((a, b) => a.epoch - b.epoch);
  const gaps = [];
  for (let i = 1; i < data.length; i += 1) {
    const difference = Number(data[i].epoch) - Number(data[i - 1].epoch);
    if (difference > SECONDS.M5 && difference % SECONDS.M5 === 0) {
      gaps.push({
        start: Number(data[i - 1].epoch) + SECONDS.M5,
        end: Number(data[i].epoch) - SECONDS.M5,
        missingCandles: difference / SECONDS.M5 - 1
      });
    }
  }
  return gaps;
}

async function fetchR10M5Backfill(now, existingRows = [], WebSocketImpl = WebSocket) {
  const ws = new WebSocketImpl(PUBLIC);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Deriv research backfill connection timed out")), 15000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Deriv research backfill connection failed")); }, { once: true });
    });
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Deriv research backfill request timed out")), 20000);
      const onMessage = event => {
        let data;
        try { data = JSON.parse(String(event.data)); } catch { return; }
        if (data.req_id !== 1) return;
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        if (data.error) reject(new Error(data.error.message || "Deriv candle history request failed"));
        else resolve(data);
      };
      ws.addEventListener("message", onMessage);
      ws.send(JSON.stringify({
        ticks_history: "R_10", adjust_start_time: 1, count: BACKFILL_M5_COUNT,
        end: "latest", granularity: SECONDS.M5, style: "candles", req_id: 1
      }));
    });
    const candles = normalizeBackfillCandles(reply.candles, now);
    if (candles.length < 500) throw new Error("Deriv returned fewer than 500 completed R_10 M5 candles");

    // Repair historical discontinuities separately from the rolling latest-history
    // request. The API accepts inclusive start/end candle boundaries.
    const gapRows = findM5Gaps(existingRows);
    for (let index = 0; index < gapRows.length; index += 1) {
      const gap = gapRows[index];
      const gapReply = await new Promise((resolve, reject) => {
        const reqId = index + 2;
        const timer = setTimeout(() => reject(new Error("Deriv targeted M5 gap request timed out")), 15000);
        const onMessage = event => {
          let data;
          try { data = JSON.parse(String(event.data)); } catch { return; }
          if (data.req_id !== reqId) return;
          clearTimeout(timer);
          ws.removeEventListener("message", onMessage);
          if (data.error) reject(new Error(data.error.message || "Deriv targeted M5 gap request failed"));
          else resolve(data);
        };
        ws.addEventListener("message", onMessage);
        // Request the last N candles ending at the next known candle boundary.
        // Deriv's count/end form is more reliable for small historical windows
        // than start/end-only requests on this public candle endpoint.
        ws.send(JSON.stringify({
          ticks_history: "R_10", count: gap.missingCandles + 1,
          end: String(gap.end + SECONDS.M5),
          granularity: SECONDS.M5, style: "candles", req_id: reqId
        }));
      });
      let recovered = normalizeBackfillCandles(gapReply.candles, now)
        .filter(c => c.epoch >= gap.start && c.epoch <= gap.end);
      let tickCount = 0;
      let tickRecovered = [];
      if (recovered.length < gap.missingCandles) {
        const tickReqId = index + 1002;
        const tickReply = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Deriv targeted M5 tick-history request timed out")), 15000);
          const onMessage = event => {
            let data;
            try { data = JSON.parse(String(event.data)); } catch { return; }
            if (data.req_id !== tickReqId) return;
            clearTimeout(timer);
            ws.removeEventListener("message", onMessage);
            if (data.error) reject(new Error(data.error.message || "Deriv targeted M5 tick-history request failed"));
            else resolve(data);
          };
          ws.addEventListener("message", onMessage);
          ws.send(JSON.stringify({
            ticks_history: "R_10", start: gap.start,
            end: String(gap.end + SECONDS.M5), count: 5000,
            style: "ticks", req_id: tickReqId
          }));
        });
        tickCount = Math.min(tickReply.history?.times?.length || 0, tickReply.history?.prices?.length || 0);
        tickRecovered = candlesFromTickHistory(tickReply.history, gap, now);
        const recoveredEpochs = new Set(recovered.map(c => c.epoch));
        for (const candle of tickRecovered) {
          if (!recoveredEpochs.has(candle.epoch)) recovered.push(candle);
        }
        recovered.sort((a, b) => a.epoch - b.epoch);
      }
      candles.push(...recovered);
      console.log(JSON.stringify({
        event: "r10_m5_research_gap_repair",
        start: gap.start, end: gap.end,
        expectedCandles: gap.missingCandles,
        candleApiCandles: Array.isArray(gapReply.candles) ? gapReply.candles.length : 0,
        tickCount, tickReconstructedCandles: tickRecovered.length,
        recoveredCandles: recovered.length,
        status: recovered.length === gap.missingCandles ? "success" : "incomplete"
      }));
    }
    const byEpoch = new Map(candles.map(c => [c.epoch, c]));
    return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
  } finally {
    try { ws.close(); } catch {}
  }
}

function validCandle(c) {
  return c && [c.epoch, c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.high >= c.low && c.high >= Math.max(c.open, c.close) &&
    c.low <= Math.min(c.open, c.close);
}
function mergeLowerTimeframeArchive(prior, incoming) {
  const archive = prior && prior.version === 1
    ? prior : { version: 1, updatedAt: null, markets: {} };
  archive.markets ||= {};
  for (const [marketId, market] of Object.entries(incoming || {})) {
    const saved = archive.markets[marketId] ||= { marketName: market.marketName || marketId, timeframes: {} };
    saved.marketName = market.marketName || saved.marketName || marketId;
    saved.timeframes ||= {};
    for (const tf of Object.keys(LIMITS)) {
      const oldRows = saved.timeframes[tf] || [];
      const newRows = market.timeframes?.[tf] || [];
      const byEpoch = new Map();
      for (const c of oldRows.concat(newRows)) {
        // Keep only candles aligned to the requested timeframe. Older collector
        // snapshots may contain off-boundary timestamps that split an otherwise
        // continuous historical sequence and make replay readiness misleading.
        if (!validCandle(c) || Number(c.epoch) % SECONDS[tf] !== 0) continue;
        byEpoch.set(Number(c.epoch), {
          epoch: Number(c.epoch), open: Number(c.open), high: Number(c.high),
          low: Number(c.low), close: Number(c.close)
        });
      }
      saved.timeframes[tf] = [...byEpoch.values()]
        .sort((a, b) => a.epoch - b.epoch).slice(-LIMITS[tf]);
    }
  }
  archive.updatedAt = new Date().toISOString();
  return archive;
}
function frameStats(rows, tf, rawRows = rows) {
  const data = Array.isArray(rows) ? rows : [];
  const raw = Array.isArray(rawRows) ? rawRows : [];
  const diffs = data.slice(1).map((c, i) => c.epoch - data[i].epoch);
  const seen = new Set();
  let duplicateEpochs = 0;
  for (const candle of raw) {
    const epoch = Number(candle?.epoch);
    if (seen.has(epoch)) duplicateEpochs += 1;
    seen.add(epoch);
  }
  let segmentStartIndex = Math.max(0, data.length - 1);
  while (segmentStartIndex > 0 && data[segmentStartIndex].epoch - data[segmentStartIndex - 1].epoch === SECONDS[tf]) {
    segmentStartIndex -= 1;
  }
  const latestSegment = data.slice(segmentStartIndex);
  return {
    candles: data.length,
    firstEpoch: data.length ? data[0].epoch : null,
    lastEpoch: data.length ? data[data.length - 1].epoch : null,
    expectedIntervalSeconds: SECONDS[tf],
    gaps: diffs.filter(d => d !== SECONDS[tf]).length,
    latestSegmentCandles: latestSegment.length,
    latestSegmentStartEpoch: latestSegment.length ? latestSegment[0].epoch : null,
    latestSegmentEndEpoch: latestSegment.length ? latestSegment[latestSegment.length - 1].epoch + SECONDS[tf] : null,
    duplicateEpochs,
    invalidCandles: raw.filter(c => !validCandle(c)).length,
    unalignedEpochs: raw.filter(c => Number.isFinite(Number(c?.epoch)) && Number(c.epoch) % SECONDS[tf] !== 0).length,
    largestIntervalSeconds: diffs.length ? Math.max(...diffs) : null
  };
}
function buildReport(archive, incoming = {}, options = {}) {
  const markets = {};
  for (const id of MARKETS) {
    const m = archive.markets?.[id] || { timeframes: {} };
    const frames = {};
    for (const tf of Object.keys(LIMITS)) {
      // Validate the persisted archive itself, not just this run's incoming rows.
      frames[tf] = frameStats(m.timeframes?.[tf], tf, m.timeframes?.[tf]);
    }
    const starts = Object.values(frames).map(x => x.latestSegmentStartEpoch).filter(Number.isFinite);
    const ends = Object.values(frames).map(x => x.latestSegmentEndEpoch).filter(Number.isFinite);
    const overlapStart = starts.length ? Math.max(...starts) : null;
    const overlapEnd = ends.length ? Math.min(...ends) : null;
    markets[id] = {
      marketName: m.marketName || id, frames,
      commonOverlapHours: Number.isFinite(overlapStart) && Number.isFinite(overlapEnd)
        ? Math.max(0, (overlapEnd - overlapStart) / 3600) : 0
    };
  }
  const qualifiedMarketIds = Object.entries(markets).filter(([, m]) =>
    m.frames.M1.latestSegmentCandles >= 1440 &&
    m.frames.M5.latestSegmentCandles >= 500 &&
    m.frames.M15.latestSegmentCandles >= 400 &&
    m.commonOverlapHours >= 24 &&
    Object.values(m.frames).every(f => f.duplicateEpochs === 0 &&
      f.invalidCandles === 0 && f.unalignedEpochs === 0)
  ).map(([id]) => id);
  const focusMarket = MARKETS.includes(options.focusMarket) ? options.focusMarket : null;
  const readyMarketIds = focusMarket
    ? qualifiedMarketIds.filter(id => id === focusMarket)
    : qualifiedMarketIds;
  const marketsRequired = focusMarket ? 1 : 3;
  const ready = readyMarketIds.length >= marketsRequired;
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: ready ? "ready_for_lower_timeframe_replay" : "collecting_lower_timeframe_history",
    focusMarket,
    marketsReady: readyMarketIds.length,
    marketsRequired,
    qualifiedMarketIds,
    markets,
    researchDesign: {
      setup: "Completed M15 candidate from the existing EMA strategy comparison; direction is frozen at the M15 close.",
      m5Entry: "After the setup close, wait for M5 EMA9/EMA21 alignment and an EMA9 pullback/reclaim candle; enter at the next M5 open.",
      m1Entry: "Require M5 EMA9/EMA21 alignment, then an M1 EMA9 pullback followed by a close beyond the prior three-candle micro swing; enter at the next M1 open.",
      stop: "Structure-based stop beyond the recent five completed entry-timeframe candles, with an ATR buffer. Reject entries with invalid or excessively wide risk; never force a smaller stop.",
      baseline: "Compare against the existing M15 next-open entry and 1.5 x M15 ATR stop.",
      outcomes: "Use identical 2R target and a one-hour observation horizon for the first comparison. Report target, stop, same-candle ambiguity, time exit, expectancy in R, stop distance in M15 ATR units, and signal coverage.",
      safeguards: [
        "Only completed candles; no future higher-timeframe candles may enter a trigger.",
        "No look-ahead: entry is the candle after the trigger candle.",
        "Keep markets separate and show per-market results.",
        "Use chronological discovery/validation/holdout splits; do not tune on holdout.",
        "Do not promote on a smaller stop alone; compare stop frequency and expectancy."
      ]
    },
    note: "Readiness is based on the latest continuous segment in each timeframe, so an older historical gap no longer blocks research forever. No strategy performance result is claimed until replay completes."
  };
}
async function main() {
  if (!fs.existsSync(INPUT)) throw new Error("Missing collector output: " + INPUT);
  const latest = JSON.parse(fs.readFileSync(INPUT, "utf8"));
  let prior = { version: 1, markets: {} };
  if (fs.existsSync(ARCHIVE)) prior = JSON.parse(fs.readFileSync(ARCHIVE, "utf8"));
  let incoming = latest.markets;
  // Isolated research-only historical backfill. Production scanner data and
  // its signal/Telegram path remain untouched. Failure is non-blocking.
  try {
    const now = Number(latest.generatedEpoch) || Math.floor(Date.now() / 1000);
    const historicalM5 = await fetchR10M5Backfill(now, prior.markets?.R_10?.timeframes?.M5 || []);
    incoming = {
      ...latest.markets,
      R_10: {
        ...latest.markets.R_10,
        timeframes: { ...(latest.markets.R_10?.timeframes || {}), M5: historicalM5 }
      }
    };
    console.log(JSON.stringify({ event: "r10_m5_research_backfill", candles: historicalM5.length, status: "success" }));
  } catch (error) {
    console.log(JSON.stringify({ event: "r10_m5_research_backfill", status: "failed_nonblocking", message: String(error.message || error).slice(0, 200) }));
  }
  const archive = mergeLowerTimeframeArchive(prior, incoming);
  const report = buildReport(archive, incoming, { focusMarket: process.env.LOWER_TF_FOCUS_MARKET || null });
  fs.writeFileSync(ARCHIVE, JSON.stringify(archive, null, 2) + "\n");
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({
    event: "lower_tf_research_archive_updated",
    markets: Object.keys(archive.markets).length,
    marketsReady: report.marketsReady,
    mode: report.mode,
    counts: Object.fromEntries(MARKETS.map(id => [id, {
      M1: report.markets[id].frames.M1.candles,
      M5: report.markets[id].frames.M5.candles,
      M15: report.markets[id].frames.M15.candles
    }]))
  }));
}
if (require.main === module) main();
module.exports = { mergeLowerTimeframeArchive, frameStats, buildReport, normalizeBackfillCandles, candlesFromTickHistory, findM5Gaps, LIMITS, SECONDS, MARKETS, BACKFILL_M5_COUNT };
