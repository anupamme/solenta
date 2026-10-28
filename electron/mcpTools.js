"use strict";

/**
 * List one installed MCP server's tools (#1720) so Settings can set a
 * per-tool allow / ask / deny. Connects with the MCP SDK client
 * (initialize + tools/list) over the server's own transport and closes it
 * again. Hard 10 s limit: a hung server must not hang the Settings pane.
 */

const path = require("node:path");
const { createRequire } = require("node:module");

const LIST_TIMEOUT_MS = 10_000;
const MAX_TOOLS = 256;
const STDERR_TAIL = 2048;

function sdk() {
  const req = createRequire(path.join(__dirname, "../memory-server/package.json"));
  return {
    Client: req("@modelcontextprotocol/sdk/client/index.js").Client,
    StreamableHTTPClientTransport: req("@modelcontextprotocol/sdk/client/streamableHttp.js")
      .StreamableHTTPClientTransport,
    SSEClientTransport: req("@modelcontextprotocol/sdk/client/sse.js").SSEClientTransport,
    stdio: req("@modelcontextprotocol/sdk/client/stdio.js"),
  };
}

/** Same bearer the CLIs get: a static token wins over the OAuth sign-in. */
function bearerOf(row) {
  if (typeof row.token === "string" && row.token) return row.token;
  return row.oauth && typeof row.oauth.accessToken === "string" ? row.oauth.accessToken : "";
}

/**
 * @param {object} row - stored (unredacted) server row
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<Array<{ name: string, description: string }>>}
 */
async function listServerTools(row, opts = {}) {
  const { Client, StreamableHTTPClientTransport, SSEClientTransport, stdio } = sdk();
  let stderr = "";
  let transport;
  if (row.transport === "stdio") {
    if (row.trusted !== true) throw new Error("Trust this local server before listing its tools");
    const env = opts.env || process.env;
    transport = new stdio.StdioClientTransport({
      command: row.command,
      args: Array.isArray(row.args) ? row.args : [],
      env: { ...stdio.getDefaultEnvironment(), PATH: env.PATH || "", ...(row.env || {}) },
      ...(row.cwd ? { cwd: row.cwd } : {}),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-STDERR_TAIL);
    });
  } else {
    const headers = { ...(row.headers || {}) };
    const bearer = bearerOf(row);
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const url = new URL(row.url);
    transport =
      row.transport === "sse"
        ? new SSEClientTransport(url, { requestInit: { headers } })
        : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  }
  const client = new Client({ name: "Solenta", version: "1" });
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`No answer from ${row.name} within ${Math.round((opts.timeoutMs || LIST_TIMEOUT_MS) / 1000)}s`)),
      opts.timeoutMs || LIST_TIMEOUT_MS,
    );
  });
  try {
    const listed = await Promise.race([
      (async () => {
        await client.connect(transport);
        /** @type {Array<{ name: string, description?: string }>} */
        const tools = [];
        let cursor;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined);
          tools.push(...(page.tools || []));
          cursor = page.nextCursor;
        } while (cursor && tools.length < MAX_TOOLS);
        return tools;
      })(),
      timeout,
    ]);
    return listed.slice(0, MAX_TOOLS).map((t) => ({
      name: String(t.name),
      description: typeof t.description === "string" ? t.description.slice(0, 400) : "",
    }));
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if ((err && err.code === 401) || /\b401\b|Unauthorized/i.test(msg)) {
      throw new Error(`${row.name} needs sign-in before its tools can be listed`);
    }
    const tail = stderr.trim().split("\n").slice(-3).join(" ").trim();
    throw new Error(tail ? `${msg} (${tail})` : msg);
  } finally {
    clearTimeout(timer);
    try {
      await client.close();
    } catch {
      // ignore
    }
  }
}

module.exports = { LIST_TIMEOUT_MS, listServerTools };
