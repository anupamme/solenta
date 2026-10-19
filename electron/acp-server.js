#!/usr/bin/env node
"use strict";

/**
 * Solenta as an Agent Client Protocol agent (#272, the inverse of acp.js).
 * An editor (Zed, JetBrains, any ACP client) spawns this over stdio; each
 * ACP session becomes one Solenta task, driven through the external pairing
 * MCP tools (#157): task_launch, task_send, task_status, task_stop. So it
 * holds no power of its own: the pairing's projects, capabilities, launch
 * approval and rate limits all still apply.
 *
 * Env: SOLENTA_MCP_URL (http://127.0.0.1:<port>/mcp) and SOLENTA_TOKEN (a
 * pairing token; Settings › Integrations prints the whole config).
 * SOLENTA_PROJECT_ID picks the project; otherwise the one whose folder name
 * matches the editor's cwd, or the only one the pairing can see.
 *
 * ponytail: polls task_status (1s) and streams the reply as it grows. Tool
 * calls and permission prompts stay in the Solenta app; mirror them as
 * session/update tool_call items if editors need to see them.
 */

const path = require("node:path");
const crypto = require("node:crypto");

const POLL_MS = Number(process.env.SOLENTA_ACP_POLL_MS) || 1000;

/** Statuses after which a turn is over. */
const TERMINAL = new Set(["done", "failed", "idle"]);

/**
 * One MCP tools/call against the pairing endpoint (stateless streamable
 * HTTP: the response is JSON or a single SSE `data:` line).
 * @param {{ url: string, token: string, fetch?: typeof fetch }} conn
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
async function callTool(conn, name, args) {
  const doFetch = conn.fetch || fetch;
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(conn.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${conn.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    // The pairing's read limit: wait it out rather than fail the turn.
    if (res.status === 429 && attempt < 10) {
      await sleep(5000);
      continue;
    }
    if (res.status === 401) {
      throw new Error("Solenta rejected the pairing token. Is Solenta running, and is the pairing still valid?");
    }
    if (!res.ok) throw new Error(`Solenta returned HTTP ${res.status}`);
    const text = await res.text();
    const data = text.split("\n").find((l) => l.startsWith("data:"));
    const msg = JSON.parse(data ? data.slice(5) : text);
    if (msg.error) throw new Error(msg.error.message || "Solenta MCP error");
    const out = (msg.result && msg.result.content && msg.result.content[0] && msg.result.content[0].text) || "";
    if (msg.result && msg.result.isError) throw new Error(out || `${name} failed`);
    return out ? JSON.parse(out) : null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {Array<{ id: string, name?: string | null, slug?: string | null }>} projects
 * @param {string} cwd
 * @param {string | undefined} wanted
 */
function pickProject(projects, cwd, wanted) {
  if (wanted) {
    const hit = projects.find((p) => p.id === wanted);
    if (!hit) throw new Error(`SOLENTA_PROJECT_ID ${wanted} is not visible to this pairing`);
    return hit;
  }
  const base = cwd ? path.basename(cwd) : "";
  const bySlug = projects.filter((p) => p.slug && p.slug === base);
  if (bySlug.length === 1) return bySlug[0];
  if (projects.length === 1) return projects[0];
  const names = projects.map((p) => `${p.name || p.slug} (${p.id})`).join(", ") || "none";
  throw new Error(
    `No Solenta project matches ${cwd || "this folder"}. Set SOLENTA_PROJECT_ID to one of: ${names}`,
  );
}

/** ACP prompt content blocks -> one Solenta prompt. */
function promptText(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((b) => {
      if (!b) return "";
      if (b.type === "text") return String(b.text || "");
      if (b.type === "resource_link") return String(b.uri || "");
      if (b.type === "resource" && b.resource) {
        return b.resource.text != null
          ? `${b.resource.uri || ""}\n${b.resource.text}`
          : String(b.resource.uri || "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Serve ACP on a pair of streams.
 * @param {{
 *   input: NodeJS.ReadableStream,
 *   output: NodeJS.WritableStream,
 *   url: string,
 *   token: string,
 *   projectId?: string,
 *   pollMs?: number,
 *   fetch?: typeof fetch,
 * }} opts
 */
function serveAcp(opts) {
  const conn = { url: opts.url, token: opts.token, fetch: opts.fetch };
  const pollMs = opts.pollMs || POLL_MS;
  /** @type {Map<string, { projectId: string, threadId: string | null, cancelled: boolean }>} */
  const sessions = new Map();

  const write = (msg) => opts.output.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  const chunk = (sessionId, text) =>
    write({
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
    });

  async function prompt(sessionId, blocks) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session: ${sessionId}`);
    const text = promptText(blocks);
    if (!text.trim()) throw new Error("Empty prompt");
    s.cancelled = false;
    // The reply to stream is the first assistant message newer than this.
    let baseline = null;
    let task;
    if (!s.threadId) {
      task = await callTool(conn, "task_launch", { projectId: s.projectId, prompt: text });
      s.threadId = task.threadId;
      // Cancelled while the launch was in flight: there was no task to stop.
      if (s.cancelled) await callTool(conn, "task_stop", { threadId: s.threadId }).catch(() => {});
    } else {
      const before = await callTool(conn, "task_status", { threadId: s.threadId });
      baseline = before && before.reply ? before.reply.id : null;
      task = await callTool(conn, "task_send", { threadId: s.threadId, prompt: text });
    }
    let sent = "";
    let replyId = null;
    let toldApproval = false;
    let sawRun = false;
    for (;;) {
      if (task.status === "awaiting_approval" && !toldApproval) {
        toldApproval = true;
        chunk(sessionId, "Waiting for you to approve this task in Solenta…\n\n");
      }
      if (task.status === "working" || task.status === "awaiting_approval") sawRun = true;
      const reply = task.reply && task.reply.id !== baseline ? task.reply : null;
      if (reply) {
        if (reply.id !== replyId) {
          replyId = reply.id;
          sent = "";
        }
        // Grows in place while streaming; a rewrite resends nothing.
        if (reply.text.startsWith(sent) && reply.text.length > sent.length) {
          chunk(sessionId, reply.text.slice(sent.length));
          sent = reply.text;
        }
      }
      if (TERMINAL.has(task.status) && (sawRun || reply)) {
        if (s.cancelled) return { stopReason: "cancelled" };
        if (task.status === "failed" && task.lastError) {
          chunk(sessionId, `${sent ? "\n\n" : ""}${task.lastError}`);
        }
        return { stopReason: "end_turn" };
      }
      await sleep(pollMs);
      task = await callTool(conn, "task_status", { threadId: s.threadId });
    }
  }

  async function handle(msg) {
    const p = msg.params || {};
    switch (msg.method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, promptCapabilities: { embeddedContext: true } },
          authMethods: [],
          agentInfo: { name: "solenta", title: "Solenta" },
        };
      case "session/new": {
        const projects = await callTool(conn, "projects_list", {});
        const project = pickProject(projects || [], String(p.cwd || ""), opts.projectId);
        const sessionId = crypto.randomUUID();
        sessions.set(sessionId, { projectId: project.id, threadId: null, cancelled: false });
        return { sessionId };
      }
      case "session/prompt":
        return prompt(String(p.sessionId), p.prompt);
      default:
        throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
    }
  }

  async function notified(msg) {
    if (msg.method !== "session/cancel") return;
    const s = sessions.get(String(msg.params && msg.params.sessionId));
    if (!s) return;
    s.cancelled = true;
    if (!s.threadId) return;
    await callTool(conn, "task_stop", { threadId: s.threadId }).catch(() => {});
  }

  let buf = "";
  opts.input.setEncoding("utf8");
  opts.input.on("data", (d) => {
    buf += d;
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
      if (msg.id === undefined || msg.id === null) {
        void notified(msg);
        continue;
      }
      // Responses to requests we never send: ignore.
      if (!msg.method) continue;
      handle(msg).then(
        (result) => write({ id: msg.id, result }),
        (err) => write({ id: msg.id, error: { code: err.code || -32603, message: err.message || String(err) } }),
      );
    }
  });
}

module.exports = { serveAcp, callTool, pickProject, promptText };

if (require.main === module) {
  const url = process.env.SOLENTA_MCP_URL;
  const token = process.env.SOLENTA_TOKEN;
  if (!url || !token) {
    process.stderr.write("solenta acp: set SOLENTA_MCP_URL and SOLENTA_TOKEN (Settings › Integrations).\n");
    process.exit(2);
  }
  serveAcp({
    input: process.stdin,
    output: process.stdout,
    url,
    token,
    projectId: process.env.SOLENTA_PROJECT_ID || undefined,
  });
}
