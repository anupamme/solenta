"use strict";

/**
 * Move a project's app-only commands into solenta.json through a PR (#438).
 *
 * A fresh worktree thread starts from origin's default branch. It writes the
 * stored setupCommand / quickActions into solenta.json, keeping every other
 * key and putting "$schema" first. It also adds solenta.local.json to
 * .gitignore, then commits and opens a PR with the regular createPr.
 *
 * Stored settings are left alone. They keep shadowing the file until the
 * user clears them after the PR merges, so nothing changes before review.
 */

const fs = require("node:fs");
const path = require("node:path");
const {
  REPO_CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  SCHEMA_URL,
  parseRepoConfig,
} = require("./repoConfig.js");
const { slugFromName } = require("./automations-file.js");
const { normalizeCommand } = require("./verify.js");

const PR_TITLE = "Move project commands to solenta.json";

/**
 * The app-only commands worth moving, or null when there are none.
 * @param {any} project
 */
function storedCommands(project) {
  const setup = normalizeCommand(project && project.setupCommand);
  const actions = Array.isArray(project && project.quickActions)
    ? project.quickActions.filter((/** @type {any} */ a) => a && a.name && a.command)
    : [];
  if (!setup && !actions.length) return null;
  return { setup, actions };
}

/**
 * solenta.json with the stored commands folded in. Stored values win, the
 * same precedence the app applies today, so the PR changes no behaviour.
 *
 * @param {unknown} existing parsed solenta.json, or undefined
 * @param {{ setup: string | null, actions: Array<{ name: string, command: string }> }} cmds
 */
function migratedDoc(existing, cmds) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? /** @type {Record<string, unknown>} */ ({ ...existing })
      : {};
  delete base.$schema;
  /** @type {Record<string, unknown>} */
  const doc = { $schema: SCHEMA_URL, ...base };
  if (cmds.setup) doc.setup = cmds.setup;
  if (cmds.actions.length) {
    /** @type {string[]} */
    const taken = [];
    doc.quickActions = cmds.actions.map((a) => {
      const id = slugFromName(a.name, taken);
      taken.push(id);
      return { id, name: String(a.name).trim(), command: String(a.command).trim() };
    });
  }
  return doc;
}

/**
 * `.gitignore` text with solenta.local.json listed, or null if it already is.
 * @param {string} text
 */
function ignoredLocal(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(LOCAL_CONFIG_FILE) || lines.includes(`/${LOCAL_CONFIG_FILE}`)) {
    return null;
  }
  const sep = text && !text.endsWith("\n") ? "\n" : "";
  return `${text}${sep}${LOCAL_CONFIG_FILE}\n`;
}

/**
 * @param {import("./store").Store} store
 * @param {{ projectId: string }} input
 * @param {{ worktreeBase: string, broadcast?: (channel: string, payload: unknown) => void }} deps
 * @returns {Promise<{ threadId: string, prUrl: string, prNumber: number }>}
 */
async function moveConfigToRepo(store, input, deps) {
  const project = store.getProject(String((input && input.projectId) || ""));
  if (!project) throw new Error(`Unknown project: ${input && input.projectId}`);
  if (project.remoteHost || require("./wsl.js").wslTarget(project)) {
    throw new Error("Moving settings to solenta.json is not supported for remote projects");
  }
  const cmds = storedCommands(project);
  if (!cmds) throw new Error("This project has no stored setup command or quick actions to move");
  if (!deps || !deps.worktreeBase) throw new Error("worktreeBase is not configured");

  const services = require("./services.js");
  const { setupWorktree } = require("./worktrees.js");
  const { commit } = require("./worktrees-changes.js");
  const { createPr } = require("./worktrees-pr.js");

  const created = services.createThread(store, {
    projectId: project.id,
    title: PR_TITLE,
    projectDefaults: false,
  });
  // Start from origin's default branch, not whatever the checkout is on.
  store.updateThread(created.id, { worktreeFromOrigin: true });
  const thread = setupWorktree({
    store,
    threadId: created.id,
    worktreeBase: deps.worktreeBase,
    broadcast: deps.broadcast,
  });
  const dir = thread.worktreePath;

  const file = path.join(dir, REPO_CONFIG_FILE);
  let existing;
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new Error(`${REPO_CONFIG_FILE} on the default branch is not valid JSON; fix it first`);
    }
  }
  const doc = migratedDoc(existing, cmds);
  const check = parseRepoConfig(doc);
  if (check && check.error) throw new Error(check.error);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  const paths = [REPO_CONFIG_FILE];
  const ignoreFile = path.join(dir, ".gitignore");
  const ignore = ignoredLocal(fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, "utf8") : "");
  if (ignore != null) {
    fs.writeFileSync(ignoreFile, ignore);
    paths.push(".gitignore");
  }

  commit({
    store,
    threadId: created.id,
    message: `${PR_TITLE}\n\nMoved from this project's Solenta settings so the commands are reviewed and shared with the repo.`,
    paths,
  });
  const moved = [
    cmds.setup ? `- setup: \`${cmds.setup}\`` : null,
    ...cmds.actions.map((a) => `- quick action **${a.name}**: \`${a.command}\``),
  ].filter(Boolean);
  const pr = await createPr({
    store,
    threadId: created.id,
    title: PR_TITLE,
    body: [
      "Moves these commands from Solenta's project settings into `solenta.json`, so they are reviewed and shared with everyone who opens the repo:",
      "",
      ...moved,
      "",
      `Also gitignores \`${LOCAL_CONFIG_FILE}\`, the per-checkout override file.`,
      "",
      "After this merges, clear the stored setup command and quick actions in Edit project so the file takes effect.",
    ].join("\n"),
    broadcast: deps.broadcast,
  });
  return { threadId: created.id, prUrl: pr.url, prNumber: pr.number };
}

module.exports = { moveConfigToRepo, migratedDoc, ignoredLocal, storedCommands };
