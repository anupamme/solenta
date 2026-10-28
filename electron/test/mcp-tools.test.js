"use strict";

/**
 * Per-tool MCP rules (#1720): tools/list against local fake MCP servers
 * (stdio + streamable HTTP behind a bearer), the 10 s limit, and the rules
 * compiled into governance plus each CLI's native deny list.
 */

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "coder-mcp-tools-home-"));
process.env.CODER_KIMI_MCP_PATH = path.join(tmpHome, "kimi-mcp.json");
process.env.CODER_GROK_MCP_DISABLE = "1";
process.env.CODER_CURSOR_MCP_DISABLE = "1";

const { describe, it, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createRequire } = require("node:module");
const { listServerTools } = require("../mcpTools.js");
const { evaluate, mcpToolRules, threadPolicy } = require("../governance.js");
const { IPC_HANDLERS } = require("../ipc.js");
const { Store } = require("../store.js");
const {
  resetMemorySupForTests,
  syncUserMcpServers,
  getClaudeMcpArgs,
  getCodexMcpArgs,
  opencodeMcpConfigForRun,
} = require("../memory-sup.js");

const SDK_REQ = createRequire(path.join(__dirname, "../../memory-server/package.json"));
const SDK_DIR = path.dirname(SDK_REQ.resolve("@modelcontextprotocol/sdk/package.json"));

after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));
afterEach(() => resetMemorySupForTests());

function fakeStdioServer(dir) {
  const file = path.join(dir, "fake-mcp.js");
  fs.writeFileSync(
    file,
    `const { createRequire } = require("node:module");
const req = createRequire(${JSON.stringify(path.join(SDK_DIR, "package.json"))});
const { McpServer } = req("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = req("@modelcontextprotocol/sdk/server/stdio.js");
const server = new McpServer({ name: "fake", version: "1" });
server.registerTool("search", { description: "Search things" }, async () => ({ content: [] }));
server.registerTool("delete_item", { description: "Delete one" }, async () => ({ content: [] }));
if (process.env.FAKE_EXTRA) server.registerTool(process.env.FAKE_EXTRA, {}, async () => ({ content: [] }));
server.connect(new StdioServerTransport());
`,
  );
  return file;
}

/** Streamable HTTP MCP server that only answers `Bearer good`. */
async function fakeHttpServer() {
  const { McpServer } = SDK_REQ("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = SDK_REQ(
    "@modelcontextprotocol/sdk/server/streamableHttp.js",
  );
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer good") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end("{}");
    }
    const mcp = new McpServer({ name: "fake-http", version: "1" });
    mcp.registerTool("issues_list", { description: "List issues" }, async () => ({ content: [] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      mcp.close();
    });
    await mcp.connect(transport);
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}

describe("listServerTools", () => {
  it("lists a trusted stdio server's tools and refuses an untrusted one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-mcp-tools-"));
    try {
      const row = {
        name: "fake",
        transport: "stdio",
        command: process.execPath,
        args: [fakeStdioServer(dir)],
        env: { FAKE_EXTRA: "from_env" },
        trusted: true,
      };
      const tools = await listServerTools(row);
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        ["delete_item", "from_env", "search"],
      );
      assert.equal(tools.find((t) => t.name === "search").description, "Search things");
      await assert.rejects(() => listServerTools({ ...row, trusted: false }), /Trust/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends the OAuth bearer to a remote server and explains a 401", async () => {
    const srv = await fakeHttpServer();
    try {
      const row = { name: "remote", transport: "http", url: srv.url, headers: {} };
      const tools = await listServerTools({ ...row, oauth: { accessToken: "good" } });
      assert.deepEqual(tools, [{ name: "issues_list", description: "List issues" }]);
      await assert.rejects(() => listServerTools(row), /needs sign-in/);
    } finally {
      await srv.close();
    }
  });

  it("gives up after the time limit and shows the error", async () => {
    const row = {
      name: "hung",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"],
      trusted: true,
    };
    const started = Date.now();
    await assert.rejects(() => listServerTools(row, { timeoutMs: 300 }), /No answer from hung/);
    assert.ok(Date.now() - started < 5000);
    await assert.rejects(
      () =>
        listServerTools({
          name: "broken",
          transport: "stdio",
          command: process.execPath,
          args: ["-e", "console.error('boom: missing API key'); process.exit(3)"],
          trusted: true,
        }),
      /boom: missing API key/,
    );
  });
});

describe("per-tool rules", () => {
  const servers = [
    {
      name: "github",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      enabled: true,
      toolRules: { search_code: "allow", create_issue: "ask", delete_repo: "deny" },
    },
    { name: "off", transport: "http", url: "https://x.example/mcp", enabled: false, toolRules: { a: "deny" } },
    { name: "junk", transport: "http", url: "https://y.example/mcp", toolRules: { "*": "allow", ok: "maybe" } },
  ];

  it("compile to governance tool rules on mcp__<server>__<tool>", () => {
    assert.deepEqual(mcpToolRules(servers), [
      { kind: "tool", match: "mcp__github__search_code", action: "allow", source: "mcp" },
      { kind: "tool", match: "mcp__github__create_issue", action: "ask", source: "mcp" },
      { kind: "tool", match: "mcp__github__delete_repo", action: "deny", source: "mcp" },
    ]);
  });

  it("decide calls through the same evaluate, deny winning over a profile allow", () => {
    const mcpRules = mcpToolRules(servers);
    const run = (toolName, policy = null) =>
      evaluate({ toolName, rawInput: {}, worktreePath: null, policy, builtin: null, mcpRules });
    assert.equal(run("mcp__github__delete_repo").decision, "deny");
    assert.equal(run("mcp__github__delete_repo").layer, "mcp.deny");
    assert.equal(run("mcp__github__create_issue").decision, "ask");
    assert.equal(run("mcp__github__create_issue").layer, "mcp.ask");
    assert.equal(run("mcp__github__search_code").decision, "allow");
    assert.equal(run("mcp__github__search_code").layer, "mcp.allow");
    // No rule: untouched (no profile → ask default, same as before).
    assert.equal(run("mcp__github__other").layer, "profile.default");
    // A profile that allows every tool still loses to the MCP deny.
    const allowAll = { defaultAction: "allow", rules: [{ kind: "tool", match: "*", action: "allow" }] };
    assert.equal(run("mcp__github__delete_repo", allowAll).decision, "deny");
    // A profile deny still beats an MCP allow.
    const denyGh = { defaultAction: "allow", rules: [{ kind: "tool", match: "mcp__github__*", action: "deny" }] };
    assert.equal(run("mcp__github__search_code", denyGh).decision, "deny");
  });

  it("threadPolicy hands the rules to every thread, profile or not", () => {
    const store = {
      getThread: () => ({ agentProfileId: null }),
      getSettings: () => ({ mcpServers: servers, agentProfiles: [] }),
    };
    const gov = threadPolicy(store, "t1");
    assert.equal(gov.policy, null);
    assert.equal(gov.mcpRules.length, 3);
  });

  it("setToolRule persists, clears, validates and re-syncs native deny lists", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-mcp-rules-"));
    try {
      const ctx = { store: new Store(path.join(tmp, "store.json")), userDataPath: tmp };
      await IPC_HANDLERS["mcp:save"](ctx, {
        name: "github",
        transport: "http",
        url: "https://api.githubcopilot.com/mcp/",
      });
      await IPC_HANDLERS["mcp:setToolRule"](ctx, { name: "github", tool: "delete_repo", action: "deny" });
      const row = await IPC_HANDLERS["mcp:setToolRule"](ctx, {
        name: "github",
        tool: "create_issue",
        action: "ask",
      });
      assert.deepEqual(row.toolRules, { delete_repo: "deny", create_issue: "ask" });
      const cleared = await IPC_HANDLERS["mcp:setToolRule"](ctx, {
        name: "github",
        tool: "create_issue",
        action: null,
      });
      assert.deepEqual(cleared.toolRules, { delete_repo: "deny" });
      await assert.rejects(
        () => IPC_HANDLERS["mcp:setToolRule"](ctx, { name: "github", tool: "*", action: "allow" }),
        /Invalid MCP tool name/,
      );
      await assert.rejects(
        () => IPC_HANDLERS["mcp:setToolRule"](ctx, { name: "github", tool: "x", action: "block" }),
        /allow, ask, deny/,
      );
      // Toggling the server keeps its rules.
      await IPC_HANDLERS["mcp:setEnabled"](ctx, { name: "github", enabled: true });
      assert.deepEqual(ctx.store.getSettings().mcpServers[0].toolRules, { delete_repo: "deny" });

      // The sync carried the deny into each CLI's own deny list.
      const claude = getClaudeMcpArgs();
      assert.ok(claude.includes("--disallowedTools=mcp__github__delete_repo"), claude.join(" "));
      const codex = getCodexMcpArgs();
      assert.ok(codex.includes('mcp_servers.github.disabled_tools=["delete_repo"]'), codex.join(" "));
      assert.deepEqual(opencodeMcpConfigForRun().tools, { github_delete_repo: false });

      const listed = await IPC_HANDLERS["mcp:listTools"](
        { ...ctx, listServerTools: async (r) => [{ name: `${r.name}-tool`, description: "" }] },
        { name: "github" },
      );
      assert.deepEqual(listed, { tools: [{ name: "github-tool", description: "" }] });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("servers without rules add no deny flags", () => {
    syncUserMcpServers([{ name: "plain", transport: "http", url: "https://p.example/mcp" }]);
    assert.equal(getCodexMcpArgs().some((a) => a.includes("disabled_tools")), false);
    assert.equal(opencodeMcpConfigForRun().tools, undefined);
  });
});
