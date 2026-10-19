/**
 * Privacy gateway (#295): per-provider redaction of outbound prompts, and the
 * runner join (the CLI sees the redacted prompt, the transcript keeps the raw
 * one plus an event row naming what went).
 *
 * Run: npm run test:electron -- electron/test/privacy-gateway.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const {
  filterOutbound,
  levelFor,
  normalizePrivacyGateway,
} = require("../privacyGateway.js");
const threadSecrets = require("../threadSecrets.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

const GH = "ghp_" + "a".repeat(36);
const settingsWith = (privacyGateway) => ({ privacyGateway });

describe("privacy gateway filter", () => {
  it("is off unless a level is set, and per-provider beats default", () => {
    assert.equal(levelFor({}, "claude"), "off");
    const s = settingsWith({ default: "secrets", providers: { opencode: "off" }, patterns: [] });
    assert.equal(levelFor(s, "claude"), "secrets");
    assert.equal(levelFor(s, "opencode"), "off");
    const off = filterOutbound(s, "t1", "opencode", `token ${GH}`);
    assert.deepEqual(off, { text: `token ${GH}`, note: null });
  });

  it("secrets level redacts token shapes but leaves personal data", () => {
    const s = settingsWith({ default: "secrets", providers: {}, patterns: [] });
    const r = filterOutbound(s, "t1", "claude", `use ${GH} and mail ann@example.org`);
    assert.equal(r.text, "use [redacted:github-token] and mail ann@example.org");
    assert.equal(
      r.note,
      "Privacy gateway (secrets, claude) redacted 1 item before sending: github-token ×1.",
    );
  });

  it("strict adds emails, Luhn-valid cards, SSNs and custom patterns", () => {
    const s = settingsWith({ default: "strict", providers: {}, patterns: ["ACME-\\d{4}", "x*"] });
    const r = filterOutbound(
      s,
      "t1",
      "codex",
      "ann@example.org card 4111 1111 1111 1111, not 4111111111111112, ts 1760000000000, ssn 123-45-6789, ticket ACME-1234",
    );
    assert.equal(
      r.text,
      "[redacted:email] card [redacted:card], not 4111111111111112, ts 1760000000000, ssn [redacted:ssn], ticket [redacted:pattern]",
    );
    assert.match(r.note, /redacted 4 items before sending: email ×1, card ×1, ssn ×1, pattern ×1\./);
  });

  it("redacts this thread's secret-card values", () => {
    threadSecrets.set("t-card", "DB_PASSWORD", "hunter2hunter2");
    try {
      const s = settingsWith({ default: "secrets", providers: {}, patterns: [] });
      const r = filterOutbound(s, "t-card", "claude", "pw is hunter2hunter2");
      assert.equal(r.text, "pw is [secret:DB_PASSWORD]");
      assert.match(r.note, /request-card ×1/);
    } finally {
      threadSecrets.clear("t-card");
    }
  });

  it("settings heal on load and reject junk on set", () => {
    assert.deepEqual(normalizePrivacyGateway({ default: "loud", providers: { a: "x", b: "strict" }, patterns: ["(", "ok"] }), {
      default: "off",
      providers: { b: "strict" },
      patterns: ["ok"],
    });
    assert.throws(() => normalizePrivacyGateway({ default: "loud" }, true), /off, secrets or strict/);
    assert.throws(() => normalizePrivacyGateway({ patterns: ["("] }, true), /Invalid privacy pattern/);
  });
});

describe("store settings round-trip", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-privacy-store-"));
  });
  afterEach(async () => {
    await rmTree(tmpDir);
  });

  it("defaults off, merges patches, persists", () => {
    const file = path.join(tmpDir, "store.json");
    const store = new Store(file);
    assert.deepEqual(store.getSettings().privacyGateway, { default: "off", providers: {}, patterns: [] });
    store.setSettings({ privacyGateway: { providers: { grok: "strict" } } });
    store.setSettings({ privacyGateway: { patterns: ["ACME-\\d+"] } });
    assert.throws(() => store.setSettings({ privacyGateway: "strict" }), /must be an object/);
    store.saveNow();
    assert.deepEqual(new Store(file).getSettings().privacyGateway, {
      default: "off",
      providers: { grok: "strict" },
      patterns: ["ACME-\\d+"],
    });
  });
});

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe("runner sends the redacted prompt", () => {
  let tmpDir;
  let store;
  let runner;
  let argvFile;
  const prevEnv = {};

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-privacy-run-"));
    argvFile = path.join(tmpDir, "argv.json");
    for (const k of ["CODER_SIMULATE", "CODER_GROK_BIN", "CODER_FAKE_GROK_ARGV_FILE", "HOME"]) {
      prevEnv[k] = process.env[k];
    }
    delete process.env.CODER_SIMULATE;
    process.env.HOME = tmpDir;
    process.env.CODER_FAKE_GROK_ARGV_FILE = argvFile;
    process.env.CODER_GROK_BIN = writeFakeBin(
      path.join(tmpDir, "fake-grok"),
      `#!/usr/bin/env node
"use strict";
require("fs").writeFileSync(process.env.CODER_FAKE_GROK_ARGV_FILE, JSON.stringify(process.argv.slice(1)), "utf8");
function emit(o){process.stdout.write(JSON.stringify(o)+"\\n");}
emit({type:"system",subtype:"init",session_id:"g-priv-1",model:"grok-4.6"});
emit({type:"assistant",message:{content:[{type:"text",text:"ok"}]}});
emit({type:"result",subtype:"success",is_error:false,result:"ok",usage:{input_tokens:1,output_tokens:2},total_cost_usd:0,num_turns:1,session_id:"g-priv-1"});
process.exit(0);
`,
    );
    store = new Store(path.join(tmpDir, "store.json"));
    const core = await import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
    runner = createRunner({ store, core, pushFn: () => {}, tickMs: 15, userDataPath: tmpDir });
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["commit", "--allow-empty", "-m", "init"],
    ]) {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    }
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, { projectId: project.id, title: "Priv" });
    services.setProvider(store, { threadId: thread.id, provider: "grok" });
    store.setSettings({ privacyGateway: { providers: { grok: "strict" } } });
    store.saveNow();
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    runner = null;
    await rmTree(tmpDir);
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("redacts the -p prompt, keeps the raw transcript, logs an event", async () => {
    const thread = store.getThreads()[0];
    const prompt = `deploy with ${GH} and ping ann@example.org`;
    await runner.startRun({ threadId: thread.id, prompt });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const sent = String(argv[argv.indexOf("-p") + 1]);
    assert.match(sent, /deploy with \[redacted:github-token\] and ping \[redacted:email\]/);
    assert.ok(!sent.includes(GH) && !sent.includes("ann@example.org"));

    const msgs = store.getMessages(thread.id);
    assert.ok(msgs.some((m) => m.role === "user" && m.text === prompt));
    const event = msgs.find((m) => m.role === "event" && /^Privacy gateway/.test(m.text));
    assert.ok(event, "expected a privacy gateway event row");
    assert.match(event.text, /\(strict, grok\).*github-token ×1.*email ×1/);
    assert.ok(!event.text.includes(GH));
  });
});
