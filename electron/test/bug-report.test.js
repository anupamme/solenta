/**
 * Issue #1703: agents file Solenta bug reports through coder-threads.
 * Run: node --test electron/test/bug-report.test.js
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const { createToolHandlers } = require("../orchServer.js");
const bugReport = require("../bugReport.js");
const feedback = require("../feedback.js");
const { bugReportNoteFor } = require("../services-notes.js");

const HOME = os.homedir();
const WORKTREE = `${HOME}/Library/Application Support/Solenta/worktrees/t1`;

function fakeFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

function setup(settings = {}) {
  const messages = [
    {
      role: "tool",
      tool: { name: "Bash", isError: true, output: "old failure" },
    },
    {
      role: "tool",
      tool: {
        name: "mcp__coder-threads__thread_status",
        isError: true,
        output: `Unknown IPC method at ${WORKTREE}/electron/ipc.js token ghp_${"a".repeat(36)}`,
      },
    },
    { role: "tool", tool: { name: "Read", isError: false, output: "ok" } },
  ];
  const thread = {
    id: "t1",
    projectId: "p1",
    provider: "claude",
    model: "claude-opus-5-5",
    worktreePath: WORKTREE,
  };
  const store = {
    getThread: (id) => (id === "t1" ? thread : null),
    getProject: () => ({ id: "p1", path: "/Users/someone/code/app" }),
    getMessages: () => messages,
    getSettings: () => settings,
    appendMessage: (_id, m) => messages.push(m),
  };
  const fetch = fakeFetch();
  const handlers = createToolHandlers({
    store,
    runner: {},
    forkThread: () => ({ id: "x" }),
    getProvider: () => null,
    userDataPath: `${HOME}/Library/Application Support/Solenta`,
    fetch,
  });
  return { handlers, fetch, messages };
}

const args = (title, body = "The tool said the method is missing.") => ({
  threadId: "t1",
  projectId: "p1",
  title,
  body,
});

describe("solenta_bug_report", () => {
  beforeEach(() => bugReport.resetBugReportLimits());

  it("sends one feedback payload with the attached context", async () => {
    const { handlers, fetch, messages } = setup();
    const res = await handlers.solenta_bug_report(args("thread_status errors"));
    assert.equal(res.sent, true);
    assert.equal(res.remainingToday, 2);
    assert.equal(fetch.calls.length, 1);
    const { url, body } = fetch.calls[0];
    assert.equal(url, feedback.ENDPOINT);
    assert.deepEqual(Object.keys(body).sort(), ["platform", "text", "version"]);
    assert.equal(body.version, feedback.appVersion());
    assert.equal(body.platform, `${process.platform} ${process.arch}`);
    const t = body.text;
    assert.match(t, /^\[agent bug report\] thread_status errors\n\nThe tool said/);
    assert.match(t, /\napp: /);
    assert.match(t, new RegExp(`\nos: ${process.platform} `));
    assert.match(t, /\nprovider: claude\n/);
    assert.match(t, /\nmodel: claude-opus-5-5\n/);
    assert.match(t, /\nthread: t1\n/);
    // The LAST errored tool, not the first.
    assert.match(t, /\nlast tool error: mcp__coder-threads__thread_status: Unknown IPC method/);
    assert.ok(t.length <= feedback.MAX_TEXT);
    // The transcript shows what was sent.
    assert.match(messages.at(-1).text, /Bug report sent to the Solenta team: thread_status errors/);
  });

  it("redacts secrets and absolute paths everywhere", async () => {
    const { handlers, fetch } = setup();
    await handlers.solenta_bug_report(
      args(
        `crash in ${HOME}/x/y.js`,
        [
          `key sk-ant-${"b".repeat(30)} and Bearer ${"c".repeat(20)}`,
          `worktree ${WORKTREE}/src/App.tsx`,
          "project /Users/someone/code/app/package.json",
          "elsewhere /opt/homebrew/bin/node and C:\\Users\\bob\\app.js",
          "keep electron/runner.js and https://github.com/currentbits/solenta",
        ].join("\n"),
      ),
    );
    const t = fetch.calls[0].body.text;
    assert.doesNotMatch(t, /sk-ant-b|ghp_a|cccccccccccccccc/);
    assert.doesNotMatch(t, new RegExp(HOME.replace(/[/\\]/g, "\\$&")));
    assert.doesNotMatch(t, /\/Users\/|\/opt\/|C:\\/);
    assert.match(t, /crash in ~\/x\/y\.js|crash in <path>/);
    assert.match(t, /worktree <worktree>\/src\/App\.tsx/);
    assert.match(t, /project <project>\/package\.json/);
    assert.match(t, /elsewhere <path> and <path>/);
    assert.match(t, /keep electron\/runner\.js and https:\/\/github\.com\/currentbits\/solenta/);
    assert.match(t, /last tool error: .*<worktree>\/electron\/ipc\.js token \[redacted:github-token\]/);
  });

  it("allows 3 per thread per day and does not resend a repeated title", async () => {
    const { handlers, fetch } = setup();
    await handlers.solenta_bug_report(args("one"));
    const dup = await handlers.solenta_bug_report(args("  ONE "));
    assert.deepEqual(
      { sent: dup.sent, duplicate: dup.duplicate },
      { sent: false, duplicate: true },
    );
    await handlers.solenta_bug_report(args("two"));
    await handlers.solenta_bug_report(args("three"));
    await assert.rejects(
      () => handlers.solenta_bug_report(args("four")),
      /3 per thread per day/,
    );
    assert.equal(fetch.calls.length, 3);
  });

  it("frees the allowance after a day", async () => {
    const fetch = fakeFetch();
    const r = (title) => ({ title, text: title, version: "1", platform: "p" });
    for (const t of ["a", "b", "c"]) {
      await bugReport.fileBugReport("t9", r(t), { fetch, now: 0 });
    }
    await assert.rejects(() => bugReport.fileBugReport("t9", r("d"), { fetch, now: 1 }));
    const res = await bugReport.fileBugReport("t9", r("d"), { fetch, now: 24 * 3600e3 });
    assert.equal(res.sent, true);
  });

  it("is refused, and the prompt hint dropped, when the setting is off", async () => {
    const { handlers, fetch } = setup({ agentBugReports: false });
    await assert.rejects(
      () => handlers.solenta_bug_report(args("x")),
      /turned off in Settings/,
    );
    assert.equal(fetch.calls.length, 0);
    assert.equal(bugReportNoteFor({ agentBugReports: false }), "");
  });
});
