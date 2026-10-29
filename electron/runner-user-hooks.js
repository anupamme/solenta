"use strict";

/**
 * Runner side of user lifecycle hooks (#1724). The runner resolves a
 * thread's hooks at run start, runs UserPromptSubmit before dispatch and
 * fires PostToolUse / Stop from its own transcript events for every
 * provider. PreToolUse is native on claude and codex (the CLI waits on
 * the bridge); elsewhere it fires when the tool card appears, which is
 * best effort: the tool may already be running, so a block is reported
 * but cannot stop it.
 */

const userHooks = require("./user-hooks.js");

/** Parse the transcript's pretty-printed tool input back to an object. */
function toolInputObject(input) {
  if (input && typeof input === "object") return input;
  if (typeof input !== "string" || !input) return {};
  try {
    const o = JSON.parse(input);
    return o && typeof o === "object" && !Array.isArray(o) ? o : { value: o };
  } catch {
    return { raw: input };
  }
}

/**
 * @param {{
 *   store: any,
 *   userDataPath: string,
 *   appendMessage: Function,
 *   pushDetail: Function,
 *   runEvent?: typeof userHooks.runThreadEvent,
 * }} ctx
 */
function createUserHookEvents(ctx) {
  const { store, userDataPath, appendMessage, pushDetail } = ctx;
  const runEvent = ctx.runEvent || userHooks.runThreadEvent;
  /** Events each thread's current run has hooks for. */
  /** @type {Map<string, { events: Set<string>, provider: string }>} */
  const byThread = new Map();

  /**
   * Resolve hooks for this run. Never throws.
   * @returns {string | null} SOLENTA_USER_HOOKS path, or null
   */
  function prepare({ threadId, project, provider, model, cwd, remote }) {
    byThread.delete(threadId);
    if (!userDataPath) return null;
    try {
      // Hooks are local commands; a remote run's cwd is on another host.
      if (remote) {
        require("node:fs").rmSync(
          userHooks.threadHooksFile(userDataPath, threadId),
          { force: true },
        );
        return null;
      }
      const out = userHooks.prepareRunHooks({
        userDataPath,
        projectPath: project && project.path,
        threadId,
        provider,
        model,
        cwd,
      });
      if (!out) return null;
      byThread.set(threadId, {
        events: new Set(out.hooks.map((h) => h.event)),
        provider: String(provider || ""),
      });
      return out.file;
    } catch {
      return null;
    }
  }

  /**
   * Resolved file + hooks for a native PreToolUse bridge, or null.
   * @returns {{ file: string, hooks: any[] } | null}
   */
  function nativePreTool(threadId) {
    if (!has(threadId, "PreToolUse")) return null;
    const file = userHooks.threadHooksFile(userDataPath, threadId);
    const resolved = require("./user-hooks-run.js").readResolved(file);
    return resolved ? { file, hooks: resolved.hooks } : null;
  }

  function has(threadId, event) {
    const t = byThread.get(threadId);
    return Boolean(t && t.events.has(event));
  }

  function report(threadId, runId, out) {
    if (!out) return;
    for (const w of out.warnings) appendMessage(threadId, "event", w, runId);
    if (out.warnings.length) {
      store.save();
      pushDetail(threadId);
    }
  }

  /** Fire-and-forget; resolves to the outcome (tests await it). */
  function fire(threadId, runId, event, extra, onBlock) {
    if (!has(threadId, event)) return Promise.resolve(null);
    return runEvent({ userDataPath, threadId, event, ...extra })
      .then((out) => {
        report(threadId, runId, out);
        if (out && out.blocked && onBlock) onBlock(out);
        return out;
      })
      .catch(() => null);
  }

  /**
   * Before dispatch. Blocked → the caller refuses the turn.
   * @returns {Promise<{ blocked: boolean, reason: string, context: string }>}
   */
  async function beforePrompt(threadId, runId, prompt) {
    const none = { blocked: false, reason: "", context: "" };
    if (!has(threadId, "UserPromptSubmit")) return none;
    let out = null;
    try {
      out = await runEvent({
        userDataPath,
        threadId,
        event: "UserPromptSubmit",
        payload: { prompt: String(prompt || "") },
      });
    } catch {
      out = null;
    }
    report(threadId, runId, out);
    if (!out) return none;
    return {
      blocked: out.blocked,
      reason: out.reason,
      context: out.contexts.length
        ? `\n\n[Hook context]\n${out.contexts.join("\n\n")}`
        : "",
    };
  }

  /** A tool card appeared (not yet done). Best-effort PreToolUse. */
  function toolStarted(threadId, runId, tool) {
    const t = byThread.get(threadId);
    if (!t || userHooks.NATIVE_PRE_TOOL.includes(t.provider)) return null;
    const name = String(tool.name || "tool");
    return fire(
      threadId,
      runId,
      "PreToolUse",
      {
        toolName: name,
        payload: { tool_name: name, tool_input: toolInputObject(tool.input), best_effort: true },
      },
      (out) => {
        appendMessage(
          threadId,
          "event",
          `Hook blocked ${name}: ${out.reason} (${t.provider} has no pre-tool hook, so the tool may already have run)`,
          runId,
        );
        store.save();
        pushDetail(threadId);
      },
    );
  }

  /** A tool call finished (noteToolSpan). */
  function toolFinished(threadId, runId, toolId, name) {
    if (!has(threadId, "PostToolUse")) return null;
    const msgs = store.getMessages(threadId) || [];
    let tool = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].tool && msgs[i].tool.id === toolId) {
        tool = msgs[i].tool;
        break;
      }
    }
    const toolName = String(name || (tool && tool.name) || "tool");
    return fire(
      threadId,
      runId,
      "PostToolUse",
      {
        toolName,
        payload: {
          tool_name: toolName,
          tool_input: toolInputObject(tool && tool.input),
          tool_response: tool ? tool.output ?? null : null,
          is_error: Boolean(tool && tool.isError),
        },
      },
      (out) => {
        // The tool already ran; exit 2 here is feedback, not a veto.
        appendMessage(threadId, "event", `Hook flagged ${toolName}: ${out.reason}`, runId);
        store.save();
        pushDetail(threadId);
      },
    );
  }

  /** The turn finished normally. */
  function turnDone(threadId, runId, lastText) {
    return fire(
      threadId,
      runId,
      "Stop",
      { payload: { status: "done", last_assistant_message: String(lastText || "") } },
      (out) => {
        appendMessage(threadId, "event", `Stop hook: ${out.reason}`, runId);
        store.save();
        pushDetail(threadId);
      },
    );
  }

  return { prepare, has, nativePreTool, beforePrompt, toolStarted, toolFinished, turnDone };
}

module.exports = { createUserHookEvents, toolInputObject };
