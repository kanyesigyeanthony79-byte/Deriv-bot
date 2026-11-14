"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { assessNewPosition, positionsPastTimeLimit } = require("./account_risk");

function kampalaDate(nowMs) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(nowMs));
}

class JsonBaselineStore {
  constructor(filePath) {
    if (!filePath) throw new Error("baseline_store_path_required");
    this.filePath = path.resolve(filePath);
  }

  load() {
    if (!fs.existsSync(this.filePath)) return null;
    let data;
    try { data = JSON.parse(fs.readFileSync(this.filePath, "utf8")); }
    catch (_) { throw new Error("baseline_store_corrupt_refusing_entries"); }
    if (!data || typeof data !== "object" || data.version !== 1 ||
        !Number.isFinite(data.dayStartEquity) || data.dayStartEquity <= 0 ||
        !Number.isFinite(data.sessionPeakEquity) || data.sessionPeakEquity <= 0 ||
        typeof data.date !== "string") {
      throw new Error("baseline_store_invalid_refusing_entries");
    }
    return data;
  }

  save(data) {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const temp = this.filePath + ".tmp";
    fs.writeFileSync(temp, JSON.stringify({ version: 1, ...data }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }
}

async function initializeBaselineFromVerifiedDemo(adapter, store, now = () => Date.now()) {
  if (!adapter || typeof adapter.getAccountSnapshot !== "function" ||
      !store || typeof store.save !== "function") throw new Error("adapter_and_baseline_store_required");
  const snapshot = await adapter.getAccountSnapshot({ dayStartEquity: 1, sessionPeakEquity: 1 });
  if (snapshot.mode !== "demo" || !snapshot.accountId) throw new Error("verified_demo_snapshot_required");
  if (snapshot.openPositions.length !== 0) throw new Error("baseline_initialization_requires_no_open_positions");
  const timestamp = now();
  const baseline = {
    date: kampalaDate(timestamp),
    dayStartEquity: snapshot.equity,
    sessionPeakEquity: snapshot.equity,
    updatedAt: new Date(timestamp).toISOString(),
    accountId: snapshot.accountId,
    currency: snapshot.currency
  };
  store.save(baseline);
  return baseline;
}

class DemoExecutionManager {
  constructor({
    adapter,
    baselineStore,
    allowedSymbols,
    signalEvaluator = null,
    exitEvaluator = null,
    executionEnabled = false,
    strategyApprovalId = null,
    maxEntriesPerCycle = 1,
    maxSignalAgeMs = 60000,
    now = () => Date.now()
  }) {
    if (!adapter || typeof adapter.getAccountSnapshot !== "function" ||
        typeof adapter.closeContract !== "function") throw new Error("demo_adapter_required");
    if (!baselineStore || typeof baselineStore.load !== "function" ||
        typeof baselineStore.save !== "function") throw new Error("persistent_baseline_store_required");
    if (!Array.isArray(allowedSymbols) || !allowedSymbols.length) throw new Error("synthetic_symbol_allowlist_required");
    if (!Number.isInteger(maxEntriesPerCycle) || maxEntriesPerCycle < 0 || maxEntriesPerCycle > 1) {
      throw new Error("max_entries_per_cycle_must_be_zero_or_one");
    }
    this.adapter = adapter;
    this.baselineStore = baselineStore;
    this.allowedSymbols = new Set(allowedSymbols.map(s => String(s).toUpperCase()));
    this.signalEvaluator = signalEvaluator;
    this.exitEvaluator = exitEvaluator;
    this.executionEnabled = executionEnabled === true;
    this.strategyApprovalId = strategyApprovalId;
    if (!Number.isFinite(maxSignalAgeMs) || maxSignalAgeMs < 1000 || maxSignalAgeMs > 60000) throw new Error("max_signal_age_must_be_1_to_60_seconds");
    this.maxEntriesPerCycle = maxEntriesPerCycle;
    this.maxSignalAgeMs = maxSignalAgeMs;
    this.now = now;
    this.cycleInFlight = false;
  }

  async runCycle(marketData) {
    if (this.cycleInFlight) return { status: "skipped", reason: "cycle_already_running" };
    this.cycleInFlight = true;
    try {
      const nowMs = this.now();
      let baseline;
      try { baseline = this.baselineStore.load(); }
      catch (error) {
        return { status: "blocked", reason: error.message };
      }

      // Without a persisted baseline, use harmless placeholder values solely to
      // retrieve the reconciled portfolio. Entry assessment is explicitly blocked.
      const dayStart = baseline ? baseline.dayStartEquity : 1;
      const peak = baseline ? baseline.sessionPeakEquity : 1;
      let snapshot;
      try { snapshot = await this.adapter.getAccountSnapshot({ dayStartEquity: dayStart, sessionPeakEquity: peak }); }
      catch (_) { return { status: "blocked", reason: "demo_account_or_portfolio_reconciliation_failed" }; }

      if (baseline && baseline.accountId && baseline.accountId !== snapshot.accountId) {
        return { status: "blocked", reason: "baseline_account_identity_mismatch" };
      }

      const currentDate = kampalaDate(nowMs);
      if (baseline) {
        if (baseline.date !== currentDate) {
          baseline = { ...baseline, date: currentDate, dayStartEquity: snapshot.equity, sessionPeakEquity: snapshot.equity };
        } else {
          baseline = { ...baseline, sessionPeakEquity: Math.max(baseline.sessionPeakEquity, snapshot.equity) };
        }
        baseline.updatedAt = new Date(nowMs).toISOString();
        this.baselineStore.save(baseline);
        snapshot.dayStartEquity = baseline.dayStartEquity;
        snapshot.sessionPeakEquity = baseline.sessionPeakEquity;
      }

      const actions = [];
      const closedIds = new Set();
      const due = positionsPastTimeLimit(snapshot.openPositions, nowMs, this.adapter.policy);
      for (const item of due) {
        const position = snapshot.openPositions.find(p => Number(p.contractId) === Number(item.contractId));
        if (!position) continue;
        if (!position.isValidToSell) {
          actions.push({ type: "EXIT_BLOCKED", contractId: position.contractId, reason: "holding_limit_reached_contract_not_sellable" });
          continue;
        }
        const result = await this.adapter.closeContract(position.contractId, item.reason);
        actions.push({ type: result.closed ? "EXIT_CONFIRMED" : "EXIT_UNCONFIRMED", ...result });
        if (result.closed) closedIds.add(Number(position.contractId));
      }

      // Additional profit-protection/early-loss exits require an explicit,
      // tested policy callback. There is intentionally no invented threshold.
      if (typeof this.exitEvaluator === "function") {
        for (const position of snapshot.openPositions) {
          if (closedIds.has(Number(position.contractId))) continue;
          const decision = await this.exitEvaluator({ position, snapshot, nowMs });
          if (!decision || decision.exit !== true) continue;
          if (!position.isValidToSell) {
            actions.push({ type: "EXIT_BLOCKED", contractId: position.contractId, reason: "contract_not_sellable", policyReason: decision.reason || null });
            continue;
          }
          const result = await this.adapter.closeContract(position.contractId, decision.reason || "approved_exit_policy");
          actions.push({ type: result.closed ? "EXIT_CONFIRMED" : "EXIT_UNCONFIRMED", ...result });
          if (result.closed) closedIds.add(Number(position.contractId));
        }
      }

      if (!baseline) {
        return { status: "observe_only", reason: "persistent_equity_baseline_not_initialized", accountMode: snapshot.mode, openPositions: snapshot.openPositions.length, actions };
      }
      if (!this.executionEnabled) {
        return { status: "observe_only", reason: "execution_disabled_by_default", accountMode: snapshot.mode, openPositions: snapshot.openPositions.length, actions };
      }
      if (actions.some(action => action.type === "EXIT_BLOCKED" || action.type === "EXIT_UNCONFIRMED")) {
        return { status: "blocked", reason: "unresolved_exit_requires_reconciliation_before_new_entry", actions };
      }
      if (!this.strategyApprovalId || typeof this.signalEvaluator !== "function" || this.maxEntriesPerCycle !== 1) {
        return { status: "blocked", reason: "explicit_strategy_approval_and_single_entry_evaluator_required", actions };
      }

      let candidate;
      try { candidate = await this.signalEvaluator(marketData); }
      catch (_) { return { status: "blocked", reason: "strategy_evaluation_failed", actions }; }
      if (!candidate || candidate.validated !== true || candidate.completedCandlesOnly !== true) {
        return { status: "observe_only", reason: "no_validated_completed_candle_candidate", actions };
      }
      const generatedAtMs = Number(candidate.generatedAtMs);
      if (!Number.isFinite(generatedAtMs) || generatedAtMs > nowMs || nowMs - generatedAtMs > this.maxSignalAgeMs) {
        return { status: "blocked", reason: "candidate_missing_or_stale_timestamp", actions };
      }
      const symbol = String(candidate.symbol || "").toUpperCase();
      const direction = String(candidate.direction || "").toUpperCase();
      const duration = Number(candidate.duration);
      if (!this.allowedSymbols.has(symbol) || !["BUY", "SELL"].includes(direction) ||
          !Number.isFinite(duration) || duration <= 0 || duration > 60) {
        return { status: "blocked", reason: "candidate_symbol_or_direction_not_allowed", actions };
      }
      if (candidate.experimentalReversal === true || candidate.source === "price_action_reversal_research") {
        return { status: "observe_only", reason: "experimental_reversal_engine_not_execution_approved", actions };
      }
      const risk = assessNewPosition(snapshot, this.adapter.policy, nowMs);
      if (!risk.allowed) return { status: "blocked", reason: risk.reason, actions };
      const opened = await this.adapter.openPosition({
        symbol,
        contractType: direction === "BUY" ? "CALL" : "PUT",
        duration: candidate.duration,
        durationUnit: candidate.durationUnit || "m",
        dayStartEquity: baseline.dayStartEquity,
        sessionPeakEquity: baseline.sessionPeakEquity
      });
      actions.push({ type: opened.opened ? "ENTRY_CONFIRMED" : "ENTRY_REJECTED", ...opened });
      return { status: opened.opened ? "executed_demo" : "blocked", actions };
    } finally {
      this.cycleInFlight = false;
    }
  }
}

module.exports = { DemoExecutionManager, JsonBaselineStore, initializeBaselineFromVerifiedDemo, kampalaDate };
