"use strict";

const { makePolicy, assessNewPosition, positionsPastTimeLimit } = require("./account_risk");

const ALLOWED_CONTRACT_TYPES = new Set(["CALL", "PUT"]);
const APPROVED_SYNTHETIC_SYMBOLS = new Set(["R_10", "R_25", "R_50", "R_75", "JD100", "CRASH500", "BOOM500"]);

function positive(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(name + " must be positive");
  return n;
}

function isDemoUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "wss:" &&
      u.hostname === "api.derivws.com" &&
      u.pathname === "/trading/v1/options/ws/demo" &&
      Boolean(u.searchParams.get("otp"));
  } catch (_) { return false; }
}

function unwrap(response, key) {
  if (!response || response.error) {
    const message = response && response.error && response.error.message;
    throw new Error(key + "_request_failed" + (message ? ": " + message : ""));
  }
  if (!response[key]) throw new Error(key + "_response_missing");
  return response[key];
}

class DerivDemoAdapter {
  constructor({ connection, websocketUrl, accountId, allowedSymbols, policy, now = () => Date.now() }) {
    if (!isDemoUrl(websocketUrl)) throw new Error("demo_websocket_required");
    if (!connection || typeof connection.ask !== "function" || typeof connection.close !== "function") {
      throw new Error("authenticated_connection_required");
    }
    if (!accountId) throw new Error("expected_demo_account_id_required");
    if (!Array.isArray(allowedSymbols) || !allowedSymbols.length) throw new Error("explicit_synthetic_symbol_allowlist_required");
    const requestedSymbols = allowedSymbols.map(x => String(x).toUpperCase());
    if (requestedSymbols.some(symbol => !APPROVED_SYNTHETIC_SYMBOLS.has(symbol))) {
      throw new Error("symbol_allowlist_contains_non_approved_synthetic");
    }
    this.connection = connection;
    this.accountId = String(accountId).toUpperCase();
    this.allowedSymbols = new Set(requestedSymbols);
    this.policy = makePolicy(policy);
    this.now = now;
    this.entryOutcomeUnknown = false;
    this.closeInFlight = new Set();
  }

  async request(payload, key) {
    const response = await this.connection.ask(payload);
    return unwrap(response, key);
  }

  async getBalance() {
    const result = await this.request({ balance: 1 }, "balance");
    if (!Number.isFinite(Number(result.balance))) throw new Error("balance_value_invalid");
    const returnedAccountId = String(result.loginid || "").toUpperCase();
    if (!returnedAccountId || returnedAccountId !== this.accountId) {
      throw new Error("demo_account_identity_mismatch");
    }
    return result;
  }

  async getPortfolio() {
    const result = await this.request({ portfolio: 1 }, "portfolio");
    if (!Array.isArray(result.contracts)) throw new Error("portfolio_contracts_missing");
    return result.contracts;
  }

  async getContractStatus(contractId) {
    positive(contractId, "contractId");
    const status = await this.request({ proposal_open_contract: 1, contract_id: Number(contractId) }, "proposal_open_contract");
    if (Number(status.contract_id) !== Number(contractId)) throw new Error("open_contract_identity_mismatch");
    return status;
  }

  async getAccountSnapshot({ dayStartEquity, sessionPeakEquity }) {
    const [balanceResponse, contracts] = await Promise.all([this.getBalance(), this.getPortfolio()]);
    const positions = await Promise.all(contracts.map(async contract => {
      const id = Number(contract.contract_id);
      const status = await this.getContractStatus(id);
      const stake = Number(status.buy_price ?? contract.buy_price);
      const bidPrice = Number(status.bid_price);
      const profit = Number(status.profit);
      const openedAt = Number(status.date_start ?? contract.date_start);
      if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(stake) || stake < 0 ||
          !Number.isFinite(openedAt) || (!Number.isFinite(bidPrice) && !Number.isFinite(profit))) {
        throw new Error("open_contract_reconciliation_incomplete");
      }
      return {
        contractId: id,
        symbol: status.underlying ?? contract.underlying,
        contractType: status.contract_type ?? contract.contract_type,
        stake,
        remainingRisk: stake,
        openedAt: openedAt * 1000,
        currentValue: Number.isFinite(bidPrice) ? bidPrice : Math.max(0, stake + profit),
        profit: Number.isFinite(profit) ? profit : bidPrice - stake,
        isValidToSell: status.is_valid_to_sell === 1 || status.is_valid_to_sell === true
      };
    }));
    const balance = Number(balanceResponse.balance);
    const equity = balance + positions.reduce((sum, p) => sum + p.currentValue, 0);
    if (!Number.isFinite(equity) || equity <= 0) throw new Error("account_equity_unavailable");
    return {
      mode: "demo",
      accountId: this.accountId,
      currency: balanceResponse.currency || null,
      balance,
      equity,
      dayStartEquity: Number(dayStartEquity),
      sessionPeakEquity: Number(sessionPeakEquity),
      fetchedAtMs: this.now(),
      openPositions: positions
    };
  }

  async openPosition({ symbol, contractType, duration, durationUnit = "m", dayStartEquity, sessionPeakEquity }) {
    if (this.entryOutcomeUnknown) return { opened: false, reason: "previous_buy_outcome_requires_manual_reconciliation" };
    const normalizedSymbol = String(symbol || "").toUpperCase();
    if (!this.allowedSymbols.has(normalizedSymbol)) return { opened: false, reason: "symbol_not_allowlisted" };
    const type = String(contractType || "").toUpperCase();
    if (!ALLOWED_CONTRACT_TYPES.has(type)) return { opened: false, reason: "unsupported_contract_type" };
    const durationValue = positive(duration, "duration");
    const unit = String(durationUnit);
    const durationMinutes = unit === "m" ? durationValue : unit === "h" ? durationValue * 60 : unit === "s" ? durationValue / 60 : NaN;
    if (!Number.isFinite(durationMinutes) || durationMinutes > this.policy.maxHoldingMinutes) {
      return { opened: false, reason: "contract_duration_exceeds_60_minute_ceiling" };
    }

    let snapshot;
    try {
      snapshot = await this.getAccountSnapshot({ dayStartEquity, sessionPeakEquity });
    } catch (_) {
      return { opened: false, reason: "account_or_portfolio_reconciliation_failed" };
    }
    const decision = assessNewPosition(snapshot, this.policy, this.now());
    if (!decision.allowed) return { opened: false, reason: decision.reason, risk: decision };

    let proposalResponse;
    try {
      proposalResponse = await this.request({
        proposal: 1,
        amount: decision.stake,
        basis: "stake",
        contract_type: type,
        currency: snapshot.currency,
        duration: durationValue,
        duration_unit: unit,
        underlying_symbol: normalizedSymbol
      }, "proposal");
    } catch (_) {
      return { opened: false, reason: "proposal_request_failed" };
    }
    const proposalId = proposalResponse.id;
    const askPrice = Number(proposalResponse.ask_price);
    if (!proposalId || !Number.isFinite(askPrice) || askPrice <= 0 || askPrice > decision.stake * 1.001) {
      return { opened: false, reason: "proposal_price_invalid_or_above_risk_budget" };
    }

    let buyResponse;
    try {
      buyResponse = await this.request({ buy: proposalId, price: askPrice }, "buy");
    } catch (error) {
      // Never retry an ambiguous buy: it may have reached the broker even if its
      // acknowledgement was lost. Require an operator to reconcile before entries.
      this.entryOutcomeUnknown = true;
      return { opened: false, reason: "buy_outcome_unknown_manual_reconciliation_required" };
    }
    const contractId = Number(buyResponse.contract_id);
    if (!Number.isFinite(contractId) || contractId <= 0) {
      this.entryOutcomeUnknown = true;
      return { opened: false, reason: "buy_receipt_incomplete_manual_reconciliation_required" };
    }
    return {
      opened: true,
      contractId,
      symbol: normalizedSymbol,
      contractType: type,
      stake: Number(buyResponse.buy_price ?? askPrice),
      balanceAfter: Number.isFinite(Number(buyResponse.balance_after)) ? Number(buyResponse.balance_after) : null,
      risk: decision
    };
  }

  async closeContract(contractId, reason = "profit_or_risk_exit") {
    const id = Number(contractId);
    positive(id, "contractId");
    if (this.closeInFlight.has(id)) return { closed: false, reason: "close_already_in_progress" };
    this.closeInFlight.add(id);
    try {
      const status = await this.getContractStatus(id);
      if (status.is_valid_to_sell !== 1 && status.is_valid_to_sell !== true) {
        return { closed: false, reason: "contract_not_currently_sellable", contractId: id };
      }
      const sold = await this.request({ sell: id, price: 0 }, "sell");
      const contracts = await this.getPortfolio();
      const stillOpen = contracts.some(c => Number(c.contract_id) === id);
      if (stillOpen) return { closed: false, reason: "broker_close_not_confirmed", contractId: id };
      return { closed: true, contractId: id, reason, soldFor: Number(sold.sold_for ?? sold.price ?? NaN) };
    } finally {
      this.closeInFlight.delete(id);
    }
  }

  async enforceHoldingLimit({ dayStartEquity, sessionPeakEquity }) {
    const snapshot = await this.getAccountSnapshot({ dayStartEquity, sessionPeakEquity });
    const due = positionsPastTimeLimit(snapshot.openPositions, this.now(), this.policy);
    const results = [];
    for (const item of due) {
      const position = snapshot.openPositions.find(p => p.contractId === Number(item.contractId));
      if (!position) continue;
      if (!position.isValidToSell) {
        results.push({ contractId: position.contractId, closed: false, reason: "holding_limit_reached_but_contract_not_sellable" });
        continue;
      }
      results.push(await this.closeContract(position.contractId, item.reason));
    }
    return results;
  }

  close() {
    this.connection.close();
  }
}

module.exports = { DerivDemoAdapter, isDemoUrl, APPROVED_SYNTHETIC_SYMBOLS };
