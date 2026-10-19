"use strict";

/**
 * Solenta as an ACP agent (#272): acp-server.js drives the pairing MCP
 * tools (#157) on a real orch server and Store, with a fake runner.
 *
 * Run: node --test electron/test/acp-server.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { execFileSync, spawnSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const pairing = require("../pairing.js");
const { createOrchServer } = require("../orchServer.js");
const { resetMemorySupForTests } = require("../memory-sup.js");
const { serveAcp, pickProject } = require("../acp-server.js");
const { rmTree } = require("./support/rmTree.js");

const APP_PATH = path.join(__dirname, "..", "..");
const ENV_KEYS = [
  "CODER_KIMI_MCP_PATH",
  "CODER_KIMI_BIN",
  "CODER_GROK_MCP_DISABLE",
  "CODER_GROK_BIN",
  "CODER_GROK_CONFIG_PATH",
  "CODER_CURSOR_MCP_DISABLE",
];

/** An ACP client over in-memory pipes. */
function acpClient(opts) {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  serveAcp({ input: toServer, output: fromServer, pollMs: 20, ...opts });
  const pending = new Map();
  /** @type {Array<{ sessionId: string, update: any }>} */
  const updates = [];
  let buf = "";
  let nextId = 1;
  fromServer.setEncoding("utf8");
  fromServer.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (msg.method === "session/update") updates.push(msg.params);
      else if (pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    }
  });
  return {
    updates,
    request(method, params) {
      const id = nextId++;
      toServer.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    notify(method, params) {
      toServer.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    text(sessionId) {
      return updates
        .filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk")
        .map((u) => u.update.content.text)
        .join("");
    },
  };
}

describe("acp-server", () => {
  let tmpDir;
  let store;
  let orch;
  let project;
  let url;
  const saved = {};
  /** @type {Array<{ threadId: string, prompt: string }>} */
  let runs;
  /** threadId -> finish the fake run */
  let finishers;

  beforeEach(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-acp-server-"));
    process.env.CODER_KIMI_MCP_PATH = path.join(tmpDir, "kimi-mcp.json");
    process.env.CODER_KIMI_BIN = path.join(tmpDir, "no-kimi");
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = path.join(tmpDir, "no-grok");
    process.env.CODER_GROK_CONFIG_PATH = path.join(tmpDir, "grok-config.toml");
    process.env.CODER_CURSOR_MCP_DISABLE = "1";
    resetMemorySupForTests();
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    project = await services.addProject(store, repo);
    runs = [];
    finishers = new Map();
    // Streams "echo: <prompt>" in two growing writes, then waits for finish.
    const runner = {
      async startRun({ threadId, prompt }) {
        runs.push({ threadId, prompt });
        store.updateThread(threadId, { status: "working" });
        const id = `m${runs.length}`;
        store.appendMessage(threadId, { id, role: "assistant", text: "echo: " });
        setTimeout(() => store.updateMessage(threadId, id, { text: `echo: ${prompt}` }), 30);
        finishers.set(threadId, (status = "done") => store.updateThread(threadId, { status }));
        return { runId: id };
      },
      async stopRun({ threadId }) {
        store.updateThread(threadId, { status: "idle" });
      },
      isRunning: (threadId) => store.getThread(threadId).status === "working",
    };
    orch = createOrchServer({ store, runner, userDataPath: tmpDir, appPath: APP_PATH, log() {} });
    await orch.start();
    url = `http://127.0.0.1:${orch.getStatus().port}/mcp`;
  });

  afterEach(async () => {
    orch.stop();
    resetMemorySupForTests();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rmTree(tmpDir);
  });

  function mint(input = {}) {
    return pairing.createPairing(
      tmpDir,
      { name: "Zed", capabilities: ["read", "launch", "steer"], requireApproval: false, readsPerMinute: 10000, ...input },
      { getOrchStatus: () => orch.getStatus() },
    );
  }

  /** Finish the latest fake run once the editor has seen its whole reply. */
  async function finishWhen(predicate) {
    for (let i = 0; i < 500 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
    finishers.get(runs.at(-1).threadId)("done");
  }

  it("launches a task, streams its reply, and sends follow-ups to the same thread", async () => {
    const minted = mint();
    const acpJson = JSON.parse(minted.acpJson);
    const entry = acpJson.agent_servers.Solenta;
    assert.equal(entry.env.SOLENTA_MCP_URL, url);
    assert.equal(entry.env.SOLENTA_TOKEN, minted.token);
    assert.equal(path.basename(entry.args[0]), "acp-server.js");

    const client = acpClient({ url, token: minted.token });
    const init = await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    assert.equal(init.protocolVersion, 1);
    const { sessionId } = await client.request("session/new", { cwd: project.path, mcpServers: [] });

    const first = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "fix the bug" }] });
    await finishWhen(() => client.text(sessionId) === "echo: fix the bug");
    assert.deepEqual(await first, { stopReason: "end_turn" });
    assert.equal(client.text(sessionId), "echo: fix the bug", "the growing reply streams as deltas");
    const threadId = runs[0].threadId;
    assert.equal(store.getThread(threadId).projectId, project.id);
    assert.equal(store.getThread(threadId).pairingLabel, "Zed");

    const second = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "again" }] });
    await finishWhen(() => client.text(sessionId).endsWith("echo: again"));
    assert.deepEqual(await second, { stopReason: "end_turn" });
    assert.equal(runs.length, 2);
    assert.equal(runs[1].threadId, threadId, "task_send on the session's thread");
    assert.equal(client.text(sessionId), "echo: fix the bugecho: again", "only the new reply streams");
  });

  it("session/cancel stops the task and the turn ends cancelled", async () => {
    const minted = mint();
    const client = acpClient({ url, token: minted.token });
    const { sessionId } = await client.request("session/new", { cwd: project.path, mcpServers: [] });
    const turn = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "long job" }] });
    for (let i = 0; i < 500 && !client.text(sessionId); i++) await new Promise((r) => setTimeout(r, 10));
    client.notify("session/cancel", { sessionId });
    assert.deepEqual(await turn, { stopReason: "cancelled" });
    assert.equal(store.getThread(runs[0].threadId).status, "idle");
  });

  it("tells the editor when a launch waits for approval in Solenta", async () => {
    const minted = mint({ requireApproval: true });
    const client = acpClient({ url, token: minted.token });
    const { sessionId } = await client.request("session/new", { cwd: project.path, mcpServers: [] });
    const turn = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "needs ok" }] });
    for (let i = 0; i < 500 && !client.text(sessionId); i++) await new Promise((r) => setTimeout(r, 10));
    assert.match(client.text(sessionId), /approve this task in Solenta/);
    const thread = store.getThreads().find((t) => t.pairingLabel === "Zed");
    await pairing.approveExternalRun({ store, runner: { startRun: async (i) => {
      store.updateThread(i.threadId, { status: "working" });
      store.appendMessage(i.threadId, { id: "ok", role: "assistant", text: "approved and done" });
      store.updateThread(i.threadId, { status: "done" });
    } } }, thread.id);
    assert.deepEqual(await turn, { stopReason: "end_turn" });
    assert.match(client.text(sessionId), /approved and done$/);
  });

  it("a read-only pairing fails the prompt with Solenta's own error", async () => {
    const minted = mint({ capabilities: ["read"] });
    const client = acpClient({ url, token: minted.token });
    const { sessionId } = await client.request("session/new", { cwd: project.path, mcpServers: [] });
    await assert.rejects(
      client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "x" }] }),
      /launch/,
    );
  });

  it("picks the project by id, folder name, or the only one; otherwise says which to set", () => {
    const list = [
      { id: "a", name: "Alpha", slug: "alpha" },
      { id: "b", name: "Beta", slug: "beta" },
    ];
    assert.equal(pickProject(list, "/x/beta", undefined).id, "b");
    assert.equal(pickProject(list, "/x/other", "a").id, "a");
    assert.equal(pickProject([list[0]], "/x/other", undefined).id, "a");
    assert.throws(() => pickProject(list, "/x/other", undefined), /SOLENTA_PROJECT_ID.*Alpha \(a\)/);
    assert.throws(() => pickProject(list, "/x/beta", "zzz"), /not visible/);
  });

  it("the script refuses to start without its env", () => {
    const res = spawnSync(process.execPath, [path.join(__dirname, "..", "acp-server.js")], {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /SOLENTA_MCP_URL/);
  });
});
