"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const sources = require("../mentionSources.js");
const handlers = require("../ipc-mentions.js");

/** @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} fn */
async function serve(fn) {
  const server = http.createServer(fn);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

test("fetchUrl turns HTML into labelled text and drops scripts", async () => {
  const s = await serve((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      "<html><head><title>Docs &amp; Guides</title><style>.x{}</style></head><body>" +
        "<nav>Menu</nav><h1>Working with files</h1><p>Use <a href='/m'>mentions</a> &lt;here&gt;.</p>" +
        "<script>alert(1)</script><ul><li>One</li><li>Two</li></ul></body></html>",
    );
  });
  try {
    const out = await sources.fetchUrl(`${s.url}/docs`);
    assert.match(out.label, /^127\.0\.0\.1:\d+ · \d+ B$/);
    assert.match(out.text, /Title: Docs & Guides/);
    assert.match(out.text, /# Working with files/);
    assert.match(out.text, /Use \[mentions\]\(\/m\) <here>\./);
    assert.match(out.text, /- One\n- Two/);
    assert.match(out.text, /untrusted/);
    assert.doesNotMatch(out.text, /alert|Menu|\.x\{\}/);
  } finally {
    await s.close();
  }
});

test("fetchUrl caps the download and the text", async () => {
  const s = await serve((_req, res) => {
    res.setHeader("content-type", "text/plain");
    res.end("a".repeat(300_000));
  });
  try {
    const small = await sources.fetchUrl(s.url, { maxBytes: 1000 });
    assert.match(small.text, /download stopped at 1000 B/);
    const big = await sources.fetchUrl(s.url);
    assert.match(big.text, /truncated: 250000 more chars/);
  } finally {
    await s.close();
  }
});

test("fetchUrl times out", async () => {
  const s = await serve(() => {});
  try {
    await assert.rejects(sources.fetchUrl(s.url, { timeoutMs: 200 }), /Timed out after 0s/);
  } finally {
    await s.close();
  }
});

test("fetchUrl refuses non-http schemes and redirects to file:", async () => {
  await assert.rejects(sources.fetchUrl("file:///etc/passwd"), /Only http and https/);
  await assert.rejects(sources.fetchUrl("ftp://example.com/x"), /Only http and https/);
  await assert.rejects(sources.fetchUrl("not a url"), /Not a valid URL/);
  const s = await serve((req, res) => {
    if (req.url === "/hop") {
      res.writeHead(302, { location: "/evil" });
    } else {
      res.writeHead(302, { location: "file:///etc/passwd" });
    }
    res.end();
  });
  try {
    await assert.rejects(sources.fetchUrl(`${s.url}/hop`), /Only http and https URLs can be fetched \(got file:\)/);
  } finally {
    await s.close();
  }
});

test("fetchUrl refuses binary content", async () => {
  const s = await serve((_req, res) => {
    res.setHeader("content-type", "image/png");
    res.end(Buffer.alloc(10));
  });
  try {
    await assert.rejects(sources.fetchUrl(s.url), /Not a text page \(image\/png\)/);
  } finally {
    await s.close();
  }
});

test("terminalText strips ANSI and carriage-return redraws, keeps the tail", () => {
  const raw =
    "\x1b[32mgreen\x1b[0m line\r\n\x1b]0;title\x07prompt$ ls\r\n" +
    "progress 10%\rprogress 100%\r\n" +
    Array.from({ length: 300 }, (_, i) => `row ${i}`).join("\r\n") +
    "\r\n\r\n";
  const all = sources.terminalText(raw, 1000).split("\n");
  assert.equal(all[0], "green line");
  assert.equal(all[1], "prompt$ ls");
  assert.equal(all[2], "progress 100%");
  const tail = sources.terminalText(raw).split("\n");
  assert.equal(tail.length, 200);
  assert.equal(tail[199], "row 299");
  assert.ok(!tail.join("").includes("\x1b"));
});

test("terminalTail reads a live buffer, falls back to the log on disk, errors when empty", () => {
  const live = {
    list: () => ["1"],
    read: () => ({ text: "\x1b[1m$ npm test\x1b[0m\r\nok\r\n" }),
  };
  const out = sources.terminalTail(live, "t1", undefined);
  assert.match(out.label, /^2 lines · /);
  assert.match(out.text, /\$ npm test\nok$/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-term-"));
  fs.mkdirSync(path.join(dir, "t1"));
  fs.writeFileSync(path.join(dir, "t1", "2.log"), "from disk\r\n");
  const dead = { list: () => ["2"], read: () => ({ text: "" }) };
  assert.match(sources.terminalTail(dead, "t1", dir).text, /from disk/);
  assert.throws(() => sources.terminalTail({ list: () => [], read: () => ({ text: "" }) }, "t1", dir), /no output/);
});

test("runProblems runs the verify command and caps the output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-prob-"));
  const out = await sources.runProblems({
    requestId: "r1",
    command: "printf 'src/a.ts(1,1): error TS1\\n'; exit 2",
    cwd: dir,
    project: { path: dir },
  });
  assert.match(out.label, /^exit 2 · /);
  assert.match(out.text, /verify command `printf/);
  assert.match(out.text, /error TS1/);
  await assert.rejects(
    sources.runProblems({ requestId: "r2", command: null, cwd: dir, project: null }),
    /No verify command/,
  );
});

test("runProblems is cancellable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-prob-"));
  const started = Date.now();
  const pending = sources.runProblems({ requestId: "slow", command: "sleep 30", cwd: dir, project: { path: dir } });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(sources.cancelProblems("slow"), { ok: true });
  const out = await pending;
  assert.equal(out.cancelled, true);
  assert.ok(Date.now() - started < 10_000);
  assert.deepEqual(sources.cancelProblems("slow"), { ok: false });
});

/** Temp repo with one commit and dirty, staged and untracked changes. */
function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-git-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "bee\n");
  git("add", ".");
  git("commit", "-qm", "First commit");
  return { dir, git };
}

/** ctx the ipc-mentions handlers expect. */
function ctxFor(dir, verifyCommand = null) {
  const thread = { id: "t1", projectId: "p1", worktreePath: dir, verifyCommand };
  return {
    store: {
      getThread: (id) => (id === "t1" ? thread : null),
      getProject: () => ({ id: "p1", path: dir }),
    },
  };
}

test("gitChanges shows staged + unstaged + untracked; clean tree errors", async () => {
  const { dir } = tempRepo();
  const ctx = ctxFor(dir);
  await assert.rejects(handlers["mentions:gitChanges"](ctx, { threadId: "t1" }), /No uncommitted changes/);
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "staged\n");
  execFileSync("git", ["add", "b.txt"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "new.txt"), "x\n");
  const out = await handlers["mentions:gitChanges"](ctx, { threadId: "t1" });
  assert.match(out.label, /^3 files · /);
  assert.match(out.text, /\+two/);
  assert.match(out.text, /\+staged/);
  assert.match(out.text, /\?\? new\.txt/);
});

test("listCommits and showCommit, with bad-sha rejection", async () => {
  const { dir, git } = tempRepo();
  const ctx = ctxFor(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
  git("commit", "-qam", "Second commit");
  const commits = await handlers["mentions:listCommits"](ctx, { threadId: "t1" });
  assert.deepEqual(commits.map((c) => c.subject), ["Second commit", "First commit"]);
  assert.equal(commits[0].sha, git("rev-parse", "HEAD"));

  const shown = await handlers["mentions:showCommit"](ctx, { threadId: "t1", sha: commits[0].short.toUpperCase() });
  assert.match(shown.label, /^[0-9a-f]{7} Second commit · /);
  assert.match(shown.text, /a\.txt \| 2 \+-/);
  assert.match(shown.text, /\+changed/);

  for (const bad of ["--output=/tmp/x", "HEAD", "abc", "zzzz1234", "abcd;rm -rf /", "a".repeat(41)]) {
    await assert.rejects(handlers["mentions:showCommit"](ctx, { threadId: "t1", sha: bad }), /Not a commit sha/, bad);
  }
  await assert.rejects(handlers["mentions:showCommit"](ctx, { threadId: "t1", sha: "deadbeef" }), /Unknown commit deadbeef/);
  await assert.rejects(handlers["mentions:listCommits"](ctx, { threadId: "nope" }), /Unknown thread/);
});

test("runProblems handler uses the thread's verify command", async () => {
  const { dir } = tempRepo();
  await assert.rejects(
    handlers["mentions:runProblems"](ctxFor(dir), { threadId: "t1", requestId: "x" }),
    /No verify command/,
  );
  const out = await handlers["mentions:runProblems"](ctxFor(dir, "echo all good"), { threadId: "t1", requestId: "y" });
  assert.match(out.label, /^passed/);
  assert.match(out.text, /all good/);
});
