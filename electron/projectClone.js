"use strict";

/**
 * Add project from a URL (#1506 H3): `git clone` into a chosen folder with
 * live progress on "clone:progress" and a cancel, then the usual add.
 *
 * Only https:// and ssh (ssh:// or user@host:path) URLs, plus GitHub
 * `owner/repo` shorthand (#459): other transports (file://, ext::, plain
 * paths) can read local files or run commands. GitHub sources go through
 * `gh repo clone` when gh is signed in, so private repos clone with the
 * user's gh access; otherwise plain `git clone`.
 * The target must be missing, an empty folder, or already a clone of the
 * same repo (then it is just added); whatever this clone created is removed
 * again on failure or cancel.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { expandUserPath } = require("./fsBrowse.js");
const { killTree } = require("./proc.js");
const { gitTryAsync } = require("./worktrees-git.js");
const { ghBin, ghTryAsync, remoteHostOf } = require("./worktrees-pr.js");
const { slugFromRemoteUrl } = require("./services-projects.js");

/** GitHub `owner/repo`; owners never start with a dash, so no flag injection. */
const GITHUB_SHORTHAND = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9._-]+$/;

/** Progress pushes at most this often; git rewrites its line many times a second. */
const PROGRESS_THROTTLE_MS = 100;

/** @type {Map<string, { cancel: () => void }>} */
const active = new Map();

let spawnFn = spawn;

/**
 * Test hook: swap the spawner. Pass null to restore.
 * @param {typeof spawn | null} fn
 */
function setCloneSpawnFn(fn) {
  spawnFn = typeof fn === "function" ? fn : spawn;
}

/**
 * Why `url` is not cloneable here, or null when it is.
 * @param {unknown} url
 * @returns {string | null}
 */
function cloneUrlError(url) {
  const u = typeof url === "string" ? url.trim() : "";
  if (!u) return "Repository URL is required";
  if (/\s/.test(u)) return "Repository URL cannot contain spaces";
  if (/^https:\/\/[^/\s]+\/.+/i.test(u) || /^ssh:\/\/[^/\s]+\/.+/i.test(u)) {
    return null;
  }
  // scp-like ssh: user@host:path. The user part is required so a Windows
  // drive path or a bare "host:path" local name is never taken for ssh.
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/\s].*/.test(u)) return null;
  if (GITHUB_SHORTHAND.test(u)) return null;
  return "Use owner/repo, an https:// URL, or an ssh URL (for example git@github.com:owner/repo.git)";
}

/**
 * Folder name git would pick: last path segment without `.git`.
 * @param {string} url
 */
function repoNameFromUrl(url) {
  const tail = String(url)
    .trim()
    .replace(/[/\\]+$/, "")
    .split(/[/:]/)
    .pop();
  return String(tail || "").replace(/\.git$/i, "");
}

/**
 * `host/owner/repo`, lowercased, to tell whether a checkout is this repo.
 * @param {string} url
 * @returns {string | null}
 */
function repoKey(url) {
  if (GITHUB_SHORTHAND.test(url)) return `github.com/${url}`.toLowerCase();
  const slug = slugFromRemoteUrl(url);
  const host = remoteHostOf(url);
  return slug && host ? `${host.host}/${slug}`.toLowerCase() : null;
}

/** gh is installed and signed in to github.com (local check, no network). */
async function ghSignedIn(cwd) {
  const res = await ghTryAsync(cwd, ["auth", "token", "--hostname", "github.com"], {
    timeout: 10_000,
  });
  return res.ok;
}

/**
 * Last progress line from a stderr chunk ("Receiving objects:  42% ...").
 * @param {string} text
 */
function lastLine(text) {
  const lines = String(text)
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

/**
 * Clone and add. Resolves the added ProjectInfo; rejects with git's last
 * stderr lines on failure, or "Clone cancelled".
 *
 * @param {{
 *   url?: string,
 *   parentDir?: string,
 *   name?: string,
 *   cloneId?: string,
 * }} input
 * @param {{
 *   addProject: (target: string) => Promise<unknown>,
 *   broadcast?: (channel: string, payload: unknown) => void,
 *   ghSignedIn?: (cwd: string) => Promise<boolean>,
 * }} deps
 */
async function cloneProject(input, deps) {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const urlErr = cloneUrlError(url);
  if (urlErr) throw new Error(urlErr);
  const parentDir =
    typeof input.parentDir === "string" ? input.parentDir.trim() : "";
  if (!parentDir) throw new Error("Location is required");
  const name =
    (typeof input.name === "string" && input.name.trim()) ||
    repoNameFromUrl(url);
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) {
    throw new Error("Folder name must be a plain folder name (no slashes)");
  }
  const parent = path.resolve(expandUserPath(parentDir));
  let stat;
  try {
    stat = fs.statSync(parent);
  } catch {
    throw new Error(`Path does not exist: ${parent}`);
  }
  if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${parent}`);

  const target = path.join(parent, name);
  const existed = fs.existsSync(target);
  if (existed) {
    let entries;
    try {
      entries = fs.readdirSync(target);
    } catch {
      throw new Error(`Already exists and is not a folder: ${target}`);
    }
    if (entries.length) {
      // Same repo already checked out here: add it instead of failing.
      // The .git check keeps a plain subfolder of another repo from
      // answering with its parent's origin.
      const origin = fs.existsSync(path.join(target, ".git"))
        ? await gitTryAsync(target, ["remote", "get-url", "origin"])
        : null;
      const want = repoKey(url);
      if (want && origin && origin.ok && repoKey(String(origin.stdout).trim()) === want) {
        return deps.addProject(target);
      }
      throw new Error(`Folder is not empty: ${target}`);
    }
  }

  const shorthand = GITHUB_SHORTHAND.test(url);
  const github =
    shorthand || (remoteHostOf(url) || { host: "" }).host === "github.com";
  const viaGh = github && (await (deps.ghSignedIn || ghSignedIn)(parent));
  const [bin, args] = viaGh
    ? [ghBin(), ["repo", "clone", url, target, "--", "--progress"]]
    : ["git", ["clone", "--progress", "--", shorthand ? `https://github.com/${url}.git` : url, target]];

  const cloneId = typeof input.cloneId === "string" ? input.cloneId : "";
  const broadcast = deps.broadcast;
  const push = (/** @type {Record<string, unknown>} */ extra) => {
    if (cloneId && typeof broadcast === "function") {
      broadcast("clone:progress", { cloneId, ...extra });
    }
  };
  const cleanup = () => {
    try {
      if (existed) {
        for (const e of fs.readdirSync(target)) {
          fs.rmSync(path.join(target, e), { recursive: true, force: true });
        }
      } else {
        fs.rmSync(target, { recursive: true, force: true });
      }
    } catch {
      // best effort: a half clone left behind is visible, not dangerous
    }
  };

  await new Promise((resolve, reject) => {
    const child = spawnFn(bin, args, {
      // No hidden credential prompt: fail fast with git's own message.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let cancelled = false;
    let tail = "";
    let lastPush = 0;
    if (cloneId) {
      active.set(cloneId, {
        cancel() {
          cancelled = true;
          killTree(child, 2000);
        },
      });
    }
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (/** @type {string} */ chunk) => {
      tail = (tail + chunk).slice(-4000);
      const now = Date.now();
      if (now - lastPush < PROGRESS_THROTTLE_MS) return;
      lastPush = now;
      const line = lastLine(chunk);
      if (line) push({ line });
    });
    child.on("error", (err) => {
      if (cloneId) active.delete(cloneId);
      cleanup();
      reject(new Error(`Could not run ${viaGh ? "gh" : "git"}: ${err.message}`));
    });
    child.on("close", (code) => {
      if (cloneId) active.delete(cloneId);
      if (cancelled) {
        cleanup();
        reject(new Error("Clone cancelled"));
      } else if (code !== 0) {
        cleanup();
        const why = tail
          .split(/[\r\n]+/)
          .map((l) => l.trim())
          .filter((l) => l && !/^(Cloning into|remote: (Counting|Compressing|Enumerating))/.test(l))
          .slice(-3)
          .join("\n");
        reject(new Error(why || `${viaGh ? "gh repo" : "git"} clone exited with code ${code}`));
      } else {
        resolve(null);
      }
    });
  });

  push({ line: "Adding project" });
  return deps.addProject(target);
}

/**
 * Stop an in-flight clone. Unknown / finished ids are a no-op.
 * @param {{ cloneId?: string }} input
 */
function cancelClone(input) {
  const id = input && typeof input.cloneId === "string" ? input.cloneId : "";
  const job = active.get(id);
  if (job) job.cancel();
}

module.exports = {
  cloneProject,
  cancelClone,
  cloneUrlError,
  repoNameFromUrl,
  setCloneSpawnFn,
};
