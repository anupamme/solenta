"use strict";

// createRunner seam: stall + lane-heartbeat watchdogs (#1447, seam 1).
//
// Seam convention (template for every createRunner split step):
// - One flat file per seam, `electron/runner-<seam>.js`, exporting
//   `create<Seam>(ctx)`. Flat, not `electron/runner/`: package-app.sh and
//   package-cross.sh copy only `electron/*.js`, so a subdirectory would be
//   dropped from the packaged app.
// - `ctx` is built once in createRunner. Destructure deps at the top of the
//   factory so function bodies move verbatim. That is safe only for what
//   already exists when the factory runs: opts bindings, owned Maps, and the
//   hoisted function declarations inside createRunner.
// - Anything that does not exist yet at factory time (functions another seam
//   adds to ctx later, or a const defined after the factory call) must be read
//   lazily at call time: `ctx.startRun(...)`, never destructured.
// - The factory owns the seam's Maps and timers and returns its functions,
//   plus a `dispose()` for stopAll when it owns a timer.
// - Do not require("./runner.js") from a seam (circular); take module-level
//   runner functions such as resolveProvider through ctx.

const { heartbeatLane } = require("./mergeQueue.js");
const { budgetBreach } = require("./budgetCaps.js");
const { priceCell } = require("./modelPrices.js");

/**
 * @param {object} ctx - createRunner context (see header)
 */
function createWatchdogs(ctx) {
  const {
    store,
    active,
    nowFn,
    resolveProvider,
    appendMessage,
    pushDetail,
    pushThreadsChanged,
    hasRunningSubagent,
  } = ctx;

  /**
   * Advisory stall sweep (issue #314). Scans every thread, not just `active`:
   * a working row with no live run is the zombie this issue names. Never
   * kills the CLI — a slow-but-alive stream clears stalledAt via stampLastEvent.
   * STALL_MS is read at check time so a test can shorten the window.
   */
  function checkStalls() {
    const stallMs = Number(process.env.CODER_STALL_MS) || 10 * 60 * 1000;
    const now = Date.now();
    for (const thread of store.getThreads()) {
      if (thread.status !== "working") continue;
      if (thread.awaitingInput) continue;
      if (thread.stalledAt) continue;
      // Background subagents run silently in the parent CLI (kimi -p stays
      // alive for them, #175); "may be hung, Stop" would kill their results.
      if (hasRunningSubagent(thread.id)) continue;
      const last = thread.lastEventAt ?? thread.runStartedAt ?? now;
      if (now - last <= stallMs) continue;
      store.updateThread(thread.id, { stalledAt: now });
      const provider = resolveProvider(thread);
      const mins = Math.max(1, Math.round((now - last) / 60000));
      appendMessage(
        thread.id,
        "event",
        `No output from the ${provider} CLI for ${mins} min — the turn may be hung. Stop and retry if it stays quiet.`,
      );
      store.save();
      pushDetail(thread.id, undefined, { skipStamp: true });
      pushThreadsChanged();
    }
  }

  /**
   * Ledger usage plus the live run's in-flight turn (entry.liveUsage, Claude
   * only for now). The CLI reports no cost mid-turn, so $ is estimated from
   * the user's modelPrices when the model has one; otherwise only tokens bite.
   * @param {any} usage
   * @param {any} entry
   */
  function withLiveUsage(usage, entry) {
    const live = entry && entry.liveUsage;
    if (!live || live.size === 0) return usage;
    const prices = store.getSettings().modelPrices || {};
    const out = { ...(usage || {}) };
    for (const cell of live.values()) {
      out.inputTokens = (Number(out.inputTokens) || 0) + cell.inputTokens;
      out.outputTokens = (Number(out.outputTokens) || 0) + cell.outputTokens;
      const price = cell.model ? prices[cell.model] : undefined;
      if (price) out.costUsd = (Number(out.costUsd) || 0) + priceCell(cell, price);
    }
    return out;
  }

  /** Threads a budget stop is already in flight for. */
  const budgetStopping = new Set();

  /**
   * Hard budget caps, live half (#286). The start gate refuses a run that
   * is already over; this stops one that crosses a cap mid-run, then flags
   * the thread so the user decides. Usage-based caps move when the provider
   * reports usage; minutes is the in-turn hard stop.
   * ponytail: 15 s sweep granularity, a per-run timer if that ever matters.
   */
  async function checkBudgets() {
    const now = nowFn();
    for (const [threadId, entry] of [...active.entries()]) {
      if (!entry || entry.stopping || budgetStopping.has(threadId)) continue;
      const thread = store.getThread(threadId);
      if (!thread || !thread.budget || thread.memoryConsolidate === true) continue;
      const why = budgetBreach(thread, withLiveUsage(store.getUsage(threadId), entry), now);
      if (!why) continue;
      budgetStopping.add(threadId);
      try {
        appendMessage(
          threadId,
          "event",
          `Budget cap reached: ${why}. Stopping the run. Raise or clear this thread's cap to continue.`,
          entry.runId || null,
        );
        await ctx.stopRun({ threadId });
        store.updateThread(threadId, { awaitingInput: true });
        store.save();
        pushThreadsChanged();
      } finally {
        budgetStopping.delete(threadId);
      }
    }
  }

  /**
   * Reset lastBeat on every active lane thread so the 30-minute watchdog
   * does not recycle a live run. Idle / wedged lanes are left alone.
   * @param {{ now?: number }} [opts]
   */
  function heartbeatActiveLanes(opts) {
    const at = opts && opts.now != null ? opts.now : nowFn();
    for (const threadId of active.keys()) {
      const live = store.getThread(threadId);
      if (!live || !live.lane) continue;
      try {
        heartbeatLane({ store, threadId, now: at });
      } catch {
        // never break the runner
      }
    }
  }

  // Native timer (not setIntervalFn): tests replace that hook for sim ticks.
  const stallTimer = setInterval(() => {
    try {
      checkStalls();
    } catch {
      // never break the runner
    }
    try {
      heartbeatActiveLanes();
    } catch {
      // never break the runner
    }
    checkBudgets().catch(() => {
      // never break the runner
    });
  }, 15_000);
  if (typeof stallTimer.unref === "function") stallTimer.unref();

  return {
    checkStalls,
    checkBudgets,
    heartbeatActiveLanes,
    dispose() {
      clearInterval(stallTimer);
    },
  };
}

module.exports = { createWatchdogs };
