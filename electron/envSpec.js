"use strict";

/**
 * The repo's existing environment spec (#396), read so a new worktree is
 * provisioned the way the repo already says it should be:
 *
 *   .devcontainer/devcontainer.json, .devcontainer.json
 *     onCreateCommand + updateContentCommand + postCreateCommand → setup
 *     containerEnv + remoteEnv → env
 *   .github/workflows/copilot-setup-steps.yml
 *     the copilot-setup-steps job's `run:` steps → setup (`uses:` steps
 *     need GitHub's runner and are skipped), workflow + job `env:` → env
 *
 * Commands run on the host in the worktree, not in a container. The spec
 * only fills gaps: a project setting or a solenta.json `setup` wins
 * (repoConfig.js), and everything here sits under the same approval hash
 * as solenta.json, so an edit to the spec re-prompts before it runs.
 *
 * ponytail: Dockerfile and .flox/ are not honoured; running the agent in a
 * container or under `flox activate` is its own feature. direnv's
 * `use flox` already covers flox users today (direnvEnv.js).
 */

const fs = require("node:fs");
const path = require("node:path");

const DEVCONTAINER_FILES = [".devcontainer/devcontainer.json", ".devcontainer.json"];
const COPILOT_FILE = ".github/workflows/copilot-setup-steps.yml";
const COPILOT_JOB = "copilot-setup-steps";
const DEVCONTAINER_STAGES = ["onCreateCommand", "updateContentCommand", "postCreateCommand"];
const MAX_BYTES = 256 * 1024;
/** Joined steps outgrow the 500-char settings cap; past this, refuse rather than cut. */
const SPEC_SETUP_MAX = 8000;

/** @type {Map<string, { key: string, spec: EnvSpec | null }>} */
const cache = new Map();

/**
 * @typedef {{ file: string, setup?: string, env?: Record<string, string>, error?: string }} EnvSpec
 */

/** @param {string} s */
function shQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * devcontainer variables, rewritten for a host shell whose cwd is the
 * worktree: the workspace folder is `.`, ${localEnv:X:d} is ${X:-d}.
 * @param {string} cmd
 */
function hostCommand(cmd) {
  return cmd
    .replace(/\$\{(?:containerWorkspaceFolder|localWorkspaceFolder)\}/g, ".")
    .replace(/\$\{(?:localEnv|containerEnv):([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g, (_m, name, def) =>
      def === undefined ? `\${${name}}` : `\${${name}:-${def}}`,
    );
}

/**
 * One exec-form argument as a shell word. Only the devcontainer variables
 * may expand; any other `$` stays literal, as it would without a shell.
 * @param {string} arg
 */
function execArg(arg) {
  if (!arg.includes("$")) return shQuote(arg);
  const escaped = arg
    .replace(/["\\`]/g, "\\$&")
    .replace(/\$(?!\{(?:containerWorkspaceFolder|localWorkspaceFolder|localEnv:|containerEnv:))/g, "\\$");
  return `"${hostCommand(escaped)}"`;
}

/**
 * Same variables in an env value, resolved at spawn time against `cwd`
 * and the app's own environment. Unknown ${...} stay literal.
 * @param {Record<string, string> | undefined} env
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [base]
 */
function resolveSpecEnv(env, cwd, base = process.env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    out[k] = v
      .replace(/\$\{(?:containerWorkspaceFolder|localWorkspaceFolder)\}/g, cwd)
      .replace(/\$\{(?:localEnv|containerEnv):([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g, (_m, name, def) =>
        base[name] ?? def ?? "",
      );
  }
  return out;
}

const TRAILING = /\s*[}\]]/y;

/**
 * devcontainer.json is JSONC: drop comments and trailing commas, both
 * outside strings only.
 * @param {string} text
 */
function stripJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const m = end.exec(text);
      const str = m ? m[0] : text.slice(i);
      out += str;
      i += str.length - 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      TRAILING.lastIndex = i + 1;
      if (c !== "," || !TRAILING.test(text)) out += c;
    }
  }
  return out;
}

/**
 * A lifecycle command: string (shell), array (exec form), or object of
 * named commands devcontainers run in parallel; here they run in order.
 * @param {unknown} v
 * @returns {string | null}
 */
function lifecycleCommand(v) {
  if (typeof v === "string") return hostCommand(v.trim()) || null;
  if (Array.isArray(v)) {
    return v.length && v.every((s) => typeof s === "string") ? v.map(execArg).join(" ") : null;
  }
  if (v && typeof v === "object") {
    const parts = Object.values(v).map(lifecycleCommand).filter(Boolean);
    return parts.length ? parts.join(" && ") : null;
  }
  return null;
}

/**
 * String-valued entries with a valid name; PATH is dropped later with
 * project env (normalizeProjectEnv).
 * @param {...unknown} maps
 */
function stringEnv(...maps) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const m of maps) {
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    }
  }
  return out;
}

/**
 * @param {string} text
 * @param {string} file
 * @returns {EnvSpec}
 */
function parseDevcontainer(text, file) {
  let data;
  try {
    // Two passes: `, // x\n}` only reads as trailing once the comment is gone.
    data = JSON.parse(stripJsonc(stripJsonc(text)));
  } catch {
    return { file, error: `${file} is not valid JSON` };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { file, error: `${file} must be a JSON object` };
  }
  const cmds = DEVCONTAINER_STAGES.map((k) => lifecycleCommand(data[k])).filter(Boolean);
  return finish(file, cmds.join(" && "), stringEnv(data.containerEnv, data.remoteEnv));
}

/**
 * The slice of YAML GitHub workflows use: block maps, `- ` sequences,
 * plain/quoted scalars, `|` and `>` block scalars, # comments. Flow
 * collections come back as their raw text. Anything it cannot place
 * throws, so a misread never silently drops a step.
 * @param {string} text
 */
function parseYamlSubset(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  const blank = (/** @type {string} */ l) => /^\s*(#.*)?$/.test(l);
  const indentOf = (/** @type {string} */ l) => /** @type {RegExpMatchArray} */ (l.match(/^ */))[0].length;
  const skip = () => {
    while (i < lines.length && blank(lines[i])) i++;
  };
  const isItem = (/** @type {number} */ ind) =>
    i < lines.length && indentOf(lines[i]) === ind && /^-( |$)/.test(lines[i].slice(ind));

  /** @param {string} s */
  const scalar = (s) => {
    s = s.trim();
    const dq = s.match(/^"((?:[^"\\]|\\.)*)"/);
    if (dq) {
      try {
        return JSON.parse(`"${dq[1]}"`);
      } catch {
        return dq[1];
      }
    }
    const sq = s.match(/^'((?:[^']|'')*)'/);
    if (sq) return sq[1].replace(/''/g, "'");
    return s.replace(/\s+#.*$/, "");
  };

  /** @param {number} parent @param {string} style */
  const blockScalar = (parent, style) => {
    const body = [];
    while (i < lines.length && (!lines[i].trim() || indentOf(lines[i]) > parent)) body.push(lines[i++]);
    const first = body.find((l) => l.trim());
    const ind = first ? indentOf(first) : 0;
    const rows = body.map((l) => l.slice(ind));
    while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
    return style === ">" ? rows.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ") : rows.join("\n");
  };

  /** @param {number} min */
  const node = (min) => {
    skip();
    if (i >= lines.length || indentOf(lines[i]) < min) return null;
    const ind = indentOf(lines[i]);
    return isItem(ind) ? seq(ind) : map(ind);
  };

  /** @param {number} ind */
  const seq = (ind) => {
    const out = [];
    for (skip(); isItem(ind); skip()) {
      const rest = lines[i].slice(ind + 1);
      if (!rest.trim()) {
        i++;
        out.push(node(ind + 1));
        continue;
      }
      // `- key: v` → the item's map starts where `key` sits.
      const pad = indentOf(rest);
      lines[i] = " ".repeat(ind + 1 + pad) + rest.slice(pad);
      out.push(node(ind + 1));
    }
    return out;
  };

  /** @param {number} ind */
  const map = (ind) => {
    /** @type {Record<string, unknown>} */
    const out = {};
    let keys = 0;
    for (skip(); i < lines.length && indentOf(lines[i]) === ind && !isItem(ind); skip()) {
      const line = lines[i].slice(ind);
      const m = line.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s:#'"][^:#]*?)\s*:(?:\s+(.*))?$/);
      if (!m) {
        if (keys) throw new Error(`unsupported YAML at line ${i + 1}`);
        i++;
        return scalar(line);
      }
      keys++;
      i++;
      const key = String(scalar(m[1]));
      const rest = (m[2] || "").trim();
      if (/^[|>][+-]?\d*(\s+#.*)?$/.test(rest)) out[key] = blockScalar(ind, rest[0]);
      else if (rest && !rest.startsWith("#")) out[key] = scalar(rest);
      else {
        const child = node(ind + 1);
        skip();
        out[key] = child === null && isItem(ind) ? seq(ind) : child;
      }
    }
    return out;
  };

  const doc = node(0);
  skip();
  if (i < lines.length) throw new Error(`unsupported YAML at line ${i + 1}`);
  return doc;
}

/**
 * @param {string} text
 * @param {string} file
 * @returns {EnvSpec}
 */
function parseCopilotSetupSteps(text, file) {
  /** @type {any} */
  let doc;
  try {
    doc = parseYamlSubset(text);
  } catch (err) {
    return { file, error: `${file}: ${/** @type {Error} */ (err).message}` };
  }
  const job = doc && doc.jobs && doc.jobs[COPILOT_JOB];
  if (!job || !Array.isArray(job.steps)) {
    return { file, error: `${file}: no ${COPILOT_JOB} job with steps` };
  }
  const cmds = [];
  for (const step of job.steps) {
    if (!step || typeof step.run !== "string" || !step.run.trim()) continue;
    if (step.shell && !/^(bash|sh)\b/.test(step.shell)) continue;
    const wd = typeof step["working-directory"] === "string" ? step["working-directory"] : "";
    cmds.push(wd ? `(\ncd ${shQuote(wd)}\n${step.run.trim()}\n)` : step.run.trim());
  }
  // `${{ }}` needs GitHub's expression engine; those values are dropped.
  const env = Object.fromEntries(
    Object.entries(stringEnv(doc.env, job.env)).filter(([, v]) => !v.includes("${{")),
  );
  // Actions runs each step under `bash -e`; one script keeps that.
  return finish(file, cmds.length ? `set -e\n${cmds.join("\n")}` : "", env);
}

/**
 * @param {string} file
 * @param {string} setup
 * @param {Record<string, string>} env
 * @returns {EnvSpec}
 */
function finish(file, setup, env) {
  if (setup.length > SPEC_SETUP_MAX) {
    return { file, error: `${file}: setup is longer than ${SPEC_SETUP_MAX} characters` };
  }
  return {
    file,
    ...(setup ? { setup } : {}),
    ...(Object.keys(env).length ? { env } : {}),
  };
}

/**
 * The first spec present under `root`, cached on mtime+size. A spec
 * that yields neither setup nor env still counts (devcontainer with only
 * an image), so the next one down is not consulted.
 * @param {string | null | undefined} root
 * @returns {EnvSpec | null}
 */
function readEnvSpec(root) {
  if (!root || typeof root !== "string") return null;
  for (const rel of [...DEVCONTAINER_FILES, COPILOT_FILE]) {
    const abs = path.join(root, rel);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = cache.get(abs);
    if (hit && hit.key === key) return hit.spec;
    /** @type {EnvSpec} */
    let spec;
    if (st.size > MAX_BYTES) spec = { file: rel, error: `${rel} is larger than 256 KB` };
    else {
      const text = fs.readFileSync(abs, "utf8");
      spec = rel === COPILOT_FILE ? parseCopilotSetupSteps(text, rel) : parseDevcontainer(text, rel);
    }
    cache.set(abs, { key, spec });
    return spec;
  }
  return null;
}

module.exports = {
  SPEC_SETUP_MAX,
  readEnvSpec,
  resolveSpecEnv,
  parseDevcontainer,
  parseCopilotSetupSteps,
  parseYamlSubset,
  stripJsonc,
};
