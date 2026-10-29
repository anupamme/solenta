"use strict";

/**
 * Sign in to remote MCP servers (#1720). Solenta is the OAuth *client* here;
 * electron/mcpOauth.js is the unrelated OAuth server for our own endpoint.
 *
 * The MCP authorization flow: 401 → protected-resource metadata (RFC 9728)
 * → authorization-server metadata (RFC 8414) → dynamic client registration
 * (RFC 7591) → PKCE authorization code in the browser, redirected to a
 * one-shot 127.0.0.1 listener on a random port → token exchange → refresh.
 * The SDK's auth() (shipped with memory-server) does the protocol; this file
 * owns the loopback, the browser hand-off and the `oauth` record that the
 * server row stores and secrets.js seals.
 */

const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { createRequire } = require("node:module");

const CONNECT_TIMEOUT_MS = 5 * 60_000;
/** Refresh this long before expiry so a run never starts on a dead token. */
const REFRESH_SKEW_MS = 5 * 60_000;

/** @type {Map<string, (err: Error) => void>} server name → cancel */
const pending = new Map();

function sdkAuth() {
  const req = createRequire(path.join(__dirname, "../memory-server/package.json"));
  return req("@modelcontextprotocol/sdk/client/auth.js");
}

/**
 * OAuthClientProvider over a plain state object.
 * @param {{ redirectUri: string, stateParam?: string, client?: object, tokens?: object, verifier?: string, onRedirect: (url: URL) => void | Promise<void> }} st
 */
function provider(st) {
  return {
    get redirectUrl() {
      return st.redirectUri;
    },
    get clientMetadata() {
      return {
        client_name: "Solenta",
        redirect_uris: [st.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    state: () => st.stateParam || "",
    clientInformation: () => st.client,
    saveClientInformation: (info) => {
      st.client = info;
    },
    tokens: () => st.tokens,
    saveTokens: (tokens) => {
      st.tokens = tokens;
    },
    redirectToAuthorization: (url) => st.onRedirect(url),
    saveCodeVerifier: (v) => {
      st.verifier = v;
    },
    codeVerifier: () => {
      if (!st.verifier) throw new Error("No PKCE verifier saved");
      return st.verifier;
    },
  };
}

function toRecord(st, now) {
  const t = st.tokens || {};
  const c = st.client || {};
  /** @type {Record<string, string | number>} */
  const out = {};
  const put = (k, v) => {
    if (typeof v === "string" && v) out[k] = v;
  };
  put("accessToken", t.access_token);
  put("refreshToken", t.refresh_token);
  put("tokenType", t.token_type);
  put("scope", t.scope);
  put("clientId", c.client_id);
  put("clientSecret", c.client_secret);
  put("redirectUri", st.redirectUri);
  if (Number.isFinite(t.expires_in) && t.expires_in > 0) {
    out.expiresAt = now + t.expires_in * 1000;
  }
  if (!out.accessToken) throw new Error("The authorization server returned no access token");
  return out;
}

const PAGE = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:15px system-ui;margin:4em auto;max-width:28em;text-align:center">` +
  `<h2>${title}</h2><p>${body}</p></body>`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * One-shot loopback redirect target. A request with the wrong `state` gets
 * a 400 and does not end the wait, so a stray tab cannot cancel sign-in.
 * @param {string} expectedState
 */
function startLoopback(expectedState) {
  /** @type {(code: string) => void} */
  let resolve = () => {};
  /** @type {(err: Error) => void} */
  let reject = () => {};
  const code = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Raced later; never an unhandled rejection while auth() is still running.
  code.catch(() => {});
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    const send = (status, title, body) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", connection: "close" });
      res.end(PAGE(title, body));
    };
    if (u.pathname !== "/callback") return send(404, "Not found", "");
    if (u.searchParams.get("state") !== expectedState) {
      return send(400, "Sign-in link expired", "Go back to Solenta and try again.");
    }
    const error = u.searchParams.get("error");
    if (error) {
      const desc = u.searchParams.get("error_description");
      send(400, "Sign-in failed", escapeHtml(desc || error));
      return reject(new Error(`Sign-in failed: ${desc || error}`));
    }
    const got = u.searchParams.get("code");
    if (!got) return send(400, "Sign-in failed", "No authorization code.");
    send(200, "Signed in", "You can close this tab and return to Solenta.");
    resolve(got);
  });
  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => {
      const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
      res({
        port: addr.port,
        code,
        close: () => {
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}

/**
 * Ask the server first: a 401 carries `WWW-Authenticate: Bearer
 * resource_metadata=… scope=…`, which beats guessing the well-known path.
 * @param {string} serverUrl
 * @param {"http" | "sse" | undefined} transport
 * @param {typeof fetch} fetchFn
 */
async function probe(serverUrl, transport, fetchFn) {
  const { extractWWWAuthenticateParams } = sdkAuth();
  let res;
  try {
    res =
      transport === "sse"
        ? await fetchFn(serverUrl, { headers: { accept: "text/event-stream" } })
        : await fetchFn(serverUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "Solenta", version: "1" },
              },
            }),
          });
  } catch (err) {
    throw new Error(`Cannot reach ${serverUrl}: ${err && err.message ? err.message : err}`);
  }
  try {
    await res.body?.cancel();
  } catch {
    // ignore
  }
  return res.status === 401 ? extractWWWAuthenticateParams(res) : {};
}

/**
 * Interactive sign-in. Resolves with the `oauth` record to store on the row.
 * @param {{
 *   name: string,
 *   serverUrl: string,
 *   transport?: "http" | "sse",
 *   openExternal: (url: string) => void | Promise<void>,
 *   fetchFn?: typeof fetch,
 *   timeoutMs?: number,
 *   now?: () => number,
 * }} opts
 */
async function connect(opts) {
  const { name, serverUrl } = opts;
  cancel(name);
  const stateParam = crypto.randomBytes(16).toString("base64url");
  const loop = await startLoopback(stateParam);
  /** @type {Parameters<typeof provider>[0]} */
  const st = {
    redirectUri: `http://127.0.0.1:${loop.port}/callback`,
    stateParam,
    onRedirect: (url) => opts.openExternal(url.href),
  };
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {(err: Error) => void} */
  let stop = () => {};
  const stopped = new Promise((_, rej) => {
    stop = rej;
  });
  stopped.catch(() => {});
  pending.set(name, stop);
  timer = setTimeout(
    () => stop(new Error("Sign-in timed out")),
    opts.timeoutMs || CONNECT_TIMEOUT_MS,
  );
  try {
    const { auth } = sdkAuth();
    const hint = await Promise.race([
      probe(serverUrl, opts.transport, opts.fetchFn || fetch),
      stopped,
    ]);
    const p = provider(st);
    const base = {
      serverUrl,
      fetchFn: opts.fetchFn,
      resourceMetadataUrl: hint.resourceMetadataUrl,
      scope: hint.scope,
    };
    const first = await Promise.race([auth(p, base), stopped]);
    if (first !== "AUTHORIZED") {
      const code = await Promise.race([loop.code, stopped]);
      await Promise.race([auth(p, { ...base, authorizationCode: code }), stopped]);
    }
    return toRecord(st, (opts.now || Date.now)());
  } finally {
    clearTimeout(timer);
    if (pending.get(name) === stop) pending.delete(name);
    loop.close();
  }
}

/**
 * Stop a sign-in that is waiting on the browser.
 * @param {string} name
 * @returns {boolean} true when one was pending
 */
function cancel(name) {
  const stop = pending.get(name);
  if (!stop) return false;
  pending.delete(name);
  stop(new Error("Sign-in cancelled"));
  return true;
}

function isPending(name) {
  return pending.has(name);
}

/** @param {{ expiresAt?: number, refreshToken?: string } | undefined} record */
function needsRefresh(record, now = Date.now()) {
  return Boolean(
    record &&
      record.refreshToken &&
      Number.isFinite(record.expiresAt) &&
      record.expiresAt - now < REFRESH_SKEW_MS,
  );
}

/**
 * Trade the refresh token for a new access token. Never opens a browser:
 * when the server wants a fresh sign-in this throws.
 * @param {Record<string, any>} record
 * @param {{ serverUrl: string, fetchFn?: typeof fetch, now?: () => number }} opts
 */
async function refresh(record, opts) {
  if (!record || !record.refreshToken || !record.clientId) {
    throw new Error("Sign-in expired; connect again");
  }
  /** @type {Parameters<typeof provider>[0]} */
  const st = {
    redirectUri: record.redirectUri || "http://127.0.0.1/callback",
    client: {
      client_id: record.clientId,
      ...(record.clientSecret ? { client_secret: record.clientSecret } : {}),
    },
    tokens: {
      access_token: record.accessToken,
      refresh_token: record.refreshToken,
      token_type: record.tokenType || "Bearer",
    },
    onRedirect: () => {
      throw new Error("Sign-in expired; connect again");
    },
  };
  const before = st.tokens;
  const { auth } = sdkAuth();
  await auth(provider(st), { serverUrl: opts.serverUrl, fetchFn: opts.fetchFn });
  if (st.tokens === before) throw new Error("Sign-in expired; connect again");
  return toRecord(st, (opts.now || Date.now)());
}

module.exports = {
  CONNECT_TIMEOUT_MS,
  REFRESH_SKEW_MS,
  connect,
  cancel,
  isPending,
  needsRefresh,
  refresh,
};
