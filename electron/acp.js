"use strict";

/**
 * Agent Client Protocol client (#272): one prompt turn against an ACP agent
 * over stdio (protocol v1, https://agentclientprotocol.com). Same callback
 * contract as agent.js runAgent, so the custom CLI runner (#458) drives it
 * unchanged: onChunk gets the accumulated reply, onDone(code, text, stderr)
 * fires once.
 *
 * ponytail: one process per turn and no session/load, so the runner replays
 * the tail like any custom CLI. Advertises no fs/terminal capabilities: the
 * agent uses its own. Permission prompts are answered from the thread's mode
 * (Full access allows, Default rejects) instead of the approval UI; wire them
 * into runner-permissions.js when an ACP agent needs per-call approval.
 */

const { createCodexJsonRpcSession } = require("./codexJsonRpc.js");

/**
 * Pick the agent's own option for our decision. Agents must not read an
 * unknown outcome as approval, so with no matching option we cancel.
 * @param {Array<{ optionId?: string, kind?: string }>} options
 * @param {boolean} allow
 */
function permissionOutcome(options, allow) {
  const kinds = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  const list = Array.isArray(options) ? options : [];
  for (const kind of kinds) {
    const hit = list.find((o) => o && o.kind === kind && o.optionId);
    if (hit) return { outcome: "selected", optionId: hit.optionId };
  }
  return { outcome: "cancelled" };
}

/**
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} opts.args
 * @param {string} opts.cwd
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {string} opts.prompt
 * @param {boolean} opts.fullAccess
 * @param {(text: string) => void} opts.onChunk
 * @param {(update: { toolCallId?: string, title?: string, status?: string }) => void} [opts.onTool]
 * @param {(label: string) => void} [opts.onNote]
 * @param {(code: number | null, text: string, stderr: string) => void} opts.onDone
 * @param {(err: Error) => void} opts.onError
 * @returns {{ kill: () => void }}
 */
function runAcpAgent(opts) {
  let text = "";
  let settled = false;
  /** @type {string | null} */
  let sessionId = null;
  /** @type {ReturnType<typeof createCodexJsonRpcSession> | null} */
  let session = null;

  function settle(fn) {
    if (settled) return;
    settled = true;
    fn();
    // A failed spawn reports before the session is assigned.
    if (session) session.kill();
  }

  session = createCodexJsonRpcSession({
    binary: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    envExtra: /** @type {Record<string, string>} */ (opts.env),
    onNotification({ method, params }) {
      if (method !== "session/update") return;
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
      if (method !== "session/request_permission") return false;
      const p = params || {};
      const outcome = permissionOutcome(p.options, opts.fullAccess);
      if (!opts.fullAccess && opts.onNote) {
        // v1 carries toolCall; v2 moves it under subject and adds title.
        const call = p.toolCall || (p.subject && p.subject.toolCall) || {};
        opts.onNote(`Denied: ${p.title || call.title || "tool call"} (Full access allows it)`);
      }
      session.respondJsonRpc(id, { outcome });
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
    await session.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const created = /** @type {{ sessionId?: string }} */ (
      await session.request("session/new", { cwd: opts.cwd, mcpServers: [] })
    );
    sessionId = (created && created.sessionId) || null;
    if (!sessionId) throw new Error("ACP agent returned no sessionId");
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
    settle(() => opts.onError(err instanceof Error ? err : new Error(String(err))));
  });

  return {
    kill() {
      if (sessionId) session.notify("session/cancel", { sessionId });
      settled = true;
      session.kill();
    },
  };
}

module.exports = { runAcpAgent, permissionOutcome };
