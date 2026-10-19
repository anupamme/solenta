/**
 * Solenta as an ACP agent (issue #272): an ACP client spawns the real
 * acp-cli.js, which pipes over the /acp upgrade into acpServer.js. The runner
 * is scripted; the store and thread creation are real.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createAcpHub, attachAcpUpgrade } = require("../acpServer.js");
const { rmTree } = require("./support/rmTree.js");

const CLI = path.join(__dirname, "..", "acp-cli.js");
const TOKEN = "acp-test-token";

/** Scripted runner: each startRun plays `script(threadId, ctl)`. */
function fakeRunner(store, push) {
  const running = new Set();
  let pending = null;
  let onRespond = null;
  let onStop = null;
  const runner = {
    calls: [],
    isRunning: (id) => running.has(id),
    getPendingPermission: () => pending,
    respondPermission(input) {
      runner.calls.push(["respond", input]);
      pending = null;
      if (onRespond) onRespond(input.decision);
    },
    async stopRun({ threadId }) {
      runner.calls.push(["stop", threadId]);
      if (onStop) onStop();
    },
    async startRun({ threadId, prompt }) {
      runner.calls.push(["start", prompt]);
      running.add(threadId);
      store.updateThread(threadId, { status: "working" });
      const finish = (status) => {
        running.delete(threadId);
        store.updateThread(threadId, { status });
        push(threadId);
      };
      const ctl = {
        msg(m) {
          store.appendMessage(threadId, { createdAt: Date.now(), runId: "r1", ...m });
          push(threadId);
        },
        edit(id, patch) {
          store.updateMessage(threadId, id, patch);
          push(threadId);
        },
        step(item) {
          store.appendWorkLog(threadId, { runId: "r1", timestamp: Date.now(), ...item });
          push(threadId);
        },
        ask(p) {
          return new Promise((resolve) => {
            onRespond = resolve;
            pending = p;
            push(threadId);
          });
        },
        stopped: () => new Promise((resolve) => (onStop = resolve)),
        finish,
      };
      setImmediate(() => runner.script(threadId, ctl));
      return { runId: "r1" };
    },
  };
  return runner;
}

/** Line-based ACP client over the CLI's stdio. */
function acpClient(env) {
  const child = spawn(process.execPath, [CLI], { env, stdio: ["pipe", "pipe", "pipe"] });
  const updates = [];
  const waiting = new Map();
  let id = 0;
  let buf = "";
  let stderr = "";
  const client = { updates, child, onPermission: null };
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (msg.method === "session/update") updates.push(msg.params.update);
      else if (msg.method === "session/request_permission") {
        const result = client.onPermission(msg.params);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
      } else if (waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    }
  });
  client.call = (method, params) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
      child.once("exit", (code) => reject(new Error(`cli exited ${code}: ${stderr}`)));
    });
  client.notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  client.close = () =>
    new Promise((resolve) => {
      if (child.exitCode != null) return resolve();
      child.once("exit", resolve);
      child.stdin.end();
    });
  return client;
}

describe("ACP server (Solenta as an agent)", () => {
  let tmpDir;
  let repo;
  let store;
  let server;
  let runner;
  let env;
  let client;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-acp-"));
    repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    store = new Store(path.join(tmpDir, "store.json"));
    await services.addProject(store, repo);

    let hub;
    runner = fakeRunner(store, (threadId) =>
      hub.onPush("thread:updated", { thread: { id: threadId } }),
    );
    hub = createAcpHub({ store, runner });
    server = http.createServer((_req, res) => res.writeHead(404).end());
    attachAcpUpgrade(server, {
      hub,
      isAuthorized: (req) => req.headers.authorization === `Bearer ${TOKEN}`,
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const userData = path.join(tmpDir, "userData");
    fs.mkdirSync(userData);
    fs.writeFileSync(
      path.join(userData, "orch-server.json"),
      JSON.stringify({ port: server.address().port, token: TOKEN }),
    );
    env = { ...process.env, SOLENTA_USER_DATA: userData };
  });

  afterEach(async () => {
    if (client) await client.close();
    client = null;
    await new Promise((r) => server.close(r));
    await rmTree(tmpDir);
  });

  it("runs a prompt in a new thread and streams text, tools, plan and a permission", async () => {
    runner.script = async (_id, ctl) => {
      ctl.msg({ id: "a1", role: "assistant", text: "Hel" });
      ctl.edit("a1", { text: "Hello" });
      ctl.step({ id: "w1", label: "Run tests", done: false });
      ctl.msg({
        id: "t1",
        role: "tool",
        text: "Bash: npm test",
        tool: { id: "tu1", name: "Bash", input: "{}", output: null, isError: false, done: false },
      });
      const decision = await ctl.ask({ requestId: "p1", toolName: "Bash", summary: "npm test", input: {} });
      ctl.edit("t1", {
        tool: { id: "tu1", name: "Bash", input: "{}", output: decision, isError: false, done: true },
      });
      ctl.finish("done");
    };
    client = acpClient(env);
    client.onPermission = (params) => {
      assert.equal(params.toolCall.title, "npm test");
      assert.deepEqual(params.options.map((o) => o.kind), ["allow_once", "reject_once"]);
      return { outcome: { outcome: "selected", optionId: "allow" } };
    };

    const init = await client.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
    assert.equal(init.result.protocolVersion, 1);

    const created = await client.call("session/new", { cwd: repo, mcpServers: [] });
    const sessionId = created.result.sessionId;
    const thread = store.getThread(sessionId);
    assert.ok(thread, "session id is a real thread id");
    assert.equal(thread.projectId, store.getProjects()[0].id);

    const res = await client.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "run the tests" }],
    });
    assert.deepEqual(res.result, { stopReason: "end_turn" });
    assert.deepEqual(runner.calls[0], ["start", "run the tests"]);
    assert.deepEqual(runner.calls[1], ["respond", { threadId: sessionId, requestId: "p1", decision: "allow" }]);

    const text = client.updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => u.content.text)
      .join("");
    assert.equal(text, "Hello");
    const tool = client.updates.filter((u) => u.toolCallId === "t1");
    assert.deepEqual(tool.map((u) => [u.sessionUpdate, u.status]), [
      ["tool_call", "in_progress"],
      ["tool_call_update", "completed"],
    ]);
    const plan = client.updates.find((u) => u.sessionUpdate === "plan");
    assert.deepEqual(plan.entries, [{ content: "Run tests", priority: "medium", status: "in_progress" }]);
  });

  it("session/cancel stops the thread's run and ends the prompt as cancelled", async () => {
    runner.script = async (_id, ctl) => {
      ctl.msg({ id: "a1", role: "assistant", text: "working" });
      await ctl.stopped();
      ctl.finish("idle");
    };
    client = acpClient(env);
    const { result } = await client.call("session/new", { cwd: repo, mcpServers: [] });
    const prompt = client.call("session/prompt", {
      sessionId: result.sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    while (!client.updates.length) await new Promise((r) => setTimeout(r, 5));
    client.notify("session/cancel", { sessionId: result.sessionId });
    assert.deepEqual((await prompt).result, { stopReason: "cancelled" });
    assert.deepEqual(runner.calls.at(-1), ["stop", result.sessionId]);
  });

  it("rejects a cwd that is not a Solenta project", async () => {
    client = acpClient(env);
    const res = await client.call("session/new", { cwd: tmpDir, mcpServers: [] });
    assert.match(res.error.message, /No Solenta project/);
  });

  it("the CLI exits with a reason when the token is wrong", async () => {
    const userData = env.SOLENTA_USER_DATA;
    const cfg = path.join(userData, "orch-server.json");
    fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, "utf8")), token: "nope" }));
    const child = spawn(process.execPath, [CLI], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((r) => child.on("exit", r));
    assert.equal(code, 1);
    assert.match(stderr, /HTTP 401/);
  });
});
