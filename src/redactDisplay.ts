/**
 * Screen-share redaction for the transcript: known secret shapes become
 * [redacted:<rule>] where the UI paints them. Display only. The stored
 * transcript, Copy and Edit keep the raw text.
 *
 * Port of the privacy gateway's "secrets" rules (electron/privacyGateway.js,
 * built on electron/guardrails.js SECRET_RULES); test/redactDisplay.test.ts
 * holds the two in parity.
 * ponytail: per-thread secret-card values (#289) live in main only, so they
 * are not covered here. Push them with the detail if they show up on screen.
 */

const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "private-key"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "bearer"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "aws-key"],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, "github-token"],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, "github-pat"],
  [/\bsk-ant-[A-Za-z0-9_-]{24,}\b/g, "anthropic-key"],
  [/\bsk-(?!ant-)[A-Za-z0-9]{32,}\b/g, "openai-key"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "slack-token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "google-key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "jwt"],
  [
    /\b(api[_-]?key|secret|token|password|passwd|access[_-]?key)\s*[:=]\s*["'][^"'\s]{16,}["']/gi,
    "assignment",
  ],
];

/** guardrails.js PLACEHOLDER: obvious non-secrets the assignment rule trips on. */
const PLACEHOLDER =
  /(x{6,}|\.{3,}|your[_-]?|example|placeholder|changeme|dummy|redacted|<[^>]+>|\$\{|process\.env|os\.environ|REPLACE|TODO|\bnull\b|\*{4,})/i;

export function redactDisplay(text: string): string {
  let s = text;
  for (const [re, rule] of RULES) {
    s = s.replace(re, (m) =>
      !m || (rule === "assignment" && PLACEHOLDER.test(m)) ? m : `[redacted:${rule}]`,
    );
  }
  return s;
}
