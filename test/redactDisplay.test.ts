/**
 * src/redactDisplay.ts vs electron/privacyGateway.js "secrets" level must not
 * drift: the screen hides what the gateway would strip (#295).
 * Run: node --experimental-strip-types --test test/redactDisplay.test.ts
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { it } from "node:test";
import { redactDisplay } from "../src/redactDisplay.ts";

const require = createRequire(import.meta.url);
const gateway = require("../electron/privacyGateway.js") as {
  redactor: (threadId: string) => { text: (s: string) => string };
};

it("matches the privacy gateway's secret rules", () => {
  const samples = [
    `token ghp_${"a1B2".repeat(9)} and gho_${"x".repeat(40)}`,
    `github_pat_${"A_b1".repeat(8)}`,
    `AKIA${"ABCD1234".repeat(2)}`,
    `sk-ant-${"a".repeat(30)} sk-${"B".repeat(40)}`,
    "xoxb-1234567890-abcdef",
    `AIza${"z".repeat(35)}`,
    "Authorization: Bearer abcdefghijklmnop.qrstuv",
    `jwt eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`,
    `api_key = "${"q".repeat(20)}"`,
    `password: "your-password-goes-here-123"`,
    "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\ntail",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nunterminated",
    "nothing to see: ghp_short, sk-tiny",
    "",
  ];
  const r = gateway.redactor("redact-display-parity-no-cards");
  for (const s of samples) assert.equal(redactDisplay(s), r.text(s), s);
  assert.equal(samples.filter((s) => redactDisplay(s) !== s).length, 11, "samples exercise the rules");
});
