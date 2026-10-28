"use strict";

/**
 * Local model servers for Settings › Providers (#1717): Ollama and LM Studio,
 * both reached through their OpenAI-compatible `/v1` and run by opencode as
 * an OpenAI-compatible instance (providerInstances.js). Detection only: a
 * server that is not running is a normal state, never an error.
 *
 * Ollama: GET /api/tags lists installed models; POST /api/show per model
 * gives the context window (`<arch>.context_length`, or a `num_ctx`
 * parameter, which is what Ollama actually serves when set).
 * LM Studio: GET /v1/models.
 */

const DEFAULTS = Object.freeze({
  ollama: "http://127.0.0.1:11434",
  lmstudio: "http://127.0.0.1:1234",
});

// Short: these probe loopback (or a LAN box) every time the pane opens.
const TIMEOUT_MS = 1500;
// ponytail: /api/show is one request per model; past this many, skip context.
const SHOW_MAX = 30;

/**
 * Server root without a trailing slash or `/v1`, or null when not http(s).
 * @param {unknown} raw
 * @returns {string | null}
 */
function serverRoot(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "").replace(/\/v1$/, "");
  } catch {
    return null;
  }
}

/**
 * @typedef {{ id: string, label: string, contextTokens?: number }} LocalModel
 * @typedef {{ kind: "ollama" | "lmstudio", url: string, baseUrl: string, running: boolean, models: LocalModel[] }} LocalServer
 */

/** @param {Record<string, unknown>} body */
function ollamaContext(body) {
  const params = typeof body.parameters === "string" ? body.parameters : "";
  const numCtx = /^\s*num_ctx\s+(\d+)/m.exec(params);
  if (numCtx) return Number(numCtx[1]);
  const info = /** @type {Record<string, unknown>} */ (body.model_info || {});
  for (const [k, v] of Object.entries(info)) {
    if (k.endsWith(".context_length") && typeof v === "number" && v > 0) return v;
  }
  return undefined;
}

/**
 * @param {"ollama" | "lmstudio"} kind
 * @param {string} root
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} opts
 * @returns {Promise<LocalServer>}
 */
async function probe(kind, root, opts) {
  const fetchImpl = opts.fetch || fetch;
  const out = /** @type {LocalServer} */ ({ kind, url: root, baseUrl: `${root}/v1`, running: false, models: [] });
  // A plain ref'd timer covering headers and body, not AbortSignal.timeout.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  /** @param {string} url @param {RequestInit} [init] */
  const getJson = async (url, init) => {
    const res = await fetchImpl(url, { ...init, signal: ctl.signal });
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  };
  try {
    if (kind === "lmstudio") {
      const { parseModels } = require("./providerModels.js");
      out.models = parseModels(await getJson(`${root}/v1/models`));
      out.running = true;
      return out;
    }
    const tags = await getJson(`${root}/api/tags`);
    const rows = Array.isArray(tags && tags.models) ? tags.models : [];
    out.running = true;
    out.models = rows
      .map((r) => (r && typeof r.name === "string" ? r.name : typeof r?.model === "string" ? r.model : ""))
      .filter(Boolean)
      .map((id) => ({ id, label: id }));
    if (out.models.length <= SHOW_MAX) {
      await Promise.all(
        out.models.map(async (m) => {
          try {
            const ctx = ollamaContext(
              await getJson(`${root}/api/show`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ model: m.id }),
              }),
            );
            if (ctx) m.contextTokens = ctx;
          } catch {
            // Context is a nice-to-have; the model still lists.
          }
        }),
      );
    }
    return out;
  } catch {
    return out.running ? out : { ...out, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe both servers in parallel. Custom URLs (a LAN Ollama) replace the
 * defaults; anything that is not http(s) falls back to the default.
 * @param {{ ollamaUrl?: string | null, lmstudioUrl?: string | null } | null | undefined} input
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<LocalServer[]>}
 */
function detectLocalModels(input, opts = {}) {
  return Promise.all([
    probe("ollama", serverRoot(input && input.ollamaUrl) || DEFAULTS.ollama, opts),
    probe("lmstudio", serverRoot(input && input.lmstudioUrl) || DEFAULTS.lmstudio, opts),
  ]);
}

module.exports = { detectLocalModels, serverRoot, ollamaContext, DEFAULTS };
