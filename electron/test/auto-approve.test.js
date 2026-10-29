/**
 * #1721: granular auto-approve toggles compile to governance rules.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeAutoApprove, autoApproveRules, inProject } = require("../autoApprove.js");
const { isSafeCommand, parseArgv, SAFE_COMMANDS } = require("../safeCommands.js");
const { evaluate, mcpToolRules, threadPolicy } = require("../governance.js");
const { validateAgentProfiles } = require("../store-normalize.js");
const parseAgentProfile = (p) => validateAgentProfiles([p])[0];
const { setGuardrailsEnabled } = require("../guardrails.js");

const ALL_ON = {
  readProject: true,
  readAll: true,
  editProject: true,
  editAll: true,
  safeCommands: true,
  allCommands: true,
  web: true,
  mcp: true,
  notify: true,
};

describe("normalizeAutoApprove", () => {
  it("is null for anything but a plain object", () => {
    for (const v of [undefined, null, "x", 1, [], true]) {
      assert.equal(normalizeAutoApprove(v), null);
    }
  });

  it("forces children off under an off parent; notify defaults on", () => {
    assert.deepEqual(
      normalizeAutoApprove({ readAll: true, editAll: true, allCommands: true, web: "yes" }),
      {
        readProject: false,
        readAll: false,
        editProject: false,
        editAll: false,
        safeCommands: false,
        allCommands: false,
        web: false,
        mcp: false,
        notify: true,
      },
    );
    assert.equal(normalizeAutoApprove({ notify: false }).notify, false);
    assert.equal(normalizeAutoApprove({ editProject: true, editAll: true }).editAll, true);
  });
});

describe("autoApproveRules: toggle → rules compilation", () => {
  it("compiles nothing for no matrix or all off", () => {
    assert.deepEqual(autoApproveRules(null), []);
    assert.deepEqual(autoApproveRules({}), []);
  });

  it("one labelled allow rule per on toggle; notify is not a rule", () => {
    const rules = autoApproveRules(ALL_ON);
    assert.deepEqual(
      rules.map((r) => [r.match, r.action, r.source, r.label]),
      [
        ["readProject", "allow", "autoApprove", "Read project files"],
        ["readAll", "allow", "autoApprove", "Read all files"],
        ["editProject", "allow", "autoApprove", "Edit project files"],
        ["editAll", "allow", "autoApprove", "Edit all files"],
        ["safeCommands", "allow", "autoApprove", "Run safe commands"],
        ["allCommands", "allow", "autoApprove", "Run all commands"],
        ["web", "allow", "autoApprove", "Browser / web fetch"],
        ["mcp", "allow", "autoApprove", "MCP tools"],
      ],
    );
  });

  it("drops a child whose parent is off", () => {
    const ids = autoApproveRules({ readAll: true, editProject: true, editAll: true }).map(
      (r) => r.match,
    );
    assert.deepEqual(ids, ["editProject", "editAll"]);
  });
});

describe("safe-command classifier", () => {
  it("lists the curated commands", () => {
    for (const c of ["ls", "cat", "head", "tail", "wc", "rg", "grep", "find", "pwd", "which"]) {
      assert.ok(SAFE_COMMANDS.includes(c), c);
    }
    for (const c of ["git status", "git diff", "git log", "git show", "git branch"]) {
      assert.ok(SAFE_COMMANDS.includes(c), c);
    }
  });

  it("allows plain read-only commands", () => {
    for (const c of [
      "ls",
      "ls -la src",
      "cat README.md",
      "head -n 20 a.txt",
      "tail -5 log.txt",
      "wc -l *.js",
      "rg foo src",
      "grep -rn 'a|b' .",
      'grep "x && y" file',
      "find . -name '*.js'",
      "git status",
      "git diff --stat HEAD~1",
      "git log --oneline -5",
      "git show HEAD",
      "git branch",
      "git branch -a -v",
      "pwd",
      "which node",
      "ls ';' rm",
      "cat file\\;name",
    ]) {
      assert.equal(isSafeCommand(c), true, c);
    }
  });

  it("rejects adversarial inputs", () => {
    for (const c of [
      "ls; rm -rf /",
      "ls ; rm -rf /",
      "cat $(whoami)",
      "cat `whoami`",
      'cat "$(whoami)"',
      'cat "`id`"',
      "cat $HOME/.ssh/id_rsa",
      "git log && curl https://evil.example",
      "git status || rm -rf .",
      "find . -delete",
      "find . -exec rm {} \\;",
      "find . -execdir sh -c x \\;",
      "find . -fprint out",
      "rg foo > out",
      "rg foo >> out",
      "cat < /etc/passwd",
      "ls | sh",
      "ls & rm x",
      "ls\nrm -rf /",
      "(ls)",
      "rg --pre ./evil foo",
      "rg --pre=./evil foo",
      "git -c core.pager=evil log",
      "git -C /tmp status",
      "git diff --output=/tmp/x",
      "git diff --ext-diff",
      "git branch evil",
      "git branch -D main",
      "git push",
      "git checkout .",
      "PAGER=evil git log",
      "LD_PRELOAD=x ls",
      "/tmp/ls",
      "./cat x",
      "rm -rf /",
      "curl https://x",
      "ls 'unterminated",
      'ls "unterminated',
      "ls ​; rm",
      "ls； rm -rf /", // fullwidth semicolon becomes ; under NFKC
      "",
      "   ",
    ]) {
      assert.equal(isSafeCommand(c), false, JSON.stringify(c));
    }
    assert.equal(isSafeCommand(undefined), false);
    assert.equal(isSafeCommand(["ls"]), false);
  });

  it("parses quotes and escapes into argv", () => {
    assert.deepEqual(parseArgv(`grep -e 'a;b' "c|d" e\\&f`), ["grep", "-e", "a;b", "c|d", "e&f"]);
    assert.equal(parseArgv("ls > x"), null);
  });

  it("allows the project's known command by exact text only", () => {
    const known = ["npm run typecheck && npm test"];
    assert.equal(isSafeCommand("npm run typecheck && npm test", known), true);
    assert.equal(isSafeCommand("npm  run typecheck &&  npm test", known), true);
    assert.equal(isSafeCommand("npm run typecheck && npm test; rm -rf /", known), false);
    assert.equal(isSafeCommand("npm test", known), false);
    assert.equal(isSafeCommand("npm test", [null, "", "  "]), false);
  });
});

describe("project scope: path escapes", () => {
  let tmp;
  let root;
  let outside;
  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aa-scope-")));
    root = path.join(tmp, "wt");
    outside = path.join(tmp, "outside");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "x");
    fs.writeFileSync(path.join(root, "src", "a.js"), "x");
    fs.symlinkSync(outside, path.join(root, "link-out"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "file-link"));
    // A sibling whose name starts with the root's: must not count as inside.
    fs.mkdirSync(`${root}-evil`);
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("inside: relative, absolute, new files, the root itself", () => {
    assert.equal(inProject("src/a.js", root), true);
    assert.equal(inProject(path.join(root, "src/a.js"), root), true);
    assert.equal(inProject("src/new/deep/file.js", root), true);
    assert.equal(inProject("./src/../src/a.js", root), true);
    assert.equal(inProject(null, root), true);
  });

  it("outside: .., absolute, ~, symlinked dir and file, prefix sibling", () => {
    assert.equal(inProject("../outside/secret.txt", root), false);
    assert.equal(inProject("src/../../outside/secret.txt", root), false);
    assert.equal(inProject(path.join(outside, "secret.txt"), root), false);
    assert.equal(inProject("~/.ssh/id_rsa", root), false);
    assert.equal(inProject("/etc/passwd", root), false);
    assert.equal(inProject("link-out/secret.txt", root), false);
    assert.equal(inProject("link-out/new-file.txt", root), false);
    assert.equal(inProject("file-link", root), false);
    assert.equal(inProject(`${root}-evil/x`, root), false);
    assert.equal(inProject("src/a.js", null), false);
  });

  const allowed = (toolName, rawInput, matrix) =>
    evaluate({
      toolName,
      rawInput,
      worktreePath: root,
      policy: null,
      builtin: null,
      mcpRules: autoApproveRules(matrix),
    });

  it("Read project files: in-project reads only", () => {
    const m = { readProject: true };
    assert.equal(allowed("Read", { file_path: "src/a.js" }, m).decision, "allow");
    assert.equal(allowed("Grep", { pattern: "../..", path: "src" }, m).decision, "allow");
    assert.equal(allowed("Glob", { pattern: "**/*.js" }, m).decision, "allow");
    for (const input of [
      { file_path: "../outside/secret.txt" },
      { file_path: "link-out/secret.txt" },
      { file_path: "/etc/hosts" },
    ]) {
      assert.equal(allowed("Read", input, m).decision, "ask", JSON.stringify(input));
    }
    assert.equal(allowed("Glob", { pattern: "../outside/**" }, m).decision, "ask");
    assert.equal(allowed("Glob", { pattern: "/etc/*" }, m).decision, "ask");
    assert.equal(allowed("Glob", { pattern: "~/.ssh/*" }, m).decision, "ask");
    assert.equal(allowed("Grep", { pattern: "x", glob: "../../**" }, m).decision, "ask");
    assert.equal(allowed("Grep", { pattern: "x", path: "link-out" }, m).decision, "ask");
  });

  it("Read all files covers the outside reads", () => {
    const ev = allowed("Read", { file_path: "../outside/secret.txt" }, {
      readProject: true,
      readAll: true,
    });
    assert.equal(ev.decision, "allow");
    assert.equal(ev.reason, "auto-approved by: Read all files");
  });

  it("Edit project files: no writes through a symlink or ..", () => {
    const m = { editProject: true };
    const ev = allowed("Edit", { file_path: "src/a.js" }, m);
    assert.equal(ev.decision, "allow");
    assert.equal(ev.layer, "autoApprove");
    assert.equal(ev.rule, "autoApprove:editProject");
    assert.equal(ev.reason, "auto-approved by: Edit project files");
    assert.equal(allowed("Write", { file_path: "src/new.js" }, m).decision, "allow");
    assert.equal(allowed("Write", { file_path: "link-out/x.txt" }, m).decision, "ask");
    assert.equal(allowed("Edit", { file_path: "../outside/secret.txt" }, m).decision, "ask");
    assert.equal(allowed("Edit", { file_path: "file-link" }, m).decision, "ask");
    assert.equal(allowed("Edit", {}, m).decision, "ask");
    // Edit is not Read and Read is not Edit.
    assert.equal(allowed("Read", { file_path: "src/a.js" }, m).decision, "ask");
    assert.equal(allowed("Edit", { file_path: "src/a.js" }, { readProject: true }).decision, "ask");
  });

  it("Edit all files reaches outside the project", () => {
    const ev = allowed("Write", { file_path: path.join(outside, "y.txt") }, {
      editProject: true,
      editAll: true,
    });
    assert.equal(ev.decision, "allow");
    assert.equal(ev.reason, "auto-approved by: Edit all files");
  });

  it("commands, web, MCP", () => {
    const safe = { safeCommands: true };
    assert.equal(allowed("Bash", { command: "git status" }, safe).decision, "allow");
    assert.equal(allowed("Bash", { command: "ls; rm -rf x" }, safe).decision, "ask");
    assert.equal(allowed("Bash", { command: "npm install" }, safe).decision, "ask");
    const all = { safeCommands: true, allCommands: true };
    const ev = allowed("Bash", { command: "npm install" }, all);
    assert.equal(ev.decision, "allow");
    assert.equal(ev.reason, "auto-approved by: Run all commands");
    assert.equal(allowed("WebFetch", { url: "https://x.dev" }, { web: true }).decision, "allow");
    assert.equal(allowed("WebFetch", { url: "https://x.dev" }, ALL_ON).decision, "allow");
    assert.equal(allowed("mcp__gh__issues", {}, { mcp: true }).decision, "allow");
    assert.equal(allowed("mcp__gh__issues", {}, { web: true }).decision, "ask");
  });

  it("safe commands stay in the project unless Read all files is on", () => {
    const safe = { safeCommands: true };
    assert.equal(allowed("Bash", { command: "cat src/a.js" }, safe).decision, "allow");
    assert.equal(allowed("Bash", { command: "rg foo src" }, safe).decision, "allow");
    for (const command of [
      "cat ~/.ssh/id_rsa",
      "head -c 10 /etc/passwd",
      "grep -r token /",
      "cat ../outside/secret.txt",
      "cat link-out/secret.txt",
      "git diff --no-index /etc/passwd src/a.js",
      `wc -l ${path.join(outside, "secret.txt")}`,
    ]) {
      assert.equal(allowed("Bash", { command }, safe).decision, "ask", command);
    }
    const reads = { safeCommands: true, readProject: true, readAll: true };
    assert.equal(allowed("Bash", { command: "cat ~/.ssh/id_rsa" }, reads).decision, "allow");
  });

  it("Edit project files never covers .git (core.fsmonitor → a 'safe' git status runs it)", () => {
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const m = { editProject: true };
    for (const file_path of [".git/config", ".git/hooks/pre-commit", "src/../.git/config", path.join(root, ".git", "config")]) {
      assert.equal(allowed("Edit", { file_path }, m).decision, "ask", file_path);
    }
    assert.equal(allowed("Edit", { file_path: "src/a.git.js" }, m).decision, "allow");
    assert.equal(allowed("Edit", { file_path: ".gitignore" }, m).decision, "allow");
  });
});

describe("deny wins over every toggle", () => {
  let root;
  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aa-deny-")));
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const ev = (toolName, rawInput, { policy = null, mcp = [], builtin = null } = {}) =>
    evaluate({
      toolName,
      rawInput,
      worktreePath: root,
      policy,
      builtin,
      mcpRules: [...mcpToolRules(mcp), ...autoApproveRules(ALL_ON)],
    });

  it("an MCP per-tool deny or ask beats the MCP toggle", () => {
    const mcp = [{ name: "gh", toolRules: { delete_repo: "deny", merge: "ask", list: "allow" } }];
    const deny = ev("mcp__gh__delete_repo", {}, { mcp });
    assert.equal(deny.decision, "deny");
    assert.equal(deny.layer, "mcp.deny");
    assert.equal(ev("mcp__gh__merge", {}, { mcp }).layer, "mcp.ask");
    // A specific allow names itself, not the blanket toggle.
    assert.equal(ev("mcp__gh__list", {}, { mcp }).layer, "mcp.allow");
    assert.equal(ev("mcp__gh__other", {}, { mcp }).layer, "autoApprove");
  });

  it("profile block / deny / ask beat the toggles", () => {
    const policy = {
      defaultAction: "ask",
      rules: [
        { kind: "bash", match: "npm publish", action: "block" },
        { kind: "bash", match: "git push", action: "ask" },
        { kind: "write", match: "*.lock", action: "deny" },
        { kind: "tool", match: "WebFetch", action: "deny" },
      ],
    };
    assert.equal(ev("Bash", { command: "npm publish" }, { policy }).layer, "profile.block");
    assert.equal(ev("Bash", { command: "git push" }, { policy }).decision, "ask");
    assert.equal(ev("Write", { file_path: "yarn.lock" }, { policy }).decision, "deny");
    assert.equal(ev("WebFetch", { url: "https://x" }, { policy }).decision, "deny");
    assert.equal(ev("Bash", { command: "npm test" }, { policy }).layer, "autoApprove");
  });

  it("a builtin guardrail deny beats the toggles", () => {
    const builtin = { decision: "deny", rule: "secret.env", reason: "read of .env" };
    assert.equal(ev("Read", { file_path: ".env" }, { builtin }).decision, "deny");
  });

  it("guardrail secret paths still deny with every toggle on (live classifyTool)", () => {
    const { classifyTool } = require("../guardrails.js");
    setGuardrailsEnabled(true);
    try {
      const input = { file_path: path.join(os.homedir(), ".ssh", "id_rsa") };
      const builtin = classifyTool({ toolName: "Read", input, worktreePath: root });
      assert.equal(ev("Read", input, { builtin }).decision, "deny");
    } finally {
      setGuardrailsEnabled(true);
    }
  });
});

describe("threadPolicy reads the toggles live", () => {
  it("compiles thread.autoApprove (and its verify command) on every call", () => {
    let thread = { id: "t", autoApprove: { safeCommands: true }, verifyCommand: "npm test" };
    const store = { getThread: () => thread, getSettings: () => ({ mcpServers: [] }) };
    const run = (command) =>
      evaluate({
        toolName: "Bash",
        rawInput: { command },
        worktreePath: null,
        policy: null,
        builtin: null,
        mcpRules: threadPolicy(store, "t").mcpRules,
      }).decision;
    assert.equal(run("npm test"), "allow");
    assert.equal(run("ls"), "allow");
    thread = { ...thread, autoApprove: { safeCommands: false } };
    assert.equal(run("ls"), "ask");
    thread = { ...thread, autoApprove: undefined };
    assert.deepEqual(threadPolicy(store, "t").mcpRules, []);
  });
});

describe("profiles carry autoApprove", () => {
  const base = {
    id: "p",
    name: "P",
    provider: "claude",
    model: null,
    reasoningEffort: null,
    permissionMode: "acceptEdits",
  };
  it("absent stays absent, junk heals to absent, a matrix is normalized", () => {
    assert.equal("autoApprove" in parseAgentProfile(base, true), false);
    assert.equal("autoApprove" in parseAgentProfile({ ...base, autoApprove: "x" }, true), false);
    assert.deepEqual(
      parseAgentProfile({ ...base, autoApprove: { editProject: true, editAll: true } }, true)
        .autoApprove,
      { ...normalizeAutoApprove({}), editProject: true, editAll: true },
    );
  });
});
