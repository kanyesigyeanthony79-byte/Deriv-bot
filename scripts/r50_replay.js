"use strict";

// Reproducible, research-only R_50 M15 replay. Never places or manages trades.
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_ARCHIVE = path.join(__dirname, "..", "strategy_research_candles.json");
const MARKET = "R_50";
const TIMEFRAME_SECONDS = 900;
const WARMUP = 64;
const HORIZON = 16;
const SIGNAL_SPACING = 4;
const DISCOVERY_FRACTION = 0.60;
const MIN_DISCOVERY_RESOLVED = 15;

function validateBars(bars) {
  if (!Array.isArray(bars) || bars.length < 200) {
    throw new Error("R_50 needs at least 200 M15 candles for this research replay.");
  }
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    for (const key of ["epoch", "open", "high", "low", "close"]) {
      if (!Number.isFinite(Number(b[key]))) throw new Error(`Invalid R_50 candle ${i}: ${key}`);
    }
    if (!(b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close) && b.high >= b.low)) {
      throw new Error(`Invalid OHLC range in R_50 candle ${i}`);
    }
    if (i && b.epoch - bars[i - 1].epoch !== TIMEFRAME_SECONDS) {
      throw new Error(`R_50 M15 archive has a gap or duplicate at index ${i}; refusing replay.`);
    }
  }
}

function ema(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  const alpha = 2 / (period + 1);
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  out[period - 1] = current;
  for (let i = period; i < values.length; i++) out[i] = current = values[i] * alpha + current * (1 - alpha);
  return out;
}

function rsi(values, period = 14) {
  const out = Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  gains /= period;
  losses /= period;
  const value = () => losses === 0 ? (gains === 0 ? 50 : 100) : 100 - 100 / (1 + gains / losses);
  out[period] = value();
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    gains = (gains * (period - 1) + Math.max(change, 0)) / period;
    losses = (losses * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = value();
  }
  return out;
}

function atr(bars, period = 14) {
  const out = Array(bars.length).fill(null);
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const previousClose = bars[i - 1].close;
    tr.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - previousClose),
      Math.abs(bars[i].low - previousClose)
    ));
  }
  if (tr.length < period) return out;
  let current = tr.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  out[period] = current;
  for (let i = period + 1; i < bars.length; i++) {
    current = (current * (period - 1) + tr[i - 1]) / period;
    out[i] = current;
  }
  return out;
}

function buildFeatures(bars) {
  const closes = bars.map(bar => bar.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const momentum = rsi(closes, 14);
  const volatility = atr(bars, 14);
  return bars.map((bar, i) => ({ e20: e20[i], e50: e50[i], rsi: momentum[i], atr: volatility[i] }));
}

function candidateGrid() {
  const configs = [];
  for (const pullback of [false, true]) {
    for (const bodyMin of [0, 0.35, 0.5]) {
      for (const rsiMode of ["off", "mid", "strong"]) {
        for (const stopAtr of [0.75, 1, 1.25, 1.5]) {
          for (const rewardRisk of [0.75, 1, 1.25, 1.5, 2]) {
            configs.push({ pullback, bodyMin, rsiMode, stopAtr, rewardRisk });
          }
        }
      }
    }
  }
  return configs;
}

function getDirection(bar, feature, config) {
  if (!feature || !(feature.atr > 0) || !Number.isFinite(feature.e50) || !Number.isFinite(feature.rsi)) return 0;
  const direction = feature.e20 > feature.e50 ? 1 : -1;
  if (direction * (bar.close - feature.e20) <= 0) return 0;

  if (config.pullback) {
    const valid = direction === 1
      ? bar.low <= feature.e20 + feature.atr * 0.25 && bar.close > feature.e20 && bar.close > bar.open
      : bar.high >= feature.e20 - feature.atr * 0.25 && bar.close < feature.e20 && bar.close < bar.open;
    if (!valid) return 0;
  }

  const range = bar.high - bar.low;
  if (config.bodyMin > 0) {
    if (!(range > 0) || Math.abs(bar.close - bar.open) / range < config.bodyMin) return 0;
    if (direction * (bar.close - bar.open) <= 0) return 0;
  }

  if (config.rsiMode === "mid") {
    const valid = direction === 1
      ? feature.rsi >= 50 && feature.rsi <= 68
      : feature.rsi >= 32 && feature.rsi <= 50;
    if (!valid) return 0;
  } else if (config.rsiMode === "strong") {
    const valid = direction === 1
      ? feature.rsi >= 55 && feature.rsi <= 72
      : feature.rsi >= 28 && feature.rsi <= 45;
    if (!valid) return 0;
  }
  return direction;
}

function scoreCandidate(bars, features, config, from, to) {
  const outcomes = [];
  let lastSignal = -Infinity;
  for (let i = Math.max(WARMUP, from); i < Math.min(to - 1, bars.length - HORIZON); i++) {
    const direction = getDirection(bars[i], features[i], config);
    if (!direction || i - lastSignal < SIGNAL_SPACING) continue;

    const entry = bars[i + 1].open;
    const risk = features[i].atr * config.stopAtr;
    const stop = entry - direction * risk;
    const target = entry + direction * risk * config.rewardRisk;
    let status = "time_exit";

    for (let j = i + 1; j <= Math.min(i + HORIZON, to - 1); j++) {
      const bar = bars[j];
      const stopTouched = direction === 1 ? bar.low <= stop : bar.high >= stop;
      const targetTouched = direction === 1 ? bar.high >= target : bar.low <= target;
      if (stopTouched && targetTouched) { status = "ambiguous"; break; }
      if (stopTouched) { status = "loss"; break; }
      if (targetTouched) { status = "win"; break; }
    }
    outcomes.push(status);
    lastSignal = i;
  }

  const resolved = outcomes.filter(value => value === "win" || value === "loss");
  const wins = resolved.filter(value => value === "win").length;
  const losses = resolved.length - wins;
  return {
    signals: outcomes.length,
    resolved: resolved.length,
    wins,
    losses,
    ambiguous: outcomes.filter(value => value === "ambiguous").length,
    timeExits: outcomes.filter(value => value === "time_exit").length,
    winRatePct: resolved.length ? Number((100 * wins / resolved.length).toFixed(1)) : null,
    expectancyR: resolved.length
      ? Number(((wins * config.rewardRisk - losses) / resolved.length).toFixed(3))
      : null
  };
}

function runReplay(bars) {
  validateBars(bars);
  const features = buildFeatures(bars);
  const split = Math.floor(bars.length * DISCOVERY_FRACTION);
  const candidates = candidateGrid().map(config => ({
    config,
    discovery: scoreCandidate(bars, features, config, 0, split),
    holdout: scoreCandidate(bars, features, config, split, bars.length)
  }));

  const ranked = candidates
    .filter(item => item.discovery.resolved >= MIN_DISCOVERY_RESOLVED)
    .sort((a, b) => (b.discovery.expectancyR ?? -Infinity) - (a.discovery.expectancyR ?? -Infinity));

  // Freeze the top discovery-ranked configuration before reading its holdout result.
  // This is a research lock only; it does not enable or publish trading signals.
  const frozenConfig = ranked[0]?.config ?? null;
  const frozenCandidate = frozenConfig ? {
    config: frozenConfig,
    discovery: scoreCandidate(bars, features, frozenConfig, 0, split),
    holdout: scoreCandidate(bars, features, frozenConfig, split, bars.length)
  } : null;
  const baselineConfig = {
    pullback: false,
    bodyMin: 0,
    rsiMode: "off",
    stopAtr: 1.5,
    rewardRisk: 2
  };
  const baseline = {
    config: baselineConfig,
    discovery: scoreCandidate(bars, features, baselineConfig, 0, split),
    holdout: scoreCandidate(bars, features, baselineConfig, split, bars.length)
  };

  const report = {
    generatedAt: new Date().toISOString(),
    status: "research_only_not_approved_for_promotion",
    market: MARKET,
    timeframe: "M15",
    bars: bars.length,
    firstEpoch: bars[0].epoch,
    lastEpoch: bars[bars.length - 1].epoch,
    continuity: "verified_15_minute_intervals",
    split: {
      method: "chronological",
      discoveryBars: split,
      holdoutBars: bars.length - split,
      discoveryFraction: DISCOVERY_FRACTION
    },
    assumptions: {
      signalUsesCompletedCandle: true,
      entry: "next_candle_open",
      direction: "EMA20_vs_EMA50_and_close_vs_EMA20",
      pullback: "EMA20_zone_within_0.25_ATR_and_directional_close",
      bodyFilter: "directional_body_at_least_configured_fraction_of_range",
      rsi: "14_period_RSI",
      stop: "ATR14_multiple",
      target: "fixed_reward_risk_multiple",
      maxHoldingBars: HORIZON,
      minimumSignalSpacingBars: SIGNAL_SPACING,
      sameBarStopTarget: "ambiguous_excluded_from_resolved_win_rate",
      timeExit: "reported_separately_excluded_from_resolved_win_rate",
      costs: "spread_slippage_fees_and_execution_not_modelled"
    },
    candidateCount: candidateGrid().length,
    minimumDiscoveryResolved: MIN_DISCOVERY_RESOLVED,
    selectionRule: "Freeze highest discovery expectancy candidate meeting minimum discovery resolved count; do not select or tune using holdout outcomes.",
    frozenCandidate,
    baseline,
    topDiscoveryCandidates: ranked.slice(0, 20),
    warning: "Candidate selection and one historical window create selection/regime risk. Holdout counts are not proof of a durable edge. Do not promote without larger unseen and forward shadow samples."
  };
  return report;
}

function loadArchive(filePath = DEFAULT_ARCHIVE) {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const bars = payload.markets?.[MARKET];
  if (!Array.isArray(bars)) throw new Error(`Archive does not contain ${MARKET} candles.`);
  return bars.map(bar => ({
    epoch: Number(bar.epoch),
    open: Number(bar.open),
    high: Number(bar.high),
    low: Number(bar.low),
    close: Number(bar.close)
  }));
}

if (require.main === module) {
  const archivePath = process.argv[2] || DEFAULT_ARCHIVE;
  const outputPath = process.argv[3] || null;
  const report = runReplay(loadArchive(archivePath));
  const rendered = JSON.stringify(report, null, 2) + "\n";
  if (outputPath) fs.writeFileSync(outputPath, rendered);
  else process.stdout.write(rendered);
}

module.exports = {
  validateBars,
  ema,
  rsi,
  atr,
  buildFeatures,
  candidateGrid,
  getDirection,
  scoreCandidate,
  runReplay,
  loadArchive
};
