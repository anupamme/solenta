"use strict";

/**
 * #396 setup cache: a new worktree whose lockfile matches the main
 * checkout's starts with a clone of its node_modules, then setup runs.
 * Run: node --test electron/test/setup-cache.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  waitForCommand,
  setRunCommandFn,
  setCloneDirFn,
  kickWorktreeSetup,
} = require("../projectCommands.js");

function events(store, threadId) {
  return (store.getMessages(threadId) || [])
    .filter((m) => m.role === "event")
    .map((m) => String(m.text));
}

describe("setup cache (#396)", () => {
  let tmpDir;
  let store;
  let thread;
  let project;
  let repo;
  let cwd;
  /** node_modules/marker as setup saw it, or null */
  let seen;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-setupcache-"));
    store = new Store(path.join(tmpDir, "store.json"));
    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "package-lock.json"), '{"v":1}\n');
    fs.mkdirSync(path.join(repo, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "marker"), "main\n");
    fs.symlinkSync("../marker", path.join(repo, "node_modules", ".bin", "m"));
    project = await services.addProject(store, repo);
    services.updateProject(store, project.id, { setupCommand: "npm install" });
    thread = services.createThread(store, { projectId: project.id, title: "C" });
    cwd = path.join(tmpDir, "wt");
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, "package-lock.json"), '{"v":1}\n');
    seen = null;
    setRunCommandFn(async (input) => {
      try {
        seen = fs.readFileSync(path.join(input.cwd, "node_modules", "marker"), "utf8");
      } catch {
        seen = null;
      }
      return { ok: true, exitCode: 0, timedOut: false, log: "", durationMs: 1 };
    });
    // Real `cp -Rc` on macOS; elsewhere a plain copy stands in for it.
    if (process.platform !== "darwin") {
      setCloneDirFn(async (src, dest) => fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true }));
    }
  });

  afterEach(async () => {
    await waitForCommand(thread.id);
    setRunCommandFn(null);
    setCloneDirFn(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const kick = () =>
    kickWorktreeSetup({ store, threadId: thread.id, cwd, project: store.getProject(project.id) });

  it("clones node_modules before setup when the lockfile matches", async () => {
    const result = await kick();
    assert.equal(result.ok, true);
    assert.equal(seen, "main\n", "setup ran on top of the clone");
    assert.equal(fs.readlinkSync(path.join(cwd, "node_modules", ".bin", "m")), "../marker");
    const ev = events(store, thread.id);
    assert.ok(ev.some((t) => /^\[setup\] reused node_modules from the main checkout \(package-lock\.json [0-9a-f]{8}\)/.test(t)), ev.join("\n"));
    assert.ok(ev.some((t) => /^\[setup\] ok/.test(t)));
  });

  it("runs a plain setup when the lockfile differs", async () => {
    fs.writeFileSync(path.join(cwd, "package-lock.json"), '{"v":2}\n');
    await kick();
    assert.equal(seen, null);
    assert.ok(!events(store, thread.id).some((t) => /reused|cache miss/.test(t)));
  });

  it("leaves an existing node_modules alone", async () => {
    fs.mkdirSync(path.join(cwd, "node_modules"));
    fs.writeFileSync(path.join(cwd, "node_modules", "marker"), "mine\n");
    await kick();
    assert.equal(seen, "mine\n");
  });

  it("is opt-out per project", async () => {
    services.updateProject(store, project.id, { setupCacheOff: true });
    assert.equal(store.getProject(project.id).setupCacheOff, true);
    await kick();
    assert.equal(seen, null);
    services.updateProject(store, project.id, { setupCacheOff: false });
    assert.equal("setupCacheOff" in store.getProject(project.id), false);
  });

  it("a failed clone is cleaned up and setup still runs", async () => {
    setCloneDirFn(async (_src, dest) => {
      fs.mkdirSync(dest);
      fs.writeFileSync(path.join(dest, "marker"), "partial\n");
      throw new Error("cp: clonefile failed: Operation not supported");
    });
    const result = await kick();
    assert.equal(result.ok, true);
    assert.equal(seen, null, "partial copy removed before setup");
    const ev = events(store, thread.id);
    assert.ok(ev.some((t) => /^\[setup\] cache miss: could not clone node_modules \(cp: clonefile failed/.test(t)));
  });
});
