"use strict";

/**
 * Privacy gateway (#295): a deterministic filter, not a prompt, on the text
 * Solenta hands a provider CLI. The level is per provider
 * (settings.privacyGateway):
 *   off     - send as typed. The default, so upgrades change nothing.
 *   secrets - this thread's secret-card values (#289), the guardrail secret
 *             shapes, bearer tokens and whole PEM private-key blocks.
 *   strict  - secrets, plus emails, card numbers, US SSNs and the user's
 *             own patterns.
 * Each hit becomes [redacted:<rule>]. The thread gets one event row naming
 * the rules and counts, never the values.
 *
 * ponytail: covers what Solenta composes (prompt, hand-off, memory note, PDF
 * text, folded queue, steers, Ask and /btw). Files and tool output the agent
 * reads itself go from the CLI straight to its provider. Covering those needs
 * an egress proxy in front of the CLI.
 */

const { SECRET_RULES, PLACEHOLDER } = require("./guardrails.js");
const threadSecrets = require("./threadSecrets.js");

const LEVELS = ["off", "secrets", "strict"];

/** Global copies: guardrails only needs the first hit, redaction needs all. */
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "secret.private-key"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "secret.bearer"],
  ...SECRET_RULES.map(([re, rule]) => [new RegExp(re.source, re.flags + "g"), rule]),
];

const PII_RULES = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, "pii.email"],
  // ponytail: 3/4/5/6 lead + Luhn keeps ms timestamps (they start with 1) out.
  [/\b[3-6]\d{3}(?:[ -]?\d){9,15}\b/g, "pii.card"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "pii.ssn"],
];

/** threadSecrets.redact's placeholder. */
const CARD = /\[secret:[A-Z0-9_]+\]/g;

/** @param {string} s */
function luhn(s) {
  const digits = s.replace(/\D/g, "");
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * @param {string} threadId
 * @param {{ pii?: boolean, patterns?: string[] }} [opts]
 */
function redactor(threadId, opts = {}) {
  const rules = opts.pii
    ? [
        ...RULES,
        ...PII_RULES,
        ...(opts.patterns || []).map((p) => [new RegExp(p, "g"), "pattern"]),
      ]
    : RULES;
  /** @type {Record<string, number>} */
  const counts = {};
  /** @param {unknown} value @returns {string} */
  const text = (value) => {
    const raw = String(value ?? "");
    let s = threadSecrets.redact(threadId, raw);
    if (s !== raw) {
      const n = (s.match(CARD) || []).length - (raw.match(CARD) || []).length;
      counts["secret.request-card"] = (counts["secret.request-card"] || 0) + n;
    }
    for (const [re, rule] of rules) {
      s = s.replace(/** @type {RegExp} */ (re), (m) => {
        if (!m) return m;
        if (rule === "secret.assignment" && PLACEHOLDER.test(m)) return m;
        if (rule === "pii.card" && !luhn(m)) return m;
        counts[rule] = (counts[rule] || 0) + 1;
        return `[redacted:${label(rule)}]`;
      });
    }
    return s;
  };
  return { text, counts };
}

/** @param {string} rule */
function label(rule) {
  return rule.replace(/^(secret|pii)\./, "");
}

/**
 * @param {{ privacyGateway?: { default?: string, providers?: Record<string, string> } } | null | undefined} settings
 * @param {string} provider
 * @returns {"off" | "secrets" | "strict"}
 */
function levelFor(settings, provider) {
  const pg = settings && settings.privacyGateway;
  const level = (pg && pg.providers && pg.providers[provider]) || (pg && pg.default);
  return LEVELS.includes(String(level)) ? /** @type {any} */ (level) : "off";
}

/**
 * Filter one outbound prompt. `note` is the per-thread log line, null when
 * nothing matched or the provider's level is off.
 * @param {any} settings
 * @param {string} threadId
 * @param {string} provider
 * @param {string} text
 * @returns {{ text: string, note: string | null }}
 */
function filterOutbound(settings, threadId, provider, text) {
  const level = levelFor(settings, provider);
  if (level === "off") return { text, note: null };
  const r = redactor(threadId, {
    pii: level === "strict",
    patterns: settings.privacyGateway.patterns,
  });
  const out = r.text(text);
  const tally = Object.entries(r.counts).filter(([, n]) => n > 0);
  if (!tally.length) return { text, note: null };
  const total = tally.reduce((n, [, c]) => n + c, 0);
  const parts = tally.map(([rule, n]) => `${label(rule)} ×${n}`).join(", ");
  return {
    text: out,
    note: `Privacy gateway (${level}, ${provider}) redacted ${total} item${total === 1 ? "" : "s"} before sending: ${parts}.`,
  };
}

/**
 * Heal or validate the settings slice. strict (settings:set) throws on a bad
 * level or pattern; lenient (load) drops it.
 * @param {unknown} raw
 * @param {boolean} [strict]
 * @returns {{ default: "off" | "secrets" | "strict", providers: Record<string, "off" | "secrets" | "strict">, patterns: string[] }}
 */
function normalizePrivacyGateway(raw, strict = false) {
  /** @type {{ default: any, providers: Record<string, any>, patterns: string[] }} */
  const out = { default: "off", providers: {}, patterns: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (strict && raw != null) throw new Error("privacyGateway must be an object");
    return out;
  }
  const obj = /** @type {{ default?: unknown, providers?: unknown, patterns?: unknown }} */ (raw);
  /** @param {unknown} v @param {string} what */
  const level = (v, what) => {
    if (LEVELS.includes(String(v))) return v;
    if (strict) throw new Error(`${what} must be off, secrets or strict`);
    return null;
  };
  if (obj.default != null) out.default = level(obj.default, "privacyGateway.default") || "off";
  if (obj.providers && typeof obj.providers === "object" && !Array.isArray(obj.providers)) {
    for (const [id, v] of Object.entries(obj.providers)) {
      const l = level(v, `privacyGateway level for ${id}`);
      if (id && l) out.providers[id] = l;
    }
  }
  if (Array.isArray(obj.patterns)) {
    for (const p of obj.patterns) {
      const s = typeof p === "string" ? p.trim() : "";
      if (!s) continue;
      try {
        new RegExp(s, "g");
        out.patterns.push(s);
      } catch {
        if (strict) throw new Error(`Invalid privacy pattern: ${s}`);
      }
    }
  }
  return out;
}

module.exports = { redactor, levelFor, filterOutbound, normalizePrivacyGateway, LEVELS };
