"use strict";

const ENTRY_TIMEFRAME_SECONDS = Object.freeze({ M1: 60, M5: 300, H4: 14400 });
const ALERT_MAX_AGE_SECONDS = Object.freeze({ SCALP: 10 * 60, SHORT_TERM: 30 * 60, POSITION: 4 * 60 * 60 });
const MAX_ENTRY_DEVIATION_R = 0.2;

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
  const latest = new Map();
  for (const market of Object.values(markets || {})) {
    const candidates = [...(market.signals || []), ...(market.recentSignals || [])]
      .filter(s => s && s.state === "signal" && s.signalId && s.category && s.category !== "SWING");
    for (const candidate of candidates) {
      const key = candidate.marketId + ":" + candidate.category;
      const prior = latest.get(key);
      if (!prior || candidate.entryCandleEpoch > prior.entryCandleEpoch) latest.set(key, candidate);
    }
  }
  return [...latest.values()];
}

async function sendCandidateAlerts(markets, journal, nowEpoch, env, options = {}) {
  const log = options.log || (() => {});
  const persist = options.persist || (() => {});
  const fetchImpl = options.fetchImpl || fetch;
  const liveQuotes = options.liveQuotes || {};
  const result = { enabled: false, considered: 0, sent: 0, stale: 0, missed: 0, quoteUnavailable: 0, failed: 0, skipped: 0 };
  if (env.MTF_TELEGRAM_ALERTS !== "true") {
    log("mtf_telegram_disabled", { reason: "feature_flag_off" }); return result;
  }
  if (!env.TELEGRAM_WORKER_URL || !env.SIGNAL_API_KEY) {
    log("mtf_telegram_disabled", { reason: "telegram_secrets_missing" }); return result;
  }
  result.enabled = true;
  const records = new Map((journal.signals || []).map(s => [s.signalId, s]));
  for (const candidate of latestCandidates(markets)) {
    result.considered++;
    const record = records.get(candidate.signalId);
    if (!record || record.telegramStatus) { result.skipped++; continue; }
    const freshness = signalFreshness(candidate, nowEpoch);
    if (!freshness.fresh) {
      record.telegramStatus = "stale";
      record.telegramStatusReason = "candidate_outside_close_based_alert_window";
      record.telegramAgeSeconds = freshness.ageSeconds;
      record.telegramCandleCloseEpoch = freshness.candleCloseEpoch;
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
      record.telegramStatus = "missed";
      record.telegramStatusReason = priceCheck.reason;
      record.telegramLivePrice = priceCheck.livePrice;
      record.telegramEntryDeviationR = priceCheck.deviationR;
      record.telegramCheckedAt = new Date(nowEpoch * 1000).toISOString();
      result.missed++; persist(journal);
      log("mtf_candidate_missed", { signalId: candidate.signalId, ...priceCheck });
      continue;
    }
    const payload = {
      event: "new_signal", reviewAvailable: true, signalId: candidate.signalId,
      market: String(candidate.market || candidate.marketId) + " | " + String(candidate.categoryLabel || candidate.category),
      direction: candidate.direction, entry: candidate.entry, livePrice: priceCheck.livePrice,
      stopLoss: candidate.stopLoss, tp1: candidate.tp1, tp2: candidate.tp2,
      signalAgeSeconds: freshness.ageSeconds, entryTimeframe: candidate.entryTimeframe,
      candleCloseEpoch: freshness.candleCloseEpoch, entryDeviationR: Number(priceCheck.deviationR.toFixed(3)),
      priceValidation: "PASS"
    };
    try {
      const response = await fetchImpl(env.TELEGRAM_WORKER_URL, {
        method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": env.SIGNAL_API_KEY },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15000)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success !== true) throw new Error(body.error || ("Telegram Worker HTTP " + response.status));
      record.telegramStatus = "sent"; record.telegramSentAt = new Date(nowEpoch * 1000).toISOString();
      record.telegramAgeSeconds = freshness.ageSeconds; record.telegramCandleCloseEpoch = freshness.candleCloseEpoch;
      record.telegramLivePrice = priceCheck.livePrice; record.telegramEntryDeviationR = priceCheck.deviationR;
      result.sent++; persist(journal);
      log("mtf_telegram_delivered", { signalId: candidate.signalId, market: candidate.market, category: candidate.category,
        direction: candidate.direction, ageSeconds: freshness.ageSeconds, livePrice: priceCheck.livePrice });
    } catch (error) {
      record.telegramStatus = "delivery_failed"; record.telegramStatusReason = String(error.message || error).slice(0, 240);
      record.telegramAttemptedAt = new Date(nowEpoch * 1000).toISOString(); result.failed++; persist(journal);
      log("mtf_telegram_delivery_failed", { signalId: candidate.signalId, message: record.telegramStatusReason });
    }
  }
  return result;
}
module.exports = { ENTRY_TIMEFRAME_SECONDS, ALERT_MAX_AGE_SECONDS, MAX_ENTRY_DEVIATION_R, signalFreshness, assessEntryPrice, latestCandidates, sendCandidateAlerts };
