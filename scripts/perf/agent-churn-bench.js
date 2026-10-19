"use strict";
// Main-process responsiveness under agent churn (#1661, step 1 of #418).
//
//   ./node_modules/.bin/electron scripts/perf/agent-churn-bench.js /tmp/fstore [counts] [seconds]
//
// BENCH_BIG_THREADS=1 streams into the copy's largest transcripts (the worst
// case). BENCH_REAL_RENDERER=1 loads dist/index.html (npx vite build first)
// instead of a blank page with the preload.
//
// /tmp/fstore is a COPY of the data dir, as for store-stream-bench.js:
//   mkdir /tmp/fstore
//   cp -c ~/Library/Application\ Support/Solenta/coder-store.json /tmp/fstore/
//   cp -Rc ~/Library/Application\ Support/Solenta/messages /tmp/fstore/
// The bench clones it again and works on the clone. counts defaults to
// 0,1,5,10,20 concurrent agents; seconds (default 20) is the sample per level.
//
// Same wiring as electron/smoke.js (Store + runner + registerIpc + a sandboxed
// window on preload.js), with no main.js boot: no orphan sweep, no auto-resume,
// no retention timers. Each agent is a fake claude CLI streaming stream-json
// partials (~40 text deltas/s, a tool call every ~2 s) through the real
// runner-provider-claude.js path, so main does the real JSON parse, Store
// upserts, 250 ms partial saves and thread:updated pushes.
//
// Reported per level: main event-loop delay (monitorEventLoopDelay), main CPU,
// and threads.list round-trip measured in the renderer every 100 ms.

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const { pathToFileURL } = require("node:url");

const src = path.resolve(process.argv[2] || "/tmp/fstore");
const counts = (process.argv[3] || "0,1,5,10,20").split(",").map(Number);
const seconds = Number(process.argv[4] || 20);
const tmpRoots = [os.tmpdir(), "/tmp", "/private/tmp"].map((p) => fs.realpathSync(p));
if (!tmpRoots.some((root) => fs.realpathSync(src).startsWith(root + path.sep))) {
  console.error(`refusing ${src}: the bench only runs on a copy under /tmp`);
  process.exit(2);
}
if (!fs.existsSync(path.join(src, "coder-store.json"))) {
  console.error(`no coder-store.json in ${src}`);
  process.exit(2);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "churn-bench-"));
try {
  execFileSync("cp", ["-Rc", `${src}/.`, work]);
} catch {
  fs.cpSync(src, work, { recursive: true });
}
app.setPath("userData", work);
process.env.SOLENTA_SKIP_USERDATA_MIGRATION = "1";

// Fake claude: streams until killed by runs.stop.
const fakeClaude = path.join(work, "bench-fake-claude");
fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
"use strict";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const ev = (event) => emit({ type: "stream_event", event });
(async () => {
  emit({ type: "system", subtype: "init", session_id: "bench-" + process.pid, model: "bench" });
  for (let turn = 0; ; turn++) {
    ev({ type: "message_start", message: { id: "m" + turn } });
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    let text = "";
    for (let i = 0; i < 72; i++) {
      const d = "lorem ipsum dolor sit amet " + i + " ";
      text += d;
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: d } });
      await delay(25);
    }
    ev({ type: "content_block_stop", index: 0 });
    const id = "toolu_" + process.pid + "_" + turn;
    const input = { command: "ls -la " + turn };
    ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name: "Bash", input: {} } });
    ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
    ev({ type: "content_block_stop", index: 1 });
    emit({ type: "assistant", message: { content: [{ type: "text", text }, { type: "tool_use", id, name: "Bash", input }] } });
    ev({ type: "message_stop" });
    await delay(200);
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "total 0\\n".repeat(20), is_error: false }] } });
  }
})();
`, { mode: 0o755 });
process.env.CODER_CLAUDE_BIN = fakeClaude;

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const { Store } = require("../../electron/store.js");
  const { createRunner } = require("../../electron/runner.js");
  const { registerIpc } = require("../../electron/ipc.js");
  const core = await import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);

  const store = new Store(path.join(work, "coder-store.json"));
  const broadcast = (channel, payload) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  };
  const runner = createRunner({ store, core, pushFn: broadcast, tickMs: 700 });
  registerIpc({ ipcMain, dialog, store, runner, broadcast, worktreeBase: path.join(work, "worktrees"), userDataPath: work });

  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, "../../electron/preload.js"), contextIsolation: true, sandbox: true },
  });
  const dist = path.join(__dirname, "../../dist/index.html");
  const blank = path.join(work, "blank.html");
  fs.writeFileSync(blank, "<!doctype html><title>bench</title>");
  const page = process.env.BENCH_REAL_RENDERER ? dist : blank;
  await win.loadFile(page);
  const js = (expr) => win.webContents.executeJavaScript(expr, true);

  // A scratch git repo, never one of the store copy's real project paths.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "churn-bench-repo-"));
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.email=b@b", "-c", "user.name=b", "commit", "-q", "--allow-empty", "-m", "init"]);
  const project = await js(`window.coder.projects.add(${JSON.stringify(repo)})`);

  console.log(`store: ${(fs.statSync(path.join(work, "coder-store.json")).size / 1048576).toFixed(1)} MiB envelope, ${store.getThreads().length} threads; renderer: ${path.basename(page)}`);
  console.log("agents | loop p50 | loop p99 | loop max | main CPU | list p50 | list p99 | list max | pushes/s |  msgs");

  const histogram = monitorEventLoopDelay({ resolution: 1 });
  let pushes = 0;
  const realSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (ch, ...a) => { if (ch === "thread:updated") pushes++; return realSend(ch, ...a); };

  // BENCH_BIG_THREADS=1: stream into the copy's largest transcripts instead of
  // fresh threads, so each partial save rewrites a multi-MB shard. They are
  // moved onto the scratch project first so no run touches a real repo.
  const known = new Set(store.getThreads().map((t) => t.id));
  const bigThreads = process.env.BENCH_BIG_THREADS
    ? fs.readdirSync(path.join(work, "messages"))
      .map((f) => ({ id: f.replace(/\.json$/, ""), size: fs.statSync(path.join(work, "messages", f)).size }))
      .filter((s) => known.has(s.id))
      .sort((a, b) => b.size - a.size)
    : [];
  for (const { id } of bigThreads.slice(0, Math.max(...counts))) {
    store.updateThread(id, {
      projectId: project.id, provider: "claude", model: null, sessionId: null, worktreePath: null,
      permissionMode: "default", archived: false, settledOverride: null, status: "idle", queued: null,
    });
  }
  if (bigThreads.length) {
    const top = bigThreads.slice(0, Math.max(...counts)).map((s) => s.size / 1048576);
    console.log(`big threads: shards ${top[top.length - 1].toFixed(1)}–${top[0].toFixed(1)} MiB`);
  }

  for (const n of counts) {
    const levelStart = Date.now();
    const threadIds = [];
    for (let i = 0; i < n; i++) {
      const id = bigThreads.length
        ? bigThreads[i].id
        : (await js(`window.coder.threads.create(${JSON.stringify({ projectId: project.id, title: `bench ${n}/${i}` })})`)).id;
      threadIds.push(id);
      await js(`window.coder.runs.start(${JSON.stringify({ threadId: id, prompt: "bench" })})`);
    }
    await sleep(3000); // warm-up: spawn, init, first saves

    await js(`window.__rtt = []; window.__stop = false; (async () => {
      while (!window.__stop) {
        const t = performance.now();
        await window.coder.threads.list();
        window.__rtt.push(performance.now() - t);
        await new Promise((r) => setTimeout(r, 100));
      }
    })(); 0`);
    histogram.reset();
    histogram.enable();
    pushes = 0;
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    await sleep(seconds * 1000);
    const wallMs = performance.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    histogram.disable();
    const rtt = (await js(`window.__stop = true; window.__rtt`)).sort((a, b) => a - b);

    for (const id of threadIds) await js(`window.coder.runs.stop(${JSON.stringify({ threadId: id })})`);
    const msgs = threadIds.reduce((sum, id) => sum + store.getMessages(id).filter((m) => m.createdAt >= levelStart).length, 0);
    const ms = (ns) => (ns / 1e6).toFixed(1).padStart(8);
    const r = (v) => v.toFixed(1).padStart(8);
    console.log(
      `${String(n).padStart(6)} |${ms(histogram.percentile(50))} |${ms(histogram.percentile(99))} |${ms(histogram.max)} |` +
      `${(((cpu.user + cpu.system) / 1000 / wallMs) * 100).toFixed(0).padStart(7)}% |` +
      `${r(pct(rtt, 0.5))} |${r(pct(rtt, 0.99))} |${r(rtt[rtt.length - 1] || NaN)} |${(pushes / (wallMs / 1000)).toFixed(0).padStart(9)} |${String(msgs).padStart(6)}`,
    );

    await store.flushPending();
    await sleep(2000);
  }

  fs.rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 10 });
  fs.rmSync(repo, { recursive: true, force: true });
  app.exit(0);
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
