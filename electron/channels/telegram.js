"use strict";

/**
 * Telegram Bot API transport for chat channels (#1718). Long polling only
 * (getUpdates with a server-side timeout), so no public URL or webhook.
 * Knows nothing about threads: channels/index.js gets each message and
 * button press through onMessage / onButton.
 *
 * Timers are ref'd and cleared on stop(), and stop() aborts the in-flight
 * long poll, so nothing outlives a disconnect (unref'd polling timers make
 * node:test cancel tests in this repo).
 */

const API = "https://api.telegram.org";
// Telegram's hard cap on one message's text.
const MAX_TEXT = 4096;
const POLL_TIMEOUT_SEC = 25;
const BACKOFF_MAX_MS = 60_000;

/**
 * Split text into Telegram-sized chunks, preferring line breaks.
 * @param {string} text
 * @param {number} [max]
 * @returns {string[]}
 */
function chunkText(text, max = MAX_TEXT) {
  const out = [];
  let rest = String(text || "");
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    // Never split a surrogate pair.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.token
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.offset] first update id to ask for
 * @param {(offset: number) => void} [opts.onOffset]
 * @param {(msg: { chatId: string, senderId: string, text: string }) => Promise<void> | void} opts.onMessage
 * @param {(press: { id: string, chatId: string, senderId: string, data: string }) => Promise<void> | void} opts.onButton
 * @param {(state: { state: "connected" | "error", error?: string }) => void} [opts.onState]
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.pollTimeoutSec]
 * @param {number} [opts.backoffMs] first retry delay
 */
function createTelegram(opts) {
  const doFetch = opts.fetch || globalThis.fetch;
  const log = opts.log || (() => {});
  const onState = opts.onState || (() => {});
  const pollTimeoutSec = opts.pollTimeoutSec ?? POLL_TIMEOUT_SEC;
  const backoffStart = opts.backoffMs ?? 1000;
  let offset = opts.offset || 0;
  let stopped = true;
  /** @type {AbortController | null} */
  let abort = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {(() => void) | null} */
  let wake = null;
  /** @type {Promise<void> | null} */
  let loopDone = null;

  /**
   * @param {string} method
   * @param {object} [body]
   * @param {AbortSignal} [signal]
   */
  async function call(method, body, signal) {
    const res = await doFetch(`${API}/bot${opts.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
      signal,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      // Fall through to the status error.
    }
    if (!json || json.ok !== true) {
      // Never echo the URL: it carries the token.
      const err = new Error(
        (json && json.description) || `Telegram ${method} failed (HTTP ${res.status})`,
      );
      /** @type {any} */ (err).status = (json && json.error_code) || res.status;
      throw err;
    }
    return json.result;
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(() => {
        timer = null;
        wake = null;
        resolve(undefined);
      }, ms);
    });
  }

  async function loop() {
    let backoff = backoffStart;
    while (!stopped) {
      abort = new AbortController();
      try {
        const updates = await call(
          "getUpdates",
          { offset, timeout: pollTimeoutSec, allowed_updates: ["message", "callback_query"] },
          abort.signal,
        );
        if (stopped) break;
        backoff = backoffStart;
        onState({ state: "connected" });
        for (const u of updates || []) {
          offset = u.update_id + 1;
          if (opts.onOffset) opts.onOffset(offset);
          try {
            const m = u.message;
            const q = u.callback_query;
            if (m && m.chat && m.from) {
              await opts.onMessage({
                chatId: String(m.chat.id),
                senderId: String(m.from.id),
                text: typeof m.text === "string" ? m.text : "",
              });
            } else if (q && q.from && q.message && q.message.chat) {
              await opts.onButton({
                id: String(q.id),
                chatId: String(q.message.chat.id),
                senderId: String(q.from.id),
                data: String(q.data || ""),
              });
            }
          } catch (err) {
            log(`telegram: handler failed: ${err && err.message ? err.message : err}`);
          }
          if (stopped) break;
        }
      } catch (err) {
        if (stopped) break;
        const message = err && err.message ? err.message : String(err);
        onState({ state: "error", error: message });
        // A revoked or wrong token never heals by retrying.
        if (/** @type {any} */ (err).status === 401) {
          stopped = true;
          break;
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
    abort = null;
  }

  return {
    /** Check the token; resolves to the bot's user ({ username, ... }). */
    getMe: () => call("getMe"),
    /** Start long polling. No-op when already running. */
    start() {
      if (!stopped) return;
      stopped = false;
      loopDone = loop();
    },
    /** Stop polling; resolves once the loop has exited. */
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (wake) wake();
      wake = null;
      if (abort) abort.abort();
      if (loopDone) await loopDone;
      loopDone = null;
    },
    get running() {
      return !stopped;
    },
    /**
     * Plain text only: no parse_mode, so agent output needs no escaping.
     * @param {string | number} chatId
     * @param {string} text
     */
    async sendText(chatId, text) {
      for (const part of chunkText(text)) {
        await call("sendMessage", { chat_id: chatId, text: part });
      }
    },
    /**
     * One message with an inline keyboard, one button per row.
     * @param {string | number} chatId
     * @param {string} text
     * @param {Array<{ text: string, data: string }>} buttons
     */
    async sendButtons(chatId, text, buttons) {
      const parts = chunkText(text);
      for (const part of parts.slice(0, -1)) {
        await call("sendMessage", { chat_id: chatId, text: part });
      }
      await call("sendMessage", {
        chat_id: chatId,
        text: parts[parts.length - 1] || "…",
        reply_markup: {
          inline_keyboard: buttons.map((b) => [{ text: b.text, callback_data: b.data }]),
        },
      });
    },
    /**
     * Stop the button spinner, with an optional toast.
     * @param {string} id callback_query id
     * @param {string} [text]
     */
    answerButton: (id, text) =>
      call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }),
  };
}

module.exports = { createTelegram, chunkText, MAX_TEXT };
