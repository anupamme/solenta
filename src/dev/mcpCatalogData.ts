/**
 * Browser-twin copy of the main-process MCP marketplace catalog
 * (electron/mcpCatalog.js CATALOG). Generated from it; test/mcpImportTwins
 * fails when the two drift, so regenerate rather than hand-edit.
 */
import type { DevMcpCatalogEntry } from "./mcp.ts";

export const DEV_MCP_CATALOG_DATA: readonly DevMcpCatalogEntry[] = [
  {
    "id": "filesystem",
    "name": "Filesystem",
    "description": "Read, write and search files inside the folders you allow.",
    "category": "Reference",
    "publisher": "MCP",
    "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    "sourceUrl": "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    "transport": "stdio",
    "auth": "key",
    "risk": "Runs `npx -y @modelcontextprotocol/server-filesystem ${ALLOWED_FOLDER}` on this computer for every agent.",
    "requiredSecrets": [
      {
        "id": "filesystem:arg:2:ALLOWED_FOLDER",
        "label": "ALLOWED_FOLDER"
      }
    ],
    "definition": {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "${ALLOWED_FOLDER}"
      ],
      "enabled": true
    }
  },
  {
    "id": "fetch",
    "name": "Fetch",
    "description": "Fetch a URL and convert the page to markdown.",
    "category": "Reference",
    "publisher": "MCP",
    "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    "sourceUrl": "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    "transport": "stdio",
    "auth": "none",
    "risk": "Runs `uvx mcp-server-fetch` on this computer for every agent.",
    "requiredSecrets": [],
    "definition": {
      "name": "fetch",
      "transport": "stdio",
      "command": "uvx",
      "args": [
        "mcp-server-fetch"
      ],
      "enabled": true
    }
  },
  {
    "id": "memory",
    "name": "Memory",
    "description": "A local knowledge graph the agent can store and recall facts in.",
    "category": "Reference",
    "publisher": "MCP",
    "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    "sourceUrl": "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    "transport": "stdio",
    "auth": "none",
    "risk": "Runs `npx -y @modelcontextprotocol/server-memory` on this computer for every agent.",
    "requiredSecrets": [],
    "definition": {
      "name": "memory",
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-memory"
      ],
      "enabled": true
    }
  },
  {
    "id": "sequential-thinking",
    "name": "Sequential Thinking",
    "description": "A step-by-step reasoning tool for planning hard problems.",
    "category": "Reference",
    "publisher": "MCP",
    "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    "sourceUrl": "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    "transport": "stdio",
    "auth": "none",
    "risk": "Runs `npx -y @modelcontextprotocol/server-sequential-thinking` on this computer for every agent.",
    "requiredSecrets": [],
    "definition": {
      "name": "sequential-thinking",
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-sequential-thinking"
      ],
      "enabled": true
    }
  },
  {
    "id": "git",
    "name": "Git",
    "description": "Read, search and change local Git repositories.",
    "category": "Reference",
    "publisher": "MCP",
    "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    "sourceUrl": "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    "transport": "stdio",
    "auth": "none",
    "risk": "Runs `uvx mcp-server-git` on this computer for every agent.",
    "requiredSecrets": [],
    "definition": {
      "name": "git",
      "transport": "stdio",
      "command": "uvx",
      "args": [
        "mcp-server-git"
      ],
      "enabled": true
    }
  },
  {
    "id": "time",
    "name": "Time",
    "description": "Current time and time-zone conversion.",
    "category": "Reference",
    "publisher": "MCP",
    "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
    "sourceUrl": "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
    "transport": "stdio",
    "auth": "none",
    "risk": "Runs `uvx mcp-server-time` on this computer for every agent.",
    "requiredSecrets": [],
    "definition": {
      "name": "time",
      "transport": "stdio",
      "command": "uvx",
      "args": [
        "mcp-server-time"
      ],
      "enabled": true
    }
  },
  {
    "id": "github",
    "name": "GitHub",
    "description": "Repositories, issues, pull requests and Actions on GitHub's hosted server.",
    "category": "Developer tools",
    "publisher": "GitHub",
    "homepage": "https://github.com/github/github-mcp-server",
    "sourceUrl": "https://github.com/github/github-mcp-server",
    "transport": "http",
    "auth": "key",
    "risk": "Remote endpoint. Agents send it whatever its tools ask for.",
    "requiredSecrets": [
      {
        "id": "github:header:Authorization:GITHUB_PERSONAL_ACCESS_TOKEN",
        "label": "GITHUB_PERSONAL_ACCESS_TOKEN"
      }
    ],
    "definition": {
      "name": "github",
      "transport": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"
      },
      "enabled": true
    }
  },
  {
    "id": "sentry",
    "name": "Sentry",
    "description": "Errors, issues, projects and Seer analysis from Sentry.",
    "category": "Developer tools",
    "publisher": "Sentry",
    "homepage": "https://docs.sentry.io/ai/mcp/",
    "sourceUrl": "https://docs.sentry.io/ai/mcp/",
    "transport": "http",
    "auth": "oauth",
    "risk": "Remote endpoint. Agents send it whatever its tools ask for.",
    "requiredSecrets": [],
    "definition": {
      "name": "sentry",
      "transport": "http",
      "url": "https://mcp.sentry.dev/mcp",
      "enabled": true
    }
  },
  {
    "id": "playwright",
    "name": "Playwright",
    "description": "Drive a browser: navigate, click, fill forms and read the page.",
    "category": "Browser",
    "publisher": "Microsoft",
    "homepage": "https://github.com/microsoft/playwright-mcp",
    "sourceUrl": "https://github.com/microsoft/playwright-mcp",
    "transport": "stdio",
    "auth": "none",
    "risk": "Runs `npx -y @playwright/mcp@latest` on this computer for every agent.",
    "requiredSecrets": [],
    "definition": {
      "name": "playwright",
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@playwright/mcp@latest"
      ],
      "enabled": true
    }
  },
  {
    "id": "chrome-devtools",
    "name": "Chrome DevTools",
    "description": "Control and inspect a live Chrome: console, network, performance.",
    "category": "Browser",
    "publisher": "Google",
    "homepage": "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    "sourceUrl": "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    "transport": "stdio",
    "auth": "none",
    "risk": "Runs `npx -y chrome-devtools-mcp@latest` on this computer for every agent.",
    "requiredSecrets": [],
    "definition": {
      "name": "chrome-devtools",
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@latest"
      ],
      "enabled": true
    }
  },
  {
    "id": "figma",
    "name": "Figma (desktop)",
    "description": "Design context from the Figma desktop app's local Dev Mode server.",
    "category": "Design",
    "publisher": "Figma",
    "homepage": "https://help.figma.com/hc/en-us/articles/32132100833559",
    "sourceUrl": "https://help.figma.com/hc/en-us/articles/32132100833559",
    "transport": "http",
    "auth": "none",
    "risk": "Remote endpoint. Agents send it whatever its tools ask for.",
    "requiredSecrets": [],
    "definition": {
      "name": "figma",
      "transport": "http",
      "url": "http://127.0.0.1:3845/mcp",
      "enabled": true
    }
  },
  {
    "id": "context7",
    "name": "Context7",
    "description": "Up-to-date library documentation and code examples.",
    "category": "Docs & search",
    "publisher": "Upstash",
    "homepage": "https://context7.com/docs",
    "sourceUrl": "https://context7.com/docs",
    "transport": "http",
    "auth": "none",
    "risk": "Remote endpoint. Agents send it whatever its tools ask for.",
    "requiredSecrets": [],
    "definition": {
      "name": "context7",
      "transport": "http",
      "url": "https://mcp.context7.com/mcp",
      "enabled": true
    }
  },
  {
    "id": "deepwiki",
    "name": "DeepWiki",
    "description": "Ask questions about any public GitHub repository.",
    "category": "Docs & search",
    "publisher": "Cognition",
    "homepage": "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
    "sourceUrl": "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
    "transport": "http",
    "auth": "none",
    "risk": "Remote endpoint. Agents send it whatever its tools ask for.",
    "requiredSecrets": [],
    "definition": {
      "name": "deepwiki",
      "transport": "http",
      "url": "https://mcp.deepwiki.com/mcp",
      "enabled": true
    }
  },
  {
    "id": "microsoft-learn",
    "name": "Microsoft Learn",
    "description": "Search official Microsoft and Azure documentation and samples.",
    "category": "Docs & search",
    "publisher": "Microsoft",
    "homepage": "https://github.com/microsoftdocs/mcp",
    "sourceUrl": "https://github.com/microsoftdocs/mcp",
    "transport": "http",
    "auth": "none",
    "risk": "Remote endpoint. Agents send it whatever its tools ask for.",
    "requiredSecrets": [],
    "definition": {
      "name": "microsoft-learn",
      "transport": "http",
      "url": "https://learn.microsoft.com/api/mcp",
      "enabled": true
    }
  },
  {
    "id": "aws-documentation",
    "name": "AWS Documentation",
    "description": "Search and read the public AWS documentation. No AWS account needed.",
    "category": "Docs & search",
    "publisher": "AWS Labs",
    "homepage": "https://github.com/awslabs/mcp/tree/main/src/aws-documentation-mcp-server",
    "sourceUrl": "https://github.com/awslabs/mcp/tree/main/src/aws-documentation-mcp-server",
    "transport": "stdio",
    "auth": "none",
    "risk": "Runs `uvx awslabs.aws-documentation-mcp-server@latest` on this computer for every agent.",
    "requiredSecrets": [],
    "definition": {
      "name": "aws-documentation",
      "transport": "stdio",
      "command": "uvx",
      "args": [
        "awslabs.aws-documentation-mcp-server@latest"
      ],
      "enabled": true
    }
  },
  {
    "id": "exa",
    "name": "Exa",
    "description": "Web and code search backed by the Exa search API.",
    "category": "Docs & search",
    "publisher": "Exa",
    "homepage": "https://exa.ai/docs/reference/exa-mcp",
    "sourceUrl": "https://exa.ai/docs/reference/exa-mcp",
    "transport": "http",
    "auth": "none",
    "risk": "Remote endpoint. Agents send it whatever its tools ask for.",
    "requiredSecrets": [],
    "definition": {
      "name": "exa",
      "transport": "http",
      "url": "https://mcp.exa.ai/mcp",
      "enabled": true
    }
  },
  {
    "id": "brave-search",
    "name": "Brave Search",
    "description": "Web, news, image and local search through the Brave Search API.",
    "category": "Docs & search",
    "publisher": "Brave",
    "homepage": "https://github.com/brave/brave-search-mcp-server",
    "sourceUrl": "https://github.com/brave/brave-search-mcp-server",
    "transport": "stdio",
    "auth": "key",
    "risk": "Runs `npx -y @brave/brave-search-mcp-server` on this computer for every agent.",
    "requiredSecrets": [
      {
        "id": "brave-search:env:BRAVE_API_KEY:BRAVE_API_KEY",
        "label": "BRAVE_API_KEY"
      }
    ],
    "definition": {
      "name": "brave-search",
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@brave/brave-search-mcp-server"
      ],
      "env": {
        "BRAVE_API_KEY": "${BRAVE_API_KEY}"
      },
      "enabled": true
    }
  },
  {
    "id": "firecrawl",
    "name": "Firecrawl",
    "description": "Scrape, crawl and search the web through Firecrawl.",
    "category": "Docs & search",
    "publisher": "Firecrawl",
    "homepage": "https://github.com/mendableai/firecrawl-mcp-server",
    "sourceUrl": "https://github.com/mendableai/firecrawl-mcp-server",
    "transport": "stdio",
    "auth": "key",
    "risk": "Runs `npx -y firecrawl-mcp` on this computer for every agent.",
    "requiredSecrets": [
      {
        "id": "firecrawl:env:FIRECRAWL_API_KEY:FIRECRAWL_API_KEY",
        "label": "FIRECRAWL_API_KEY"
      }
    ],
    "definition": {
      "name": "firecrawl",
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "firecrawl-mcp"
      ],
      "env": {
        "FIRECRAWL_API_KEY": "${FIRECRAWL_API_KEY}"
      },
      "enabled": true
    }
  },
  {
    "id": "linear",
    "name": "Linear",
    "description": "Issues, projects and cycles in Linear.",
    "category": "Productivity",
    "publisher": "Linear",
    "homepage": "https://linear.app/docs/mcp",
    "sourceUrl": "https://linear.app/docs/mcp",
    "transport": "http",
    "auth": "oauth",
    "risk": "Remote endpoint. Agents send it whatever its tools ask for.",
    "requiredSecrets": [],
    "definition": {
      "name": "linear",
      "transport": "http",
      "url": "https://mcp.linear.app/mcp",
      "enabled": true
    }
  },
  {
    "id": "notion",
    "name": "Notion",
    "description": "Search, read and edit Notion pages and databases.",
    "category": "Productivity",
    "publisher": "Notion",
    "homepage": "https://developers.notion.com/docs/get-started-with-mcp",
    "sourceUrl": "https://developers.notion.com/docs/get-started-with-mcp",
    "transport": "http",
    "auth": "oauth",
    "risk": "Remote endpoint. Agents send it whatever its tools ask for.",
    "requiredSecrets": [],
    "definition": {
      "name": "notion",
      "transport": "http",
      "url": "https://mcp.notion.com/mcp",
      "enabled": true
    }
  },
  {
    "id": "atlassian",
    "name": "Atlassian",
    "description": "Jira and Confluence through Atlassian's Rovo MCP server.",
    "category": "Productivity",
    "publisher": "Atlassian",
    "homepage": "https://developer.atlassian.com/cloud/rovo-mcp/guides/getting-started/",
    "sourceUrl": "https://developer.atlassian.com/cloud/rovo-mcp/guides/getting-started/",
    "transport": "http",
    "auth": "oauth",
    "risk": "Remote endpoint. Agents send it whatever its tools ask for.",
    "requiredSecrets": [],
    "definition": {
      "name": "atlassian",
      "transport": "http",
      "url": "https://mcp.atlassian.com/v2/mcp",
      "enabled": true
    }
  },
  {
    "id": "supabase",
    "name": "Supabase",
    "description": "Manage Supabase projects, databases and edge functions.",
    "category": "Cloud & data",
    "publisher": "Supabase",
    "homepage": "https://supabase.com/docs/guides/getting-started/mcp",
    "sourceUrl": "https://supabase.com/docs/guides/getting-started/mcp",
    "transport": "http",
    "auth": "oauth",
    "risk": "Remote endpoint. Agents send it whatever its tools ask for.",
    "requiredSecrets": [],
    "definition": {
      "name": "supabase",
      "transport": "http",
      "url": "https://mcp.supabase.com/mcp",
      "enabled": true
    }
  },
  {
    "id": "neon",
    "name": "Neon",
    "description": "Neon Postgres projects, branches, queries and migrations.",
    "category": "Cloud & data",
    "publisher": "Neon",
    "homepage": "https://neon.com/docs/ai/neon-mcp-server",
    "sourceUrl": "https://neon.com/docs/ai/neon-mcp-server",
    "transport": "http",
    "auth": "oauth",
    "risk": "Remote endpoint. Agents send it whatever its tools ask for.",
    "requiredSecrets": [],
    "definition": {
      "name": "neon",
      "transport": "http",
      "url": "https://mcp.neon.tech/mcp",
      "enabled": true
    }
  },
  {
    "id": "cloudflare",
    "name": "Cloudflare",
    "description": "Your Cloudflare account: Workers, DNS, storage and more.",
    "category": "Cloud & data",
    "publisher": "Cloudflare",
    "homepage": "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    "sourceUrl": "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    "transport": "http",
    "auth": "oauth",
    "risk": "Remote endpoint. Agents send it whatever its tools ask for.",
    "requiredSecrets": [],
    "definition": {
      "name": "cloudflare",
      "transport": "http",
      "url": "https://mcp.cloudflare.com/mcp",
      "enabled": true
    }
  },
  {
    "id": "postgres",
    "name": "Postgres",
    "description": "Query and tune a Postgres database (Postgres MCP Pro, read-only mode).",
    "category": "Cloud & data",
    "publisher": "Crystal DBA",
    "homepage": "https://github.com/crystaldba/postgres-mcp",
    "sourceUrl": "https://github.com/crystaldba/postgres-mcp",
    "transport": "stdio",
    "auth": "key",
    "risk": "Runs `uvx postgres-mcp --access-mode=restricted` on this computer for every agent.",
    "requiredSecrets": [
      {
        "id": "postgres:env:DATABASE_URI:DATABASE_URI",
        "label": "DATABASE_URI"
      }
    ],
    "definition": {
      "name": "postgres",
      "transport": "stdio",
      "command": "uvx",
      "args": [
        "postgres-mcp",
        "--access-mode=restricted"
      ],
      "env": {
        "DATABASE_URI": "${DATABASE_URI}"
      },
      "enabled": true
    }
  },
  {
    "id": "stripe",
    "name": "Stripe",
    "description": "Stripe payments, billing and docs search.",
    "category": "Payments",
    "publisher": "Stripe",
    "homepage": "https://docs.stripe.com/mcp",
    "sourceUrl": "https://docs.stripe.com/mcp",
    "transport": "http",
    "auth": "oauth",
    "risk": "Remote endpoint. Agents send it whatever its tools ask for.",
    "requiredSecrets": [],
    "definition": {
      "name": "stripe",
      "transport": "http",
      "url": "https://mcp.stripe.com",
      "enabled": true
    }
  }
];
