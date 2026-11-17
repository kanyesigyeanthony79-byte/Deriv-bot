"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { latestCandidates, sendCandidateAlerts, sendOutcomeAlerts, ALERT_MAX_AGE_SECONDS, signalFreshness, assessEntryPrice } = require("../multi_timeframe_alerts");

function candidate(overrides = {}) {
  return {
    state: "signal", signalId: "R_50-SCALP-1000", marketId: "R_50", market: "Volatility 50 Index",
    category: "SCALP", categoryLabel: "Scalping", direction: "BUY", entryTimeframe: "M5",
    setupTimeframe: "M15", confirmationTimeframe: "M15", quality: "VALID",
    entryCandleEpoch: 1000, entry: 100, stopLoss: 98, tp1: 102, tp2: 103,
    ...overrides
  };
}
function fixture(candidates) {
  return {
    markets: { R_50: { signals: [], recentSignals: candidates } },
    journal: { version: 1, signals: candidates.map(s => ({ ...s, status: "pending", telegramStatus: null })) }
  };
}


test("live quote must remain within 0.2R of entry", () => {
  assert.equal(assessEntryPrice(candidate(), 100.3).valid, true);
  assert.equal(assessEntryPrice(candidate(), 100.5).valid, false);
  assert.equal(assessEntryPrice(candidate(), 102).reason, "tp1_already_reached");
  assert.equal(assessEntryPrice(candidate(), null).valid, false);
});

test("freshness is measured from entry candle close, not candle open", () => {
  const item = candidate({ entryCandleEpoch: 1000, entryTimeframe: "M5" });
  assert.equal(signalFreshness(item, 1300).ageSeconds, 0);
  assert.equal(signalFreshness(item, 1300).fresh, true);
  assert.equal(signalFreshness(item, 1300 + ALERT_MAX_AGE_SECONDS.SCALP + 1).fresh, false);
});

test("alert candidates retain every distinct candle entry and deduplicate repeated IDs", () => {
  const older = candidate({ signalId: "old", entryCandleEpoch: 900 });
  const newer = candidate({ signalId: "new", entryCandleEpoch: 1000 });
  const swing = candidate({ signalId: "swing", category: "SWING" });
  const found = latestCandidates({ R_50: { signals: [older], recentSignals: [newer, older, swing] } });
  assert.deepEqual(found.map(s => s.signalId), ["old", "new"]);
});

test("WATCH candidates are excluded while STRONG and VALID candidates remain actionable", () => {
  const valid = candidate({ signalId: "valid" });
  const strong = candidate({ signalId: "strong", quality: "STRONG" });
  const watch = candidate({ signalId: "watch", quality: "WATCH" });
  const found = latestCandidates({ R_50: { signals: [], recentSignals: [valid, strong, watch] } });
  assert.deepEqual(found.map(s => s.signalId), ["valid", "strong"]);
});

test("swing candidates remain observation-only and are excluded from Telegram alerts", async () => {
  const swing = candidate({ category: "SWING", signalId: "R_50-SWING-1000" });
  const { markets, journal } = fixture([swing]);
  let calls = 0;
  const env = { MTF_TELEGRAM_ALERTS: "true", TELEGRAM_WORKER_URL: "https://worker.example", SIGNAL_API_KEY: "secret" };
  const result = await sendCandidateAlerts(markets, journal, 1301, env, {
    liveQuotes: { R_50: { price: 100 } }, fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ success: true }) }; }
  });
  assert.equal(result.considered, 0);
  assert.equal(result.sent, 0);
  assert.equal(calls, 0);
  assert.equal(journal.signals[0].telegramStatus, null);
});

test("feature flag off never calls Telegram", async () => {
  const { markets, journal } = fixture([candidate()]);
  let calls = 0;
  const result = await sendCandidateAlerts(markets, journal, 1301, {}, { liveQuotes: { R_50: { price: 100 } }, fetchImpl: async () => { calls++; } });
  assert.equal(result.enabled, false);
  assert.equal(calls, 0);
});

test("recent candidate is sent once with its horizon in the market label", async () => {
  const { markets, journal } = fixture([candidate()]);
  const requests = [];
  const options = { liveQuotes: { R_50: { price: 100 } }, fetchImpl: async (url, init) => {
    requests.push({ url, payload: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ success: true }) };
  }};
  const env = { MTF_TELEGRAM_ALERTS: "true", TELEGRAM_WORKER_URL: "https://worker.example", SIGNAL_API_KEY: "secret" };
  const first = await sendCandidateAlerts(markets, journal, 1301, env, options);
  const second = await sendCandidateAlerts(markets, journal, 1301, env, options);
  assert.equal(first.sent, 1);
  assert.equal(second.skipped, 1);
  assert.equal(requests.length, 1);
  assert.match(requests[0].payload.market, /Scalping/);
  assert.equal(requests[0].payload.event, "new_signal");
});

test("SCALP, SHORT_TERM and POSITION candidates each route with their own horizon label", async () => {
  const env = { MTF_TELEGRAM_ALERTS: "true", TELEGRAM_WORKER_URL: "https://worker.example", SIGNAL_API_KEY: "secret" };
  for (const [category, label] of [["SCALP", "Scalping"], ["SHORT_TERM", "Short-term"], ["POSITION", "Position"]]) {
    const item = candidate({ category, categoryLabel: label, entryTimeframe: category === "SCALP" ? "M5" : category === "SHORT_TERM" ? "M5" : "H4", signalId: "R_50-" + category + "-1000" });
    const { markets, journal } = fixture([item]);
    const requests = [];
    const result = await sendCandidateAlerts(markets, journal, 1000 + (category === "SCALP" ? 300 : category === "SHORT_TERM" ? 300 : 14400) + 10, env, {
      liveQuotes: { R_50: { price: 100 } }, fetchImpl: async (url, init) => {
        requests.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ success: true }) };
      }
    });
    assert.equal(result.sent, 1, category + " should be delivered");
    assert.match(requests[0].market, new RegExp(label));
  }
});

test("SHORT_TERM and POSITION use their own stale-alert cutoffs", async () => {
  const env = { MTF_TELEGRAM_ALERTS: "true", TELEGRAM_WORKER_URL: "https://worker.example", SIGNAL_API_KEY: "secret" };
  for (const category of ["SHORT_TERM", "POSITION"]) {
    const item = candidate({ category, entryTimeframe: category === "SHORT_TERM" ? "M5" : "H4", signalId: "R_50-" + category + "-1000" });
    const { markets, journal } = fixture([item]);
    let calls = 0;
    const result = await sendCandidateAlerts(markets, journal, 1000 + (category === "SHORT_TERM" ? 300 : 14400) + ALERT_MAX_AGE_SECONDS[category] + 1, env, {
      fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ success: true }) }; }
    });
    assert.equal(result.stale, 1, category + " should be marked stale");
    assert.equal(calls, 0, category + " stale candidate must not be sent");
  }
});

test("price already moved too far is marked missed and not sent", async () => {
  const { markets, journal } = fixture([candidate()]);
  let calls=0;
  const env={MTF_TELEGRAM_ALERTS:"true",TELEGRAM_WORKER_URL:"https://worker.example",SIGNAL_API_KEY:"secret"};
  const result=await sendCandidateAlerts(markets,journal,1301,env,{liveQuotes:{R_50:{price:101}},fetchImpl:async()=>{calls++;}});
  assert.equal(result.missed,1);
  assert.equal(calls,0);
  assert.equal(journal.signals[0].telegramStatus,"missed");
});

test("missing live quote blocks delivery without falsely marking signal sent", async () => {
  const { markets, journal }=fixture([candidate()]);
  const env={MTF_TELEGRAM_ALERTS:"true",TELEGRAM_WORKER_URL:"https://worker.example",SIGNAL_API_KEY:"secret"};
  const result=await sendCandidateAlerts(markets,journal,1301,env,{liveQuotes:{},fetchImpl:async()=>({ok:true,json:async()=>({success:true})})});
  assert.equal(result.quoteUnavailable,1);
  assert.equal(journal.signals[0].telegramStatus,null);
});

test("candidate outside the alert age window is not sent", async () => {
  const old = candidate({ entryCandleEpoch: 1000 });
  const { markets, journal } = fixture([old]);
  let calls = 0;
  const env = { MTF_TELEGRAM_ALERTS: "true", TELEGRAM_WORKER_URL: "https://worker.example", SIGNAL_API_KEY: "secret" };
  const result = await sendCandidateAlerts(markets, journal, 1000 + 300 + ALERT_MAX_AGE_SECONDS.SCALP + 1, env, {
    fetchImpl: async () => { calls++; }
  });
  assert.equal(result.stale, 1);
  assert.equal(calls, 0);
  assert.equal(journal.signals[0].telegramStatus, "stale");
});

test("uncertain delivery failure is recorded and not retried automatically", async () => {
  const { markets, journal } = fixture([candidate()]);
  let calls = 0;
  const env = { MTF_TELEGRAM_ALERTS: "true", TELEGRAM_WORKER_URL: "https://worker.example", SIGNAL_API_KEY: "secret" };
  const options = { liveQuotes: { R_50: { price: 100 } }, fetchImpl: async () => { calls++; throw new Error("network timeout"); } };
  const first = await sendCandidateAlerts(markets, journal, 1301, env, options);
  const second = await sendCandidateAlerts(markets, journal, 1301, env, options);
  assert.equal(first.failed, 1);
  assert.equal(second.skipped, 1);
  assert.equal(calls, 1);
});


test("TP1 and terminal outcomes are sent once, in order", async () => {
  const journal = { version: 1, signals: [{
    ...candidate(), status: "tp2_hit", tp1Hit: true, telegramStatus: "sent"
  }] };
  const requests = [];
  const env = { MTF_TELEGRAM_ALERTS: "true", TELEGRAM_WORKER_URL: "https://worker.example", SIGNAL_API_KEY: "secret" };
  const options = { fetchImpl: async (url, init) => {
    requests.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ success: true }) };
  }};
  const first = await sendOutcomeAlerts(journal, 2000, env, options);
  const second = await sendOutcomeAlerts(journal, 2001, env, options);
  assert.equal(first.sent, 2);
  assert.equal(second.sent, 0);
  assert.deepEqual(requests.map(item => item.outcome), ["TP1_HIT", "TP2_HIT"]);
  assert.deepEqual(journal.signals[0].telegramOutcomeEvents, { TP1_HIT: "sent", TP2_HIT: "sent" });
});

test("failed outcome delivery is retried and does not suppress later terminal update", async () => {
  const journal = { version: 1, signals: [{
    ...candidate(), status: "tp2_hit", tp1Hit: true, telegramStatus: "sent"
  }] };
  let calls = 0;
  const env = { MTF_TELEGRAM_ALERTS: "true", TELEGRAM_WORKER_URL: "https://worker.example", SIGNAL_API_KEY: "secret" };
  const failFirst = { fetchImpl: async () => {
    calls++;
    if (calls === 1) return { ok: false, json: async () => ({ success: false, error: "temporary" }) };
    return { ok: true, json: async () => ({ success: true }) };
  }};
  const first = await sendOutcomeAlerts(journal, 2000, env, failFirst);
  assert.equal(first.failed, 1);
  assert.deepEqual(journal.signals[0].telegramOutcomeEvents, {}, "failed event must remain unsent and retryable");
  const retry = await sendOutcomeAlerts(journal, 2010, env, failFirst);
  assert.equal(retry.sent, 2);
  assert.equal(calls, 3);
});

test("stop after TP1 has a distinct Telegram outcome", async () => {
  const journal = { version: 1, signals: [{
    ...candidate(), status: "stopped_after_tp1", tp1Hit: true, telegramStatus: "sent"
  }] };
  const outcomes = [];
  const env = { MTF_TELEGRAM_ALERTS: "true", TELEGRAM_WORKER_URL: "https://worker.example", SIGNAL_API_KEY: "secret" };
  await sendOutcomeAlerts(journal, 2000, env, { fetchImpl: async (url, init) => {
    outcomes.push(JSON.parse(init.body).outcome);
    return { ok: true, json: async () => ({ success: true }) };
  }});
  assert.deepEqual(outcomes, ["TP1_HIT", "SL_AFTER_TP1"]);
});

test("enabled MT5 queue receives validated synthetic signal payload without changing Telegram delivery", async () => {
  const { markets, journal } = fixture([candidate()]);
  const calls = [];
  const env = {
    MTF_TELEGRAM_ALERTS: "true", MT5_EXECUTION_QUEUE_ENABLED: "true",
    TELEGRAM_WORKER_URL: "https://worker.example", SIGNAL_API_KEY: "secret"
  };
  const result = await sendCandidateAlerts(markets, journal, 1301, env, {
    liveQuotes: { R_50: { price: 100 } },
    fetchImpl: async (url, init) => {
      calls.push({ url, payload: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ success: true, duplicate: false }) };
    }
  });
  assert.equal(result.executionQueued, 1);
  assert.equal(result.sent, 1);
  assert.equal(calls[0].url, "https://worker.example/mt5/ingest");
  assert.equal(calls[0].payload.marketId, "R_50");
  assert.equal(calls[0].payload.category, "SCALP");
  assert.equal(calls[0].payload.priceValidation, "PASS");
  assert.equal(calls[1].url, "https://worker.example");
  assert.equal(journal.signals[0].mt5QueueStatus, "queued");
  assert.equal(journal.signals[0].telegramStatus, "sent");
});

test("failed MT5 queue delivery retries independently without duplicating Telegram alert", async () => {
  const { markets, journal } = fixture([candidate()]);
  let queueAttempts = 0, telegramAttempts = 0;
  const env = {
    MTF_TELEGRAM_ALERTS: "true", MT5_EXECUTION_QUEUE_ENABLED: "true",
    TELEGRAM_WORKER_URL: "https://worker.example", SIGNAL_API_KEY: "secret"
  };
  const options = {
    liveQuotes: { R_50: { price: 100 } },
    fetchImpl: async (url) => {
      if (url.endsWith("/mt5/ingest")) {
        queueAttempts++;
        if (queueAttempts === 1) throw new Error("queue unavailable");
      } else telegramAttempts++;
      return { ok: true, json: async () => ({ success: true }) };
    }
  };
  const first = await sendCandidateAlerts(markets, journal, 1301, env, options);
  const second = await sendCandidateAlerts(markets, journal, 1301, env, options);
  assert.equal(first.executionFailed, 1);
  assert.equal(first.sent, 1);
  assert.equal(second.executionQueued, 1);
  assert.equal(second.sent, 0);
  assert.equal(queueAttempts, 2);
  assert.equal(telegramAttempts, 1);
  assert.equal(journal.signals[0].mt5QueueStatus, "queued");
  assert.equal(journal.signals[0].telegramStatus, "sent");
});

test("MT5 queue remains disabled unless its explicit feature flag is true", async () => {
  const { markets, journal } = fixture([candidate()]);
  const urls = [];
  const env = {
    MTF_TELEGRAM_ALERTS: "true", MT5_EXECUTION_QUEUE_ENABLED: "false",
    TELEGRAM_WORKER_URL: "https://worker.example", SIGNAL_API_KEY: "secret"
  };
  const result = await sendCandidateAlerts(markets, journal, 1301, env, {
    liveQuotes: { R_50: { price: 100 } },
    fetchImpl: async (url, init) => { urls.push(url); return { ok: true, json: async () => ({ success: true }) }; }
  });
  assert.equal(result.executionEnabled, false);
  assert.deepEqual(urls, ["https://worker.example"]);
  assert.equal(journal.signals[0].mt5QueueStatus, undefined);
});
