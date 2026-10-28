"use strict";

/**
 * Main-process curated MCP catalog (#1720 marketplace). Renderer looks up by
 * id only; commands and URLs never come from the client.
 *
 * ENTRIES is plain JSON-shaped data so electron/remoteCatalog.js could serve
 * a newer copy later. Every command / URL was checked against the server's
 * own README or docs on 2026-10-28 (the `homepage` link). `${NAME}` in env,
 * headers or args is asked for by the install form; nothing else is.
 *
 * auth: "oauth" = sign in after install (MCP authorization flow, needs
 * dynamic client registration); "key" / "none" are derived from templates.
 * Left out on purpose: Slack, Vercel, Figma remote and Asana only accept
 * allowlisted or pre-registered OAuth clients; the archived reference
 * servers (old GitHub, Postgres, Slack, Brave) were replaced below.
 */

const { parseMcpConfigDocument } = require("./mcp.js");

const ENTRIES = [
  // Reference servers (modelcontextprotocol/servers)
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read, write and search files inside the folders you allow.",
    category: "Reference",
    publisher: "MCP",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    definition: {
      name: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "${ALLOWED_FOLDER}"],
    },
  },
  {
    id: "fetch",
    name: "Fetch",
    description: "Fetch a URL and convert the page to markdown.",
    category: "Reference",
    publisher: "MCP",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    definition: { name: "fetch", transport: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
  },
  {
    id: "memory",
    name: "Memory",
    description: "A local knowledge graph the agent can store and recall facts in.",
    category: "Reference",
    publisher: "MCP",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    definition: {
      name: "memory",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    },
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    description: "A step-by-step reasoning tool for planning hard problems.",
    category: "Reference",
    publisher: "MCP",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    definition: {
      name: "sequential-thinking",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    },
  },
  {
    id: "git",
    name: "Git",
    description: "Read, search and change local Git repositories.",
    category: "Reference",
    publisher: "MCP",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    definition: { name: "git", transport: "stdio", command: "uvx", args: ["mcp-server-git"] },
  },
  {
    id: "time",
    name: "Time",
    description: "Current time and time-zone conversion.",
    category: "Reference",
    publisher: "MCP",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
    definition: { name: "time", transport: "stdio", command: "uvx", args: ["mcp-server-time"] },
  },
  // Developer tools
  {
    id: "github",
    name: "GitHub",
    description: "Repositories, issues, pull requests and Actions on GitHub's hosted server.",
    category: "Developer tools",
    publisher: "GitHub",
    homepage: "https://github.com/github/github-mcp-server",
    definition: {
      name: "github",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      // GitHub's OAuth needs an allowlisted client (no DCR); a PAT works for all.
      headers: { Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" },
    },
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Errors, issues, projects and Seer analysis from Sentry.",
    category: "Developer tools",
    publisher: "Sentry",
    homepage: "https://docs.sentry.io/ai/mcp/",
    auth: "oauth",
    definition: { name: "sentry", transport: "http", url: "https://mcp.sentry.dev/mcp" },
  },
  {
    id: "playwright",
    name: "Playwright",
    description: "Drive a browser: navigate, click, fill forms and read the page.",
    category: "Browser",
    publisher: "Microsoft",
    homepage: "https://github.com/microsoft/playwright-mcp",
    definition: {
      name: "playwright",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
    },
  },
  {
    id: "chrome-devtools",
    name: "Chrome DevTools",
    description: "Control and inspect a live Chrome: console, network, performance.",
    category: "Browser",
    publisher: "Google",
    homepage: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    definition: {
      name: "chrome-devtools",
      transport: "stdio",
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest"],
    },
  },
  {
    id: "figma",
    name: "Figma (desktop)",
    description: "Design context from the Figma desktop app's local Dev Mode server.",
    category: "Design",
    publisher: "Figma",
    homepage: "https://help.figma.com/hc/en-us/articles/32132100833559",
    definition: { name: "figma", transport: "http", url: "http://127.0.0.1:3845/mcp" },
  },
  // Docs & search
  {
    id: "context7",
    name: "Context7",
    description: "Up-to-date library documentation and code examples.",
    category: "Docs & search",
    publisher: "Upstash",
    homepage: "https://context7.com/docs",
    definition: { name: "context7", transport: "http", url: "https://mcp.context7.com/mcp" },
  },
  {
    id: "deepwiki",
    name: "DeepWiki",
    description: "Ask questions about any public GitHub repository.",
    category: "Docs & search",
    publisher: "Cognition",
    homepage: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
    definition: { name: "deepwiki", transport: "http", url: "https://mcp.deepwiki.com/mcp" },
  },
  {
    id: "microsoft-learn",
    name: "Microsoft Learn",
    description: "Search official Microsoft and Azure documentation and samples.",
    category: "Docs & search",
    publisher: "Microsoft",
    homepage: "https://github.com/microsoftdocs/mcp",
    definition: {
      name: "microsoft-learn",
      transport: "http",
      url: "https://learn.microsoft.com/api/mcp",
    },
  },
  {
    id: "aws-documentation",
    name: "AWS Documentation",
    description: "Search and read the public AWS documentation. No AWS account needed.",
    category: "Docs & search",
    publisher: "AWS Labs",
    homepage: "https://github.com/awslabs/mcp/tree/main/src/aws-documentation-mcp-server",
    definition: {
      name: "aws-documentation",
      transport: "stdio",
      command: "uvx",
      args: ["awslabs.aws-documentation-mcp-server@latest"],
    },
  },
  {
    id: "exa",
    name: "Exa",
    description: "Web and code search backed by the Exa search API.",
    category: "Docs & search",
    publisher: "Exa",
    homepage: "https://exa.ai/docs/reference/exa-mcp",
    definition: { name: "exa", transport: "http", url: "https://mcp.exa.ai/mcp" },
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Web, news, image and local search through the Brave Search API.",
    category: "Docs & search",
    publisher: "Brave",
    homepage: "https://github.com/brave/brave-search-mcp-server",
    definition: {
      name: "brave-search",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@brave/brave-search-mcp-server"],
      env: { BRAVE_API_KEY: "${BRAVE_API_KEY}" },
    },
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    description: "Scrape, crawl and search the web through Firecrawl.",
    category: "Docs & search",
    publisher: "Firecrawl",
    homepage: "https://github.com/mendableai/firecrawl-mcp-server",
    definition: {
      name: "firecrawl",
      transport: "stdio",
      command: "npx",
      args: ["-y", "firecrawl-mcp"],
      env: { FIRECRAWL_API_KEY: "${FIRECRAWL_API_KEY}" },
    },
  },
  // Productivity
  {
    id: "linear",
    name: "Linear",
    description: "Issues, projects and cycles in Linear.",
    category: "Productivity",
    publisher: "Linear",
    homepage: "https://linear.app/docs/mcp",
    auth: "oauth",
    definition: { name: "linear", transport: "http", url: "https://mcp.linear.app/mcp" },
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search, read and edit Notion pages and databases.",
    category: "Productivity",
    publisher: "Notion",
    homepage: "https://developers.notion.com/docs/get-started-with-mcp",
    auth: "oauth",
    definition: { name: "notion", transport: "http", url: "https://mcp.notion.com/mcp" },
  },
  {
    id: "atlassian",
    name: "Atlassian",
    description: "Jira and Confluence through Atlassian's Rovo MCP server.",
    category: "Productivity",
    publisher: "Atlassian",
    homepage: "https://developer.atlassian.com/cloud/rovo-mcp/guides/getting-started/",
    auth: "oauth",
    definition: { name: "atlassian", transport: "http", url: "https://mcp.atlassian.com/v2/mcp" },
  },
  // Cloud & data
  {
    id: "supabase",
    name: "Supabase",
    description: "Manage Supabase projects, databases and edge functions.",
    category: "Cloud & data",
    publisher: "Supabase",
    homepage: "https://supabase.com/docs/guides/getting-started/mcp",
    auth: "oauth",
    definition: { name: "supabase", transport: "http", url: "https://mcp.supabase.com/mcp" },
  },
  {
    id: "neon",
    name: "Neon",
    description: "Neon Postgres projects, branches, queries and migrations.",
    category: "Cloud & data",
    publisher: "Neon",
    homepage: "https://neon.com/docs/ai/neon-mcp-server",
    auth: "oauth",
    definition: { name: "neon", transport: "http", url: "https://mcp.neon.tech/mcp" },
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Your Cloudflare account: Workers, DNS, storage and more.",
    category: "Cloud & data",
    publisher: "Cloudflare",
    homepage:
      "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    auth: "oauth",
    definition: { name: "cloudflare", transport: "http", url: "https://mcp.cloudflare.com/mcp" },
  },
  {
    id: "postgres",
    name: "Postgres",
    description: "Query and tune a Postgres database (Postgres MCP Pro, read-only mode).",
    category: "Cloud & data",
    publisher: "Crystal DBA",
    homepage: "https://github.com/crystaldba/postgres-mcp",
    definition: {
      name: "postgres",
      transport: "stdio",
      command: "uvx",
      args: ["postgres-mcp", "--access-mode=restricted"],
      env: { DATABASE_URI: "${DATABASE_URI}" },
    },
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Stripe payments, billing and docs search.",
    category: "Payments",
    publisher: "Stripe",
    homepage: "https://docs.stripe.com/mcp",
    auth: "oauth",
    definition: { name: "stripe", transport: "http", url: "https://mcp.stripe.com" },
  },
];

function freeze(value) {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Install form fields: one per `${NAME}` in the definition. */
function requiredSecretsOf(entry) {
  const parsed = parseMcpConfigDocument([entry.definition]);
  const meta = parsed.servers[0] && parsed.servers[0].meta;
  return meta ? meta.requiredSecrets.map((s) => ({ id: s.id, label: s.label })) : [];
}

function summaryOf(def) {
  return def.transport === "stdio" ? [def.command, ...(def.args || [])].join(" ") : def.url;
}

const CATALOG = freeze(
  ENTRIES.map((e) => {
    const requiredSecrets = requiredSecretsOf(e);
    return {
      ...e,
      transport: e.definition.transport,
      auth: e.auth || (requiredSecrets.length ? "key" : "none"),
      risk:
        e.definition.transport === "stdio"
          ? `Runs \`${summaryOf(e.definition)}\` on this computer for every agent.`
          : "Remote endpoint. Agents send it whatever its tools ask for.",
      requiredSecrets,
      definition: { ...e.definition, enabled: true },
    };
  }),
);

/**
 * @param {unknown} id
 * @returns {(typeof CATALOG)[number] | null}
 */
function getCatalogEntry(id) {
  const key = typeof id === "string" ? id.trim() : "";
  if (!key) return null;
  return CATALOG.find((entry) => entry.id === key) || null;
}

/**
 * @param {{ servers?: Array<{ name?: string, provenance?: string, catalogId?: string }> }} [opts]
 */
function listCatalog(opts = {}) {
  /** @type {Map<string, string>} */
  const installed = new Map();
  for (const row of opts.servers || []) {
    if (
      row &&
      row.provenance === "curated" &&
      typeof row.catalogId === "string" &&
      row.catalogId
    ) {
      installed.set(row.catalogId, String(row.name || ""));
    }
  }
  return CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    category: entry.category,
    publisher: entry.publisher,
    homepage: entry.homepage,
    sourceUrl: entry.homepage,
    transport: entry.transport,
    auth: entry.auth,
    risk: entry.risk,
    summary: summaryOf(entry.definition),
    requiredSecrets: entry.requiredSecrets.map((s) => ({ ...s })),
    installed: installed.has(entry.id),
    ...(installed.get(entry.id) ? { installedName: installed.get(entry.id) } : {}),
  }));
}

module.exports = {
  CATALOG,
  getCatalogEntry,
  listCatalog,
};
