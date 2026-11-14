"use strict";

// Sends only newly observed, recent multi-timeframe candidates to the existing Telegram Worker.
// No order execution. The feature flag is an independent kill switch.
const ALERT_MAX_AGE_SECONDS = Object.freeze({
  SCALP: 15 * 60,
  SHORT_TERM: 60 * 60,
  POSITION: 24 * 60 * 60
});

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
    const age = nowEpoch - Number(candidate.entryCandleEpoch);
    const maxAge = ALERT_MAX_AGE_SECONDS[candidate.category];
    if (!Number.isFinite(age) || age < 0 || !maxAge || age > maxAge) {
      record.telegramStatus = "stale";
      record.telegramStatusReason = "candidate_outside_alert_age_window";
      result.stale++;
      persist(journal);
      log("mtf_candidate_stale", { signalId: candidate.signalId, ageSeconds: age });
      continue;
    }

    const payload = {
      event: "new_signal",
      signalId: candidate.signalId,
      market: String(candidate.market || candidate.marketId) + " | " + String(candidate.categoryLabel || candidate.category),
      direction: candidate.direction,
      entry: candidate.entry,
      stopLoss: candidate.stopLoss,
      tp1: candidate.tp1,
      tp2: candidate.tp2
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
      result.sent++;
      persist(journal);
      log("mtf_telegram_delivered", { signalId: candidate.signalId, market: candidate.market, category: candidate.category, direction: candidate.direction });
    } catch (error) {
      // Mark the attempt terminal to avoid duplicate Telegram messages if the relay accepted
      // the message but its response was lost. A failed/uncertain delivery is visible in the journal.
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

module.exports = { ALERT_MAX_AGE_SECONDS, latestCandidates, sendCandidateAlerts };
