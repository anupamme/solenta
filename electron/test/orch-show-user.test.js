"use strict";

/**
 * coder-threads `show_user` (#293): an agent points the user at the diff, a
 * file at a line, or the terminal. The host validates the path; the
 * renderer opens the pane from the tool result.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Store } = require("../store.js");
const services = require("../services.js");
const { createToolHandlers } = require("../orchServer.js");

describe("show_user MCP tool (#293)", () => {
  let tmpDir;
  let store;
  let thread;
  let handlers;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-orch-show-"));
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "a.ts"), "one\ntwo\n");
    store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([{ id: "p1", slug: "acme/app", name: "app", path: tmpDir }]);
    thread = services.createThread(store, {
      projectId: "p1",
      title: "Chat",
      provider: "claude",
    });
    store.saveNow();
    handlers = createToolHandlers({
      store,
      runner: { isRunning: () => false },
      forkThread: services.forkThread,
      getProvider: () => ({ id: "claude" }),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const call = (over) =>
    handlers.show_user({ threadId: thread.id, projectId: "p1", ...over });

  it("normalizes an absolute file path to workspace-relative with its line", async () => {
    const out = await call({
      target: "file",
      path: path.join(tmpDir, "src", "a.ts"),
      line: 2,
      reason: "  the bug  ",
    });
    assert.deepEqual(out, {
      shown: true,
      target: "file",
      path: "src/a.ts",
      line: 2,
      reason: "the bug",
    });
  });

  it("refuses paths outside the workspace and missing files", async () => {
    await assert.rejects(call({ target: "file", path: "../etc/passwd" }), /outside/);
    await assert.rejects(call({ target: "file", path: "src/nope.ts" }), /No such file/);
    await assert.rejects(call({ target: "file" }), /needs a path/);
  });

  it("lets a diff point at a deleted file and drops terminal paths and lines", async () => {
    const diff = await call({ target: "diff", path: "./src/gone.ts", line: 3 });
    assert.equal(diff.path, "src/gone.ts");
    assert.equal(diff.line, null);
    const term = await call({ target: "terminal", path: "src/a.ts" });
    assert.equal(term.path, null);
  });

  it("rejects unknown targets and other projects", async () => {
    await assert.rejects(call({ target: "browser" }), /target must be/);
    await assert.rejects(call({ target: "terminal", projectId: "p2" }), /own project/);
  });
});
