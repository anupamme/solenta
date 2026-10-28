"use strict";

// Local models (#1717): Ollama / LM Studio detection against fake servers on
// random ports, and the opencode config the "Use with Solenta" instance makes.

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { detectLocalModels, serverRoot } = require("../localModels.js");
const inst = require("../providerInstances.js");

/** @param {(req: http.IncomingMessage, body: string, res: http.ServerResponse) => void} handler */
async function serve(handler) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, body, res));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${port}`, server };
}

const servers = [];
after(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
});

/** A port nothing listens on: bind, read it, close. */
async function deadUrl() {
  const { url, server } = await serve(() => {});
  await new Promise((r) => server.close(r));
  return url;
}

const json = (res, body) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

describe("detectLocalModels (#1717)", () => {
  it("lists Ollama tags with context from /api/show, preferring num_ctx", async () => {
    const shown = [];
    const s = await serve((req, body, res) => {
      if (req.url === "/api/tags") return json(res, { models: [{ name: "qwen3-coder:30b" }, { name: "llama3.2:3b" }] });
      if (req.url === "/api/show" && req.method === "POST") {
        const { model } = JSON.parse(body);
        shown.push(model);
        return json(
          res,
          model === "llama3.2:3b"
            ? { parameters: "stop <|eot|>\nnum_ctx 8192", model_info: { "llama.context_length": 131072 } }
            : { model_info: { "general.architecture": "qwen3moe", "qwen3moe.context_length": 262144 } },
        );
      }
      res.writeHead(404).end();
    });
    servers.push(s.server);
    const [ollama, lm] = await detectLocalModels({ ollamaUrl: `${s.url}/v1/`, lmstudioUrl: await deadUrl() });
    assert.deepEqual(ollama, {
      kind: "ollama",
      url: s.url,
      baseUrl: `${s.url}/v1`,
      running: true,
      models: [
        { id: "qwen3-coder:30b", label: "qwen3-coder:30b", contextTokens: 262144 },
        { id: "llama3.2:3b", label: "llama3.2:3b", contextTokens: 8192 },
      ],
    });
    assert.deepEqual(shown.sort(), ["llama3.2:3b", "qwen3-coder:30b"]);
    assert.equal(lm.running, false);
  });

  it("lists LM Studio /v1/models", async () => {
    const s = await serve((req, _body, res) =>
      req.url === "/v1/models"
        ? json(res, { object: "list", data: [{ id: "qwen/qwen3-coder-30b", object: "model" }] })
        : res.writeHead(404).end(),
    );
    servers.push(s.server);
    const [, lm] = await detectLocalModels({ ollamaUrl: await deadUrl(), lmstudioUrl: s.url });
    assert.deepEqual(lm, {
      kind: "lmstudio",
      url: s.url,
      baseUrl: `${s.url}/v1`,
      running: true,
      models: [{ id: "qwen/qwen3-coder-30b", label: "qwen/qwen3-coder-30b" }],
    });
  });

  it("reports not running, without throwing, when nothing listens", async () => {
    const dead = await deadUrl();
    const rows = await detectLocalModels({ ollamaUrl: dead, lmstudioUrl: dead });
    assert.deepEqual(rows.map((r) => [r.kind, r.running, r.models.length]), [
      ["ollama", false, 0],
      ["lmstudio", false, 0],
    ]);
  });

  it("gives up on a slow server within the timeout", async () => {
    const s = await serve(() => {}); // accepts, never answers
    servers.push(s.server);
    const t0 = Date.now();
    const rows = await detectLocalModels({ ollamaUrl: s.url, lmstudioUrl: s.url }, { timeoutMs: 100 });
    assert.ok(Date.now() - t0 < 2000, "the timeout bounds the probe");
    assert.deepEqual(rows.map((r) => r.running), [false, false]);
  });

  it("falls back to the default hosts for junk URLs", () => {
    assert.equal(serverRoot("file:///etc/passwd"), null);
    assert.equal(serverRoot("not a url"), null);
    assert.equal(serverRoot("http://192.168.1.5:11434/v1/"), "http://192.168.1.5:11434");
  });
});

describe("Use with Solenta instance (#1717)", () => {
  // The exact shape ProvidersPane's localInstance() saves (test/settingsModal.test.tsx pins it).
  const OLLAMA = {
    id: "ollama",
    name: "Ollama",
    provider: "opencode",
    configDir: null,
    env: {},
    openaiCompatible: {
      baseUrl: "http://127.0.0.1:11434/v1",
      modelsUrl: null,
      models: ["qwen3-coder:30b"],
      defaultModel: "qwen3-coder:30b",
      headers: {},
    },
  };

  it("validates and produces opencode's local provider block with no API key", () => {
    const [row] = inst.validateProviderInstances([OLLAMA]);
    assert.deepEqual(inst.opencodeProviderConfig(row), {
      ollama: {
        npm: "@ai-sdk/openai-compatible",
        name: "Ollama",
        options: { baseURL: "http://127.0.0.1:11434/v1" },
        models: { "qwen3-coder:30b": { name: "qwen3-coder:30b" } },
      },
    });
  });

  it("accepts the LM Studio name and id too", () => {
    const lm = { ...OLLAMA, id: "lmstudio", name: "LM Studio", openaiCompatible: { ...OLLAMA.openaiCompatible, baseUrl: "http://127.0.0.1:1234/v1" } };
    assert.equal(inst.validateProviderInstances([lm])[0].id, "lmstudio");
  });
});
