"use strict";

const ENTRY_TIMEFRAME_SECONDS = Object.freeze({ M1: 60, M5: 300, H4: 14400 });
const ALERT_MAX_AGE_SECONDS = Object.freeze({ SCALP: 10 * 60, SHORT_TERM: 30 * 60, POSITION: 4 * 60 * 60 });
const MAX_ENTRY_DEVIATION_R = 0.2;
// Automated MT5 execution is intentionally restricted to the approved synthetic CFDs.
const MT5_EXECUTION_MARKETS = new Set(["R_10", "R_25", "R_50", "R_75", "JD100", "CRASH500", "BOOM500"]);

function signalFreshness(candidate, nowEpoch) {
  const timeframeSeconds = ENTRY_TIMEFRAME_SECONDS[candidate.entryTimeframe];
  const candleCloseEpoch = Number(candidate.entryCandleEpoch) + Number(timeframeSeconds);
  const ageSeconds = Number(nowEpoch) - candleCloseEpoch;
  const maxAgeSeconds = ALERT_MAX_AGE_SECONDS[candidate.category];
  return { candleCloseEpoch, ageSeconds, maxAgeSeconds,
    fresh: Number.isFinite(candleCloseEpoch) && Number.isFinite(ageSeconds) && ageSeconds >= 0 &&
      Boolean(maxAgeSeconds) && ageSeconds <= maxAgeSeconds };
}

function assessEntryPrice(candidate, livePrice) {
  const price = Number(livePrice);
  const entry = Number(candidate.entry);
  const stop = Number(candidate.stopLoss);
  const risk = Math.abs(entry - stop);
  if (![price, entry, stop, risk].every(Number.isFinite) || risk <= 0) {
    return { valid: false, reason: "invalid_or_missing_live_price_or_levels", livePrice: Number.isFinite(price) ? price : null };
  }
  const maxDeviation = risk * MAX_ENTRY_DEVIATION_R;
  const deviation = Math.abs(price - entry);
  const direction = String(candidate.direction || "").toUpperCase();
  const targetAlreadyPassed = direction === "BUY" ? price >= Number(candidate.tp1)
    : direction === "SELL" ? price <= Number(candidate.tp1) : false;
  const valid = (direction === "BUY" || direction === "SELL") && deviation <= maxDeviation && !targetAlreadyPassed;
  return { valid, reason: valid ? null : targetAlreadyPassed ? "tp1_already_reached" : "live_price_too_far_from_entry",
    livePrice: price, deviation, maxDeviation, deviationR: deviation / risk };
}

function latestCandidates(markets) {
  // Keep every distinct completed-candle candidate visible to the dashboard.
  // The signalId is the deduplication key: the same candidate can appear in
  // both signals and recentSignals, but separate candle entries remain distinct.
  const unique = new Map();
  for (const market of Object.values(markets || {})) {
    const candidates = [...(market.signals || []), ...(market.recentSignals || [])]
      .filter(s => s && s.state === "signal" && s.signalId && s.category && s.category !== "SWING" && ["STRONG", "VALID"].includes(s.quality));
    for (const candidate of candidates) {
      if (!unique.has(candidate.signalId)) unique.set(candidate.signalId, candidate);
    }
  }
  // Process oldest first so a burst of recovered recent candles is delivered
  // in chronological order. Freshness and live-entry checks still apply per item.
  return [...unique.values()].sort((a, b) =>
    Number(a.entryCandleEpoch) - Number(b.entryCandleEpoch) ||
    String(a.signalId).localeCompare(String(b.signalId))
  );
}

async function sendCandidateAlerts(markets, journal, nowEpoch, env, options = {}) {
  const log = options.log || (() => {});
  const persist = options.persist || (() => {});
  const fetchImpl = options.fetchImpl || fetch;
  const liveQuotes = options.liveQuotes || {};
  const workerUrl = String(env.TELEGRAM_WORKER_URL || "").replace(/\/+$/, "");
  const hasWorkerAuth = Boolean(workerUrl && env.SIGNAL_API_KEY);
  const telegramEnabled = env.MTF_TELEGRAM_ALERTS === "true" && hasWorkerAuth;
  const executionEnabled = env.MT5_EXECUTION_QUEUE_ENABLED === "true" && hasWorkerAuth;
  const result = { enabled: telegramEnabled, executionEnabled, considered: 0, sent: 0, executionQueued: 0, executionFailed: 0, stale: 0, missed: 0, quoteUnavailable: 0, failed: 0, skipped: 0 };
  if (!telegramEnabled && !executionEnabled) {
    log("mtf_alerts_disabled", { reason: "telegram_and_execution_flags_off_or_worker_secrets_missing" });
    return result;
  }

  const records = new Map((journal.signals || []).map(s => [s.signalId, s]));
  for (const candidate of latestCandidates(markets)) {
    result.considered++;
    const record = records.get(candidate.signalId);
    if (!record || !["pending", "tp1_hit"].includes(record.status)) { result.skipped++; continue; }
    const executionEligible = MT5_EXECUTION_MARKETS.has(String(candidate.marketId || ""));
    const needQueue = executionEnabled && executionEligible && record.mt5QueueStatus !== "queued" && record.mt5QueueStatus !== "stale";
    const needTelegram = telegramEnabled && !record.telegramStatus;
    if (!needQueue && !needTelegram) { result.skipped++; continue; }

    const freshness = signalFreshness(candidate, nowEpoch);
    if (!freshness.fresh) {
      if (needQueue) {
        record.mt5QueueStatus = "stale";
        record.mt5QueueStatusReason = "candidate_outside_close_based_execution_window";
      }
      if (needTelegram) {
        record.telegramStatus = "stale";
        record.telegramStatusReason = "candidate_outside_close_based_alert_window";
        record.telegramAgeSeconds = freshness.ageSeconds;
        record.telegramCandleCloseEpoch = freshness.candleCloseEpoch;
      }
      result.stale++; persist(journal);
      log("mtf_candidate_stale", { signalId: candidate.signalId, ageSeconds: freshness.ageSeconds });
      continue;
    }

    const quote = liveQuotes[candidate.marketId];
    const priceCheck = assessEntryPrice(candidate, quote && quote.price);
    if (!quote || !Number.isFinite(Number(quote.price))) {
      result.quoteUnavailable++;
      log("mtf_live_quote_unavailable", { signalId: candidate.signalId, marketId: candidate.marketId });
      continue;
    }
    if (!priceCheck.valid) {
      if (needQueue) {
        record.mt5QueueStatus = "missed";
        record.mt5QueueStatusReason = priceCheck.reason;
      }
      if (needTelegram) {
        record.telegramStatus = "missed";
        record.telegramStatusReason = priceCheck.reason;
        record.telegramLivePrice = priceCheck.livePrice;
        record.telegramEntryDeviationR = priceCheck.deviationR;
        record.telegramCheckedAt = new Date(nowEpoch * 1000).toISOString();
      }
      result.missed++; persist(journal);
      log("mtf_candidate_missed", { signalId: candidate.signalId, ...priceCheck });
      continue;
    }

    const payload = {
      event: "new_signal", source: "PROMOTED_MTF", reviewAvailable: true, signalId: candidate.signalId,
      marketId: candidate.marketId, category: candidate.category, quality: candidate.quality,
      entryTimeframe: candidate.entryTimeframe, setupTimeframe: candidate.setupTimeframe,
      confirmationTimeframe: candidate.confirmationTimeframe,
      market: String(candidate.market || candidate.marketId) + " | " + String(candidate.categoryLabel || candidate.category),
      direction: candidate.direction, entry: candidate.entry, livePrice: priceCheck.livePrice,
      stopLoss: candidate.stopLoss, tp1: candidate.tp1, tp2: candidate.tp2,
      signalAgeSeconds: freshness.ageSeconds,
      candleCloseEpoch: freshness.candleCloseEpoch, entryDeviationR: Number(priceCheck.deviationR.toFixed(3)),
      priceValidation: "PASS"
    };

    if (needQueue) {
      try {
        const response = await fetchImpl(workerUrl + "/mt5/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": env.SIGNAL_API_KEY },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000)
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.success !== true) throw new Error(body.error || ("Execution queue HTTP " + response.status));
        record.mt5QueueStatus = "queued";
        record.mt5QueueQueuedAt = new Date(nowEpoch * 1000).toISOString();
        record.mt5QueueDuplicate = Boolean(body.duplicate);
        result.executionQueued++; persist(journal);
        log("mt5_signal_queued", { signalId: candidate.signalId, marketId: candidate.marketId, duplicate: Boolean(body.duplicate) });
      } catch (error) {
        record.mt5QueueStatus = "failed";
        record.mt5QueueStatusReason = String(error.message || error).slice(0, 240);
        record.mt5QueueAttemptedAt = new Date(nowEpoch * 1000).toISOString();
        result.executionFailed++; persist(journal);
        log("mt5_signal_queue_failed", { signalId: candidate.signalId, message: record.mt5QueueStatusReason });
      }
    }

    if (needTelegram) {
      try {
        const response = await fetchImpl(workerUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": env.SIGNAL_API_KEY },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000)
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.success !== true) throw new Error(body.error || ("Telegram Worker HTTP " + response.status));
        record.telegramStatus = "sent";
        record.telegramSentAt = new Date(nowEpoch * 1000).toISOString();
        record.telegramAgeSeconds = freshness.ageSeconds;
        record.telegramCandleCloseEpoch = freshness.candleCloseEpoch;
        record.telegramLivePrice = priceCheck.livePrice;
        record.telegramEntryDeviationR = priceCheck.deviationR;
        result.sent++; persist(journal);
        log("mtf_telegram_delivered", { signalId: candidate.signalId, market: candidate.market, category: candidate.category,
          direction: candidate.direction, ageSeconds: freshness.ageSeconds, livePrice: priceCheck.livePrice });
      } catch (error) {
        record.telegramStatus = "delivery_failed";
        record.telegramStatusReason = String(error.message || error).slice(0, 240);
        record.telegramAttemptedAt = new Date(nowEpoch * 1000).toISOString();
        result.failed++; persist(journal);
        log("mtf_telegram_delivery_failed", { signalId: candidate.signalId, message: record.telegramStatusReason });
      }
    }
  }
  return result;
}

const OUTCOME_EVENTS = Object.freeze({
  tp1_hit: "TP1_HIT",
  tp2_hit: "TP2_HIT",
  stopped: "SL_HIT",
  stopped_after_tp1: "SL_AFTER_TP1",
  expired: "EXPIRED",
  ambiguous: "AMBIGUOUS"
});

async function sendOutcomeAlerts(journal, nowEpoch, env, options = {}) {
  const log = options.log || (() => {});
  const persist = options.persist || (() => {});
  const fetchImpl = options.fetchImpl || fetch;
  const liveQuotes = options.liveQuotes || {};
  const result = { enabled: false, considered: 0, sent: 0, failed: 0, skipped: 0 };
  if (env.MTF_TELEGRAM_ALERTS !== "true" || !env.TELEGRAM_WORKER_URL || !env.SIGNAL_API_KEY) {
    log("mtf_outcome_alerts_disabled", { reason: "feature_flag_or_secrets_missing" });
    return result;
  }
  result.enabled = true;
  for (const record of journal.signals || []) {
    if (record.telegramStatus !== "sent") continue;
    const terminal = OUTCOME_EVENTS[record.status];
    const events = [];
    if (record.tp1Hit) events.push("TP1_HIT");
    if (terminal && terminal !== "TP1_HIT") events.push(terminal);
    if (!events.length) continue;
    record.telegramOutcomeEvents ||= {};
    for (const outcome of [...new Set(events)]) {
      if (record.telegramOutcomeEvents[outcome] === "sent") { result.skipped++; continue; }
      result.considered++;
      const quote = liveQuotes[record.marketId];
      const payload = {
        event: "outcome", source: "PROMOTED_MTF", outcome, signalId: record.signalId,
        market: String(record.market || record.marketId) + " | " + String(record.categoryLabel || record.category || ""),
        direction: record.direction, entry: record.entry, stopLoss: record.stopLoss,
        tp1: record.tp1, tp2: record.tp2,
        currentPrice: Number.isFinite(Number(quote?.price)) ? Number(quote.price) : undefined,
        afterTp1: record.status === "stopped_after_tp1"
      };
      try {
        const response = await fetchImpl(env.TELEGRAM_WORKER_URL, {
          method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": env.SIGNAL_API_KEY },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(15000)
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.success !== true) throw new Error(body.error || ("Telegram Worker HTTP " + response.status));
        record.telegramOutcomeEvents[outcome] = "sent";
        record.telegramOutcomeSentAt = new Date(nowEpoch * 1000).toISOString();
        result.sent++;
        persist(journal);
        log("mtf_outcome_delivered", { signalId: record.signalId, outcome });
      } catch (error) {
        record.telegramOutcomeAttempts ||= {};
        record.telegramOutcomeAttempts[outcome] = Number(record.telegramOutcomeAttempts[outcome] || 0) + 1;
        record.telegramOutcomeError = String(error.message || error).slice(0, 240);
        result.failed++;
        persist(journal);
        log("mtf_outcome_delivery_failed", { signalId: record.signalId, outcome, message: record.telegramOutcomeError });
        // Do not send a later terminal update before an earlier TP1 update is confirmed.
        break;
      }
    }
  }
  return result;
}

module.exports = { ENTRY_TIMEFRAME_SECONDS, ALERT_MAX_AGE_SECONDS, MAX_ENTRY_DEVIATION_R, signalFreshness, assessEntryPrice, latestCandidates, sendCandidateAlerts, sendOutcomeAlerts, OUTCOME_EVENTS };
