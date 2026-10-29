"use strict";

/**
 * Issue #1723: the diagnostics zip leaves the machine, so no secret, prompt,
 * transcript or home path may survive into it.
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const { createSecrets } = require("../secrets.js");
const {
  BASE_FILES,
  buildDiagnostics,
  diagnosticsFileList,
  probeVersion,
  redactSettings,
  zipFiles,
  exportDiagnostics,
} = require("../diagnostics.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-diag-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const HOME = "/home/fixture-user";
const PROMPT = "PROMPT-CANARY please refactor the billing module";
const OPENAI = "sk-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4";
const GH = "ghp_" + "a".repeat(36);
const SLACK = "xoxb-123456789012-abcdefABCDEF";
const BEARER = "Bearer " + "Zx9".repeat(12);
const HEX = "f".repeat(20) + "0123456789abcdef".repeat(2);
const B64 = "QWxhZGRpbjpvcGVuIHNlc2FtZQ".repeat(2);

/** Common key shapes; any hit in the bundle is a leak. */
const LEAK_PATTERNS = [
  /sk-[A-Za-z0-9_-]{10,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /Bearer\s+[A-Za-z0-9._~+/-]{8,}/,
  /\b[0-9a-f]{32,}\b/i,
  /[A-Za-z0-9+/]{40,}={0,2}/,
];

function fixtureStore() {
  const store = new Store(path.join(tmp, "coder-store.json"), {
    secrets: createSecrets({ safeStorage: null, inElectron: false }),
  });
  store.data.settings = {
    mcpServers: [
      {
        name: "team",
        url: "https://mcp.example.com",
        token: OPENAI,
        enabled: true,
        headers: { Authorization: BEARER },
      },
      {
        name: "local",
        transport: "stdio",
        command: `${HOME}/bin/mcp`,
        args: [],
        env: { API_KEY: "plain-env-value-not-a-pattern", OTHER: GH },
        enabled: true,
        trusted: true,
      },
    ],
    otel: { endpoint: "http://127.0.0.1:4318", headers: { "x-team": "plain-header-value" } },
    linearApiKey: "lin_api_" + "q".repeat(32),
    sentryAuthToken: HEX,
    githubHosts: [{ host: "github.example.com", token: GH }],
    webhook: { url: `https://hooks.slack.com/services/${SLACK}`, onDone: true },
    providerInstances: [
      {
        id: "work",
        provider: "claude",
        name: "Work",
        env: { ANTHROPIC_API_KEY: OPENAI, CLAUDE_CONFIG_DIR: `${HOME}/.claude-work` },
      },
    ],
    promptSnippets: [{ id: "s1", name: "Review", text: PROMPT }],
    worktreeRoot: `${HOME}/worktrees`,
  };
  store.setThreads([
    {
      id: "t-err",
      projectId: "p1",
      title: PROMPT,
      provider: "codex",
      model: "gpt-5",
      status: "failed",
      lastError: `Run error: ${HOME}/repo exploded with ${BEARER}`,
      updatedAt: 2000,
      createdAt: 1000,
    },
    { id: "t-ok", projectId: "p1", title: "fine", provider: "claude", status: "idle", updatedAt: 3000, createdAt: 1000 },
  ]);
  store.appendMessage("t-err", { id: "m1", role: "user", text: PROMPT, createdAt: 1500 });
  return store;
}

const userData = path.join(tmp, "userData");
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(
  path.join(userData, "crash.log"),
  `old line\nsolenta: unhandledRejection: Error at ${HOME}/app/main.js token=${GH}\n`,
);

function build(store = fixtureStore()) {
  return buildDiagnostics({
    store,
    userDataPath: userData,
    home: HOME,
    env: { PATH: "/usr/bin" },
    now: Date.UTC(2026, 9, 29),
    providers: [
      { id: "claude", name: "Claude Code", defaultBin: "claude" },
      { id: "codex", name: "Codex", defaultBin: "codex" },
    ],
    which: (bin) => (bin === "claude" ? `${HOME}/.local/bin/claude` : null),
    probe: async () => ({ version: "2.1.283 (Claude Code)" }),
    authState: (id) => (id === "claude" ? "signedIn" : undefined),
  });
}

/** Reads the central directory and inflates each entry: a real reader's view. */
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "end of central directory record");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(buf.subarray(start, start + csize));
    assert.equal(zlib.crc32(data), buf.readUInt32LE(p + 16), `${name} crc`);
    out[name] = data.toString("utf8");
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

describe("buildDiagnostics", () => {
  it("bundles exactly the expected files", async () => {
    const files = await build();
    assert.deepEqual(
      files.map((f) => f.name),
      [...BASE_FILES, "logs/crash.log"],
    );
    assert.deepEqual(diagnosticsFileList({ userDataPath: userData }), files.map((f) => f.name));
    assert.deepEqual(diagnosticsFileList({ userDataPath: path.join(tmp, "none") }), BASE_FILES);
  });

  it("leaks no secret, prompt, transcript or home path", async () => {
    const files = await build();
    for (const f of files) {
      for (const re of LEAK_PATTERNS) {
        assert.doesNotMatch(f.data, re, `${f.name} leaks ${re}`);
      }
      assert.ok(!f.data.includes(HOME), `${f.name} names the home dir`);
      assert.ok(!f.data.includes("PROMPT-CANARY"), `${f.name} carries prompt text`);
      assert.ok(!f.data.includes("plain-env-value"), `${f.name} carries an env value`);
      assert.ok(!f.data.includes("plain-header-value"), `${f.name} carries an OTel header`);
    }
  });

  it("records providers, errors and secret status without identities", async () => {
    const byName = Object.fromEntries((await build()).map((f) => [f.name, JSON.parse(f.name.endsWith(".json") ? f.data : "null")]));
    const [claude, codex] = byName["providers.json"];
    assert.equal(claude.bin, "~/.local/bin/claude");
    assert.equal(claude.version, "2.1.283 (Claude Code)");
    assert.equal(claude.signedIn, "yes");
    assert.equal(codex.installed, false);
    assert.equal(codex.signedIn, "unknown");
    assert.ok(!("email" in claude) && !("account" in claude));

    const errors = byName["errors.json"];
    assert.equal(errors.length, 1);
    assert.equal(errors[0].threadId, "t-err");
    assert.equal(errors[0].provider, "codex");
    assert.match(errors[0].error, /^Run error: ~\/repo exploded/);
    assert.ok(!("title" in errors[0]));

    assert.deepEqual(byName["secrets-status.json"], { encryption: "unavailable", lockedCount: 0 });
    const s = byName["settings.redacted.json"];
    assert.equal(s.mcpServers[0].token, "[redacted]");
    assert.equal(s.mcpServers[0].headers.Authorization, "[redacted]");
    assert.equal(s.mcpServers[1].env.API_KEY, "[redacted]");
    assert.equal(s.mcpServers[1].command, "~/bin/mcp");
    assert.equal(s.providerInstances[0].env.ANTHROPIC_API_KEY, "[redacted]");
    assert.equal(s.worktreeRoot, "~/worktrees");
    assert.deepEqual(s.promptSnippets, { count: 1 });

    const app = byName["app.json"];
    assert.equal(app.platform, process.platform);
    assert.equal(typeof app.uptimeSeconds, "number");
  });

  it("drops telegram.botToken and redacts every secretGroups field", () => {
    const out = redactSettings(
      { telegram: { botToken: "123456:AAE" + "x".repeat(30), enabled: true }, webhook: { url: "https://x" } },
      (v) => String(v),
    );
    assert.deepEqual(out.telegram, { enabled: true });
    assert.equal(out.webhook.url, "[redacted]");
  });
});

describe("zipFiles", () => {
  it("writes a zip that opens and lists the bundle", async () => {
    const files = await build();
    const zip = zipFiles(files);
    const entries = unzip(zip);
    assert.deepEqual(Object.keys(entries), files.map((f) => f.name));
    assert.equal(entries["app.json"], files[0].data);
    if (process.platform !== "win32") {
      const file = path.join(tmp, "check.zip");
      fs.writeFileSync(file, zip);
      let listing = "";
      try {
        listing = execFileSync("unzip", ["-l", file], { encoding: "utf8" });
      } catch {
        return; // no unzip on this runner; the parser above already read it
      }
      for (const f of files) assert.ok(listing.includes(f.name), `unzip lists ${f.name}`);
    }
  });
});

describe("probeVersion", () => {
  it("kills a CLI that hangs past the timeout", async () => {
    const started = Date.now();
    const r = await probeVersion(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], 200);
    assert.deepEqual(r, { version: null, error: "timed out" });
    assert.ok(Date.now() - started < 5000);
  });

  it("returns the first line of --version", async () => {
    const r = await probeVersion(process.execPath, ["--version"]);
    assert.equal(r.version, process.version);
  });

  it("reports a missing binary as failed", async () => {
    const r = await probeVersion(path.join(tmp, "no-such-cli"));
    assert.deepEqual(r, { version: null, error: "failed" });
  });
});

describe("exportDiagnostics", () => {
  it("writes nothing when the save dialog is cancelled", async () => {
    const r = await exportDiagnostics({
      store: fixtureStore(),
      dialog: { showSaveDialog: async () => ({ canceled: true }) },
    });
    assert.equal(r, null);
  });

  it("saves the zip where the dialog points, with the default name offered", async () => {
    const target = path.join(tmp, "out.zip");
    let offered = "";
    const r = await exportDiagnostics({
      store: fixtureStore(),
      userDataPath: userData,
      dialog: {
        showSaveDialog: async (o) => {
          offered = path.basename(o.defaultPath);
          return { canceled: false, filePath: target };
        },
      },
    }, { which: () => null, authState: () => undefined });
    assert.equal(r, target);
    assert.match(offered, /^solenta-diagnostics-.+-\d{4}-\d{2}-\d{2}\.zip$/);
    assert.ok(Object.keys(unzip(fs.readFileSync(target))).includes("settings.redacted.json"));
  });
});
