"use strict";

/**
 * Hard budget caps per thread and per automation (#286).
 *
 * A cap lives on the thread row (`thread.budget`), never in the transcript:
 * it is harness state, so context compaction, rewind and session resets
 * cannot drop it. Automations and agent profiles carry a default that is
 * stamped onto the thread they start or are applied to.
 *
 * usd / tokens / turns are lifetime totals of the thread's usage ledger
 * (store.getUsage). minutes is wall-clock per run. A crossed cap refuses the
 * next start and stops a live run; it never silently continues.
 */

/** @typedef {{ usd?: number, tokens?: number, turns?: number, minutes?: number }} Budget */

const FIELDS = /** @type {const} */ (["usd", "tokens", "turns", "minutes"]);

/**
 * Absent / null / {} → null. Strict throws on junk; lenient (disk reads)
 * drops bad fields.
 * @param {unknown} raw
 * @param {boolean} [strict]
 * @returns {Budget | null}
 */
function normalizeBudget(raw, strict = false) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    if (strict) throw new Error("budget must be an object or null");
    return null;
  }
  /** @type {Record<string, unknown>} */
  const rec = /** @type {any} */ (raw);
  /** @type {Budget} */
  const out = {};
  for (const key of FIELDS) {
    const v = rec[key];
    if (v == null) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      if (strict) throw new Error(`budget.${key} must be a positive number or null`);
      continue;
    }
    out[key] = key === "usd" ? v : Math.ceil(v);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Patch that adopts a profile's / automation's default cap. A source with no
 * cap leaves the thread's own cap alone (never loosens by omission).
 * @param {{ budget?: unknown } | null | undefined} source
 * @returns {{ budget?: Budget }}
 */
function budgetPatchFrom(source) {
  const budget = normalizeBudget(source && source.budget);
  return budget ? { budget } : {};
}

/**
 * First crossed cap as a human sentence, or null. `minutes` only counts
 * while a run is live (runStartedAt set).
 * @param {{ budget?: unknown, runStartedAt?: unknown } | null | undefined} thread
 * @param {{ costUsd?: number, inputTokens?: number, outputTokens?: number, turns?: number } | null | undefined} usage
 * @param {number} [now]
 * @returns {string | null}
 */
function budgetBreach(thread, usage, now = Date.now()) {
  const budget = normalizeBudget(thread && thread.budget);
  if (!budget) return null;
  const u = usage || {};
  const cost = Number(u.costUsd) || 0;
  if (budget.usd != null && cost >= budget.usd) {
    return `spent $${cost.toFixed(2)} of a $${budget.usd.toFixed(2)} cap`;
  }
  const tokens = (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0);
  if (budget.tokens != null && tokens >= budget.tokens) {
    return `used ${tokens.toLocaleString("en-US")} of a ${budget.tokens.toLocaleString("en-US")} token cap`;
  }
  const turns = Number(u.turns) || 0;
  if (budget.turns != null && turns >= budget.turns) {
    return `ran ${turns} of a ${budget.turns} turn cap`;
  }
  const started = Number(thread && thread.runStartedAt);
  if (budget.minutes != null && Number.isFinite(started) && started > 0) {
    const mins = (now - started) / 60000;
    if (mins >= budget.minutes) {
      return `ran ${Math.floor(mins)} of a ${budget.minutes} min per-run cap`;
    }
  }
  return null;
}

/**
 * Start-time gate: throws when the thread is already over a cap.
 * @param {import('./store').Store} store
 * @param {object} thread
 */
function assertUnderThreadBudget(store, thread) {
  // runStartedAt is stripped: a stale stamp must not trip the per-run clock
  // on a fresh start.
  const why = budgetBreach(
    { budget: thread.budget },
    store.getUsage(thread.id),
  );
  if (why) {
    throw new Error(
      `Thread budget reached (${why}). Raise or clear this thread's cap to continue.`,
    );
  }
}

module.exports = {
  BUDGET_FIELDS: FIELDS,
  normalizeBudget,
  budgetPatchFrom,
  budgetBreach,
  assertUnderThreadBudget,
};
