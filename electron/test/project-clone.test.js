"use strict";

/**
 * #1506 H3: Add project from a URL.
 * Run: npm run test:electron -- electron/test/project-clone.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { execFileSync } = require("node:child_process");
const {
  cloneProject,
  cancelClone,
  cloneUrlError,
  repoNameFromUrl,
  setCloneSpawnFn,
} = require("../projectClone.js");

describe("clone URL rules", () => {
  it("allows https and ssh only", () => {
    for (const ok of [
      "https://github.com/owner/repo.git",
      "https://gitlab.example.com/group/sub/repo",
      "ssh://git@github.com/owner/repo.git",
      "git@github.com:owner/repo.git",
      "deploy@host.internal:repos/app",
      "owner/repo",
      "my-org/app.js",
    ]) {
      assert.equal(cloneUrlError(ok), null, ok);
    }
    for (const bad of [
      "",
      "http://github.com/owner/repo.git",
      "file:///etc",
      "/Users/me/code/repo",
      "C:\\code\\repo",
      "ext::sh -c touch% /tmp/pwned",
      "--upload-pack=touch /tmp/x",
      "github.com:owner/repo",
      "https://github.com",
      "https://github.com/owner/repo extra",
      "-x/repo",
      "owner/..",
      "a/b/c",
    ]) {
      assert.ok(cloneUrlError(bad), `should reject ${JSON.stringify(bad)}`);
    }
  });

  it("derives the folder name git would pick", () => {
    assert.equal(repoNameFromUrl("https://github.com/owner/repo.git"), "repo");
    assert.equal(repoNameFromUrl("git@github.com:owner/my-app.git"), "my-app");
    assert.equal(repoNameFromUrl("ssh://git@host/a/b/"), "b");
    assert.equal(repoNameFromUrl("owner/repo"), "repo");
  });
});

describe("cloneProject", () => {
  let tmpDir;
  /** @type {any[]} */
  let spawned;
  /** @type {(child: any, args: string[]) => void} */
  let behave;

  function fakeSpawn(bin, args, opts) {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    // Above any real pid_max: the group kill gets ESRCH and falls back
    // to child.kill, so no real process can be signalled.
    child.pid = 2147480000;
    child.kill = () => {
      setImmediate(() => child.emit("close", null));
    };
    spawned.push({ bin, args, opts, child });
    setImmediate(() => behave(child, args));
    return child;
  }

  let savedGhBin;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-clone-"));
    spawned = [];
    setCloneSpawnFn(fakeSpawn);
    // A gh that does not exist: the default sign-in probe says no.
    savedGhBin = process.env.CODER_GH_BIN;
    process.env.CODER_GH_BIN = path.join(tmpDir, "no-gh");
  });

  afterEach(() => {
    if (savedGhBin === undefined) delete process.env.CODER_GH_BIN;
    else process.env.CODER_GH_BIN = savedGhBin;
    setCloneSpawnFn(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clones into parent/name with progress, then adds", async () => {
    behave = (child, args) => {
      const target = args[args.length - 1];
      fs.mkdirSync(path.join(target, ".git"), { recursive: true });
      child.stderr.write("Cloning into 'repo'...\nReceiving objects:  50% (1/2)\r");
      setTimeout(() => {
        child.stderr.end();
        child.emit("close", 0);
      }, 20);
    };
    const pushes = [];
    const added = [];
    const result = await cloneProject(
      { url: "https://github.com/owner/repo.git", parentDir: tmpDir, cloneId: "c1" },
      {
        addProject: async (t) => {
          added.push(t);
          return { id: "p1", path: t };
        },
        broadcast: (ch, payload) => pushes.push([ch, payload]),
      },
    );
    const target = path.join(tmpDir, "repo");
    assert.deepEqual(spawned[0].args, [
      "clone",
      "--progress",
      "--",
      "https://github.com/owner/repo.git",
      target,
    ]);
    assert.equal(spawned[0].opts.env.GIT_TERMINAL_PROMPT, "0");
    assert.deepEqual(added, [target]);
    assert.equal(result.path, target);
    assert.ok(
      pushes.some(([ch, p]) => ch === "clone:progress" && p.cloneId === "c1" && /Receiving objects/.test(p.line)),
      JSON.stringify(pushes),
    );
  });

  const succeed = (child, args) => {
    const target = args[0] === "repo" ? args[3] : args[args.length - 1];
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });
    child.stderr.end();
    child.emit("close", 0);
  };

  it("clones GitHub owner/repo through gh when gh is signed in", async () => {
    behave = succeed;
    await cloneProject(
      { url: "owner/repo", parentDir: tmpDir },
      { addProject: async (t) => ({ path: t }), ghSignedIn: async () => true },
    );
    assert.equal(spawned[0].bin, process.env.CODER_GH_BIN);
    assert.deepEqual(spawned[0].args, [
      "repo",
      "clone",
      "owner/repo",
      path.join(tmpDir, "repo"),
      "--",
      "--progress",
    ]);
  });

  it("falls back to git over https for owner/repo without gh", async () => {
    behave = succeed;
    await cloneProject(
      { url: "owner/repo", parentDir: tmpDir },
      { addProject: async (t) => ({ path: t }) },
    );
    assert.equal(spawned[0].bin, "git");
    assert.deepEqual(spawned[0].args, [
      "clone",
      "--progress",
      "--",
      "https://github.com/owner/repo.git",
      path.join(tmpDir, "repo"),
    ]);
  });

  it("adds an existing checkout of the same repo instead of cloning", async () => {
    const target = path.join(tmpDir, "repo");
    fs.mkdirSync(target);
    execFileSync("git", ["init", "-q"], { cwd: target });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:Owner/Repo.git"], { cwd: target });
    const added = [];
    await cloneProject(
      { url: "https://github.com/owner/repo", parentDir: tmpDir },
      { addProject: async (t) => added.push(t) },
    );
    assert.deepEqual(added, [target]);
    assert.equal(spawned.length, 0);

    await assert.rejects(
      cloneProject(
        { url: "https://gitlab.com/owner/repo", parentDir: tmpDir },
        { addProject: async () => ({}) },
      ),
      /Folder is not empty/,
    );
    assert.equal(spawned.length, 0);
  });

  it("refuses an existing non-empty target without spawning", async () => {
    fs.mkdirSync(path.join(tmpDir, "repo"));
    fs.writeFileSync(path.join(tmpDir, "repo", "keep.txt"), "mine");
    await assert.rejects(
      cloneProject(
        { url: "git@github.com:owner/repo.git", parentDir: tmpDir },
        { addProject: async () => ({}) },
      ),
      /Folder is not empty/,
    );
    assert.equal(spawned.length, 0);
    assert.equal(fs.readFileSync(path.join(tmpDir, "repo", "keep.txt"), "utf8"), "mine");
  });

  it("refuses non-https/ssh URLs without spawning", async () => {
    await assert.rejects(
      cloneProject(
        { url: "file:///etc", parentDir: tmpDir },
        { addProject: async () => ({}) },
      ),
      /an https:\/\/ URL, or an ssh URL/,
    );
    assert.equal(spawned.length, 0);
  });

  it("a failed clone removes what it created and surfaces git's reason", async () => {
    behave = (child, args) => {
      fs.mkdirSync(path.join(args[args.length - 1], ".git"), { recursive: true });
      child.stderr.write("Cloning into 'repo'...\nfatal: repository 'https://x/y/' not found\n");
      child.stderr.end();
      child.emit("close", 128);
    };
    let addCalled = false;
    await assert.rejects(
      cloneProject(
        { url: "https://x.example/y/repo", parentDir: tmpDir },
        { addProject: async () => { addCalled = true; } },
      ),
      /repository 'https:\/\/x\/y\/' not found/,
    );
    assert.equal(addCalled, false);
    assert.equal(fs.existsSync(path.join(tmpDir, "repo")), false);
  });

  it("an existing empty target is kept, emptied again on failure", async () => {
    fs.mkdirSync(path.join(tmpDir, "repo"));
    behave = (child, args) => {
      fs.mkdirSync(path.join(args[args.length - 1], ".git"), { recursive: true });
      child.stderr.end();
      child.emit("close", 1);
    };
    await assert.rejects(
      cloneProject(
        { url: "https://x.example/y/repo", parentDir: tmpDir },
        { addProject: async () => ({}) },
      ),
    );
    assert.deepEqual(fs.readdirSync(path.join(tmpDir, "repo")), []);
  });

  it("cancel stops the clone and cleans up", async () => {
    behave = (_child, args) => {
      fs.mkdirSync(path.join(args[args.length - 1], ".git"), { recursive: true });
      // never closes on its own
    };
    const p = cloneProject(
      { url: "https://x.example/y/repo", parentDir: tmpDir, cloneId: "c2" },
      { addProject: async () => ({}) },
    );
    await new Promise((r) => setTimeout(r, 30));
    cancelClone({ cloneId: "c2" });
    await assert.rejects(p, /Clone cancelled/);
    assert.equal(fs.existsSync(path.join(tmpDir, "repo")), false);
    cancelClone({ cloneId: "unknown" });
  });
});
