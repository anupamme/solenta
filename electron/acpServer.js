"use strict";

/**
 * Solenta as an Agent Client Protocol agent (issue #272), ACP v1.
 *
 * An editor spawns electron/acp-cli.js, which pipes its stdio over an
 * `Upgrade: solenta-acp` request on the orch server. All protocol logic lives
 * here in main, next to the store and runner. One ACP session is one thread;
 * session/update is derived from the thread's own transcript on every runner
 * push, so it works for every provider without per-adapter code.
 */

const { StringDecoder } = require("node:string_decoder");
const services = require("./services.js");
const { findExistingProject } = require("./services-projects.js");

const PROTOCOL_VERSION = 1;
const UPGRADE_PROTOCOL = "solenta-acp";

class AcpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function toolStatus(tool) {
  if (!tool.done) return "in_progress";
  return tool.isError ? "failed" : "completed";
}

/**
 * One client connection: newline-delimited JSON-RPC 2.0 on a duplex stream.
 * @param {{ store: any, runner: any, stream: import('node:stream').Duplex, broadcast?: (c: string, p: unknown) => void, log?: (m: string) => void }} deps
 */
function createAcpConnection(deps) {
  const { store, runner, stream } = deps;
  const log = deps.log || (() => {});
  /** @type {Map<string, any>} threadId -> session */
  const sessions = new Map();
  /** @type {Map<number, (msg: any) => void>} */
  const outbound = new Map();
  let nextId = 1;
  let buf = "";

  function write(msg) {
    if (stream.destroyed || !stream.writable) return;
    stream.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  }

  function request(method, params) {
    const id = nextId++;
    write({ id, method, params });
    return new Promise((resolve) => outbound.set(id, resolve));
  }

  function update(sessionId, payload) {
    write({ method: "session/update", params: { sessionId, update: payload } });
  }

  function requireSession(params) {
    const s = sessions.get(String(params && params.sessionId));
    if (!s) throw new AcpError(-32602, `Unknown session: ${params && params.sessionId}`);
    return s;
  }

  function snapshotIds(threadId) {
    return {
      messages: new Set(store.getMessages(threadId).map((m) => m.id)),
      work: new Set(store.getWorkLog(threadId).map((w) => w.id)),
    };
  }

  /** Push the turn's new transcript to the client, and settle it once the run ends. */
  function sync(s) {
    const turn = s.turn;
    if (!turn) return;
    const id = s.threadId;
    for (const m of store.getMessages(id)) {
      if (!m || turn.known.messages.has(m.id)) continue;
      if (m.role === "assistant") {
        const text = String(m.text || "");
        const sent = turn.sent.get(m.id) || 0;
        if (text.length > sent) {
          update(id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: text.slice(sent) },
          });
          turn.sent.set(m.id, text.length);
        }
      } else if (m.role === "tool" && m.tool) {
        const status = toolStatus(m.tool);
        const prev = turn.sent.get(m.id);
        if (prev === undefined) {
          update(id, {
            sessionUpdate: "tool_call",
            toolCallId: m.id,
            title: String(m.text || m.tool.name || "tool"),
            kind: "other",
            status,
            rawInput: m.tool.input,
          });
        } else if (prev !== status) {
          update(id, {
            sessionUpdate: "tool_call_update",
            toolCallId: m.id,
            status,
            ...(m.tool.output != null
              ? { content: [{ type: "content", content: { type: "text", text: String(m.tool.output) } }] }
              : {}),
          });
        }
        turn.sent.set(m.id, status);
      }
    }

    const entries = store
      .getWorkLog(id)
      .filter((w) => w && !turn.known.work.has(w.id))
      .map((w) => ({
        content: String(w.label || ""),
        priority: "medium",
        status: w.done ? "completed" : "in_progress",
      }));
    const plan = JSON.stringify(entries);
    if (entries.length && plan !== turn.plan) {
      turn.plan = plan;
      update(id, { sessionUpdate: "plan", entries });
    }

    const pending =
      typeof runner.getPendingPermission === "function"
        ? runner.getPendingPermission(id)
        : null;
    if (pending && pending.requestId != null && pending.requestId !== turn.asked) {
      turn.asked = pending.requestId;
      void askPermission(s, pending);
    }

    const thread = store.getThread(id);
    const running =
      (typeof runner.isRunning === "function" && runner.isRunning(id)) ||
      (thread && (thread.status === "working" || thread.status === "quota-wait"));
    if (running) {
      turn.started = true;
      return;
    }
    // A queued turn has not started yet; idle then is not "finished".
    if (!turn.started) return;
    s.turn = null;
    if (turn.cancelled) return turn.resolve({ stopReason: "cancelled" });
    if (!thread || thread.status === "failed") {
      const reason = (thread && thread.lastError) || "Run failed";
      return turn.reject(new AcpError(-32603, String(reason)));
    }
    turn.resolve({ stopReason: "end_turn" });
  }

  async function askPermission(s, pending) {
    const options = [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      ...(pending.acceptAlways
        ? [{ optionId: "allowAlways", name: "Always allow", kind: "allow_always" }]
        : []),
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ];
    const res = await request("session/request_permission", {
      sessionId: s.threadId,
      toolCall: {
        toolCallId: `permission-${pending.requestId}`,
        title: String(pending.summary || pending.toolName || "Permission"),
        kind: "other",
        status: "pending",
        rawInput: pending.input,
      },
      options,
    });
    const outcome = res && res.result && res.result.outcome;
    const picked =
      outcome && outcome.outcome === "selected" ? String(outcome.optionId) : "deny";
    const decision = picked === "allow" || picked === "allowAlways" ? picked : "deny";
    // First answer wins: the same card is live in the app.
    const still = runner.getPendingPermission(s.threadId);
    if (!still || still.requestId !== pending.requestId) return;
    try {
      runner.respondPermission({
        threadId: s.threadId,
        requestId: pending.requestId,
        decision,
      });
    } catch (err) {
      log(`acp: respondPermission failed: ${err && err.message ? err.message : err}`);
    }
  }

  const methods = {
    initialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        authMethods: [],
        agentInfo: { name: "solenta", title: "Solenta" },
      };
    },

    "session/new"(params) {
      const cwd = params && params.cwd ? String(params.cwd) : "";
      const project = cwd ? findExistingProject(store, { path: cwd }) : null;
      if (!project) {
        throw new AcpError(
          -32602,
          `No Solenta project at ${cwd || "(no cwd)"}. Add the folder in Solenta first.`,
        );
      }
      // ponytail: no worktree, so edits land in the checkout the editor has open.
      const thread = services.createThread(store, { projectId: project.id });
      store.save();
      if (typeof deps.broadcast === "function") {
        deps.broadcast("threads:changed", services.listThreads(store));
      }
      sessions.set(thread.id, { threadId: thread.id, turn: null });
      return { sessionId: thread.id };
    },

    async "session/prompt"(params) {
      const s = requireSession(params);
      if (s.turn) throw new AcpError(-32600, "A prompt is already running in this session");
      const text = (Array.isArray(params.prompt) ? params.prompt : [])
        .map((b) =>
          b && b.type === "text"
            ? String(b.text || "")
            : b && b.type === "resource_link" && b.uri
              ? String(b.uri)
              : "",
        )
        .filter(Boolean)
        .join("\n\n");
      if (!text.trim()) throw new AcpError(-32602, "Prompt has no text");
      const done = new Promise((resolve, reject) => {
        s.turn = {
          resolve,
          reject,
          known: snapshotIds(s.threadId),
          sent: new Map(),
          plan: "",
          asked: null,
          started: false,
          cancelled: false,
        };
      });
      const turn = s.turn;
      try {
        const res = await runner.startRun({ threadId: s.threadId, prompt: text });
        if (!(res && res.queued)) turn.started = true;
      } catch (err) {
        s.turn = null;
        throw err;
      }
      sync(s);
      return done;
    },

    async "session/cancel"(params) {
      const s = requireSession(params);
      if (!s.turn) return;
      s.turn.cancelled = true;
      await runner.stopRun({ threadId: s.threadId });
      sync(s);
    },
  };

  async function dispatch(msg) {
    if (msg.method == null) {
      const resolve = outbound.get(msg.id);
      if (resolve) {
        outbound.delete(msg.id);
        resolve(msg);
      }
      return;
    }
    const handler = methods[msg.method];
    if (msg.id == null) {
      if (!handler) return;
      try {
        await handler(msg.params || {});
      } catch (err) {
        log(`acp: ${msg.method} failed: ${err && err.message ? err.message : err}`);
      }
      return;
    }
    if (!handler) {
      write({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      return;
    }
    try {
      const result = await handler(msg.params || {});
      write({ id: msg.id, result: result === undefined ? null : result });
    } catch (err) {
      write({
        id: msg.id,
        error: {
          code: Number.isInteger(err && err.code) ? err.code : -32603,
          message: err && err.message ? String(err.message) : String(err),
        },
      });
    }
  }

  // Upgraded http sockets refuse setEncoding (RFC 7230), so decode here.
  const decoder = new StringDecoder("utf8");
  stream.on("data", (chunk) => {
    buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      void dispatch(msg);
    }
  });

  return {
    /** Runner push for a thread; only this connection's sessions react. */
    onThread(threadId) {
      const s = sessions.get(String(threadId));
      if (s) sync(s);
    },
  };
}

/**
 * Fan-out from runner pushes to every open ACP connection.
 * @param {{ store: any, runner: any, broadcast?: (c: string, p: unknown) => void, log?: (m: string) => void }} deps
 */
function createAcpHub(deps) {
  const conns = new Set();
  return {
    onPush(channel, payload) {
      if (channel !== "thread:updated" || !payload || !payload.thread) return;
      for (const c of conns) c.onThread(payload.thread.id);
    },
    connect(stream) {
      const c = createAcpConnection({ ...deps, stream });
      conns.add(c);
      // A dropped editor leaves its thread running in the app. The CLI
      // half-closes on stdin EOF; finish our side so it can exit.
      stream.on("end", () => stream.end());
      stream.on("close", () => conns.delete(c));
      return c;
    },
  };
}

/**
 * Accept `Upgrade: solenta-acp` on the orch server's http.Server.
 * @param {import('node:http').Server} server
 * @param {{ hub: ReturnType<typeof createAcpHub>, isAuthorized: (req: import('node:http').IncomingMessage) => boolean }} opts
 */
function attachAcpUpgrade(server, opts) {
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const proto = String(req.headers.upgrade || "").toLowerCase();
    if (url.pathname !== "/acp" || proto !== UPGRADE_PROTOCOL) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    if (!opts.isAuthorized(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        `Upgrade: ${UPGRADE_PROTOCOL}\r\nConnection: Upgrade\r\n\r\n`,
    );
    if (head && head.length) socket.unshift(head);
    try {
      opts.hub.connect(socket);
    } catch {
      // Never let one client throw inside main's upgrade handler.
      socket.destroy();
    }
  });
}

module.exports = {
  createAcpConnection,
  createAcpHub,
  attachAcpUpgrade,
  PROTOCOL_VERSION,
  UPGRADE_PROTOCOL,
};
