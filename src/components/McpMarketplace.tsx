import { useMemo, useState } from "react";
import type {
  McpCatalogEntry,
  McpServerDefinition,
  McpToolAction,
  McpToolInfo,
  McpToolRules,
} from "../shared/ipc";
import styles from "./SkillsTab.module.css";
import own from "./McpMarketplace.module.css";

const ALL = "All";

function matches(entry: McpCatalogEntry, query: string): boolean {
  if (!query) return true;
  const hay = [
    entry.name,
    entry.description,
    entry.publisher,
    entry.category ?? "",
    entry.id,
  ]
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

function authLabel(entry: McpCatalogEntry): string | null {
  if (entry.auth === "oauth") return "Sign-in";
  if (entry.auth === "key") {
    const all = entry.requiredSecrets ?? [];
    return all.length && all.every((s) => s.id.includes(":arg:")) ? "Asks for a folder" : "API key";
  }
  return null;
}

/**
 * Settings → Skills & MCP marketplace (#1720), after Cline's Marketplace
 * view: search, category filter, one row per server, and a one-click
 * Install that only expands into a form when the server needs keys.
 */
export function McpMarketplace({
  catalog,
  busy,
  error,
  onInstall,
  onUninstall,
}: {
  catalog: McpCatalogEntry[];
  busy: boolean;
  error?: string | null;
  onInstall: (id: string, secrets: Record<string, string>) => void;
  onUninstall: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(ALL);
  const [formId, setFormId] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const e of catalog) if (e.category) seen.add(e.category);
    return [ALL, ...[...seen].sort()];
  }, [catalog]);

  const visible = catalog.filter(
    (e) => (category === ALL || e.category === category) && matches(e, query.trim()),
  );

  const openForm = (entry: McpCatalogEntry) => {
    setFormId(entry.id);
    setSecrets({});
  };

  const install = (entry: McpCatalogEntry) => {
    const needed = entry.requiredSecrets ?? [];
    if (needed.length && formId !== entry.id) {
      openForm(entry);
      return;
    }
    onInstall(entry.id, needed.length ? secrets : {});
    setFormId(null);
  };

  return (
    <section
      className={styles.subSection}
      aria-label="MCP marketplace"
      data-mcp-section="marketplace"
    >
      <div className={styles.sectionLabel}>MCP marketplace</div>
      <div className={styles.toolbarRow}>
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Search MCP servers"
          aria-label="Search MCP servers"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className={styles.count}>
          {visible.length === 1 ? "1 server" : `${visible.length} servers`}
        </span>
      </div>
      {categories.length > 2 && (
        <div className={own.pills} role="group" aria-label="Category">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              className={own.pill}
              aria-pressed={category === c}
              data-mcp-category={c}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      )}
      {visible.length === 0 ? (
        <p className={styles.empty}>
          {catalog.length === 0 ? "No MCP servers in the catalog" : "No MCP servers match"}
        </p>
      ) : (
        <ul className={styles.list}>
          {visible.map((entry) => {
            const auth = authLabel(entry);
            const needed = entry.requiredSecrets ?? [];
            const formOpen = formId === entry.id && !entry.installed;
            const ready = needed.every((s) => (secrets[s.id] ?? "").trim());
            return (
              <li
                key={entry.id}
                className={styles.row}
                data-mcp-catalog={entry.id}
                data-installed={entry.installed ? "" : undefined}
              >
                <div className={styles.rowMain}>
                  <span className={styles.rowName}>
                    {entry.name}
                    {entry.installed && (
                      <span className={`${styles.badge} ${own.installed}`}>
                        Installed
                      </span>
                    )}
                  </span>
                  <span className={styles.rowDetail}>{entry.description}</span>
                  <span className={own.meta}>
                    {[entry.publisher, entry.category, entry.transport === "stdio" ? "Local" : "Remote", auth]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {entry.summary && (
                    <code className={own.summary} title={entry.summary}>
                      {entry.summary}
                    </code>
                  )}
                </div>
                <div className={styles.rowSide}>
                  {entry.homepage && (
                    <a
                      className={styles.sourceLink}
                      href={entry.homepage}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Docs
                    </a>
                  )}
                  {entry.installed ? (
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      disabled={busy || !entry.installedName}
                      aria-label={`Uninstall ${entry.name}`}
                      onClick={() => entry.installedName && onUninstall(entry.installedName)}
                    >
                      Uninstall
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      disabled={busy || formOpen}
                      aria-label={`Install ${entry.name}`}
                      onClick={() => install(entry)}
                    >
                      Install
                    </button>
                  )}
                </div>
                {formOpen && (
                  <form
                    className={own.form}
                    data-mcp-install-form={entry.id}
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (ready) install(entry);
                    }}
                  >
                    {needed.map((s) => (
                      <label key={s.id} className={own.field}>
                        <span className={styles.formHint}>{s.label}</span>
                        <input
                          type={s.id.includes(":arg:") ? "text" : "password"}
                          autoComplete="off"
                          className={styles.input}
                          aria-label={s.label}
                          value={secrets[s.id] ?? ""}
                          onChange={(e) =>
                            setSecrets((prev) => ({ ...prev, [s.id]: e.target.value }))
                          }
                        />
                      </label>
                    ))}
                    <span className={styles.formHint}>
                      Stored encrypted on this computer and passed only to this server.
                    </span>
                    <div className={styles.addActions}>
                      <button
                        type="submit"
                        className={styles.primaryBtn}
                        disabled={busy || !ready}
                      >
                        Install {entry.name}
                      </button>
                      <button
                        type="button"
                        className={styles.ghostBtn}
                        onClick={() => setFormId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const TOOL_ACTIONS: Array<{ value: McpToolAction | ""; label: string }> = [
  { value: "", label: "Default" },
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask" },
  { value: "deny", label: "Deny" },
];

/**
 * One installed server's tools with a per-tool allow / ask / deny (#1720).
 * Rules compile into governance rules; Claude enforces all three, Codex and
 * OpenCode hide denied tools, the rest is best effort.
 */
export function McpToolsPanel({
  server,
  listTools,
  setToolRule,
}: {
  server: McpServerDefinition;
  listTools: (input: { name: string }) => Promise<{ tools: McpToolInfo[] }>;
  setToolRule: (input: {
    name: string;
    tool: string;
    action: McpToolAction | null;
  }) => Promise<McpServerDefinition>;
}) {
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<McpToolInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState<McpToolRules>(server.toolRules ?? {});

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listTools({ name: server.name });
      setTools(res.tools);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setError(raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !tools && !loading) void load();
  };

  const change = async (tool: string, value: McpToolAction | "") => {
    setError(null);
    try {
      const saved = await setToolRule({ name: server.name, tool, action: value || null });
      setRules(saved.toolRules ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const ruleCount = Object.keys(rules).length;
  return (
    <div className={own.toolsWrap} data-mcp-tools={server.name}>
      <button
        type="button"
        className={styles.ghostBtn}
        aria-expanded={open}
        aria-label={`Tools for ${server.name}`}
        onClick={toggle}
      >
        {open ? "Hide tools" : ruleCount ? `Tools · ${ruleCount} rule${ruleCount === 1 ? "" : "s"}` : "Tools"}
      </button>
      {open && (
        <div className={own.tools}>
          {loading && <span className={own.status}>Connecting to {server.name}…</span>}
          {error && (
            <span className={own.status} data-state="error" role="alert">
              {error}{" "}
              <button type="button" className={styles.ghostBtn} onClick={() => void load()}>
                Retry
              </button>
            </span>
          )}
          {tools && tools.length === 0 && <span className={own.status}>This server has no tools.</span>}
          {tools?.map((t) => (
            <div key={t.name} className={own.toolRow} data-mcp-tool={t.name}>
              <span className={own.toolName} title={t.description || t.name}>
                {t.name}
              </span>
              <select
                className={own.toolSelect}
                aria-label={`Rule for ${t.name}`}
                value={rules[t.name] ?? ""}
                onChange={(e) => void change(t.name, e.target.value as McpToolAction | "")}
              >
                {TOOL_ACTIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {tools && tools.length > 0 && (
            <span className={own.status}>
              Claude enforces allow, ask and deny. Codex and OpenCode hide denied tools.
              Other agents: best effort.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
