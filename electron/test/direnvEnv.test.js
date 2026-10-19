const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadDirenv, direnvEnv } = require("../direnvEnv.js");
const { withProjectEnv } = require("../worktreeEnv.js");

// Fake direnv: .envrc without .allowed is blocked; `allow` marks the dir;
// `export json` prints the envrc's single line as the JSON diff.
const FAKE = `#!/bin/sh
echo "$*" >> "$PWD/.calls"
if [ "$1" = allow ]; then touch "$PWD/.allowed"; exit 0; fi
[ -f "$PWD/.envrc" ] || exit 0
if [ ! -f "$PWD/.allowed" ]; then echo "direnv: error $PWD/.envrc is blocked. Run \\\`direnv allow\\\`" >&2; exit 1; fi
cat "$PWD/.envrc"
`;

describe("direnv env (#320)", { skip: process.platform === "win32" }, () => {
  const saved = { PATH: process.env.PATH, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  let root;
  const rc = '{"FROM_DIRENV":"1","PATH":"/nix/store/x/bin:/usr/bin","UNSET_ME":null}';
  const mk = (name, envrc) => {
    const d = path.join(root, name);
    fs.mkdirSync(d);
    if (envrc != null) fs.writeFileSync(path.join(d, ".envrc"), envrc);
    return d;
  };
  const calls = (d) => fs.readFileSync(path.join(d, ".calls"), "utf8").trim().split("\n");
  /** Record a direnv allow for `dir`/.envrc the way direnv itself does. */
  const allow = (dir) => {
    const file = path.join(dir, ".envrc");
    const hash = crypto.createHash("sha256").update(`${file}\n`).update(fs.readFileSync(file)).digest("hex");
    const allowDir = path.join(process.env.XDG_DATA_HOME, "direnv", "allow");
    fs.mkdirSync(allowDir, { recursive: true });
    fs.writeFileSync(path.join(allowDir, hash), file);
  };

  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "direnv-")));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "direnv"), FAKE, { mode: 0o755 });
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.XDG_DATA_HOME = path.join(root, "data");
  });
  after(() => {
    process.env.PATH = saved.PATH;
    if (saved.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved.XDG_DATA_HOME;
  });

  it("an allowed .envrc lands under project.env and the spawn overlay; null unsets", async () => {
    const d = mk("allowed", rc);
    fs.writeFileSync(path.join(d, ".allowed"), "");
    await loadDirenv(d);
    const env = withProjectEnv({ env: { FROM_DIRENV: "project" } }, { OVERLAY: "o" }, d);
    assert.deepEqual(env, {
      FROM_DIRENV: "project",
      PATH: "/nix/store/x/bin:/usr/bin",
      UNSET_ME: undefined,
      OVERLAY: "o",
    });
    assert.ok(Object.hasOwn(env, "UNSET_ME"), "undefined key makes child_process drop it");
    assert.equal(withProjectEnv({ remoteHost: "box" }, undefined, d), undefined, "remote: no local direnv");
  });

  it("a worktree inherits the main checkout's allow only for a byte-identical .envrc", async () => {
    const main = mk("main", rc);
    allow(main);
    const same = mk("wt-same", rc);
    await loadDirenv(same, { mainPath: main });
    assert.deepEqual(calls(same), ["export json", "allow .", "export json"]);
    assert.equal(direnvEnv(same).FROM_DIRENV, "1");

    const changed = mk("wt-changed", rc.replace('"1"', '"2"'));
    await loadDirenv(changed, { mainPath: main });
    assert.deepEqual(calls(changed), ["export json"], "edited .envrc stays blocked");
    assert.equal(direnvEnv(changed), undefined);

    const unallowedMain = mk("main2", rc);
    const wt = mk("wt-unallowed-main", rc);
    await loadDirenv(wt, { mainPath: unallowedMain });
    assert.deepEqual(calls(wt), ["export json"], "main never allowed: nothing to inherit");
  });

  it("no .envrc, missing cwd, or no direnv on PATH add nothing", async () => {
    const plain = mk("plain", null);
    await loadDirenv(plain);
    assert.equal(direnvEnv(plain), undefined);
    await loadDirenv(path.join(root, "gone"));
    assert.equal(direnvEnv(path.join(root, "gone")), undefined);
    const d = mk("nodirenv", rc);
    fs.writeFileSync(path.join(d, ".allowed"), "");
    process.env.PATH = "/nonexistent";
    try {
      await loadDirenv(d);
    } finally {
      process.env.PATH = `${path.join(root, "bin")}:${saved.PATH}`;
    }
    assert.equal(direnvEnv(d), undefined);
    assert.deepEqual(withProjectEnv({}, { A: "1" }, d), { A: "1" });
  });
});
