"use strict";

// Pure account-risk policy for the demo scalper. This module never places orders.
// Callers must supply a fresh, reconciled account snapshot from the authenticated
// DEMO account and must fail closed when account or open-contract data is unavailable.

const DEFAULT_POLICY = Object.freeze({
  riskPerPositionPct: 0.5,
  maxOpenRiskPct: 2,
  dailyLossLimitPct: 3,
  drawdownPausePct: 5,
  maxOpenPositions: 5,
  maxHoldingMinutes: 60,
  maxStake: 20,
  minStake: 0.35,
  snapshotMaxAgeSeconds: 30,
  stakeDecimals: 2
});

const HARD_CAPS = Object.freeze({
  riskPerPositionPct: 1,
  maxOpenRiskPct: 3,
  dailyLossLimitPct: 5,
  drawdownPausePct: 8,
  maxOpenPositions: 5,
  maxHoldingMinutes: 60,
  maxStake: 20
});

function finitePositive(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(name + " must be a positive finite number");
  return n;
}

function makePolicy(overrides = {}) {
  const p = { ...DEFAULT_POLICY, ...overrides };
  for (const key of Object.keys(HARD_CAPS)) {
    const n = finitePositive(p[key], key);
    if (n > HARD_CAPS[key]) throw new Error(key + " exceeds the hard safety cap of " + HARD_CAPS[key]);
    p[key] = n;
  }
  if (p.maxOpenPositions > 5 || !Number.isInteger(p.maxOpenPositions)) throw new Error("maxOpenPositions must be an integer from 1 to 5");
  if (!Number.isInteger(p.maxHoldingMinutes) || p.maxHoldingMinutes > 60) throw new Error("maxHoldingMinutes must be an integer from 1 to 60");
  p.minStake = finitePositive(p.minStake, "minStake");
  if (p.minStake > p.maxStake) throw new Error("minStake cannot exceed maxStake");
  p.snapshotMaxAgeSeconds = finitePositive(p.snapshotMaxAgeSeconds, "snapshotMaxAgeSeconds");
  if (!Number.isInteger(p.stakeDecimals) || p.stakeDecimals < 0 || p.stakeDecimals > 6) throw new Error("stakeDecimals must be an integer from 0 to 6");
  if (p.riskPerPositionPct > p.maxOpenRiskPct) throw new Error("riskPerPositionPct cannot exceed maxOpenRiskPct");
  if (p.dailyLossLimitPct > p.drawdownPausePct) throw new Error("dailyLossLimitPct cannot exceed drawdownPausePct");
  return Object.freeze(p);
}

function pctLoss(reference, current) {
  return Math.max(0, (reference - current) / reference * 100);
}

function openRiskOf(position) {
  // remainingRisk must be a broker-derived, current worst-case loss from now.
  // Until the execution adapter can prove that value, reserve the original stake.
  const n = Number(position && position.remainingRisk);
  if (Number.isFinite(n) && n >= 0) return n;
  const stake = Number(position && position.stake);
  if (!Number.isFinite(stake) || stake < 0) throw new Error("Open position is missing a valid stake; refusing new risk");
  return stake;
}

function assessNewPosition(snapshot, policy = makePolicy(), nowMs = Date.now()) {
  const p = policy && Object.isFrozen(policy) ? policy : makePolicy(policy);
  const block = reason => ({ allowed: false, stake: 0, reason });
  if (!snapshot || snapshot.mode !== "demo") return block("demo_account_required");
  const balance = Number(snapshot.balance), equity = Number(snapshot.equity);
  const dayStart = Number(snapshot.dayStartEquity), peak = Number(snapshot.sessionPeakEquity);
  const freshAt = Number(snapshot.fetchedAtMs);
  if (![balance, equity, dayStart, peak, freshAt].every(Number.isFinite) || balance < 0 || equity <= 0 || dayStart <= 0 || peak <= 0) return block("account_snapshot_incomplete");
  if (nowMs < freshAt || (nowMs - freshAt) / 1000 > p.snapshotMaxAgeSeconds) return block("account_snapshot_stale");
  if (!Array.isArray(snapshot.openPositions)) return block("open_positions_unavailable");

  let openRisk;
  try { openRisk = snapshot.openPositions.reduce((sum, position) => sum + openRiskOf(position), 0); }
  catch (e) { return block("open_position_risk_unknown"); }

  const dailyLossPct = pctLoss(dayStart, equity);
  const drawdownPct = pctLoss(peak, equity);
  if (dailyLossPct >= p.dailyLossLimitPct) return block("daily_loss_limit_reached");
  if (drawdownPct >= p.drawdownPausePct) return block("drawdown_pause_reached");
  if (snapshot.openPositions.length >= p.maxOpenPositions) return block("maximum_open_positions_reached");

  const totalRiskCap = equity * p.maxOpenRiskPct / 100;
  const positionRiskCap = equity * p.riskPerPositionPct / 100;
  const remainingRisk = Math.max(0, totalRiskCap - openRisk);
  const stake = Math.floor(Math.min(positionRiskCap, remainingRisk, balance, p.maxStake) * (10 ** p.stakeDecimals)) / (10 ** p.stakeDecimals);
  if (stake < p.minStake) return block("insufficient_risk_budget_or_balance");
  return {
    allowed: true,
    stake,
    currency: snapshot.currency || null,
    openRisk,
    remainingRisk,
    totalRiskCap,
    positionRiskCap,
    dailyLossPct,
    drawdownPct,
    openPositionCount: snapshot.openPositions.length
  };
}

function positionsPastTimeLimit(openPositions, nowMs = Date.now(), policy = makePolicy()) {
  const p = policy && Object.isFrozen(policy) ? policy : makePolicy(policy);
  if (!Array.isArray(openPositions)) throw new Error("openPositions must be an array");
  return openPositions.filter(position => {
    const openedAt = typeof position.openedAt === "number" ? position.openedAt : Date.parse(position.openedAt);
    return Number.isFinite(openedAt) && nowMs - openedAt >= p.maxHoldingMinutes * 60 * 1000;
  }).map(position => ({
    contractId: position.contractId,
    reason: "maximum_holding_time_reached",
    ageMs: nowMs - (typeof position.openedAt === "number" ? position.openedAt : Date.parse(position.openedAt))
  }));
}

module.exports = { DEFAULT_POLICY, HARD_CAPS, makePolicy, assessNewPosition, positionsPastTimeLimit, pctLoss };
