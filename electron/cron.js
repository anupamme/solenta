"use strict";

// Issue #1719: 5-field cron schedules for automations, in local time.
// Twin of src/cron.ts (the editor's live preview); keep them in sync.
// test/cronParity.test.ts runs both against the same vectors.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1, hint: " or jan-dec" },
  // 7 is Sunday too; folded to 0 after parsing.
  { name: "day-of-week", min: 0, max: 7, names: DAYS, nameBase: 0, hint: " or sun-sat" },
];

// Feb counts 29 so "0 0 29 2 *" (leap days only) is valid.
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Automations may not fire more often than this (a typo must not spawn a thread a minute). */
const MIN_INTERVAL_MINUTES = 5;

// Leap-day-only schedules repeat every 4 years (8 across a skipped 2100).
const SEARCH_DAYS = 366 * 8 + 1;

/**
 * @param {string} raw
 * @param {{ name: string, min: number, max: number, names?: string[], nameBase?: number, hint?: string }} f
 */
function fieldValue(raw, f) {
  const lower = raw.toLowerCase();
  const named = f.names ? f.names.indexOf(lower) : -1;
  if (named >= 0) return named + /** @type {number} */ (f.nameBase);
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= f.min && n <= f.max)) {
    throw new Error(`${f.name} must be ${f.min}-${f.max}${f.hint || ""} (got "${raw}")`);
  }
  return n;
}

/**
 * @param {string} text
 * @param {typeof FIELDS[number]} f
 * @returns {number[]} sorted unique values
 */
function parseField(text, f) {
  const out = new Set();
  for (const part of text.split(",")) {
    if (!part) throw new Error(`${f.name} has an empty list item`);
    const [range, stepRaw, extra] = part.split("/");
    if (extra !== undefined) throw new Error(`${f.name} has more than one "/" in "${part}"`);
    let step = 1;
    if (stepRaw !== undefined) {
      step = /^\d+$/.test(stepRaw) ? Number(stepRaw) : 0;
      if (step < 1) throw new Error(`${f.name} step must be a positive number (got "${stepRaw}")`);
    }
    let lo;
    let hi;
    if (range === "*") {
      lo = f.min;
      hi = f.max;
    } else {
      const ends = range.split("-");
      if (ends.length > 2 || !ends[0] || ends[1] === "") {
        throw new Error(`${f.name} has a malformed range "${range}"`);
      }
      lo = fieldValue(ends[0], f);
      // "5/15" means 5-max stepping 15, as in Vixie cron.
      hi = ends.length === 2 ? fieldValue(ends[1], f) : stepRaw !== undefined ? f.max : lo;
      if (lo > hi) throw new Error(`${f.name} range "${range}" runs backwards`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Parse and validate a 5-field cron expression. Throws a readable Error.
 * @param {unknown} expr
 * @returns {{ minutes: number[], hours: number[], days: Set<number>, months: Set<number>, weekdays: Set<number>, domStar: boolean, dowStar: boolean }}
 */
function parseCron(expr) {
  const parts = String(expr == null ? "" : expr).trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    throw new Error(
      `Cron needs 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
    );
  }
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => parseField(p, FIELDS[i]));
  const parsed = {
    minutes,
    hours,
    days: new Set(days),
    months: new Set(months),
    weekdays: new Set(weekdays.map((d) => d % 7)),
    // Vixie rule: a field starting with "*" is unrestricted. When both
    // day fields are restricted, a day matching either one fires.
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

/**
 * Shortest wall-clock gap between two fires. Treats 23 -> 0 as adjacent
 * even across a skipped day (conservative).
 * @param {{ minutes: number[], hours: number[] }} p
 */
function minGapMinutes(p) {
  const { minutes: m, hours: h } = p;
  let gap = Infinity;
  for (let i = 1; i < m.length; i++) gap = Math.min(gap, m[i] - m[i - 1]);
  const adjacent = h.some((x) => h.includes((x + 1) % 24));
  if (adjacent || h.length === 24) gap = Math.min(gap, 60 - m[m.length - 1] + m[0]);
  // Single hour, single minute: the day-level gap is at least an hour.
  return gap;
}

/**
 * Local wall-clock time to epoch ms. A time skipped by spring-forward maps
 * to the first valid minute after the gap; an ambiguous fall-back time maps
 * to its first occurrence only, so it never fires twice.
 */
function localInstant(y, mo, d, h, mi) {
  const t = new Date(y, mo, d, h, mi).getTime();
  const at = new Date(t);
  if (at.getHours() === h && at.getMinutes() === mi) return t;
  // JS pushed the skipped time forward by the gap; walk back to its end.
  const offset = at.getTimezoneOffset();
  let x = t;
  while (new Date(x - 60_000).getTimezoneOffset() === offset) x -= 60_000;
  return x;
}

/**
 * Next fire strictly after fromMs, or null if none within 8 years.
 * @param {string | ReturnType<typeof parseCron>} cron
 * @param {number} fromMs
 * @returns {number | null}
 */
function nextCronFire(cron, fromMs) {
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

/**
 * The next `count` fire times after fromMs.
 * @param {string} cron
 * @param {number} fromMs
 * @param {number} count
 */
function nextCronFires(cron, fromMs, count) {
  const p = parseCron(cron);
  const out = [];
  let at = fromMs;
  while (out.length < count) {
    const t = nextCronFire(p, at);
    if (t == null) break;
    out.push(t);
    at = t;
  }
  return out;
}

module.exports = { MIN_INTERVAL_MINUTES, parseCron, nextCronFire, nextCronFires };
