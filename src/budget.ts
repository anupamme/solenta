import type { SessionUsage, ThreadBudget } from "./shared/ipc";

/** Hard budget cap fields (#286), in display order. */
export const BUDGET_FIELDS = [
  { key: "usd", label: "USD", hint: "Provider-reported spend" },
  { key: "tokens", label: "Tokens", hint: "Input + output tokens" },
  { key: "turns", label: "Turns", hint: "Agent turns" },
  { key: "minutes", label: "Min / run", hint: "Wall-clock per run" },
] as const;

export type BudgetDraft = Record<keyof ThreadBudget, string>;

export function budgetToDraft(b: ThreadBudget | null | undefined): BudgetDraft {
  const s = (v: number | undefined) => (v == null ? "" : String(v));
  return {
    usd: s(b?.usd),
    tokens: s(b?.tokens),
    turns: s(b?.turns),
    minutes: s(b?.minutes),
  };
}

/** Blank fields drop out; all blank is null (no cap). Throws on junk. */
export function draftToBudget(d: BudgetDraft): ThreadBudget | null {
  const out: ThreadBudget = {};
  for (const { key, label } of BUDGET_FIELDS) {
    const raw = d[key].trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`${label} cap must be a positive number`);
    }
    out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Mirror of electron/budgetCaps.js budgetBreach for the lifetime axes; the
 * per-run minutes cap leaves nothing over once the run is stopped.
 */
export function budgetReached(
  b: ThreadBudget | null | undefined,
  u: SessionUsage | null | undefined,
): string | null {
  if (!b || !u) return null;
  if (b.usd != null && u.costUsd >= b.usd) {
    return `$${u.costUsd.toFixed(2)} of $${b.usd.toFixed(2)}`;
  }
  const tokens = u.inputTokens + u.outputTokens;
  if (b.tokens != null && tokens >= b.tokens) {
    return `${tokens.toLocaleString("en-US")} of ${b.tokens.toLocaleString("en-US")} tokens`;
  }
  if (b.turns != null && u.turns >= b.turns) {
    return `${u.turns} of ${b.turns} turns`;
  }
  return null;
}
