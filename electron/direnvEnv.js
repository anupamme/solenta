"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

/**
 * direnv for agent spawns (#320): the env `cd <worktree>` would load in the
 * user's terminal (.envrc, `use flake`, `use nix`, ...). The runner awaits
 * loadDirenv(cwd) before dispatch; withProjectEnv reads the result
 * synchronously through direnvEnv(cwd). No direnv on PATH, no .envrc, or a
 * blocked .envrc all mean "nothing to add", never a failed run.
 */

// A cold `use flake` evaluates the whole devShell; later loads hit
// nix-direnv's cache. Past this the agent starts without the env.
const DIRENV_TIMEOUT_MS = 60_000;

/** @type {Map<string, Record<string, string | undefined>>} */
const loaded = new Map();

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ err: (Error & { code?: unknown }) | null, stdout: string, stderr: string }>}
 */
function direnv(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      "direnv",
      args,
      { cwd, env: process.env, encoding: "utf8", timeout: DIRENV_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") }),
    );
  });
}

/**
 * True when direnv has an allow record for this exact .envrc path + content
 * (same sha256(path + "\n" + bytes) as direnv's fileHash; direnv sees the
 * symlink-resolved path, e.g. /private/tmp, so hash that one).
 *
 * @param {string} file absolute .envrc path
 * @param {NodeJS.ProcessEnv} env
 */
function envrcAllowed(file, env = process.env) {
  try {
    const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    const hash = crypto
      .createHash("sha256")
      .update(`${fs.realpathSync(file)}\n`)
      .update(fs.readFileSync(file))
      .digest("hex");
    return fs.existsSync(path.join(dataHome, "direnv", "allow", hash));
  } catch {
    return false;
  }
}

/**
 * A worktree is a new path, so direnv blocks its .envrc even when the user
 * allowed the very same file in the main checkout. Carry that decision over
 * only for byte-identical content; an .envrc the branch changed stays blocked.
 *
 * @param {string} cwd
 * @param {string} mainPath
 */
function inheritsAllow(cwd, mainPath) {
  if (!mainPath || path.resolve(mainPath) === path.resolve(cwd)) return false;
  const mainRc = path.join(path.resolve(mainPath), ".envrc");
  try {
    const same = fs
      .readFileSync(path.join(cwd, ".envrc"))
      .equals(fs.readFileSync(mainRc));
    return same && envrcAllowed(mainRc);
  } catch {
    return false;
  }
}

/**
 * Re-run direnv for `cwd` and cache the result. Called once per run start, so
 * an edited .envrc is picked up next turn. Never rejects.
 *
 * @param {string} cwd
 * @param {{ mainPath?: string, platform?: NodeJS.Platform }} [opts]
 */
async function loadDirenv(cwd, opts = {}) {
  if (!cwd || (opts.platform || process.platform) === "win32") return;
  try {
    // ENOENT (direnv not installed) lands in the r.err branch below.
    let r = await direnv(cwd, ["export", "json"]);
    if (/is blocked/.test(r.stderr) && inheritsAllow(cwd, opts.mainPath || "")) {
      await direnv(cwd, ["allow", "."]);
      r = await direnv(cwd, ["export", "json"]);
    }
    if (r.err || !r.stdout.trim()) {
      loaded.delete(cwd);
      return;
    }
    /** @type {Record<string, string | undefined>} */
    const env = {};
    // null = direnv unsets it; undefined makes child_process drop the key.
    for (const [k, v] of Object.entries(JSON.parse(r.stdout))) {
      env[k] = typeof v === "string" ? v : undefined;
    }
    loaded.set(cwd, env);
  } catch {
    loaded.delete(cwd);
  }
}

/**
 * The last loadDirenv result for `cwd`, or undefined.
 * @param {string | null | undefined} cwd
 */
function direnvEnv(cwd) {
  return cwd ? loaded.get(cwd) : undefined;
}

module.exports = { loadDirenv, direnvEnv, envrcAllowed, inheritsAllow, DIRENV_TIMEOUT_MS };
