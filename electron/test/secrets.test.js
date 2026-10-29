/**
 * At-rest credential encryption (issue #543).
 *
 * Disk holds Electron safeStorage ciphertext; memory stays plaintext.
 * A missing OS keychain must warn, never silently look encrypted.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  PREFIX,
  createSecrets,
  getDefaultSecrets,
} = require("../secrets.js");
const { Store, SAVE_DEBOUNCE_MS } = require("../store.js");
const { createOtel } = require("../otel.js");
const {
  registerMcpServer,
  resetMemorySupForTests,
} = require("../memory-sup.js");
const { rmTree } = require("./support/rmTree.js");

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString(plain) {
      return Buffer.from(`ENC(${plain})`, "utf8");
    },
    decryptString(buf) {
      const s = Buffer.from(buf).toString("utf8");
      if (!s.startsWith("ENC(") || !s.endsWith(")")) {
        throw new Error("bad cipher");
      }
      return s.slice(4, -1);
    },
  };
}

/** Mimics OS safeStorage: same plaintext seals to distinct nonce ciphertext. */
function nonceSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString(plain) {
      const nonce = crypto.randomBytes(16).toString("hex");
      return Buffer.from(`ENC(${nonce}:${plain})`, "utf8");
    },
    decryptString(buf) {
      const s = Buffer.from(buf).toString("utf8");
      if (!s.startsWith("ENC(") || !s.endsWith(")")) {
        throw new Error("bad cipher");
      }
      const inner = s.slice(4, -1);
      const sep = inner.indexOf(":");
      if (sep < 0) throw new Error("bad cipher");
      return inner.slice(sep + 1);
    },
  };
}

describe("createSecrets", () => {
  it("round-trips a string through the enc:v1 envelope", () => {
    const s = createSecrets({ safeStorage: fakeSafeStorage() });
    const sealed = s.seal("sk-live-token");
    assert.ok(sealed.startsWith(PREFIX));
    assert.ok(!sealed.includes("sk-live-token"));
    assert.equal(s.open(sealed), "sk-live-token");
    assert.equal(s.isSealed(sealed), true);
    assert.equal(s.isSealed("sk-live-token"), false);
  });

  it("open() leaves plaintext alone so a pre-upgrade store can load", () => {
    const s = createSecrets({ safeStorage: fakeSafeStorage() });
    assert.equal(s.open("already-plain"), "already-plain");
  });

  it("seal() is idempotent: already-sealed values are not wrapped again", () => {
    const s = createSecrets({ safeStorage: fakeSafeStorage() });
    const sealed = s.seal("tok");
    assert.equal(s.seal(sealed), sealed);
    assert.equal(s.open(s.seal(sealed)), "tok");
  });

  it("warns once and writes plaintext when encryption is unavailable in Electron", () => {
    const logs = [];
    const s = createSecrets({
      safeStorage: { isEncryptionAvailable: () => false },
      inElectron: true,
      log: (m) => logs.push(String(m)),
    });
    assert.equal(s.isEncryptionAvailable(), false);
    assert.equal(s.seal("tok-one"), "tok-one");
    assert.equal(s.seal("tok-two"), "tok-two");
    assert.equal(s.isSealed(s.seal("tok-one")), false);
    assert.equal(logs.length, 1, "unavailable warning must fire once, not per write");
    assert.match(logs[0], /unavailable/i);
    assert.match(logs[0], /plaintext/i);
    assert.doesNotMatch(logs[0], /tok-one|tok-two/);
  });

  it("does not warn about missing encryption outside Electron (node tests, no keychain)", () => {
    const logs = [];
    const s = createSecrets({
      safeStorage: null,
      inElectron: false,
      log: (m) => logs.push(String(m)),
    });
    assert.equal(s.seal("tok"), "tok");
    assert.equal(logs.length, 0);
  });

  it("default backend is disabled: plaintext, no warning, sealed values dropped", () => {
    const logs = [];
    const s = createSecrets({
      inElectron: true,
      log: (m) => logs.push(String(m)),
    });
    assert.equal(s.isEncryptionAvailable(), false);
    assert.equal(s.seal("tok"), "tok");
    assert.equal(s.isSealed(s.seal("tok")), false);
    assert.equal(logs.length, 0, "deliberate disable must not emit the unavailable warning");
    const blob = `${PREFIX}${Buffer.from("cipher").toString("base64")}`;
    assert.equal(s.open(blob, { key: "mcp:team" }), null);
    assert.ok(logs.some((l) => /disabled/.test(l) && /mcp:team/.test(l)));
  });

  it("SOLENTA_ENABLE_SAFE_STORAGE=1 re-enables the backend (and its missing-backend warning)", () => {
    process.env.SOLENTA_ENABLE_SAFE_STORAGE = "1";
    try {
      const logs = [];
      const s = createSecrets({
        inElectron: true,
        log: (m) => logs.push(String(m)),
      });
      // node has no Electron backend, so enabled-but-missing must warn again.
      assert.equal(s.seal("tok"), "tok");
      assert.ok(logs.some((l) => /unavailable/i.test(l)));
    } finally {
      delete process.env.SOLENTA_ENABLE_SAFE_STORAGE;
    }
  });

  it("packaged builds default ON; =0 forces off, unpackaged stays off (#1715)", () => {
    const prev = process.env.SOLENTA_ENABLE_SAFE_STORAGE;
    delete process.env.SOLENTA_ENABLE_SAFE_STORAGE;
    try {
      const logs = [];
      const packaged = createSecrets({
        packaged: true,
        inElectron: true,
        log: (m) => logs.push(String(m)),
      });
      // node has no Electron backend: on-but-missing reports unavailable, loudly.
      assert.equal(packaged.seal("tok"), "tok");
      assert.equal(packaged.status().encryption, "unavailable");
      assert.ok(logs.some((l) => /unavailable/i.test(l)));

      assert.equal(createSecrets({ packaged: false, inElectron: true }).status().encryption, "off");
      process.env.SOLENTA_ENABLE_SAFE_STORAGE = "0";
      assert.equal(createSecrets({ packaged: true, inElectron: true }).status().encryption, "off");
    } finally {
      if (prev === undefined) delete process.env.SOLENTA_ENABLE_SAFE_STORAGE;
      else process.env.SOLENTA_ENABLE_SAFE_STORAGE = prev;
    }
  });

  it("Linux basic_text counts as unencrypted: writes plaintext, still opens old blobs", () => {
    const real = fakeSafeStorage();
    const blob = createSecrets({ safeStorage: real }).seal("old-secret");
    const s = createSecrets({
      safeStorage: { ...real, getSelectedStorageBackend: () => "basic_text" },
      inElectron: true,
      log: () => {},
    });
    assert.equal(s.isEncryptionAvailable(), false);
    assert.equal(s.status().encryption, "unavailable");
    assert.equal(s.seal("new-secret"), "new-secret");
    assert.equal(s.open(blob), "old-secret");
  });

  it("returns null and logs when ciphertext is corrupt, without echoing the blob", () => {
    const logs = [];
    const s = createSecrets({
      safeStorage: fakeSafeStorage(),
      log: (m) => logs.push(String(m)),
    });
    assert.equal(s.open(`${PREFIX}!!!!not-base64-cipher`), null);
    assert.ok(logs.some((l) => /failed to decrypt/i.test(l)));
    assert.ok(logs.every((l) => !l.includes("!!!!not-base64-cipher")));
  });

  it("recordUse never copies the secret value into the audit row", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-secrets-audit-"));
    const auditPath = path.join(dir, "secrets-audit.jsonl");
    try {
      const s = createSecrets({
        safeStorage: fakeSafeStorage(),
        auditPath,
      });
      s.recordUse({
        purpose: "mcp-inject",
        key: "mcp:team",
        secret: "must-not-appear",
        token: "must-not-appear",
      });
      const row = s.getAuditEvents()[0];
      assert.equal(row.event, "decrypt");
      assert.equal(row.purpose, "mcp-inject");
      assert.equal(row.key, "mcp:team");
      assert.ok(row.ts);
      assert.equal(row.secret, undefined);
      assert.equal(row.token, undefined);
      assert.ok(!JSON.stringify(row).includes("must-not-appear"));
      const onDisk = fs.readFileSync(auditPath, "utf8");
      assert.ok(!onDisk.includes("must-not-appear"));
      assert.match(onDisk, /mcp-inject/);
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(auditPath).mode & 0o777, 0o600);
      }
    } finally {
      await rmTree(dir);
    }
  });

  it("concealSettings returns the same object when there is nothing to encrypt", () => {
    const s = createSecrets({ safeStorage: fakeSafeStorage() });
    const settings = {
      mcpServers: [{ name: "x", url: "https://x.example/mcp", enabled: true }],
      otel: { endpoint: null, headers: {}, claudeMetrics: false },
    };
    assert.equal(s.concealSettings(settings), settings);
  });

  it("seals and reveals a Linear API key", () => {
    const s = createSecrets({ safeStorage: fakeSafeStorage() });
    const sealed = s.concealSettings({ linearApiKey: "lin_api_secret" });
    assert.notEqual(sealed, undefined);
    assert.notEqual(sealed.linearApiKey, "lin_api_secret");
    assert.ok(s.isSealed(sealed.linearApiKey));
    const revealed = s.revealSettings(sealed);
    assert.equal(revealed.settings.linearApiKey, "lin_api_secret");
  });

  it("seals and reveals a Sentry auth token (#1588)", () => {
    const s = createSecrets({ safeStorage: fakeSafeStorage() });
    const sealed = s.concealSettings({ sentryAuthToken: "sntrys_secret" });
    assert.notEqual(sealed.sentryAuthToken, "sntrys_secret");
    assert.ok(s.isSealed(sealed.sentryAuthToken));
    const revealed = s.revealSettings(sealed);
    assert.equal(revealed.settings.sentryAuthToken, "sntrys_secret");
  });

  it("seals and reveals a saved GitHub host token (#1528)", () => {
    const s = createSecrets({ safeStorage: fakeSafeStorage() });
    const sealed = s.concealSettings({
      githubHosts: [{ host: "github.com", account: "me", token: "ghp_secret" }],
    });
    assert.ok(s.isSealed(sealed.githubHosts[0].token));
    assert.equal(sealed.githubHosts[0].account, "me");
    const revealed = s.revealSettings(sealed);
    assert.equal(revealed.settings.githubHosts[0].token, "ghp_secret");
  });

  it("seals and reveals MCP remote token, header values, and stdio env", () => {
    const s = createSecrets({ safeStorage: fakeSafeStorage() });
    const settings = {
      mcpServers: [
        {
          name: "team-tools",
          transport: "http",
          url: "https://tools.example.com/mcp",
          enabled: true,
          token: "mcp-token-unique",
          headers: {
            Authorization: "Bearer header-secret-unique",
            "X-Api-Key": "header-key-unique",
          },
        },
        {
          name: "local-tools",
          transport: "stdio",
          command: "/usr/bin/mcp-server",
          args: ["--stdio"],
          enabled: true,
          trusted: true,
          env: { GITHUB_TOKEN: "ghp-env-secret-unique" },
        },
      ],
    };
    const sealed = s.concealSettings(settings);
    assert.notEqual(sealed, settings);
    assert.ok(s.isSealed(sealed.mcpServers[0].token));
    assert.ok(s.isSealed(sealed.mcpServers[0].headers.Authorization));
    assert.ok(s.isSealed(sealed.mcpServers[0].headers["X-Api-Key"]));
    assert.ok(s.isSealed(sealed.mcpServers[1].env.GITHUB_TOKEN));
    assert.ok(!JSON.stringify(sealed).includes("mcp-token-unique"));
    assert.ok(!JSON.stringify(sealed).includes("header-secret-unique"));
    assert.ok(!JSON.stringify(sealed).includes("ghp-env-secret-unique"));
    const revealed = s.revealSettings(sealed);
    assert.equal(revealed.settings.mcpServers[0].token, "mcp-token-unique");
    assert.equal(
      revealed.settings.mcpServers[0].headers.Authorization,
      "Bearer header-secret-unique",
    );
    assert.equal(
      revealed.settings.mcpServers[1].env.GITHUB_TOKEN,
      "ghp-env-secret-unique",
    );
  });
});

describe("Store conceals secrets on disk", () => {
  let tmpDir;
  let filePath;
  let logs;
  let secrets;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-secrets-"));
    filePath = path.join(tmpDir, "coder-store.json");
    logs = [];
    secrets = createSecrets({
      safeStorage: fakeSafeStorage(),
      inElectron: true,
      log: (m) => logs.push(String(m)),
      auditPath: path.join(tmpDir, "secrets-audit.jsonl"),
    });
  });

  afterEach(async () => {
    await rmTree(tmpDir);
  });

  it("writes a Linear API key encrypted, keeps memory plaintext", () => {
    const store = new Store(filePath, { secrets });
    store.setSettings({ linearApiKey: "lin_api_disk_unique" });
    store.saveNow();
    assert.equal(store.getSettings().linearApiKey, "lin_api_disk_unique");
    assert.equal(
      store.data.settings.linearApiKey,
      "lin_api_disk_unique",
      "in-memory store must stay plaintext",
    );
    const disk = fs.readFileSync(filePath, "utf8");
    assert.ok(!disk.includes("lin_api_disk_unique"));
    const parsed = JSON.parse(disk);
    assert.ok(
      String(parsed.settings.linearApiKey).startsWith("enc:v1:"),
      "disk payload must be the enc:v1 envelope",
    );
  });

  it("writes OpenAI-compatible provider headers encrypted, keeps memory plaintext (#1714)", () => {
    const store = new Store(filePath, { secrets });
    store.setSettings({
      providerInstances: [
        {
          id: "gateway",
          name: "Gateway",
          provider: "opencode",
          env: {},
          openaiCompatible: {
            baseUrl: "https://gw.example.com/v1",
            models: ["m1"],
            headers: { Authorization: "Bearer compat-header-unique" },
          },
        },
      ],
    });
    store.saveNow();
    const inst = store.getSettings().providerInstances[0];
    assert.equal(inst.openaiCompatible.headers.Authorization, "Bearer compat-header-unique");
    const disk = fs.readFileSync(filePath, "utf8");
    assert.ok(!disk.includes("compat-header-unique"));
    const onDisk = JSON.parse(disk).settings.providerInstances[0].openaiCompatible;
    assert.ok(String(onDisk.headers.Authorization).startsWith("enc:v1:"));
    assert.equal(onDisk.baseUrl, "https://gw.example.com/v1", "non-secret fields stay plain");
    const back = new Store(filePath, { secrets });
    assert.equal(
      back.getSettings().providerInstances[0].openaiCompatible.headers.Authorization,
      "Bearer compat-header-unique",
    );
  });

  it("writes MCP tokens and OTEL header values encrypted, keeps memory plaintext", () => {
    const store = new Store(filePath, { secrets });
    store.setSettings({
      mcpServers: [
        {
          name: "team-tools",
          url: "https://tools.example.com/mcp",
          enabled: true,
          token: "plain-token-alpha-unique",
        },
      ],
      otel: {
        endpoint: "https://otel.example.com",
        headers: { Authorization: "Bearer otel-secret-unique" },
        claudeMetrics: false,
      },
    });
    store.saveNow();

    assert.equal(
      store.getSettings().mcpServers[0].token,
      "plain-token-alpha-unique",
    );
    assert.equal(
      store.getSettings().otel.headers.Authorization,
      "Bearer otel-secret-unique",
    );
    assert.equal(
      store.data.settings.mcpServers[0].token,
      "plain-token-alpha-unique",
      "in-memory store must stay plaintext",
    );

    const disk = fs.readFileSync(filePath, "utf8");
    assert.ok(!disk.includes("plain-token-alpha-unique"));
    assert.ok(!disk.includes("otel-secret-unique"));
    const parsed = JSON.parse(disk);
    assert.ok(parsed.settings.mcpServers[0].token.startsWith(PREFIX));
    assert.ok(parsed.settings.otel.headers.Authorization.startsWith(PREFIX));
  });

  it("writes MCP header and stdio env values encrypted, keeps memory plaintext", () => {
    const store = new Store(filePath, { secrets });
    store.setSettings({
      mcpServers: [
        {
          name: "team-tools",
          transport: "http",
          url: "https://tools.example.com/mcp",
          enabled: true,
          token: "plain-token-headers-unique",
          headers: { Authorization: "Bearer hdr-secret-unique" },
        },
        {
          name: "local-tools",
          transport: "stdio",
          command: "/usr/bin/mcp-server",
          args: ["--stdio"],
          enabled: true,
          trusted: true,
          env: { API_KEY: "stdio-env-secret-unique" },
        },
      ],
    });
    store.saveNow();

    const mem = store.getSettings().mcpServers;
    assert.equal(mem[0].token, "plain-token-headers-unique");
    assert.equal(mem[0].headers.Authorization, "Bearer hdr-secret-unique");
    assert.equal(mem[1].env.API_KEY, "stdio-env-secret-unique");

    const disk = fs.readFileSync(filePath, "utf8");
    assert.ok(!disk.includes("plain-token-headers-unique"));
    assert.ok(!disk.includes("hdr-secret-unique"));
    assert.ok(!disk.includes("stdio-env-secret-unique"));
    const parsed = JSON.parse(disk);
    assert.ok(parsed.settings.mcpServers[0].token.startsWith(PREFIX));
    assert.ok(parsed.settings.mcpServers[0].headers.Authorization.startsWith(PREFIX));
    assert.ok(parsed.settings.mcpServers[1].env.API_KEY.startsWith(PREFIX));
  });

  it("writes the webhook URL encrypted (Slack/Discord tokens live in the path)", () => {
    const store = new Store(filePath, { secrets });
    store.setSettings({
      webhook: {
        url: "https://hooks.slack.com/services/T00/B00/secret-hook-unique",
        onDone: true,
        onFailed: true,
        onWaiting: false,
      },
    });
    store.saveNow();
    assert.equal(
      store.getSettings().webhook.url,
      "https://hooks.slack.com/services/T00/B00/secret-hook-unique",
    );
    const disk = fs.readFileSync(filePath, "utf8");
    assert.ok(!disk.includes("secret-hook-unique"));
    const parsed = JSON.parse(disk);
    assert.ok(parsed.settings.webhook.url.startsWith(PREFIX));
    assert.equal(parsed.settings.webhook.onWaiting, false);
  });

  it("migrates plaintext credentials on load, encrypts in place, and logs the count", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        projects: [],
        threads: [],
        settings: {
          mcpServers: [
            {
              name: "a",
              url: "https://a.example.com/mcp",
              enabled: true,
              token: "plain-token-alpha-unique",
            },
            {
              name: "b",
              url: "https://b.example.com/mcp",
              enabled: true,
              token: "plain-token-beta-unique",
            },
          ],
          otel: {
            endpoint: "https://otel.example.com",
            headers: { Authorization: "Bearer otel-secret-unique" },
            claudeMetrics: false,
          },
        },
      }),
      "utf8",
    );

    const store = new Store(filePath, { secrets });
    assert.equal(store.getSettings().mcpServers[0].token, "plain-token-alpha-unique");
    assert.equal(store.getSettings().mcpServers[1].token, "plain-token-beta-unique");
    assert.equal(
      store.getSettings().otel.headers.Authorization,
      "Bearer otel-secret-unique",
    );
    assert.ok(
      logs.some((l) => /encrypted 3 plaintext credential/i.test(l)),
      `expected migration log, got: ${logs.join(" | ")}`,
    );

    store.saveNow();
    const disk = fs.readFileSync(filePath, "utf8");
    assert.ok(!disk.includes("plain-token-alpha-unique"));
    assert.ok(!disk.includes("plain-token-beta-unique"));
    assert.ok(!disk.includes("otel-secret-unique"));
    const parsed = JSON.parse(disk);
    assert.ok(parsed.settings.mcpServers[0].token.startsWith(PREFIX));
    assert.ok(parsed.settings.mcpServers[1].token.startsWith(PREFIX));
    assert.ok(parsed.settings.otel.headers.Authorization.startsWith(PREFIX));

    const reloaded = new Store(filePath, { secrets });
    assert.equal(
      reloaded.getSettings().mcpServers[0].token,
      "plain-token-alpha-unique",
    );
    // Second load of already-encrypted values must not count as a migration.
    const migrateLogs = logs.filter((l) =>
      /encrypted \d+ plaintext credential/i.test(l),
    );
    assert.equal(migrateLogs.length, 1);
  });

  it("async flush conceals secrets too, not only saveNow", async () => {
    const store = new Store(filePath, { secrets });
    store.setSettings({
      mcpServers: [
        {
          name: "team-tools",
          url: "https://tools.example.com/mcp",
          enabled: true,
          token: "plain-token-async-unique",
        },
      ],
    });
    store.save();
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS + 80));
    await store.flushPending();
    const disk = fs.readFileSync(filePath, "utf8");
    assert.ok(!disk.includes("plain-token-async-unique"));
    assert.ok(JSON.parse(disk).settings.mcpServers[0].token.startsWith(PREFIX));
    assert.equal(
      store.getSettings().mcpServers[0].token,
      "plain-token-async-unique",
    );
  });

  it("drops a corrupt sealed token on load rather than injecting ciphertext as a bearer", () => {
    const good = secrets.seal("good-token");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        projects: [],
        threads: [],
        settings: {
          mcpServers: [
            {
              name: "ok",
              url: "https://ok.example.com/mcp",
              enabled: true,
              token: good,
            },
            {
              name: "bad",
              url: "https://bad.example.com/mcp",
              enabled: true,
              token: `${PREFIX}not-valid-cipher`,
            },
          ],
        },
      }),
      "utf8",
    );
    const store = new Store(filePath, { secrets });
    const servers = store.getSettings().mcpServers;
    assert.equal(servers.find((s) => s.name === "ok").token, "good-token");
    assert.equal(servers.find((s) => s.name === "bad").token, undefined);
  });

  it("drops corrupt sealed HTTP header and stdio env values rather than ciphertext", () => {
    const goodHeader = secrets.seal("good-header");
    const goodEnv = secrets.seal("good-env");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        projects: [],
        threads: [],
        settings: {
          mcpServers: [
            {
              name: "http-one",
              transport: "http",
              url: "https://ok.example.com/mcp",
              enabled: true,
              headers: {
                Authorization: goodHeader,
                Broken: `${PREFIX}not-valid-cipher`,
              },
            },
            {
              name: "stdio-one",
              transport: "stdio",
              command: "/usr/bin/mcp-server",
              args: [],
              enabled: true,
              trusted: true,
              env: {
                GOOD: goodEnv,
                BAD: `${PREFIX}not-valid-cipher`,
              },
            },
          ],
        },
      }),
      "utf8",
    );
    const store = new Store(filePath, { secrets });
    const servers = store.getSettings().mcpServers;
    const http = servers.find((s) => s.name === "http-one");
    const stdio = servers.find((s) => s.name === "stdio-one");
    assert.equal(http.headers.Authorization, "good-header");
    assert.equal(http.headers.Broken, undefined);
    assert.ok(!JSON.stringify(http.headers).includes(PREFIX));
    assert.equal(stdio.env.GOOD, "good-env");
    assert.equal(stdio.env.BAD, undefined);
    assert.ok(!JSON.stringify(stdio.env).includes(PREFIX));
  });

  it("keeps locked ciphertext byte-for-byte through a settings save (#1715)", () => {
    const instCipher = secrets.seal("sk-instance-unique");
    const mcpCipher = secrets.seal("mcp-token-unique");
    const linearCipher = secrets.seal("lin-unique");
    const corrupt = `${PREFIX}not-valid-cipher`;
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        projects: [],
        threads: [],
        settings: {
          linearApiKey: linearCipher,
          mcpServers: [
            { name: "team", url: "https://t.example.com/mcp", enabled: true, token: mcpCipher },
          ],
          providerInstances: [
            {
              id: "work",
              name: "Claude (work)",
              provider: "claude",
              configDir: path.join(tmpDir, "claude-work"),
              env: { ANTHROPIC_API_KEY: instCipher, BROKEN: corrupt, PLAIN: "visible" },
            },
          ],
        },
      }),
      "utf8",
    );
    // Backend off (dev run / keychain refused): nothing can open.
    const off = createSecrets({ safeStorage: null, inElectron: true, log: () => {} });
    const store = new Store(filePath, { secrets: off });
    const s = store.getSettings();
    assert.equal(s.linearApiKey, null);
    assert.equal(s.mcpServers[0].token, undefined);
    assert.deepEqual(s.providerInstances[0].env, { PLAIN: "visible" });
    assert.ok(!JSON.stringify(s).includes(PREFIX), "ciphertext must never reach memory");
    assert.deepEqual(store.secretStorage().locked.sort(), [
      "instance:work:env:ANTHROPIC_API_KEY",
      "instance:work:env:BROKEN",
      "mcp:team:token",
      "settings:linearApiKey",
    ]);

    // The UI echoes the instance back with what it saw, plus one edit.
    store.setSettings({
      providerInstances: [{ ...s.providerInstances[0], env: { PLAIN: "edited" } }],
      mcpServers: s.mcpServers,
    });
    store.saveNow();
    let disk = JSON.parse(fs.readFileSync(filePath, "utf8")).settings;
    assert.equal(disk.linearApiKey, linearCipher);
    assert.equal(disk.mcpServers[0].token, mcpCipher);
    assert.deepEqual(disk.providerInstances[0].env, {
      PLAIN: "edited",
      ANTHROPIC_API_KEY: instCipher,
      BROKEN: corrupt,
    });

    // Reload with the real backend: the kept values open again.
    const back = new Store(filePath, { secrets });
    assert.equal(back.getSettings().providerInstances[0].env.ANTHROPIC_API_KEY, "sk-instance-unique");
    assert.equal(back.getSettings().mcpServers[0].token, "mcp-token-unique");
    assert.equal(back.getSettings().linearApiKey, "lin-unique");

    // A new value the user types replaces a locked one, and it stays replaced.
    const again = new Store(filePath, { secrets: off });
    again.setSettings({ linearApiKey: "typed-new" });
    again.saveNow();
    again.setSettings({ linearApiKey: null });
    again.saveNow();
    disk = JSON.parse(fs.readFileSync(filePath, "utf8")).settings;
    assert.equal(disk.linearApiKey, null);
    assert.equal(disk.providerInstances[0].env.ANTHROPIC_API_KEY, instCipher);
  });

  it("keeps a value whose decryptString throws (keychain denied) instead of dropping it", () => {
    const cipher = secrets.seal("denied-unique");
    fs.writeFileSync(
      filePath,
      JSON.stringify({ projects: [], threads: [], settings: { sentryAuthToken: cipher } }),
      "utf8",
    );
    const denied = createSecrets({
      safeStorage: {
        ...fakeSafeStorage(),
        decryptString() {
          throw new Error("user denied keychain access");
        },
      },
      inElectron: true,
      log: () => {},
    });
    const store = new Store(filePath, { secrets: denied });
    assert.equal(store.getSettings().sentryAuthToken, null);
    store.setSettings({ dailyBudgetUsd: 5 });
    store.saveNow();
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).settings.sentryAuthToken, cipher);
  });

  it("persists the migration on load without an explicit save", async () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ projects: [], threads: [], settings: { linearApiKey: "lin-plain-unique" } }),
      "utf8",
    );
    const store = new Store(filePath, { secrets });
    // Wait for the debounced save itself, not a fixed delay: a loaded CI
    // runner fired it after SAVE_DEBOUNCE_MS + 100 and the read saw plaintext.
    let disk = fs.readFileSync(filePath, "utf8");
    for (let waited = 0; disk.includes("lin-plain-unique") && waited < SAVE_DEBOUNCE_MS + 5000; waited += 50) {
      await new Promise((r) => setTimeout(r, 50));
      disk = fs.readFileSync(filePath, "utf8");
    }
    assert.ok(!disk.includes("lin-plain-unique"));
    assert.ok(JSON.parse(disk).settings.linearApiKey.startsWith(PREFIX));
    store.flushPending();
  });

  it("reloads agreeing stdio env values when ciphertext is non-deterministic", () => {
    const nonceSecrets = createSecrets({
      safeStorage: nonceSafeStorage(),
      inElectron: true,
      log: (m) => logs.push(String(m)),
    });
    const first = nonceSecrets.seal("same-plaintext-env");
    const second = nonceSecrets.seal("same-plaintext-env");
    assert.notEqual(
      first,
      second,
      "nonce safeStorage must emit distinct ciphertext for equal plaintext",
    );

    const store = new Store(filePath, { secrets: nonceSecrets });
    store.setSettings({
      mcpServers: [
        {
          name: "one",
          transport: "stdio",
          command: "/usr/bin/one",
          args: [],
          enabled: true,
          trusted: true,
          env: { SHARED: "same-plaintext-env" },
        },
        {
          name: "two",
          transport: "stdio",
          command: "/usr/bin/two",
          args: [],
          enabled: true,
          trusted: true,
          env: { SHARED: "same-plaintext-env" },
        },
      ],
    });
    store.saveNow();

    const disk = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.notEqual(
      disk.settings.mcpServers[0].env.SHARED,
      disk.settings.mcpServers[1].env.SHARED,
      "disk must hold distinct sealed envelopes for the same plaintext",
    );

    const reloaded = new Store(filePath, { secrets: nonceSecrets });
    const servers = reloaded.getSettings().mcpServers;
    assert.deepEqual(
      servers.map((s) => s.name).sort(),
      ["one", "two"],
    );
    assert.equal(servers.find((s) => s.name === "one").env.SHARED, "same-plaintext-env");
    assert.equal(servers.find((s) => s.name === "two").env.SHARED, "same-plaintext-env");
  });

  it("reloads a near-limit env value whose sealed form exceeds the plaintext cap", () => {
    const nonceSecrets = createSecrets({
      safeStorage: nonceSafeStorage(),
      inElectron: true,
      log: (m) => logs.push(String(m)),
    });
    const nearLimit = "N".repeat(32 * 1024);
    assert.ok(
      nonceSecrets.seal(nearLimit).length > nearLimit.length,
      "ciphertext must expand past the plaintext cap",
    );

    const store = new Store(filePath, { secrets: nonceSecrets });
    store.setSettings({
      mcpServers: [
        {
          name: "wide",
          transport: "stdio",
          command: "/usr/bin/wide",
          args: [],
          enabled: true,
          trusted: true,
          env: { BIG: nearLimit },
        },
      ],
    });
    store.saveNow();

    const disk = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.ok(disk.settings.mcpServers[0].env.BIG.startsWith(PREFIX));
    assert.ok(disk.settings.mcpServers[0].env.BIG.length > 32 * 1024);

    const reloaded = new Store(filePath, { secrets: nonceSecrets });
    assert.equal(reloaded.getSettings().mcpServers[0].env.BIG, nearLimit);
  });
});

describe("credential injection audit (#543 / #262 companion)", () => {
  afterEach(() => {
    resetMemorySupForTests();
  });

  it("records mcp-inject when a token is written into the CLI MCP config", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-secrets-mcp-"));
    const name = `audit-${crypto.randomBytes(6).toString("hex")}`;
    const prevDisable = process.env.CODER_GROK_MCP_DISABLE;
    const prevKimi = process.env.CODER_KIMI_MCP_PATH;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_KIMI_MCP_PATH = path.join(tmp, "kimi-mcp.json");
    try {
      const before = getDefaultSecrets().getAuditEvents().length;
      registerMcpServer({
        name,
        url: "https://example.test/mcp",
        token: "super-secret-token-xyz",
        user: true,
        userDataPath: tmp,
      });
      const events = getDefaultSecrets().getAuditEvents().slice(before);
      const hit = events.find((e) => e.key === `mcp:${name}`);
      assert.ok(hit, "expected an mcp-inject audit row");
      assert.equal(hit.purpose, "mcp-inject");
      assert.equal(hit.event, "decrypt");
      assert.ok(!JSON.stringify(hit).includes("super-secret-token-xyz"));
      const mcpPath = path.join(tmp, "mcp-coder-memory.json");
      const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      assert.equal(
        mcp.mcpServers[name].headers.Authorization,
        "Bearer super-secret-token-xyz",
      );
    } finally {
      if (prevDisable === undefined) delete process.env.CODER_GROK_MCP_DISABLE;
      else process.env.CODER_GROK_MCP_DISABLE = prevDisable;
      if (prevKimi === undefined) delete process.env.CODER_KIMI_MCP_PATH;
      else process.env.CODER_KIMI_MCP_PATH = prevKimi;
      await rmTree(tmp);
    }
  });

  it("records otel-export once per header key when custom headers are sent", async () => {
    const uses = [];
    const calls = [];
    const o = createOtel({
      getSettings: () => ({
        endpoint: "http://127.0.0.1:4318",
        headers: { Authorization: "Bearer otel-secret-unique" },
        claudeMetrics: false,
      }),
      getThread: () => ({ id: "t" }),
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200 };
      },
      recordSecretUse: (e) => uses.push(e),
      flushMs: 60_000,
      now: () => 1,
    });
    o.startRun({ threadId: "t", runId: "r1", provider: "claude" });
    o.endRun({ threadId: "t", runId: "r1", status: "done" });
    await o.flush();
    o.startRun({ threadId: "t", runId: "r2", provider: "claude" });
    o.endRun({ threadId: "t", runId: "r2", status: "done" });
    await o.flush();
    o.stop();
    assert.ok(calls.length >= 1);
    assert.equal(uses.length, 1, "otel header inject must not flood the audit log");
    assert.equal(uses[0].purpose, "otel-export");
    assert.equal(uses[0].key, "otel:Authorization");
    assert.ok(!JSON.stringify(uses).includes("otel-secret-unique"));
  });

  it("records otel-env when Claude native metrics headers are injected", () => {
    const uses = [];
    const o = createOtel({
      getSettings: () => ({
        endpoint: "http://127.0.0.1:4318",
        headers: { Authorization: "Bearer otel-secret-unique" },
        claudeMetrics: true,
      }),
      getThread: () => ({ id: "t" }),
      recordSecretUse: (e) => uses.push(e),
      flushMs: 60_000,
      now: () => 1,
    });
    const env = o.claudeEnv();
    assert.match(env.OTEL_EXPORTER_OTLP_HEADERS, /Authorization=Bearer otel-secret-unique/);
    assert.equal(uses.length, 1);
    assert.equal(uses[0].purpose, "otel-env");
    assert.equal(uses[0].key, "otel:Authorization");
    o.stop();
  });
});
