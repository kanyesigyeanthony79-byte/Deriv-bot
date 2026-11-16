"use strict";

// Sends only newly observed, recent multi-timeframe candidates to the existing Telegram Worker.
// Freshness is measured from the CLOSE of the entry candle, not its opening timestamp.
// No order execution. The feature flag is an independent kill switch.
const ENTRY_TIMEFRAME_SECONDS = Object.freeze({ M1: 60, M5: 300, H4: 14400 });
const ALERT_MAX_AGE_SECONDS = Object.freeze({
  SCALP: 10 * 60,
  SHORT_TERM: 30 * 60,
  POSITION: 4 * 60 * 60
});

function signalFreshness(candidate, nowEpoch) {
  const timeframeSeconds = ENTRY_TIMEFRAME_SECONDS[candidate.entryTimeframe];
  const candleCloseEpoch = Number(candidate.entryCandleEpoch) + Number(timeframeSeconds);
  const ageSeconds = Number(nowEpoch) - candleCloseEpoch;
  const maxAgeSeconds = ALERT_MAX_AGE_SECONDS[candidate.category];
  return {
    candleCloseEpoch,
    ageSeconds,
    maxAgeSeconds,
    fresh: Number.isFinite(candleCloseEpoch) && Number.isFinite(ageSeconds) &&
      ageSeconds >= 0 && Boolean(maxAgeSeconds) && ageSeconds <= maxAgeSeconds
  };
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
  const result = { enabled: false, considered: 0, sent: 0, stale: 0, failed: 0, skipped: 0 };

  if (env.MTF_TELEGRAM_ALERTS !== "true") {
    log("mtf_telegram_disabled", { reason: "feature_flag_off" });
    return result;
  }
  if (!env.TELEGRAM_WORKER_URL || !env.SIGNAL_API_KEY) {
    log("mtf_telegram_disabled", { reason: "telegram_secrets_missing" });
    return result;
  }
  result.enabled = true;
  const records = new Map((journal.signals || []).map(s => [s.signalId, s]));

  for (const candidate of latestCandidates(markets)) {
    result.considered++;
    const record = records.get(candidate.signalId);
    if (!record || record.telegramStatus) {
      result.skipped++;
      continue;
    }
    const freshness = signalFreshness(candidate, nowEpoch);
    if (!freshness.fresh) {
      record.telegramStatus = "stale";
      record.telegramStatusReason = "candidate_outside_close_based_alert_window";
      record.telegramAgeSeconds = freshness.ageSeconds;
      record.telegramCandleCloseEpoch = freshness.candleCloseEpoch;
      result.stale++;
      persist(journal);
      log("mtf_candidate_stale", { signalId: candidate.signalId, ageSeconds: freshness.ageSeconds, candleCloseEpoch: freshness.candleCloseEpoch });
      continue;
    }

    const payload = {
      event: "new_signal",
      reviewAvailable: true,
      signalId: candidate.signalId,
      market: String(candidate.market || candidate.marketId) + " | " + String(candidate.categoryLabel || candidate.category),
      direction: candidate.direction,
      entry: candidate.entry,
      stopLoss: candidate.stopLoss,
      tp1: candidate.tp1,
      tp2: candidate.tp2,
      signalAgeSeconds: freshness.ageSeconds,
      entryTimeframe: candidate.entryTimeframe,
      candleCloseEpoch: freshness.candleCloseEpoch
    };
    try {
      const response = await fetchImpl(env.TELEGRAM_WORKER_URL, {
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
      result.sent++;
      persist(journal);
      log("mtf_telegram_delivered", { signalId: candidate.signalId, market: candidate.market, category: candidate.category, direction: candidate.direction, ageSeconds: freshness.ageSeconds });
    } catch (error) {
      record.telegramStatus = "delivery_failed";
      record.telegramStatusReason = String(error.message || error).slice(0, 240);
      record.telegramAttemptedAt = new Date(nowEpoch * 1000).toISOString();
      result.failed++;
      persist(journal);
      log("mtf_telegram_delivery_failed", { signalId: candidate.signalId, category: candidate.category, message: record.telegramStatusReason });
    }
  }
  return result;
}

module.exports = { ENTRY_TIMEFRAME_SECONDS, ALERT_MAX_AGE_SECONDS, signalFreshness, latestCandidates, sendCandidateAlerts };
