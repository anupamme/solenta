/**
 * src/cron.ts (editor preview) must agree with electron/cron.js (the
 * scheduler) on every vector, or the preview lies about when a run fires.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { cronError, nextCronFires } from "../src/cron";

const backend = createRequire(import.meta.url)("../electron/cron.js") as {
  parseCron: (e: string) => unknown;
  nextCronFires: (e: string, from: number, n: number) => number[];
};

const VECTORS = [
  "0 9 * * 1-5",
  "*/15 2 * * *",
  "30 2 * * *",
  "0 0 13 * fri",
  "0 0 */2 * fri",
  "0 0 29 feb *",
  "5/20 0 1,15 jan-mar sun",
  "55,0 * * * *",
  "0 0 * * 7",
  "* * * * *",
  "0 24 * * *",
  "0 0 31 feb *",
  "0 0 * *",
  "0 0 * * 5-1",
  "*/0 0 * * *",
];

describe("cron parity", () => {
  it("errors and next fires match electron/cron.js", () => {
    // DST days and a leap year sit inside these starts.
    const starts = [
      new Date(2026, 2, 28, 12).getTime(),
      new Date(2026, 9, 24, 12).getTime(),
      new Date(2027, 11, 31, 23, 59).getTime(),
    ];
    for (const expr of VECTORS) {
      let backendError: string | null = null;
      try {
        backend.parseCron(expr);
      } catch (err) {
        backendError = (err as Error).message;
      }
      assert.equal(cronError(expr), backendError, expr);
      if (backendError) continue;
      for (const from of starts) {
        assert.deepEqual(nextCronFires(expr, from, 5), backend.nextCronFires(expr, from, 5), `${expr} @ ${from}`);
      }
    }
  });
});
