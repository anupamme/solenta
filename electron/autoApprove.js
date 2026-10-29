"use strict";

/**
 * Granular auto-approve toggles (#1721), after Cline's. Not an engine: the
 * matrix compiles to `allow` rules with source "autoApprove" that ride the
 * governance matrix next to profile and MCP rules, so deny still wins and a
 * per-tool MCP deny or a profile ask beats any toggle. Toggles only ever
 * add allows; a toggle that is off means the call asks as before.
 *
 * Twin of src/autoApprove.ts (toggle ids, labels, parents). Keep in lockstep.
 */

const { WRITE_TOOLS } = require("./guardrails.js");
const { isSafeCommand, parseArgv } = require("./safeCommands.js");

/** id -> label. Order is the UI order. */
const LABELS = {
  readProject: "Read project files",
  readAll: "Read all files",
  editProject: "Edit project files",
  editAll: "Edit all files",
  safeCommands: "Run safe commands",
  allCommands: "Run all commands",
  web: "Browser / web fetch",
  mcp: "MCP tools",
  notify: "Notify when an approval is needed",
};

/** A child toggle only counts while its parent is on. */
const PARENT = {
  readAll: "readProject",
  editAll: "editProject",
  allCommands: "safeCommands",
};

const READ_TOOLS = new Set(["read", "glob", "grep", "ls", "notebookread"]);
const SHELL_TOOLS = new Set(["bash", "shell", "run_command", "exec_command"]);
const WEB_TOOLS = new Set(["webfetch", "websearch"]);
const WRITE = new Set([...WRITE_TOOLS].map((t) => t.toLowerCase()));

/**
 * Stored shape: every id a boolean, children forced off under an off parent.
 * Anything that is not a plain object is "no matrix" (null).
 * @param {unknown} raw
 * @returns {Record<keyof typeof LABELS, boolean> | null}
 */
function normalizeAutoApprove(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = /** @type {Record<string, unknown>} */ (raw);
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const id of Object.keys(LABELS)) out[id] = rec[id] === true;
  // Notify defaults on: absent keeps today's "waiting" notification.
  out.notify = rec.notify !== false;
  for (const [child, parent] of Object.entries(PARENT)) {
    if (!out[parent]) out[child] = false;
  }
  return /** @type {Record<keyof typeof LABELS, boolean>} */ (out);
}

/**
 * Canonical path inside the worktree: realpath of the root, the target
 * through governance's canonicalizer (symlinks and `..` resolved). Anything
 * that cannot be canonicalized is outside.
 * @param {string | null} target
 * @param {string | null | undefined} worktreePath
 */
function inProject(target, worktreePath) {
  if (!worktreePath) return false;
  // Lazy: governance requires this module.
  const { normalizePath } = require("./governance.js");
  try {
    const root = normalizePath(worktreePath, null);
    const p = target ? normalizePath(target, worktreePath) : root;
    return p === root || p.startsWith(`${root.replace(/\/$/, "")}/`);
  } catch {
    return false;
  }
}

/** @param {Record<string, unknown>} input */
function inputPath(input) {
  for (const k of ["file_path", "path", "notebook_path", "filePath"]) {
    if (typeof input[k] === "string" && input[k]) return input[k];
  }
  return null;
}

/** Absolute, `~`, a drive letter, or a `..` segment: can leave the search root. */
const ESCAPING_GLOB = /^[/~\\]|^[A-Za-z]:|(^|[/\\])\.\.([/\\]|$)/;

/**
 * Read inside the project. A missing path is the cwd, which is the
 * worktree. Glob's `pattern` and Grep's `glob` are paths too (Grep's
 * `pattern` is a regex).
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @param {string | null | undefined} worktreePath
 */
function readsProject(tool, input, worktreePath) {
  const g = tool === "glob" ? input.pattern : tool === "grep" ? input.glob : null;
  if (typeof g === "string" && ESCAPING_GLOB.test(g)) return false;
  return inProject(inputPath(input), worktreePath);
}

/**
 * A write under `.git/`. Never "project" edits: `.git/config` can set
 * core.fsmonitor / a pager / a diff driver, which a "safe" git command then runs.
 * @param {string} target
 */
function touchesGitDir(target) {
  return /(^|[/\\])\.git([/\\]|$)/.test(String(target));
}

/**
 * Every argument of a safe command (and every `--flag=value` value)
 * resolves inside the project, symlinks followed. A plain word (a search
 * pattern) resolves to a spot under the root, so it passes. Without this,
 * "Run safe commands" alone would auto-approve `cat ~/.ssh/id_rsa` or
 * `cat link-out/secret` with "Read all files" off.
 * @param {unknown} command
 * @param {string | null} worktreePath
 */
function argsStayInProject(command, worktreePath) {
  const argv = parseArgv(String(command));
  // Unparseable here means it passed as an exact user-configured command.
  if (!argv) return true;
  for (const arg of argv.slice(1)) {
    const value = arg.startsWith("-") ? (arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "") : arg;
    if (!value) continue;
    const expanded = value.startsWith("~") ? require("node:os").homedir() + value.slice(1) : value;
    if (!inProject(expanded, worktreePath)) return false;
  }
  return true;
}

/**
 * @typedef {{ tool: string, input: Record<string, unknown>, worktreePath: string | null | undefined, known: string[] }} RuleCtx
 */

/**
 * The rules a matrix compiles to. `test` is the matcher; governance runs it
 * in place of the glob for these rules only.
 * @param {unknown} raw
 * @param {{ known?: Array<string | null | undefined>, root?: string | null }} [opts]
 *   known: the project's own commands; root: the project folder when the
 *   call carries no worktree path
 * @returns {Array<{ kind: "autoApprove", match: string, action: "allow", source: "autoApprove", label: string, test: (ctx: RuleCtx) => boolean }>}
 */
function autoApproveRules(raw, opts = {}) {
  const m = normalizeAutoApprove(raw);
  if (!m) return [];
  const known = (opts.known || []).filter((k) => typeof k === "string" && k.trim());
  const flat = (/** @type {unknown} */ s) => String(s).replace(/\s+/g, " ").trim();
  const isKnown = (/** @type {unknown} */ cmd) => known.some((k) => flat(k) === flat(cmd));
  /** @param {RuleCtx} c */
  const root = (c) => c.worktreePath || opts.root || null;
  /** @type {Record<string, (ctx: RuleCtx) => boolean>} */
  const tests = {
    readProject: (c) => READ_TOOLS.has(c.tool) && readsProject(c.tool, c.input, root(c)),
    readAll: (c) => READ_TOOLS.has(c.tool),
    editProject: (c) =>
      WRITE.has(c.tool) &&
      Boolean(inputPath(c.input)) &&
      !touchesGitDir(/** @type {string} */ (inputPath(c.input))) &&
      inProject(inputPath(c.input), root(c)),
    editAll: (c) => WRITE.has(c.tool) && Boolean(inputPath(c.input)),
    safeCommands: (c) =>
      SHELL_TOOLS.has(c.tool) &&
      isSafeCommand(c.input.command, known) &&
      // The user's own commands (exact text) are theirs to scope.
      (isKnown(c.input.command) || m.readAll || argsStayInProject(c.input.command, root(c))),
    allCommands: (c) => SHELL_TOOLS.has(c.tool),
    web: (c) => WEB_TOOLS.has(c.tool),
    mcp: (c) => c.tool.startsWith("mcp__"),
  };
  return Object.keys(tests)
    .filter((id) => m[id])
    .map((id) => ({
      kind: "autoApprove",
      match: id,
      action: "allow",
      source: "autoApprove",
      label: LABELS[id],
      test: tests[id],
    }));
}

module.exports = {
  AUTO_APPROVE_LABELS: LABELS,
  normalizeAutoApprove,
  autoApproveRules,
  inProject,
  argsStayInProject,
  touchesGitDir,
};
