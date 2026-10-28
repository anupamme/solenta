"use strict";

/**
 * Agent Client Protocol client (#272): one prompt turn against an ACP agent
 * over stdio (protocol v1, https://agentclientprotocol.com). Same callback
 * contract as agent.js runAgent, so the custom CLI runner (#458) drives it
 * unchanged: onChunk gets the accumulated reply, onDone(code, text, stderr)
 * fires once.
 *
 * One process per turn. An agent that advertises loadSession resumes its
 * own session (session/load); otherwise the runner replays the tail like any
 * custom CLI. Advertises no fs/terminal capabilities: the agent uses its own.
 * Full access answers permission requests itself; Default hands them to
 * onPermission and waits for replyPermission.
 */

const { createCodexJsonRpcSession } = require("./codexJsonRpc.js");

/**
 * A CLI that never answers initialize is not an ACP agent. Generous: an
 * `npx some-agent` first run downloads before it can answer.
 */
const HANDSHAKE_TIMEOUT_MS = 60_000;

/** Solenta reply -> ACP option kinds, best first. */
const REPLY_KINDS = Object.freeze({
  once: ["allow_once", "allow_always"],
  always: ["allow_always", "allow_once"],
  reject: ["reject_once", "reject_always"],
});

/**
 * Pick the agent's own option for our reply. Agents must not read an
 * unknown outcome as approval, so with no matching option we cancel.
 * @param {Array<{ optionId?: string, kind?: string }>} options
 * @param {"once" | "always" | "reject"} reply
 */
function permissionOutcome(options, reply) {
  const list = Array.isArray(options) ? options : [];
  for (const kind of REPLY_KINDS[reply] || []) {
    const hit = list.find((o) => o && o.kind === kind && o.optionId);
    if (hit) return { outcome: "selected", optionId: hit.optionId };
  }
  return { outcome: "cancelled" };
}

/**
 * How to sign in, from initialize's authMethods: a terminal-auth command
 * when the agent names one (kimi), else its description (opencode).
 * ponytail: we never call `authenticate`; the user signs in once in a
 * terminal, which every agent we have seen supports.
 * @param {unknown} methods
 */
function signInHint(methods) {
  const list = Array.isArray(methods) ? methods : [];
  const hints = list.map((m) => {
    const t = m && m._meta && m._meta["terminal-auth"];
    if (t && t.command) return `run \`${[t.command, ...(t.args || [])].join(" ")}\` in a terminal`;
    return (m && (m.description || m.name)) || "";
  });
  return hints.filter(Boolean).join("; or ");
}

/**
 * @typedef {object} AcpPermissionRequest
 * @property {string} id - pass back to replyPermission
 * @property {string} title
 * @property {string} toolKind - ACP tool kind (edit, execute, ...) or "tool"
 * @property {unknown} rawInput
 * @property {boolean} acceptAlways - the agent offers allow_always
 */

/**
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} opts.args
 * @param {string} opts.cwd
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {string} opts.prompt
 * @param {boolean} opts.fullAccess
 * @param {string | null} [opts.resumeSessionId] - session/load this id
 * @param {number} [opts.handshakeTimeoutMs]
 * @param {(text: string) => void} opts.onChunk
 * @param {(update: { toolCallId?: string, title?: string, status?: string }) => void} [opts.onTool]
 * @param {(req: AcpPermissionRequest) => void} [opts.onPermission]
 * @param {(sessionId: string, resumable: boolean) => void} [opts.onSession]
 * @param {(code: number | null, text: string, stderr: string) => void} opts.onDone
 * @param {(err: Error & { acpResumeFailed?: boolean }) => void} opts.onError
 * @returns {{ kill: () => void, replyPermission: (id: string, reply: "once" | "always" | "reject") => Promise<boolean> }}
 */
function runAcpAgent(opts) {
  let text = "";
  let settled = false;
  /** Updates before our prompt are session/load replaying history. */
  let prompting = false;
  /** @type {string | null} */
  let sessionId = null;
  /** @type {ReturnType<typeof createCodexJsonRpcSession> | null} */
  let session = null;
  /** @type {unknown} */
  let authMethods = null;
  /** Unanswered session/request_permission: our id -> rpc id + options. */
  const asks = new Map();

  const handshakeTimer = setTimeout(() => {
    settle(() =>
      opts.onError(
        new Error(
          `No ACP handshake within ${Math.round((opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS) / 1000)}s. ` +
            "Is this command an Agent Client Protocol agent? Check its flags in Settings › Providers.",
        ),
      ),
    );
  }, opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);

  function settle(fn) {
    if (settled) return;
    settled = true;
    clearTimeout(handshakeTimer);
    fn();
    // A failed spawn reports before the session is assigned.
    if (session) session.kill();
  }

  /** @param {string} id @param {"once" | "always" | "reject" | "cancel"} reply */
  function answer(id, reply) {
    const ask = asks.get(id);
    if (!ask || !session) return false;
    asks.delete(id);
    const outcome = reply === "cancel" ? { outcome: "cancelled" } : permissionOutcome(ask.options, reply);
    return session.respondJsonRpc(ask.rpcId, { outcome });
  }

  session = createCodexJsonRpcSession({
    binary: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    envExtra: /** @type {Record<string, string>} */ (opts.env),
    onNotification({ method, params }) {
      if (method !== "session/update" || !prompting) return;
      const update = params && params.update;
      if (!update) return;
      const kind = update.sessionUpdate;
      if (kind === "agent_message_chunk") {
        const c = update.content;
        if (c && c.type === "text" && typeof c.text === "string") {
          text += c.text;
          opts.onChunk(text);
        }
      } else if ((kind === "tool_call" || kind === "tool_call_update") && opts.onTool) {
        opts.onTool(update);
      }
    },
    onServerRequest({ id, method, params }) {
      if (method !== "session/request_permission" || !session) return false;
      const p = params || {};
      const ourId = String(id);
      asks.set(ourId, { rpcId: id, options: p.options });
      if (opts.fullAccess || !opts.onPermission) {
        answer(ourId, opts.fullAccess ? "once" : "reject");
        return true;
      }
      // v1 carries toolCall; v2 moves it under subject and adds title.
      const call = p.toolCall || (p.subject && p.subject.toolCall) || {};
      const options = Array.isArray(p.options) ? p.options : [];
      opts.onPermission({
        id: ourId,
        title: String(p.title || call.title || "Tool call"),
        toolKind: String(call.kind || "tool"),
        rawInput: call.rawInput ?? null,
        acceptAlways: options.some((o) => o && o.kind === "allow_always"),
      });
      return true;
    },
    onError(err) {
      settle(() => opts.onError(err));
    },
    onExit({ code, stderr }) {
      // Exited before the turn ended: a crash, or a CLI that is not ACP.
      settle(() => opts.onDone(code == null || code === 0 ? 1 : code, text, stderr));
    },
  });

  (async () => {
    const init = /** @type {{ agentCapabilities?: { loadSession?: boolean }, authMethods?: unknown }} */ (
      await session.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      })
    );
    clearTimeout(handshakeTimer);
    authMethods = init && init.authMethods;
    const resumable = Boolean(init && init.agentCapabilities && init.agentCapabilities.loadSession);
    if (opts.resumeSessionId && resumable) {
      try {
        await session.request("session/load", {
          sessionId: opts.resumeSessionId,
          cwd: opts.cwd,
          mcpServers: [],
        });
      } catch (err) {
        const e = /** @type {Error & { acpResumeFailed?: boolean }} */ (
          new Error(`ACP agent could not resume its session: ${err instanceof Error ? err.message : String(err)}`)
        );
        e.acpResumeFailed = true;
        throw e;
      }
      sessionId = opts.resumeSessionId;
    } else {
      const created = /** @type {{ sessionId?: string }} */ (
        await session.request("session/new", { cwd: opts.cwd, mcpServers: [] })
      );
      sessionId = (created && created.sessionId) || null;
      if (!sessionId) throw new Error("ACP agent returned no sessionId");
    }
    if (opts.onSession) opts.onSession(sessionId, resumable);
    prompting = true;
    const res = /** @type {{ stopReason?: string }} */ (
      await session.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: opts.prompt }],
      })
    );
    const stop = (res && res.stopReason) || "end_turn";
    settle(() =>
      stop === "end_turn"
        ? opts.onDone(0, text, "")
        : opts.onDone(1, text, `ACP agent stopped: ${stop}`),
    );
  })().catch((err) => {
    const e = err instanceof Error ? err : new Error(String(err));
    const hint = /auth/i.test(e.message) ? signInHint(authMethods) : "";
    if (hint) e.message = `${e.message}. Sign in first: ${hint}.`;
    settle(() => opts.onError(e));
  });

  return {
    kill() {
      // The spec: answer open permission requests with cancelled, then cancel.
      for (const id of [...asks.keys()]) answer(id, "cancel");
      if (sessionId && session) session.notify("session/cancel", { sessionId });
      settled = true;
      clearTimeout(handshakeTimer);
      if (session) session.kill();
    },
    replyPermission(id, reply) {
      return Promise.resolve(answer(id, reply));
    },
  };
}

module.exports = { runAcpAgent, permissionOutcome, signInHint, HANDSHAKE_TIMEOUT_MS };
