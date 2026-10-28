"use strict";

/**
 * MCP OAuth client (#1720) against a local fake authorization server and a
 * protected MCP endpoint, both on 127.0.0.1: 401 discovery, dynamic client
 * registration, PKCE S256, loopback redirect, token exchange, refresh,
 * cancel, and tokens sealed at rest. No real third-party OAuth.
 */

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "coder-mcp-oauth-home-"));
// Keep provider config writes (kimi/grok/cursor) off the real home.
process.env.CODER_KIMI_MCP_PATH = path.join(tmpHome, "kimi-mcp.json");
process.env.CODER_GROK_MCP_DISABLE = "1";
process.env.CODER_CURSOR_MCP_DISABLE = "1";

const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { IPC_HANDLERS } = require("../ipc.js");
const { refreshMcpTokens } = require("../ipc-mcp.js");
const { Store } = require("../store.js");
const { createSecrets } = require("../secrets.js");
const {
  resetMemorySupForTests,
  opencodeMcpConfigForRun,
  getCodexMcpEnv,
} = require("../memory-sup.js");
const oauthClient = require("../mcpOauthClient.js");

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`ENC(${plain})`, "utf8"),
    decryptString(buf) {
      const s = Buffer.from(buf).toString("utf8");
      if (!s.startsWith("ENC(") || !s.endsWith(")")) throw new Error("bad cipher");
      return s.slice(4, -1);
    },
  };
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** Fake AS + resource server in one process. */
async function startFakeAuth(opts = {}) {
  const seen = { registrations: [], authorizes: [], tokens: [], mcpAuth: [] };
  const codes = new Map();
  let issued = 0;
  let base = "";
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => resolve(raw));
    });
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, base);
    if (u.pathname === "/mcp") {
      seen.mcpAuth.push(req.headers.authorization || "");
      return json(res, 401, { error: "unauthorized" }, {
        "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      });
    }
    if (u.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (u.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (u.pathname === "/register" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      seen.registrations.push(body);
      return json(res, 201, { ...body, client_id: `client-${seen.registrations.length}` });
    }
    if (u.pathname === "/authorize") {
      const q = Object.fromEntries(u.searchParams);
      seen.authorizes.push(q);
      const code = `code-${seen.authorizes.length}`;
      codes.set(code, q);
      const back = new URL(q.redirect_uri);
      if (opts.deny) {
        back.searchParams.set("error", "access_denied");
        back.searchParams.set("error_description", "User said no");
      } else {
        back.searchParams.set("code", code);
      }
      back.searchParams.set("state", q.state);
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (u.pathname === "/token" && req.method === "POST") {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
      seen.tokens.push(form);
      if (form.grant_type === "authorization_code") {
        const q = codes.get(form.code);
        codes.delete(form.code);
        const challenge = b64url(crypto.createHash("sha256").update(form.code_verifier || "").digest());
        if (!q || q.code_challenge !== challenge || q.redirect_uri !== form.redirect_uri) {
          return json(res, 400, { error: "invalid_grant" });
        }
      } else if (form.grant_type === "refresh_token") {
        if (opts.rejectRefresh || form.refresh_token !== `rt${issued}`) {
          return json(res, 400, { error: "invalid_grant", error_description: "refresh revoked" });
        }
      } else {
        return json(res, 400, { error: "unsupported_grant_type" });
      }
      issued += 1;
      return json(res, 200, {
        access_token: `at${issued}`,
        refresh_token: `rt${issued}`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    url: `${base}/mcp`,
    seen,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}

/** The "browser": follow the authorize redirect into Solenta's loopback. */
async function browser(url) {
  const res = await fetch(url, { redirect: "manual" });
  const location = res.headers.get("location");
  await fetch(location);
}

let tmp;
let fake;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-mcp-oauth-"));
  resetMemorySupForTests();
});

afterEach(async () => {
  resetMemorySupForTests();
  if (fake) await fake.close();
  fake = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

function makeCtx(over = {}) {
  const secrets = createSecrets({ safeStorage: fakeSafeStorage(), inElectron: true, log: () => {} });
  const store = new Store(path.join(tmp, "store", "store.json"), { secrets });
  return {
    store,
    userDataPath: path.join(tmp, "user-data"),
    transport: "desktop",
    openExternal: (url) => browser(url),
    ...over,
  };
}

async function addRemote(ctx, name, url) {
  await IPC_HANDLERS["mcp:save"](ctx, { name, transport: "http", url, enabled: true });
}

function storeFilesText() {
  const dir = path.join(tmp, "store");
  let out = "";
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out += fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

describe("MCP OAuth client", () => {
  it("discovers, registers, runs PKCE through the loopback, stores sealed tokens, and injects them", async () => {
    fake = await startFakeAuth();
    const ctx = makeCtx();
    await addRemote(ctx, "acme", fake.url);

    const row = await IPC_HANDLERS["mcp:oauthConnect"](ctx, { name: "acme" });

    // Discovery started from the 401 on the MCP endpoint.
    assert.ok(fake.seen.mcpAuth.length >= 1);
    // Dynamic client registration with a random 127.0.0.1 loopback redirect.
    assert.equal(fake.seen.registrations.length, 1);
    const reg = fake.seen.registrations[0];
    assert.equal(reg.redirect_uris.length, 1);
    const redirect = new URL(reg.redirect_uris[0]);
    assert.equal(redirect.hostname, "127.0.0.1");
    assert.ok(Number(redirect.port) > 0);
    assert.equal(redirect.pathname, "/callback");
    // PKCE S256 + state + resource indicator on the authorize request.
    const az = fake.seen.authorizes[0];
    assert.equal(az.code_challenge_method, "S256");
    assert.match(az.code_challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(az.state && az.state.length >= 16);
    assert.equal(az.client_id, "client-1");
    assert.equal(az.resource, fake.url);
    // Token exchange carried the verifier that hashes to the challenge.
    const tok = fake.seen.tokens[0];
    assert.equal(tok.grant_type, "authorization_code");
    assert.equal(
      b64url(crypto.createHash("sha256").update(tok.code_verifier).digest()),
      az.code_challenge,
    );
    // The loopback listener is gone after sign-in.
    await assert.rejects(() => fetch(redirect.href));

    // Public row: status only, never a token.
    assert.equal(row.oauth.refreshable, true);
    assert.ok(row.oauth.expiresAt > Date.now());
    assert.equal(JSON.stringify(row).includes("at1"), false);
    const listed = await IPC_HANDLERS["mcp:list"](ctx);
    assert.equal(JSON.stringify(listed).includes("rt1"), false);

    // Stored on the row; sealed on disk.
    const stored = ctx.store.getSettings().mcpServers.find((s) => s.name === "acme");
    assert.equal(stored.oauth.accessToken, "at1");
    assert.equal(stored.oauth.refreshToken, "rt1");
    assert.equal(stored.oauth.clientId, "client-1");
    ctx.store.saveNow();
    const disk = storeFilesText();
    assert.ok(disk.includes("acme"));
    assert.equal(disk.includes('"at1"'), false, "access token is sealed");
    assert.equal(disk.includes('"rt1"'), false, "refresh token is sealed");

    // Every provider gets it as a bearer.
    const oc = opencodeMcpConfigForRun().mcp.acme;
    assert.equal(oc.headers.Authorization, "Bearer at1");
    assert.equal(oc.oauth, false);
    assert.equal(getCodexMcpEnv().CODER_MCP_TOKEN_ACME, "at1");
  });

  it("refreshes a token near expiry and re-injects it; a revoked refresh drops to Sign-in expired", async () => {
    fake = await startFakeAuth();
    const ctx = makeCtx();
    await addRemote(ctx, "acme", fake.url);
    await IPC_HANDLERS["mcp:oauthConnect"](ctx, { name: "acme" });

    // Not due yet: nothing happens.
    await refreshMcpTokens(ctx);
    assert.equal(fake.seen.tokens.length, 1);

    const later = () => Date.now() + 3600_000 - 60_000;
    await refreshMcpTokens(ctx, { now: later });
    const ref = fake.seen.tokens[1];
    assert.equal(ref.grant_type, "refresh_token");
    assert.equal(ref.refresh_token, "rt1");
    assert.equal(ref.client_id, "client-1");
    const stored = ctx.store.getSettings().mcpServers.find((s) => s.name === "acme");
    assert.equal(stored.oauth.accessToken, "at2");
    assert.equal(stored.oauth.refreshToken, "rt2");
    assert.equal(stored.oauth.clientId, "client-1", "refresh keeps the registered client");
    assert.equal(opencodeMcpConfigForRun().mcp.acme.headers.Authorization, "Bearer at2");

    // The server now rejects the refresh token outright.
    await fake.close();
    fake = await startFakeAuth({ rejectRefresh: true });
    const moved = ctx.store.getSettings().mcpServers.map((s) =>
      s.name === "acme"
        ? { ...s, url: fake.url, oauth: { ...s.oauth, expiresAt: Date.now() - 1 } }
        : s,
    );
    ctx.store.setSettings({ mcpServers: moved }, { replaceMcpServers: true });
    await refreshMcpTokens(ctx);
    const after = ctx.store.getSettings().mcpServers.find((s) => s.name === "acme");
    assert.equal(after.oauth.refreshToken, undefined);
    const pub = (await IPC_HANDLERS["mcp:list"](ctx)).find((s) => s.name === "acme");
    assert.equal(pub.oauth.refreshable, false);
    assert.ok(pub.oauth.expiresAt < Date.now(), "UI shows Sign-in expired");
  });

  it("cancel stops a sign-in waiting on the browser and frees the loopback", async () => {
    fake = await startFakeAuth();
    let authorizeUrl = null;
    const ctx = makeCtx({
      openExternal: (url) => {
        authorizeUrl = url;
      },
    });
    await addRemote(ctx, "acme", fake.url);
    const pending = IPC_HANDLERS["mcp:oauthConnect"](ctx, { name: "acme" });
    while (!authorizeUrl) await new Promise((r) => setImmediate(r));
    assert.equal(oauthClient.isPending("acme"), true);
    const redirect = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri"));

    // A stray hit with the wrong state does not end the wait.
    redirect.searchParams.set("code", "x");
    redirect.searchParams.set("state", "wrong");
    const stray = await fetch(redirect.href);
    assert.equal(stray.status, 400);
    assert.equal(oauthClient.isPending("acme"), true);

    assert.deepEqual(await IPC_HANDLERS["mcp:oauthCancel"](ctx, { name: "acme" }), {
      cancelled: true,
    });
    await assert.rejects(pending, /cancelled/);
    assert.equal(oauthClient.isPending("acme"), false);
    await assert.rejects(() => fetch(redirect.href), "loopback closed");
    assert.equal(ctx.store.getSettings().mcpServers[0].oauth, undefined);
  });

  it("surfaces an authorization error from the browser redirect", async () => {
    fake = await startFakeAuth({ deny: true });
    const ctx = makeCtx();
    await addRemote(ctx, "acme", fake.url);
    await assert.rejects(
      () => IPC_HANDLERS["mcp:oauthConnect"](ctx, { name: "acme" }),
      /Sign-in failed: User said no/,
    );
    assert.equal(ctx.store.getSettings().mcpServers[0].oauth, undefined);
  });

  it("sign out forgets the tokens; settings edits keep them; a new URL drops them", async () => {
    fake = await startFakeAuth();
    const ctx = makeCtx();
    await addRemote(ctx, "acme", fake.url);
    await IPC_HANDLERS["mcp:oauthConnect"](ctx, { name: "acme" });

    // Toggle + a renderer settings:set echo of the redacted rows keep the sign-in.
    await IPC_HANDLERS["mcp:setEnabled"](ctx, { name: "acme", enabled: false });
    const echoed = await IPC_HANDLERS["mcp:list"](ctx);
    ctx.store.setSettings({ mcpServers: echoed });
    assert.equal(ctx.store.getSettings().mcpServers[0].oauth.accessToken, "at1");
    // The renderer cannot plant tokens.
    await IPC_HANDLERS["mcp:save"](ctx, {
      name: "acme",
      transport: "http",
      url: fake.url,
      oauth: { accessToken: "evil" },
    });
    assert.equal(ctx.store.getSettings().mcpServers[0].oauth.accessToken, "at1");

    await IPC_HANDLERS["mcp:save"](ctx, {
      name: "acme",
      transport: "http",
      url: `${fake.base}/other`,
    });
    assert.equal(ctx.store.getSettings().mcpServers[0].oauth, undefined);

    await IPC_HANDLERS["mcp:save"](ctx, { name: "acme", transport: "http", url: fake.url });
    await IPC_HANDLERS["mcp:oauthConnect"](ctx, { name: "acme" });
    const row = await IPC_HANDLERS["mcp:oauthDisconnect"](ctx, { name: "acme" });
    assert.equal(row.oauth, undefined);
    assert.equal(ctx.store.getSettings().mcpServers[0].oauth, undefined);
  });

  it("refuses stdio servers and web devices", async () => {
    const ctx = makeCtx();
    await IPC_HANDLERS["mcp:save"](ctx, {
      name: "local",
      transport: "stdio",
      command: "/bin/echo",
      enabled: false,
    });
    await assert.rejects(
      () => IPC_HANDLERS["mcp:oauthConnect"](ctx, { name: "local" }),
      /Only remote MCP servers/,
    );
    await assert.rejects(
      () => IPC_HANDLERS["mcp:oauthConnect"]({ ...ctx, transport: "web" }, { name: "local" }),
      /desktop app/,
    );
  });
});
