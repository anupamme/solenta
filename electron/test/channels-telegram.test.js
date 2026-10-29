/**
 * Telegram chat channel (#1718) against a fake Bot API (injected fetch).
 * Never touches api.telegram.org.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const { createSecrets } = require("../secrets.js");
const { redactSettings } = require("../mcp.js");
const { createChannels } = require("../channels/index.js");
const { createTelegram, chunkText } = require("../channels/telegram.js");

const ME = "111";
const TOKEN = "123456:secret-token-xyz";

/** In-memory Bot API: getUpdates long-polls until an update is pushed or aborted. */
function fakeTelegram() {
  const sent = [];
  const answered = [];
  let queue = [];
  let nextId = 1;
  let wake = null;
  let polls = 0;
  let aborts = 0;
  let failPolls = false;
  async function fetch(url, init) {
    const method = String(url).split("/").pop();
    const body = JSON.parse(init.body || "{}");
    const ok = (result) => ({ status: 200, json: async () => ({ ok: true, result }) });
    if (method === "getMe") return ok({ id: 1, username: "test_bot" });
    if (method === "sendMessage") {
      sent.push(body);
      return ok({ message_id: sent.length });
    }
    if (method === "answerCallbackQuery") {
      answered.push(body);
      return ok(true);
    }
    if (method === "getUpdates") {
      polls++;
      if (failPolls) return { status: 502, json: async () => ({ ok: false, description: "Bad Gateway", error_code: 502 }) };
      queue = queue.filter((u) => u.update_id >= (body.offset || 0));
      if (queue.length === 0) {
        await new Promise((resolve, reject) => {
          wake = resolve;
          init.signal.addEventListener("abort", () => {
            aborts++;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      }
      const out = queue;
      queue = [];
      return ok(out);
    }
    throw new Error(`unexpected ${method}`);
  }
  const push = (u) => {
    queue.push({ update_id: nextId++, ...u });
    if (wake) wake();
    wake = null;
  };
  return {
    fetch,
    sent,
    answered,
    get polls() {
      return polls;
    },
    get aborts() {
      return aborts;
    },
    failPolls(on) {
      failPolls = on;
    },
    message(from, text, chat = from, type = "private") {
      push({ message: { chat: { id: Number(chat), type }, from: { id: Number(from) }, text } });
    },
    press(from, data, chat = from, type = "private") {
      push({
        callback_query: { id: `cb${nextId}`, from: { id: Number(from) }, data, message: { chat: { id: Number(chat), type } } },
      });
    },
  };
}

function fakeRunner() {
  const starts = [];
  const responses = [];
  const running = new Set();
  return {
    starts,
    responses,
    running,
    approvals: [],
    async startRun(input) {
      starts.push(input);
    },
    isRunning: (id) => running.has(id),
    async respondPermission(input) {
      responses.push(input);
    },
    listPendingApprovals() {
      return this.approvals;
    },
  };
}

async function waitFor(cond, what = "condition") {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

describe("telegram channel", () => {
  let tmpDir;
  let store;
  let tg;
  let runner;
  let logs;
  let channels;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-tg-"));
    store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([{ id: "p1", slug: "acme/app", name: "app", path: tmpDir }]);
    store.setSettings({
      telegram: { botToken: TOKEN, allowedSenderIds: [ME], projectId: "p1" },
    });
    store.saveNow();
    tg = fakeTelegram();
    runner = fakeRunner();
    logs = [];
    channels = createChannels({ store, runner, fetch: tg.fetch, log: (m) => logs.push(m), backoffMs: 60_000 });
    await channels.connect();
  });

  afterEach(async () => {
    await channels.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("connects as the bot and persists enabled", () => {
    assert.deepEqual(channels.status().telegram, { state: "connected", botUsername: "test_bot", error: null });
    assert.equal(store.getSettings().telegram.enabled, true);
  });

  it("ignores senders off the allowlist, logs the id once, never replies", async () => {
    tg.message("999", "rm -rf everything");
    tg.message("999", "again");
    tg.message(ME, "/status");
    await waitFor(() => tg.sent.length === 1, "status reply");
    assert.equal(runner.starts.length, 0);
    assert.equal(store.getThreads().length, 0);
    assert.equal(tg.sent[0].chat_id, ME);
    assert.equal(logs.filter((l) => l.includes("999")).length, 1);
  });

  it("ignores group chats even from an allowed sender, so output never reaches other members", async () => {
    tg.message(ME, "deploy prod", "-100123", "group");
    tg.message(ME, "and again", "-100456", "supergroup");
    tg.message(ME, "/status");
    await waitFor(() => tg.sent.length === 1, "status reply");
    assert.equal(runner.starts.length, 0);
    assert.equal(store.getThreads().length, 0);
    assert.ok(tg.sent.every((m) => String(m.chat_id) === String(ME)));
    assert.equal(logs.filter((l) => l.includes("-100123")).length, 1);
  });

  it("first message creates a tagged thread and sends the prompt", async () => {
    tg.message(ME, "fix the login bug\nsecond line");
    await waitFor(() => runner.starts.length === 1, "startRun");
    const [thread] = store.getThreads();
    assert.equal(thread.projectId, "p1");
    assert.equal(thread.title, "fix the login bug");
    assert.deepEqual(thread.channel, { kind: "telegram", chatId: ME });
    assert.equal(thread.permissionMode, "default");
    assert.deepEqual(runner.starts[0], { threadId: thread.id, prompt: "fix the login bug\nsecond line" });
    assert.equal(store.getChannelState("telegram").chats[ME], thread.id);
    assert.ok(store.getChannelState("telegram").offset > 0, "offset persisted");
  });

  it("follow-ups continue the same thread, queue while running, /new starts fresh", async () => {
    tg.message(ME, "first");
    await waitFor(() => runner.starts.length === 1);
    const id = runner.starts[0].threadId;
    tg.message(ME, "second");
    await waitFor(() => runner.starts.length === 2);
    assert.equal(runner.starts[1].threadId, id);

    runner.running.add(id);
    tg.message(ME, "third while busy");
    await waitFor(() => store.getThread(id).queued != null, "queued");
    assert.match(JSON.stringify(store.getThread(id).queued), /third while busy/);
    assert.equal(runner.starts.length, 2);

    tg.message(ME, "/new another task");
    await waitFor(() => runner.starts.length === 3);
    assert.notEqual(runner.starts[2].threadId, id);
    assert.equal(store.getThreads().length, 2);
  });

  it("posts the final assistant message back, chunked to 4096", async () => {
    tg.message(ME, "go");
    await waitFor(() => runner.starts.length === 1);
    const id = runner.starts[0].threadId;
    const before = tg.sent.length;
    const text = "a".repeat(5000);
    store.appendMessage(id, { id: "m1", role: "assistant", text, createdAt: Date.now() });
    channels.onThreadUpdate(store.getThread(id), "done");
    await waitFor(() => tg.sent.length === before + 2, "two chunks");
    const parts = tg.sent.slice(before);
    assert.ok(parts.every((p) => p.text.length <= 4096 && p.parse_mode === undefined));
    assert.equal(parts.map((p) => p.text).join(""), text);
    // Same message again (a second transition) is not re-posted.
    channels.onThreadUpdate(store.getThread(id), "done");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(tg.sent.length, before + 2);
  });

  it("approval buttons call respondPermission; strangers' presses do nothing", async () => {
    tg.message(ME, "go");
    await waitFor(() => runner.starts.length === 1);
    const id = runner.starts[0].threadId;
    runner.approvals = [{ threadId: id, requestId: "req-1", summary: "Bash: npm test", command: "npm test" }];
    channels.onThreadUpdate(store.getThread(id), "waiting");
    await waitFor(() => tg.sent.some((m) => m.reply_markup), "buttons");
    const msg = tg.sent.find((m) => m.reply_markup);
    assert.match(msg.text, /npm test/);
    const [[allow], [deny]] = msg.reply_markup.inline_keyboard;
    assert.equal(allow.text, "Allow");
    assert.equal(deny.text, "Deny");

    tg.press("999", allow.callback_data);
    tg.press(ME, allow.callback_data);
    await waitFor(() => runner.responses.length === 1, "respondPermission");
    assert.deepEqual(runner.responses[0], { threadId: id, requestId: "req-1", decision: "allow" });
    await waitFor(() => tg.answered.length === 1);
    assert.equal(tg.answered[0].text, "Allowed");
    // A used button is spent.
    tg.press(ME, allow.callback_data);
    await waitFor(() => tg.answered.length === 2);
    assert.equal(runner.responses.length, 1);
  });

  it("single-choice ask_user questions become buttons that answer through the send path", async () => {
    tg.message(ME, "go");
    await waitFor(() => runner.starts.length === 1);
    const id = runner.starts[0].threadId;
    store.updateThread(id, {
      pendingQuestion: {
        id: "q1",
        askedAt: Date.now(),
        questions: [{ question: "Which DB?", header: "DB", multiSelect: false, options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }] }],
      },
    });
    channels.onThreadUpdate(store.getThread(id), "waiting");
    await waitFor(() => tg.sent.some((m) => m.reply_markup), "question buttons");
    const buttons = tg.sent.find((m) => m.reply_markup).reply_markup.inline_keyboard.map((r) => r[0]);
    assert.deepEqual(buttons.map((b) => b.text), ["Postgres", "SQLite"]);
    tg.press(ME, buttons[1].callback_data);
    await waitFor(() => runner.starts.length === 2);
    assert.deepEqual(runner.starts[1], { threadId: id, prompt: "Answering your question:\n\nWhich DB?\n→ SQLite" });
  });

  it("disconnect aborts the long poll and leaves no timers", async () => {
    await waitFor(() => tg.polls >= 1, "first poll");
    await channels.disconnect();
    assert.equal(tg.aborts, 1);
    assert.equal(channels.status().telegram.state, "off");
    assert.equal(store.getSettings().telegram.enabled, false);
    const polls = tg.polls;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(tg.polls, polls, "no polling after disconnect");
  });

  it("stop during error backoff clears the retry timer", async () => {
    await channels.stopAll();
    tg.failPolls(true);
    const baseline = timers();
    const states = [];
    const watched = createTelegram({
      token: TOKEN,
      fetch: tg.fetch,
      onMessage() {},
      onButton() {},
      onState: (s) => states.push(s),
      backoffMs: 60_000,
    });
    watched.start();
    await waitFor(() => states.some((s) => s.state === "error"), "error state");
    assert.equal(states[0].error, "Bad Gateway");
    assert.ok(timers() > baseline, "backoff timer armed");
    await watched.stop();
    assert.equal(timers(), baseline);
  });
});

describe("telegram settings", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-tg-set-"));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("seals the bot token on disk and never sends it to the renderer", () => {
    const secrets = createSecrets({
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (p) => Buffer.from(`ENC(${p})`, "utf8"),
        decryptString: (b) => Buffer.from(b).toString("utf8").slice(4, -1),
      },
    });
    const file = path.join(tmpDir, "store.json");
    const store = new Store(file, { secrets });
    store.setSettings({ telegram: { botToken: TOKEN, allowedSenderIds: ["42"] } });
    store.saveNow();
    const disk = fs.readFileSync(file, "utf8");
    assert.ok(!disk.includes("secret-token-xyz"));
    assert.ok(JSON.parse(disk).settings.telegram.botToken.startsWith("enc:v1:"));
    assert.equal(new Store(file, { secrets }).getSettings().telegram.botToken, TOKEN);

    const redacted = redactSettings(store.getSettings());
    assert.equal("botToken" in redacted.telegram, false);
    assert.equal(redacted.telegram.hasToken, true);
    // Echoing the redacted row back keeps the saved token.
    store.setSettings({ telegram: redacted.telegram });
    assert.equal(store.getSettings().telegram.botToken, TOKEN);
    store.setSettings({ telegram: { botToken: null } });
    assert.equal(store.getSettings().telegram.botToken, null);
  });

  it("rejects non-numeric sender ids", () => {
    const store = new Store(path.join(tmpDir, "store.json"));
    assert.throws(() => store.setSettings({ telegram: { allowedSenderIds: ["@me"] } }), /must be a number/);
  });

  it("connect refuses without an allowlist", async () => {
    const store = new Store(path.join(tmpDir, "store.json"));
    store.setSettings({ telegram: { botToken: TOKEN } });
    const channels = createChannels({ store, runner: fakeRunner(), fetch: fakeTelegram().fetch, log() {} });
    await assert.rejects(channels.connect(), /allowed sender/);
  });
});

describe("chunkText", () => {
  it("prefers line breaks and keeps surrogate pairs whole", () => {
    assert.deepEqual(chunkText("ab\ncd", 4), ["ab", "cd"]);
    const emoji = "x" + "😀".repeat(3);
    const parts = chunkText(emoji, 4);
    assert.equal(parts.join(""), emoji);
    assert.ok(parts.every((p) => !/[\uD800-\uDBFF]$/.test(p)));
  });
});
