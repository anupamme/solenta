"use strict";

/**
 * Two-way chat channels (#1718): a chat message starts or continues a
 * thread, and the thread's result, approval prompts and questions go back
 * to the chat. Telegram is the only transport today. A transport needs:
 * sendText, sendButtons, answerButton, getMe, start/stop, and to hand
 * onMessage({ chatId, senderId, text }) / onButton({ id, chatId, senderId,
 * data }) normalized events in here.
 *
 * Chat text is untrusted: it only ever becomes a prompt (never a shell
 * argument), senders off the allowlist and group chats get no reply at all, and threads run
 * with the project's / profile's normal permission mode.
 *
 * State: store.getChannelState("telegram") holds the poll offset and the
 * chat -> thread map; the thread carries `channel: { kind, chatId }` so a
 * finished turn finds its chat.
 */

const services = require("../services.js");
const { createTelegram } = require("./telegram.js");

const KIND = "telegram";
const HELP =
  "Send a message to start a thread. Later messages continue it.\n" +
  "/new starts a fresh thread, /status shows the current one.";
const QUESTION_PREFIX = "Answering your question:\n\n";

/** @param {unknown} err */
function errText(err) {
  return String((err && /** @type {any} */ (err).message) || err).slice(0, 500);
}

/**
 * @param {object} deps
 * @param {import("../store").Store} deps.store
 * @param {any} deps.runner
 * @param {(channel: string, payload: unknown) => void} [deps.broadcast]
 * @param {typeof fetch} [deps.fetch]
 * @param {(msg: string) => void} [deps.log]
 * @param {number} [deps.pollTimeoutSec]
 * @param {number} [deps.backoffMs]
 */
function createChannels(deps) {
  const { store, runner } = deps;
  const broadcast = deps.broadcast || (() => {});
  const log = deps.log || ((msg) => console.warn(msg));
  /** @type {{ client: ReturnType<typeof createTelegram> | null, state: string, botUsername: string | null, error: string | null }} */
  const tg = { client: null, state: "off", botUsername: null, error: null };
  const warnedSenders = new Set();
  // Button key -> what it answers. Lost on restart: a stale press says so.
  // ponytail: grows by one per unanswered prompt; prune if that ever matters.
  /** @type {Map<string, { chatId: string, threadId: string, requestId?: string, questionId?: string }>} */
  const buttons = new Map();
  let nextKey = 1;
  const sentPrompts = new Set();
  /** @type {Map<string, unknown>} threadId -> last assistant message posted */
  const posted = new Map();

  const cfg = () => store.getSettings().telegram;
  const allowed = (/** @type {string} */ senderId) =>
    cfg().allowedSenderIds.includes(String(senderId));
  const chats = () => store.getChannelState(KIND).chats;
  const changed = () => broadcast("threads:changed", services.listThreads(store));

  /** @param {string} chatId @param {string} text */
  async function send(chatId, text) {
    if (!tg.client) return;
    try {
      await tg.client.sendText(chatId, text);
    } catch (err) {
      log(`telegram: send failed: ${errText(err)}`);
    }
  }

  /** @param {string} chatId @param {string} text @param {Array<{ text: string, data: string }>} list */
  async function sendButtons(chatId, text, list) {
    if (!tg.client) return;
    try {
      await tg.client.sendButtons(chatId, text, list);
    } catch (err) {
      log(`telegram: send failed: ${errText(err)}`);
    }
  }

  /** @param {string} chatId @param {string} text */
  async function startThread(chatId, text) {
    const c = cfg();
    const project = c.projectId ? store.getProject(c.projectId) : null;
    if (!project) {
      await send(chatId, "No default project is set. Pick one in Solenta: Settings → Integrations → Telegram.");
      return;
    }
    const thread = services.createThread(store, {
      projectId: project.id,
      title: text.split("\n")[0],
      channel: { kind: KIND, chatId },
    });
    if (c.agentProfileId) {
      try {
        services.applyAgentProfile(store, { threadId: thread.id, profileId: c.agentProfileId });
      } catch (err) {
        log(`telegram: agent profile not applied: ${errText(err)}`);
      }
    }
    // Same lazy worktree intent as a New Thread with the default on.
    if (store.getSettings().defaultWorktree && !project.scratch && !project.remoteHost) {
      store.updateThread(thread.id, { pendingWorktree: true });
    }
    chats()[chatId] = thread.id;
    store.save();
    changed();
    try {
      await runner.startRun({ threadId: thread.id, prompt: text });
      await send(chatId, `Started "${thread.title}". I'll reply here when it's done.`);
    } catch (err) {
      await send(chatId, `Could not start the thread: ${errText(err)}`);
    }
  }

  /** @param {any} thread @param {string} chatId @param {string} text */
  async function continueThread(thread, chatId, text) {
    const queue = async () => {
      services.setQueued(store, { threadId: thread.id, prompt: text });
      changed();
      await send(chatId, "Queued. It runs when the current turn finishes.");
    };
    if (runner.isRunning(thread.id) || thread.status === "working") return queue();
    try {
      await runner.startRun({ threadId: thread.id, prompt: text });
    } catch (err) {
      if (/already active/i.test(errText(err))) return queue();
      await send(chatId, `Could not send: ${errText(err)}`);
    }
  }

  /** @param {{ chatId: string, chatType: string, senderId: string, text: string }} msg */
  async function onMessage({ chatId, chatType, senderId, text }) {
    // Private chats only: in a group, every member would read the agent's
    // output (code, diffs, maybe secrets) even if only the sender is allowed.
    if (chatType !== "private") {
      if (!warnedSenders.has(`chat:${chatId}`)) {
        warnedSenders.add(`chat:${chatId}`);
        log(`telegram: ignored a message in ${chatType || "a non-private"} chat ${chatId}. Message the bot directly.`);
      }
      return;
    }
    if (!allowed(senderId)) {
      if (!warnedSenders.has(senderId)) {
        warnedSenders.add(senderId);
        log(
          `telegram: ignored a message from sender id ${senderId}. ` +
            "Add it to Allowed sender IDs in Settings to let it start threads.",
        );
      }
      return;
    }
    const body = text.trim();
    if (!body) {
      await send(chatId, "Only text messages are supported.");
      return;
    }
    const cmd = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(body);
    const name = cmd ? cmd[1].toLowerCase() : null;
    if (name === "start" || name === "help") {
      await send(chatId, HELP);
      return;
    }
    if (name === "new") {
      delete chats()[chatId];
      store.save();
      const rest = (cmd && cmd[2] ? cmd[2] : "").trim();
      if (rest) await startThread(chatId, rest);
      else await send(chatId, "OK. Your next message starts a new thread.");
      return;
    }
    const threadId = chats()[chatId];
    const thread = threadId ? store.getThread(threadId) : null;
    const live = thread && !services.isTrashed(thread) ? thread : null;
    if (name === "status") {
      if (!live) await send(chatId, "No thread yet. Send a message to start one.");
      else {
        const s = live.status === "working" && live.awaitingInput ? "waiting for you" : live.status;
        await send(chatId, `${live.title}: ${s}`);
      }
      return;
    }
    if (live) await continueThread(live, chatId, body);
    else await startThread(chatId, body);
  }

  /** @param {{ id: string, chatId: string, chatType: string, senderId: string, data: string }} press */
  async function onButton({ id, chatId, chatType, senderId, data }) {
    if (chatType !== "private" || !allowed(senderId)) return;
    const answer = async (/** @type {string} */ text) => {
      try {
        if (tg.client) await tg.client.answerButton(id, text);
      } catch {
        // The spinner times out on its own.
      }
    };
    const [kind, key, idx] = data.split(":");
    const b = buttons.get(key);
    if (!b || b.chatId !== chatId) {
      await answer("This button has expired. Answer in Solenta.");
      return;
    }
    if ((kind === "ok" || kind === "no") && b.requestId) {
      buttons.delete(key);
      try {
        // Same call the approvals inbox and the thread's permission card make.
        await runner.respondPermission({
          threadId: b.threadId,
          requestId: b.requestId,
          decision: kind === "ok" ? "allow" : "deny",
        });
        await answer(kind === "ok" ? "Allowed" : "Denied");
      } catch (err) {
        await answer(errText(err).slice(0, 180));
      }
      return;
    }
    if (kind === "q" && b.questionId) {
      const thread = store.getThread(b.threadId);
      const card = thread && thread.pendingQuestion;
      const q = card && card.id === b.questionId ? card.questions[0] : null;
      const opt = q ? q.options[Number(idx)] : null;
      if (!thread || !q || !opt) {
        buttons.delete(key);
        await answer("This question was already answered.");
        return;
      }
      buttons.delete(key);
      await answer(opt.label);
      // The desktop question card answers through the normal send path too.
      await continueThread(thread, chatId, `${QUESTION_PREFIX}${q.question}\n→ ${opt.label}`);
      return;
    }
    await answer("Unknown button.");
  }

  /** @param {any} thread */
  async function sendApprovals(thread) {
    const chatId = thread.channel.chatId;
    const list = typeof runner.listPendingApprovals === "function" ? runner.listPendingApprovals() : [];
    for (const a of list) {
      if (a.threadId !== thread.id) continue;
      const seen = `${thread.id}:${a.requestId}`;
      if (sentPrompts.has(seen)) continue;
      sentPrompts.add(seen);
      if ((a.questions && a.questions.length) || a.inputRequest) {
        await send(chatId, `${thread.title} is asking: ${a.summary}\nAnswer this in Solenta.`);
        continue;
      }
      const key = String(nextKey++);
      buttons.set(key, { chatId, threadId: thread.id, requestId: a.requestId });
      const detail = a.plan ? `Plan:\n${a.plan}` : a.command || a.summary;
      await sendButtons(chatId, `${thread.title} needs approval:\n${detail}`, [
        { text: "Allow", data: `ok:${key}` },
        { text: "Deny", data: `no:${key}` },
      ]);
    }
  }

  /** @param {any} thread */
  async function sendQuestion(thread) {
    const card = thread.pendingQuestion;
    if (!card || sentPrompts.has(card.id)) return;
    sentPrompts.add(card.id);
    const chatId = thread.channel.chatId;
    const qs = Array.isArray(card.questions) ? card.questions : [];
    const one = qs.length === 1 && !qs[0].multiSelect && qs[0].options.length > 0 ? qs[0] : null;
    if (one) {
      const key = String(nextKey++);
      buttons.set(key, { chatId, threadId: thread.id, questionId: card.id });
      const tail = one.customAnswer === false ? "" : "\n\nOr reply with your own answer.";
      await sendButtons(
        chatId,
        `${one.question}${tail}`,
        one.options.map((/** @type {any} */ o, /** @type {number} */ i) => ({
          text: String(o.label).slice(0, 60),
          data: `q:${key}:${i}`,
        })),
      );
      return;
    }
    const lines = qs.map(
      (/** @type {any} */ q) =>
        `${q.question}\n${q.options.map((/** @type {any} */ o) => `• ${o.label}`).join("\n")}`,
    );
    await send(chatId, `${lines.join("\n\n")}\n\nReply with your answers here, or answer in Solenta.`);
  }

  /** @param {any} thread @param {string} next */
  async function deliver(thread, next) {
    const chatId = thread.channel.chatId;
    if (next === "done") {
      const msg = store.getLastAssistantMessage(thread.id);
      const mark = msg && (msg.id ?? msg.text);
      if (msg && posted.get(thread.id) !== mark) {
        posted.set(thread.id, mark);
        await send(chatId, msg.text);
      }
    } else if (next === "failed") {
      await send(chatId, `${thread.title} failed: ${thread.lastError || "unknown error"}`);
    } else if (next === "waiting") {
      await sendApprovals(thread);
    }
    await sendQuestion(store.getThread(thread.id) || thread);
  }

  /**
   * Thread state transition hook (main.js pushFn, same gate as the webhook):
   * next is "done" | "failed" | "waiting".
   * @param {any} thread
   * @param {string} next
   */
  function onThreadUpdate(thread, next) {
    if (!thread || !thread.channel || thread.channel.kind !== KIND || !tg.client) return;
    void deliver(thread, next).catch((err) => log(`telegram: deliver failed: ${errText(err)}`));
  }

  async function stopClient() {
    const client = tg.client;
    tg.client = null;
    if (client) await client.stop();
  }

  function status() {
    return { telegram: { state: tg.state, botUsername: tg.botUsername, error: tg.error } };
  }

  /** Validate the token with getMe, then poll. Persists enabled so a relaunch reconnects. */
  async function connect() {
    const c = cfg();
    if (!c.botToken) throw new Error("Add a bot token first");
    if (c.allowedSenderIds.length === 0) {
      throw new Error("Add at least one allowed sender ID first");
    }
    await stopClient();
    const client = createTelegram({
      token: c.botToken,
      fetch: deps.fetch,
      offset: store.getChannelState(KIND).offset,
      onOffset: (offset) => {
        store.getChannelState(KIND).offset = offset;
        store.save();
      },
      onMessage,
      onButton,
      onState: (s) => {
        if (tg.client !== client) return;
        tg.state = s.state;
        tg.error = s.error || null;
      },
      log,
      pollTimeoutSec: deps.pollTimeoutSec,
      backoffMs: deps.backoffMs,
    });
    tg.state = "connecting";
    tg.error = null;
    try {
      require("../secrets.js").recordSecretUse({ purpose: "telegram", key: "telegram.botToken" });
      const me = await client.getMe();
      tg.botUsername = me && me.username ? String(me.username) : null;
    } catch (err) {
      tg.state = "error";
      tg.error = errText(err);
      throw err;
    }
    tg.client = client;
    tg.state = "connected";
    client.start();
    if (!c.enabled) {
      store.setSettings({ telegram: { enabled: true } });
      store.save();
    }
    return status();
  }

  async function disconnect() {
    await stopClient();
    tg.state = "off";
    tg.error = null;
    if (cfg().enabled) {
      store.setSettings({ telegram: { enabled: false } });
      store.save();
    }
    return status();
  }

  return {
    /** App start: reconnect if the user left it connected. */
    start() {
      const c = cfg();
      if (!c.enabled || !c.botToken || c.allowedSenderIds.length === 0) return;
      connect().catch((err) => log(`telegram: connect failed: ${errText(err)}`));
    },
    /** App quit: stop polling, keep the enabled flag. */
    stopAll: stopClient,
    connect,
    disconnect,
    status,
    onThreadUpdate,
  };
}

module.exports = { createChannels };
