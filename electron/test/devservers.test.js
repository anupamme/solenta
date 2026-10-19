"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  captureServerUrl,
  detectScripts,
  scriptsFromPackageJson,
  appendLog,
  start,
  stop,
} = require("../devservers.js");

function fakeNpmChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.pid = 0;
  child.unref = () => {};
  return child;
}

const temps = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-devservers-"));
  temps.push(dir);
  return dir;
}

after(() => {
  for (const dir of temps) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("captureServerUrl", () => {
  it("extracts the first http(s) URL that includes a port", () => {
    assert.equal(
      captureServerUrl("  Local: http://localhost:5173/"),
      "http://localhost:5173/",
    );
    assert.equal(
      captureServerUrl("ready on http://0.0.0.0:3000"),
      "http://0.0.0.0:3000",
    );
    assert.equal(
      captureServerUrl("https://127.0.0.1:8080/path?x=1"),
      "https://127.0.0.1:8080/path?x=1",
    );
  });

  it("returns the first URL when several appear", () => {
    assert.equal(
      captureServerUrl(
        "  Local:   http://localhost:5173/\n  Network: http://192.168.1.5:5173/",
      ),
      "http://localhost:5173/",
    );
  });

  it("ignores urls without a port and empty input", () => {
    assert.equal(captureServerUrl(""), null);
    assert.equal(captureServerUrl("listening on unix socket"), null);
    assert.equal(captureServerUrl("see https://example.com/docs"), null);
  });

  it("strips trailing sentence punctuation from the match", () => {
    assert.equal(
      captureServerUrl("open http://localhost:3000."),
      "http://localhost:3000",
    );
  });
});

describe("detectScripts", () => {
  it("returns present scripts in preference order: dev, start, serve", () => {
    assert.deepEqual(
      scriptsFromPackageJson({
        scripts: { serve: "npx serve", lint: "eslint .", start: "node .", dev: "vite" },
      }),
      ["dev", "start", "serve"],
    );
    assert.deepEqual(
      scriptsFromPackageJson({ scripts: { serve: "serve ." } }),
      ["serve"],
    );
    assert.deepEqual(scriptsFromPackageJson({ scripts: { test: "node --test" } }), []);
    assert.deepEqual(scriptsFromPackageJson({}), []);
    assert.deepEqual(scriptsFromPackageJson(null), []);
  });

  it("reads package.json at the thread root", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { start: "node server.js", build: "tsc" } }),
    );
    assert.deepEqual(detectScripts(dir), ["start"]);
  });

  it("returns [] when package.json is missing or invalid", () => {
    const dir = tmpDir();
    assert.deepEqual(detectScripts(dir), []);
    fs.writeFileSync(path.join(dir, "package.json"), "{not json");
    assert.deepEqual(detectScripts(dir), []);
    assert.deepEqual(detectScripts(""), []);
  });

  it("skips blank script values", () => {
    assert.deepEqual(
      scriptsFromPackageJson({ scripts: { dev: "   ", start: "node ." } }),
      ["start"],
    );
  });
});

describe("appendLog", () => {
  function fresh() {
    return {
      pid: 0,
      script: "dev",
      startedAt: 0,
      url: null,
      lines: [],
      pending: "",
      dead: false,
      deadAt: null,
    };
  }

  it("rewrites carriage-return progress without growing pending or flooding lines", () => {
    const rec = fresh();
    for (let i = 0; i < 200; i++) {
      appendLog(rec, `building ${i}%\r`);
    }
    assert.ok(rec.pending.length < 100);
    assert.equal(rec.lines.length, 0);
  });

  it("caps a giant newline-less chunk to PENDING_LIMIT", () => {
    const rec = fresh();
    appendLog(rec, "x".repeat(10_000));
    assert.equal(rec.pending.length, 4096);
  });

  it("captures a Local URL and pushes that line", () => {
    const rec = fresh();
    appendLog(rec, "  Local: http://localhost:5173/\n");
    assert.equal(rec.url, "http://localhost:5173/");
    assert.deepEqual(rec.lines, ["  Local: http://localhost:5173/"]);
  });

  it("treats \\r\\n as a newline, not a blank rewrite", () => {
    const rec = fresh();
    appendLog(rec, "a\r\nb\n");
    assert.deepEqual(rec.lines, ["a", "b"]);
  });
});

describe("start spawn shape", () => {
  it("spawns npm run <script> as argv, not /bin/sh -c", () => {
    const calls = [];
    start("t-posix", "/repo", "dev", {
      platform: "darwin",
      spawn: (bin, args, opts) => {
        calls.push({ bin, args, opts });
        return fakeNpmChild();
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, "npm");
    assert.deepEqual(calls[0].args, ["run", "dev"]);
    assert.equal(calls[0].opts.cwd, "/repo");
    stop("t-posix");
  });

  it("uses wsl.exe for a WSL-side root on win32", () => {
    const calls = [];
    start("t-wsl", "\\\\wsl$\\Ubuntu\\home\\me\\repo", "dev", {
      platform: "win32",
      spawn: (bin, args, opts) => {
        calls.push({ bin, args, opts });
        return fakeNpmChild();
      },
    });
    assert.equal(calls[0].bin, "wsl.exe");
    assert.deepEqual(calls[0].args, [
      "-d",
      "Ubuntu",
      "--cd",
      "/home/me/repo",
      "--",
      "npm",
      "run",
      "dev",
    ]);
    assert.equal(calls[0].opts.cwd, undefined);
    stop("t-wsl");
  });

  it("keeps npm as the binary on win32 windows-side (cross-spawn finds npm.cmd)", () => {
    const calls = [];
    start("t-win", "C:\\repo", "start", {
      platform: "win32",
      spawn: (bin, args, opts) => {
        calls.push({ bin, args, opts });
        return fakeNpmChild();
      },
    });
    assert.equal(calls[0].bin, "npm");
    assert.deepEqual(calls[0].args, ["run", "start"]);
    assert.equal(calls[0].opts.cwd, "C:\\repo");
    stop("t-win");
  });

  it("forwards opts.env so a lane can inject PORT and isolation (#346 / #250)", () => {
    const calls = [];
    start("t-env", "/repo", "dev", {
      platform: "darwin",
      env: { PORT: "3001", SOLENTA_LANE: "1", SOLENTA_DATA_DIR: "/homes/t" },
      spawn: (bin, args, opts) => {
        calls.push({ bin, args, opts });
        return fakeNpmChild();
      },
    });
    assert.equal(calls[0].opts.env.PORT, "3001");
    assert.equal(calls[0].opts.env.SOLENTA_LANE, "1");
    assert.equal(calls[0].opts.env.SOLENTA_DATA_DIR, "/homes/t");
    stop("t-env");
  });

  it("prefixes WSL npm with env KEY=value so isolation reaches the distro", () => {
    const calls = [];
    start("t-wsl-env", "\\\\wsl$\\Ubuntu\\home\\me\\repo", "dev", {
      platform: "win32",
      spawn: (bin, args, opts) => {
        calls.push({ bin, args, opts });
        return fakeNpmChild();
      },
      env: {
        PORT: "3002",
        XDG_DATA_HOME: "/tmp/solenta-dev-homes/t-wsl-env/share",
      },
    });
    assert.equal(calls[0].bin, "wsl.exe");
    assert.deepEqual(calls[0].args, [
      "-d",
      "Ubuntu",
      "--cd",
      "/home/me/repo",
      "--",
      "env",
      "PORT=3002",
      "XDG_DATA_HOME=/tmp/solenta-dev-homes/t-wsl-env/share",
      "npm",
      "run",
      "dev",
    ]);
    stop("t-wsl-env");
  });

  it("appends --user-data-dir for an Electron script using SOLENTA_DATA_DIR", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { electron: "electron ." } }),
    );
    const dataDir = path.join(dir, "dev-homes", "t-el-args");
    const calls = [];
    start("t-el-args", dir, "electron", {
      platform: "darwin",
      env: { SOLENTA_DATA_DIR: dataDir },
      spawn: (bin, args, opts) => {
        calls.push({ bin, args, opts });
        return fakeNpmChild();
      },
    });
    assert.equal(calls[0].bin, "npm");
    assert.deepEqual(calls[0].args, [
      "run",
      "electron",
      "--",
      `--user-data-dir=${path.join(dataDir, "chrome-profile")}`,
    ]);
    stop("t-el-args");
  });

  it("does not append --user-data-dir for a vite script", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } }),
    );
    const calls = [];
    start("t-vite", dir, "dev", {
      platform: "darwin",
      env: { SOLENTA_DATA_DIR: path.join(dir, "homes") },
      spawn: (bin, args) => {
        calls.push({ bin, args });
        return fakeNpmChild();
      },
    });
    assert.deepEqual(calls[0].args, ["run", "dev"]);
    stop("t-vite");
  });

  it("prepends the per-lane Electron stub to PATH for an electron script", () => {
    const root = tmpDir();
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { electron: "electron ." } }),
    );
    const dataDir = path.join(root, "dev-homes", "thr-el");
    const calls = [];
    start("t-el", root, "electron", {
      platform: "darwin",
      env: {
        SOLENTA_DATA_DIR: dataDir,
        SOLENTA_APP_NAME: "Acme · thr-el",
        SOLENTA_THREAD_ID: "thr-el",
      },
      spawn: (bin, args, opts) => {
        calls.push({ bin, args, opts });
        return fakeNpmChild();
      },
    });
    assert.equal(calls.length, 1);
    const shimDir = path.join(dataDir, "bin");
    assert.ok(String(calls[0].opts.env.PATH).startsWith(`${shimDir}${path.delimiter}`));
    assert.ok(
      fs.existsSync(path.join(dataDir, "Electron.app", "Contents", "Info.plist")),
    );
    stop("t-el");
  });

  it("start() runs a rewritten concurrently script so inner electron gets --user-data-dir", () => {
    const { isolationEnv, chromiumUserDataDir } = require("../worktreeEnv.js");
    const root = tmpDir();
    const body = 'concurrently "vite" "electron ."';
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { dev: body } }),
    );
    const env = isolationEnv({
      threadId: "thr-wrap",
      userDataPath: root,
      platform: "darwin",
    });
    const profile = chromiumUserDataDir(env);
    const calls = [];
    start("t-wrap", root, "dev", {
      platform: "darwin",
      env,
      spawn: (bin, args, opts) => {
        calls.push({ bin, args, opts });
        return fakeNpmChild();
      },
    });
    assert.equal(calls.length, 1);
    const joined = [calls[0].bin, ...(calls[0].args || [])].join(" ");
    assert.ok(
      joined.includes(`--user-data-dir=${profile}`),
      "inner electron must see the lane chrome-profile",
    );
    assert.ok(joined.includes("electron"), "must still launch electron");
    assert.ok(joined.includes("vite"), "must still launch vite");
    assert.equal(
      (calls[0].args || []).includes("--user-data-dir") ||
        (calls[0].args || []).some((a) => String(a) === `--user-data-dir=${profile}`),
      false,
      "flag must not be a trailing npm extra arg (concurrently would swallow it)",
    );
    stop("t-wrap");
  });
});


describe("readiness probes (#282)", () => {
  const { parseReadyProbe, status } = require("../devservers.js");
  const net = require("node:net");
  const http = require("node:http");
  const { spawn: realSpawn } = require("node:child_process");

  it("parses tcp, http and exec probes, expanding $PORT from the server env", () => {
    const env = { PORT: "4100" };
    const ready = (r) => parseReadyProbe({ devServer: { ready: r } }, env);
    assert.equal(parseReadyProbe({}, env), null);
    assert.equal(parseReadyProbe({ devServer: {} }, env), null);
    assert.deepEqual(ready({ tcp: 5173 }), { kind: "tcp", target: "localhost:5173", timeoutMs: 120_000 });
    assert.deepEqual(ready({ tcp: "$PORT", timeoutMs: 5000 }), { kind: "tcp", target: "localhost:4100", timeoutMs: 5000 });
    assert.equal(ready({ http: "http://127.0.0.1:${PORT}/health" }).target, "http://127.0.0.1:4100/health");
    assert.deepEqual(ready({ exec: " test -f /tmp/ready " }), { kind: "exec", target: "test -f /tmp/ready", timeoutMs: 120_000 });
  });

  it("rejects ambiguous, remote and unresolvable probes", () => {
    const ready = (r, env = {}) => parseReadyProbe({ devServer: { ready: r } }, env);
    assert.match(ready({ tcp: 1, exec: "true" }).error, /exactly one/);
    assert.match(ready({}).error, /exactly one/);
    assert.match(ready({ http: "http://example.com:80/" }).error, /localhost/);
    assert.match(ready({ tcp: "$PORT" }).error, /PORT is not set/);
    assert.match(ready({ tcp: 70000 }).error, /port/);
    assert.match(ready({ exec: "" }).error, /exec/);
    assert.match(ready({ tcp: 1, timeoutMs: 5 }).error, /timeoutMs/);
  });

  // A real, killable process group: stop() signals -pid.
  const liveSpawn = (_bin, _args, opts) =>
    realSpawn(process.execPath, ["-e", "console.log(`Local: http://localhost:${process.env.PORT}/`); setInterval(() => {}, 1e3)"], opts);

  async function until(threadId, pred) {
    for (let i = 0; i < 200; i += 1) {
      const s = status(threadId);
      if (pred(s)) return s;
      await new Promise((r) => setTimeout(r, 20));
    }
    return assert.fail(`timed out: ${JSON.stringify(status(threadId))}`);
  }

  async function freePort() {
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address();
    await new Promise((r) => srv.close(r));
    return port;
  }

  function repoWith(ready) {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "solenta.json"), JSON.stringify({ devServer: { ready } }));
    return root;
  }

  it("tcp: waits, hides the logged URL, then goes ready once the port accepts", async () => {
    const port = await freePort();
    const root = repoWith({ tcp: "$PORT" });
    const first = start("t-probe-tcp", root, "dev", {
      env: { PORT: String(port) }, spawn: liveSpawn, probeIntervalMs: 20,
    });
    try {
      assert.equal(first.probe.status, "waiting");
      assert.equal(first.probe.target, `localhost:${port}`);
      const waiting = await until("t-probe-tcp", (s) => s.lastLines && s.probe.lastError);
      assert.equal(waiting.probe.status, "waiting");
      assert.equal(waiting.url, undefined, "url stays hidden until the probe passes");
      const srv = net.createServer().listen(port, "127.0.0.1");
      try {
        const ready = await until("t-probe-tcp", (s) => s.probe.status === "ready");
        assert.equal(ready.url, `http://localhost:${port}/`);
        assert.ok(ready.probe.readyAt);
      } finally {
        srv.close();
      }
    } finally {
      stop("t-probe-tcp");
    }
  });

  it("exec: ready once the command exits 0 in the server root", { skip: process.platform === "win32" }, async () => {
    const root = repoWith({ exec: "test -f ready.flag" });
    start("t-probe-exec", root, "dev", { env: { PORT: "1" }, spawn: liveSpawn, probeIntervalMs: 20 });
    try {
      await until("t-probe-exec", (s) => s.probe.lastError);
      fs.writeFileSync(path.join(root, "ready.flag"), "");
      await until("t-probe-exec", (s) => s.probe.status === "ready");
    } finally {
      stop("t-probe-exec");
    }
  });

  it("http: a 503 never passes and the probe fails after timeoutMs", async () => {
    const srv = http.createServer((_req, res) => res.writeHead(503).end()).listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const { port } = srv.address();
    const root = repoWith({ http: "http://127.0.0.1:$PORT/health", timeoutMs: 1000 });
    start("t-probe-http", root, "dev", { env: { PORT: String(port) }, spawn: liveSpawn, probeIntervalMs: 20 });
    try {
      const failed = await until("t-probe-http", (s) => s.probe.status === "failed");
      assert.equal(failed.probe.lastError, "HTTP 503");
      assert.equal(failed.running, true, "a failed probe does not kill the server");
      assert.equal(failed.url, undefined);
    } finally {
      stop("t-probe-http");
      srv.close();
    }
  });

  it("an invalid declaration fails at start instead of hanging in waiting", () => {
    const root = repoWith({ tcp: "$NOPE_UNSET_VAR" });
    const s = start("t-probe-bad", root, "dev", { env: { PORT: "1" }, spawn: liveSpawn });
    try {
      assert.equal(s.probe.status, "failed");
      assert.match(s.probe.lastError, /NOPE_UNSET_VAR is not set/);
    } finally {
      stop("t-probe-bad");
    }
  });
});
