/**
 * MCP marketplace (#1720): search, category filter, one-click install, the
 * key form, and uninstall. Rows come from the fake coder's catalog twin,
 * which test/mcpImportTwins.test.ts pins to electron/mcpCatalog.js.
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/mcpMarketplace.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { McpMarketplace } from "../src/components/McpMarketplace";
import { AddedMcpsSection, type McpAuthState } from "../src/components/SkillsSections";
import { devMcpCatalogRows } from "../src/devCoder.ts";
import type {
  McpCatalogEntry,
  McpServerDefinition,
  McpServerRemoteDefinition,
} from "../src/shared/ipc";

afterEach(() => unmountAll());

function rows(installed: string[] = []): McpCatalogEntry[] {
  return devMcpCatalogRows(
    installed.map((id) => ({ name: id, provenance: "curated", catalogId: id })),
  );
}

function visibleIds(m: Awaited<ReturnType<typeof mount>>): string[] {
  return m.queryAll("[data-mcp-catalog]").map((el) => el.getAttribute("data-mcp-catalog") || "");
}

describe("McpMarketplace", () => {
  it("searches name, description and publisher, and filters by category", async () => {
    const all = rows();
    const m = await mount(
      <McpMarketplace catalog={all} busy={false} onInstall={() => {}} onUninstall={() => {}} />,
    );
    assert.equal(visibleIds(m).length, all.length);
    assert.ok(m.text().includes(`${all.length} servers`));

    await m.type(m.query('input[aria-label="Search MCP servers"]'), "postgres");
    assert.deepEqual(visibleIds(m).sort(), ["neon", "postgres"]);
    await m.type(m.query('input[aria-label="Search MCP servers"]'), "microsoft docs");
    assert.deepEqual(visibleIds(m), ["microsoft-learn"]);
    await m.type(m.query('input[aria-label="Search MCP servers"]'), "zzz-nothing");
    assert.ok(m.text().includes("No MCP servers match"));
    await m.type(m.query('input[aria-label="Search MCP servers"]'), "");

    await m.click(m.query('[data-mcp-category="Productivity"]'));
    assert.deepEqual(visibleIds(m).sort(), ["atlassian", "linear", "notion"]);
    assert.equal(
      m.query('[data-mcp-category="Productivity"]')?.getAttribute("aria-pressed"),
      "true",
    );
    // Search narrows inside the category.
    await m.type(m.query('input[aria-label="Search MCP servers"]'), "jira");
    assert.deepEqual(visibleIds(m), ["atlassian"]);
    await m.click(m.query('[data-mcp-category="All"]'));
    assert.deepEqual(visibleIds(m), ["atlassian"]);
  });

  it("installs in one click when no key is needed, and shows Installed + Uninstall after", async () => {
    const installs: Array<[string, Record<string, string>]> = [];
    const removed: string[] = [];
    const m = await mount(
      <McpMarketplace
        catalog={rows()}
        busy={false}
        onInstall={(id, secrets) => installs.push([id, secrets])}
        onUninstall={(name) => removed.push(name)}
      />,
    );
    await m.click(m.query('button[aria-label="Install Context7"]'));
    assert.deepEqual(installs, [["context7", {}]]);
    assert.equal(m.query("[data-mcp-install-form]"), null, "no form for a keyless server");

    await m.rerender(
      <McpMarketplace
        catalog={rows(["context7"])}
        busy={false}
        onInstall={(id, secrets) => installs.push([id, secrets])}
        onUninstall={(name) => removed.push(name)}
      />,
    );
    const row = m.query('[data-mcp-catalog="context7"]');
    assert.ok(row?.hasAttribute("data-installed"));
    assert.ok(row?.textContent?.includes("Installed"));
    assert.equal(m.query('button[aria-label="Install Context7"]'), null);
    await m.click(m.query('button[aria-label="Uninstall Context7"]'));
    assert.deepEqual(removed, ["context7"]);
  });

  it("opens a short form for required keys and sends them keyed by form id", async () => {
    const installs: Array<[string, Record<string, string>]> = [];
    const catalog = rows();
    const brave = catalog.find((e) => e.id === "brave-search");
    assert.ok(brave?.requiredSecrets?.length);
    const m = await mount(
      <McpMarketplace
        catalog={catalog}
        busy={false}
        onInstall={(id, secrets) => installs.push([id, secrets])}
        onUninstall={() => {}}
      />,
    );
    await m.click(m.query('button[aria-label="Install Brave Search"]'));
    assert.deepEqual(installs, [], "a key-backed server never installs blank");
    const form = m.query('[data-mcp-install-form="brave-search"]');
    assert.ok(form);
    const key = form?.querySelector('input[aria-label="BRAVE_API_KEY"]') as HTMLInputElement;
    assert.equal(key.type, "password");
    const submit = Array.from(form?.querySelectorAll("button") ?? []).find((b) =>
      b.textContent?.includes("Install Brave Search"),
    ) as HTMLButtonElement;
    assert.equal(submit.disabled, true, "disabled until every key is filled");
    await m.type(key, "bsk-123");
    assert.equal(submit.disabled, false);
    await m.click(submit);
    assert.deepEqual(installs, [["brave-search", { [brave!.requiredSecrets![0].id]: "bsk-123" }]]);
    assert.equal(m.query("[data-mcp-install-form]"), null, "form closes after install");

    // A folder argument is plain text, not a password field.
    await m.click(m.query('button[aria-label="Install Filesystem"]'));
    const folder = m.query('input[aria-label="ALLOWED_FOLDER"]') as HTMLInputElement;
    assert.equal(folder.type, "text");
    await m.click(m.byText("Cancel"));
    assert.equal(m.query("[data-mcp-install-form]"), null);
  });

  it("shows the command or URL, auth kind, and a docs link per row", async () => {
    const m = await mount(
      <McpMarketplace catalog={rows()} busy={false} onInstall={() => {}} onUninstall={() => {}} />,
    );
    const pw = m.query('[data-mcp-catalog="playwright"]');
    assert.ok(pw?.textContent?.includes("npx -y @playwright/mcp@latest"));
    assert.ok(pw?.textContent?.includes("Local"));
    const linear = m.query('[data-mcp-catalog="linear"]');
    assert.ok(linear?.textContent?.includes("Sign-in"));
    assert.ok(linear?.textContent?.includes("https://mcp.linear.app/mcp"));
    assert.equal(
      linear?.querySelector("a")?.getAttribute("href"),
      "https://linear.app/docs/mcp",
    );
  });
});

describe("MCP sign-in controls", () => {
  const remote = (over: Partial<McpServerRemoteDefinition> = {}): McpServerRemoteDefinition => ({
    name: "linear",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    headerNames: [],
    hasToken: false,
    enabled: true,
    provenance: "curated",
    catalogId: "linear",
    ...over,
  });

  function section(
    servers: McpServerDefinition[],
    calls: string[],
    auth: Record<string, McpAuthState> = {},
    signIn = new Set(["linear"]),
  ) {
    return (
      <AddedMcpsSection
        servers={servers}
        busy={false}
        onToggle={() => {}}
        onRemove={() => {}}
        onTrust={() => {}}
        signInNames={signIn}
        auth={auth}
        onConnect={(n) => calls.push(`connect:${n}`)}
        onCancelConnect={(n) => calls.push(`cancel:${n}`)}
        onDisconnect={(n) => calls.push(`disconnect:${n}`)}
      />
    );
  }

  it("walks needs sign-in → waiting (Cancel) → signed in (Sign out) → error", async () => {
    const calls: string[] = [];
    const m = await mount(section([remote()], calls));
    assert.equal(m.query("[data-mcp-auth]")?.getAttribute("data-mcp-auth"), "needs");
    assert.ok(m.text().includes("Needs sign-in"));
    await m.click(m.query('button[aria-label="Sign in linear"]'));
    assert.deepEqual(calls, ["connect:linear"]);

    await m.rerender(section([remote()], calls, { linear: { pending: true } }));
    assert.ok(m.text().includes("Waiting for the browser"));
    await m.click(m.query('button[aria-label="Cancel linear"]'));
    assert.deepEqual(calls, ["connect:linear", "cancel:linear"]);

    await m.rerender(
      section([remote({ oauth: { refreshable: true, expiresAt: Date.now() + 60_000 } })], calls),
    );
    assert.equal(m.query("[data-mcp-auth]")?.getAttribute("data-mcp-auth"), "connected");
    await m.click(m.query('button[aria-label="Sign out linear"]'));
    assert.deepEqual(calls.at(-1), "disconnect:linear");

    await m.rerender(section([remote()], calls, { linear: { error: "Sign-in failed: denied" } }));
    assert.equal(m.query('[role="alert"]')?.textContent, "Sign-in failed: denied");
    assert.ok(m.query('button[aria-label="Sign in linear"]'), "retry from the error");

    // Expired without a refresh token reads as expired, not signed in.
    await m.rerender(
      section([remote({ oauth: { refreshable: false, expiresAt: Date.now() - 1 } })], calls),
    );
    assert.ok(m.text().includes("Sign-in expired"));
  });

  it("hides sign-in for local servers, static-token servers and keyless catalog servers", async () => {
    const m = await mount(
      section(
        [
          remote({ name: "context7", url: "https://mcp.context7.com/mcp", catalogId: "context7" }),
          remote({ name: "github", hasToken: true, catalogId: "github" }),
          {
            name: "memory",
            transport: "stdio",
            command: "npx",
            args: [],
            envNames: [],
            hasSecrets: false,
            enabled: true,
            trusted: true,
          },
        ],
        [],
        {},
        new Set(),
      ),
    );
    assert.equal(m.query("[data-mcp-auth]"), null);
    // A hand-added remote server offers Sign in without claiming it needs it.
    await m.rerender(
      section([remote({ name: "team", provenance: "added", catalogId: undefined })], [], {}, new Set()),
    );
    assert.equal(m.query("[data-mcp-auth]")?.getAttribute("data-mcp-auth"), "optional");
    assert.equal(m.text().includes("Needs sign-in"), false);
  });
});
