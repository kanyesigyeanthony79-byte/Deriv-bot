"use strict";

// Reproducible retrospective screen of delivered MTF_BASELINE_V1 signals.
// Research only: this script does not change scanner or delivery behaviour.
const fs = require("node:fs");
const path = require("node:path");

const journalPath = process.argv[2] || path.join(__dirname, "multi_timeframe_journal.json");
const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
const all = Array.isArray(journal.signals) ? journal.signals : [];
const baseline = all.filter(s =>
  s.strategyVersion === "MTF_BASELINE_V1" &&
  s.telegramStatus === "sent" &&
  s.metrics && s.metrics.entry && s.metrics.confirmation && s.metrics.context
);

const variants = {
  baseline: baseline,
  extensionOnly: baseline.filter(s =>
    s.metrics.confirmation.direction === s.direction &&
    s.metrics.context.direction === s.direction &&
    Number.isFinite(s.metrics.entry.extensionAtr) &&
    s.metrics.entry.extensionAtr <= 1.0
  ),
  candleQualityOnly: baseline.filter(s =>
    s.metrics.confirmation.direction === s.direction &&
    s.metrics.context.direction === s.direction &&
    Number.isFinite(s.metrics.entry.bodyRatio) &&
    s.metrics.entry.bodyRatio >= 0.5 &&
    Number.isFinite(s.metrics.entry.closeLocation) &&
    s.metrics.entry.closeLocation >= 0.65
  ),
  combined: baseline.filter(s =>
    s.metrics.confirmation.direction === s.direction &&
    s.metrics.context.direction === s.direction &&
    Number.isFinite(s.metrics.entry.extensionAtr) &&
    s.metrics.entry.extensionAtr <= 1.0 &&
    Number.isFinite(s.metrics.entry.bodyRatio) &&
    s.metrics.entry.bodyRatio >= 0.5 &&
    Number.isFinite(s.metrics.entry.closeLocation) &&
    s.metrics.entry.closeLocation >= 0.65
  ),
  swingStructureOnly: baseline.filter(s =>
    s.metrics.confirmation.direction === s.direction &&
    s.metrics.context.direction === s.direction &&
    Number.isFinite(s.metrics.entry.swingAtr) &&
    s.metrics.entry.swingAtr >= 0.65
  ),
  trendSlopeOnly: baseline.filter(s =>
    s.metrics.confirmation.direction === s.direction &&
    s.metrics.context.direction === s.direction &&
    Number.isFinite(s.metrics.entry.emaSlopeAtr) &&
    s.metrics.entry.emaSlopeAtr >= 0.39
  )
};

function summarize(rows) {
  const count = status => rows.filter(s => s.status === status).length;
  const tp2 = count("tp2_hit");
  const stopped = count("stopped");
  return {
    signals: rows.length,
    retentionPct: baseline.length ? Number((rows.length / baseline.length * 100).toFixed(1)) : null,
    tp2Hit: tp2,
    stopped: stopped,
    expired: count("expired"),
    pending: count("pending"),
    partialAfterTp1: count("stopped_after_tp1"),
    decisiveOutcomes: tp2 + stopped,
    decisiveWinRatePct: tp2 + stopped ? Number((tp2 / (tp2 + stopped) * 100).toFixed(2)) : null
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  journalUpdatedAt: journal.updatedAt || null,
  source: path.basename(journalPath),
  selection: "strategyVersion=MTF_BASELINE_V1 and telegramStatus=sent",
  baselinePopulation: baseline.length,
  outcomeDefinition: "Decisive win rate = TP2 hits / (TP2 hits + stopped). Expired and pending remain reported separately; no assumption that they are losses or wins.",
  thresholds: { maxExtensionAtr: 1.0, minBodyRatio: 0.5, minCloseLocation: 0.65, minSwingAtr: 0.65, minSlopeAtr: 0.39 },
  warning: "Exploratory retrospective screen only. Small decisive samples, threshold selection bias, overlapping/related signals and no untouched holdout. Not evidence of a live win-rate improvement.",
  variants: Object.fromEntries(Object.entries(variants).map(([name, rows]) => [name, summarize(rows)]))
};
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
