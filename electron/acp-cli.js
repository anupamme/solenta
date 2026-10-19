#!/usr/bin/env node
"use strict";

/**
 * `solenta-acp`: the process an ACP client (Zed, JetBrains, ...) spawns to
 * talk to Solenta as an agent (issue #272). A dumb pipe: stdio <-> the running
 * app's orch server over `Upgrade: solenta-acp`. Protocol logic is in
 * electron/acpServer.js. SOLENTA_USER_DATA picks a non-default data dir
 * (e.g. Solenta Nightly).
 */

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

function defaultUserData() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Solenta");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Solenta");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Solenta");
}

function fail(msg) {
  process.stderr.write(`solenta-acp: ${msg}\n`);
  process.exit(1);
}

const userData = process.env.SOLENTA_USER_DATA || defaultUserData();
let config;
try {
  config = JSON.parse(fs.readFileSync(path.join(userData, "orch-server.json"), "utf8"));
} catch {
  fail(`Solenta is not running (no orch-server.json in ${userData})`);
}

const req = http.request({
  host: "127.0.0.1",
  port: config.port,
  path: "/acp",
  headers: {
    connection: "Upgrade",
    upgrade: "solenta-acp",
    authorization: `Bearer ${config.token}`,
  },
});
req.on("upgrade", (_res, socket, head) => {
  if (head && head.length) process.stdout.write(head);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  socket.on("close", () => process.exit(0));
  socket.on("error", (err) => fail(err.message));
  process.stdin.on("end", () => socket.end());
});
req.on("response", (res) => fail(`Solenta refused the connection (HTTP ${res.statusCode})`));
req.on("error", (err) => fail(`cannot reach Solenta on port ${config.port}: ${err.message}`));
req.end();
