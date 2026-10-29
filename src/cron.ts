/**
 * Issue #1719: 5-field cron for the automation editor's live preview.
 * Twin of electron/cron.js (the scheduler's source of truth); keep them in
 * sync. test/cronParity.test.ts runs both against the same vectors.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

type Field = { name: string; min: number; max: number; names?: string[]; nameBase?: number; hint?: string };

const FIELDS: Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1, hint: " or jan-dec" },
  { name: "day-of-week", min: 0, max: 7, names: DAYS, nameBase: 0, hint: " or sun-sat" },
];

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export const MIN_INTERVAL_MINUTES = 5;

const SEARCH_DAYS = 366 * 8 + 1;

export type ParsedCron = {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  domStar: boolean;
  dowStar: boolean;
};

function fieldValue(raw: string, f: Field): number {
  const named = f.names ? f.names.indexOf(raw.toLowerCase()) : -1;
  if (named >= 0) return named + (f.nameBase ?? 0);
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= f.min && n <= f.max)) {
    throw new Error(`${f.name} must be ${f.min}-${f.max}${f.hint || ""} (got "${raw}")`);
  }
  return n;
}

function parseField(text: string, f: Field): number[] {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    if (!part) throw new Error(`${f.name} has an empty list item`);
    const [range, stepRaw, extra] = part.split("/");
    if (extra !== undefined) throw new Error(`${f.name} has more than one "/" in "${part}"`);
    let step = 1;
    if (stepRaw !== undefined) {
      step = /^\d+$/.test(stepRaw) ? Number(stepRaw) : 0;
      if (step < 1) throw new Error(`${f.name} step must be a positive number (got "${stepRaw}")`);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = f.min;
      hi = f.max;
    } else {
      const ends = range.split("-");
      if (ends.length > 2 || !ends[0] || ends[1] === "") {
        throw new Error(`${f.name} has a malformed range "${range}"`);
      }
      lo = fieldValue(ends[0], f);
      hi = ends.length === 2 ? fieldValue(ends[1], f) : stepRaw !== undefined ? f.max : lo;
      if (lo > hi) throw new Error(`${f.name} range "${range}" runs backwards`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

function minGapMinutes(p: { minutes: number[]; hours: number[] }): number {
  const { minutes: m, hours: h } = p;
  let gap = Infinity;
  for (let i = 1; i < m.length; i++) gap = Math.min(gap, m[i] - m[i - 1]);
  const adjacent = h.some((x) => h.includes((x + 1) % 24));
  if (adjacent || h.length === 24) gap = Math.min(gap, 60 - m[m.length - 1] + m[0]);
  return gap;
}

/** Parse and validate; throws a readable Error. */
export function parseCron(expr: unknown): ParsedCron {
  const parts = String(expr == null ? "" : expr).trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    throw new Error(
      `Cron needs 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
    );
  }
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => parseField(p, FIELDS[i]));
  const parsed: ParsedCron = {
    minutes,
    hours,
    days: new Set(days),
    months: new Set(months),
    weekdays: new Set(weekdays.map((d) => d % 7)),
    domStar: parts[2].startsWith("*"),
    dowStar: parts[4].startsWith("*"),
  };
  if (parsed.dowStar && !months.some((m) => days.some((d) => d <= MONTH_DAYS[m - 1]))) {
    throw new Error("Cron never fires: no chosen month has that day-of-month");
  }
  const gap = minGapMinutes(parsed);
  if (gap < MIN_INTERVAL_MINUTES) {
    throw new Error(
      `Cron fires every ${gap} minute${gap === 1 ? "" : "s"}; automations can run at most every ${MIN_INTERVAL_MINUTES} minutes`,
    );
  }
  return parsed;
}

function localInstant(y: number, mo: number, d: number, h: number, mi: number): number {
  const t = new Date(y, mo, d, h, mi).getTime();
  const at = new Date(t);
  if (at.getHours() === h && at.getMinutes() === mi) return t;
  const offset = at.getTimezoneOffset();
  let x = t;
  while (new Date(x - 60_000).getTimezoneOffset() === offset) x -= 60_000;
  return x;
}

export function nextCronFire(cron: string | ParsedCron, fromMs: number): number | null {
  const p = typeof cron === "string" ? parseCron(cron) : cron;
  const from = new Date(fromMs);
  if (Number.isNaN(from.getTime())) throw new Error(`Invalid fromMs: ${fromMs}`);
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    if (!p.months.has(day.getMonth() + 1)) continue;
    const domOk = p.days.has(day.getDate());
    const dowOk = p.weekdays.has(day.getDay());
    const ok = p.domStar || p.dowStar ? domOk && dowOk : domOk || dowOk;
    if (!ok) continue;
    for (const h of p.hours) {
      for (const mi of p.minutes) {
        const t = localInstant(day.getFullYear(), day.getMonth(), day.getDate(), h, mi);
        if (t > fromMs) return t;
      }
    }
  }
  return null;
}

export function nextCronFires(cron: string, fromMs: number, count: number): number[] {
  const p = parseCron(cron);
  const out: number[] = [];
  let at = fromMs;
  while (out.length < count) {
    const t = nextCronFire(p, at);
    if (t == null) break;
    out.push(t);
    at = t;
  }
  return out;
}

/** Validation message for the editor, or null when the expression is good. */
export function cronError(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
