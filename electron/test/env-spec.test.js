"use strict";

/**
 * #396: the repo's own env spec (devcontainer.json, copilot-setup-steps.yml)
 * provisions worktrees when solenta.json / project settings do not, under
 * the same approval hash.
 * Run: node --test electron/test/env-spec.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  readEnvSpec,
  resolveSpecEnv,
  parseDevcontainer,
  parseCopilotSetupSteps,
} = require("../envSpec.js");
const { effectiveCommands, presentRepoConfig } = require("../repoConfig.js");
const { projectEnvFor } = require("../worktreeEnv.js");

const COPILOT = `name: "Copilot Setup Steps"
on:
  workflow_dispatch:
  push:
    paths:
      - .github/workflows/copilot-setup-steps.yml
env:
  CI: true
  TOKEN: \${{ secrets.TOKEN }}
jobs:
  copilot-setup-steps:
    runs-on: ubuntu-latest
    env:
      NODE_ENV: "test" # trailing comment
    steps:
      - name: Checkout code
        uses: actions/checkout@v5
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - name: Install
        run: npm ci
      - name: Build docs
        working-directory: docs site
        run: |
          echo 'a # not a comment'
          make html
      - name: Python only
        shell: python
        run: print("skip")
      - run: >
          echo folded
          line
`;

describe("devcontainer.json", () => {
  it("reads JSONC lifecycle commands in order, rewritten for the host", () => {
    const spec = parseDevcontainer(
      `{
        // comment
        "image": "mcr.microsoft.com/devcontainers/javascript-node", /* block */
        "postCreateCommand": ["bash", "\${containerWorkspaceFolder}/setup.sh", "it's"],
        "onCreateCommand": "echo http://x // not a comment",
        "updateContentCommand": { "deps": "npm ci", "tools": "make tools", },
        "containerEnv": { "API": "http://localhost", "PORT": 3001, },
        "remoteEnv": { "HOME_COPY": "\${localEnv:HOME}", "PATH": "\${containerEnv:PATH}:/x" },
      }`,
      ".devcontainer/devcontainer.json",
    );
    assert.equal(
      spec.setup,
      "echo http://x // not a comment && npm ci && make tools && bash \"./setup.sh\" 'it'\\''s'",
    );
    assert.deepEqual(spec.env, {
      API: "http://localhost",
      PORT: "3001",
      HOME_COPY: "${localEnv:HOME}",
      PATH: "${containerEnv:PATH}:/x",
    });
  });

  it("maps ${localEnv:X:default} to shell expansion", () => {
    const spec = parseDevcontainer(
      `{ "postCreateCommand": "echo \${localEnv:FOO:bar} \${localEnv:BAZ}" }`,
      ".devcontainer.json",
    );
    assert.equal(spec.setup, "echo ${FOO:-bar} ${BAZ}");
  });

  it("exec-form args expand only devcontainer variables", () => {
    const spec = parseDevcontainer(
      `{ "postCreateCommand": ["echo", "$HOME \\"q\\"", "\${localEnv:FOO}/x"] }`,
      ".devcontainer.json",
    );
    assert.equal(spec.setup, 'echo "\\$HOME \\"q\\"" "${FOO}/x"');
  });

  it("invalid JSON is an error, an image-only file declares nothing", () => {
    assert.match(parseDevcontainer("{ nope", "x.json").error, /not valid JSON/);
    assert.deepEqual(parseDevcontainer(`{ "image": "node" }`, "x.json"), { file: "x.json" });
  });

  it("resolves env variables at spawn time against the worktree", () => {
    assert.deepEqual(
      resolveSpecEnv(
        { A: "${containerWorkspaceFolder}/bin", B: "${localEnv:HOME}", C: "${localEnv:NOPE:dflt}", D: "${other}" },
        "/wt",
        { HOME: "/home/me" },
      ),
      { A: "/wt/bin", B: "/home/me", C: "dflt", D: "${other}" },
    );
  });
});

describe("copilot-setup-steps.yml", () => {
  it("runs the job's run steps under set -e and skips uses/non-sh steps", () => {
    const spec = parseCopilotSetupSteps(COPILOT, ".github/workflows/copilot-setup-steps.yml");
    assert.equal(
      spec.setup,
      [
        "set -e",
        "npm ci",
        "(",
        "cd 'docs site'",
        "echo 'a # not a comment'",
        "make html",
        ")",
        "echo folded line",
      ].join("\n"),
    );
    // ${{ }} needs GitHub's expression engine, so TOKEN is dropped.
    assert.deepEqual(spec.env, { CI: "true", NODE_ENV: "test" });
  });

  it("a file without the job is an error, not an empty setup", () => {
    const spec = parseCopilotSetupSteps("jobs:\n  build:\n    steps: []\n", "f.yml");
    assert.match(spec.error, /no copilot-setup-steps job/);
  });

  it("YAML it cannot place is an error, never a silently shorter script", () => {
    const spec = parseCopilotSetupSteps(
      "jobs:\n  copilot-setup-steps:\n    steps:\n      - run: a\n   odd: 1\n",
      "f.yml",
    );
    assert.match(spec.error, /unsupported YAML/);
  });
});

describe("env spec in the repo config", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-spec-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
    // Same-size rewrites inside one mtime tick would hit the cache.
    const t = new Date(Date.now() + Math.random() * 1e6);
    fs.utimesSync(path.join(dir, rel), t, t);
  };

  it("devcontainer wins over copilot-setup-steps", () => {
    write(".github/workflows/copilot-setup-steps.yml", COPILOT);
    write(".devcontainer/devcontainer.json", `{ "postCreateCommand": "npm ci" }`);
    assert.equal(readEnvSpec(dir).file, ".devcontainer/devcontainer.json");
  });

  it("fills setup when solenta.json has none; solenta.json setup and project settings win", () => {
    write(".devcontainer/devcontainer.json", `{ "postCreateCommand": "npm ci", "containerEnv": { "A": "1" } }`);
    const project = { path: dir };
    let eff = effectiveCommands(project);
    assert.deepEqual(eff.setup, { command: "npm ci", fromRepo: true, source: ".devcontainer/devcontainer.json" });
    assert.equal(eff.trusted, false);
    assert.deepEqual(presentRepoConfig(project).sources, [".devcontainer/devcontainer.json"]);

    write("solenta.json", JSON.stringify({ quickActions: [{ name: "T", command: "npm test" }] }));
    assert.deepEqual(presentRepoConfig(project).sources, ["solenta.json", ".devcontainer/devcontainer.json"]);
    assert.equal(effectiveCommands(project).setup.command, "npm ci");

    write("solenta.json", JSON.stringify({ setup: "pnpm i" }));
    eff = effectiveCommands(project);
    assert.deepEqual(eff.setup, { command: "pnpm i", fromRepo: true, source: "solenta.json" });
    // The spec's env still rides along.
    assert.deepEqual(eff.env, { A: "1" });

    fs.rmSync(path.join(dir, "solenta.json"));
    write("solenta.local.json", JSON.stringify({ setup: "yarn" }));
    eff = effectiveCommands(project);
    assert.deepEqual(eff.setup, { command: "yarn", fromRepo: true, source: "solenta.local.json" });

    eff = effectiveCommands({ ...project, setupCommand: "make" });
    assert.deepEqual(eff.setup, { command: "make", fromRepo: false });
  });

  it("an edit to the spec re-prompts; env only applies once approved", () => {
    write(".devcontainer.json", `{ "postCreateCommand": "npm ci", "containerEnv": { "NODE_OPTIONS": "--x", "W": "\${containerWorkspaceFolder}" } }`);
    const project = { path: dir, env: { OWN: "1", W: "own wins" } };
    assert.deepEqual(projectEnvFor(project, "/wt"), { OWN: "1", W: "own wins" });

    const trusted = { ...project, repoConfigTrust: effectiveCommands(project).hash };
    assert.equal(effectiveCommands(trusted).trusted, true);
    assert.deepEqual(projectEnvFor(trusted, "/wt"), { NODE_OPTIONS: "--x", W: "own wins", OWN: "1" });

    write(".devcontainer.json", `{ "postCreateCommand": "npm ci", "containerEnv": { "NODE_OPTIONS": "--require evil" } }`);
    assert.equal(effectiveCommands(trusted).trusted, false);
    assert.deepEqual(projectEnvFor(trusted, "/wt"), { OWN: "1", W: "own wins" });
  });

  it("a broken spec reports only when there is no solenta.json", () => {
    write(".devcontainer.json", "{ nope");
    assert.match(presentRepoConfig({ path: dir }).error, /devcontainer\.json is not valid JSON/);
    write("solenta.json", JSON.stringify({ setup: "npm ci" }));
    assert.equal(presentRepoConfig({ path: dir }).error, undefined);
    assert.equal(effectiveCommands({ path: dir }).setup.command, "npm ci");
  });

  it("remote projects read nothing", () => {
    write(".devcontainer.json", `{ "postCreateCommand": "npm ci" }`);
    assert.equal(effectiveCommands({ path: dir, remoteHost: "box" }).setup, null);
  });
});
