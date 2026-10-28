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
import { devMcpCatalogRows } from "../src/devCoder.ts";
import type { McpCatalogEntry } from "../src/shared/ipc";

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
