/**
 * #1721: auto-approve toggles in the composer's permission menu.
 *
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/autoApprove.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { Composer } from "../src/components/Composer";
import type { AutoApprove, PermissionMode, ProviderInfo } from "../src/shared/ipc";
import {
  autoApproveForMode,
  modeForAutoApprove,
  normalizeAutoApprove,
} from "../src/autoApprove";

const ALL_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];

const PROVIDERS: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
    permissionModes: ALL_MODES,
  },
  {
    id: "codex",
    name: "Codex",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
    permissionModes: ["default", "acceptEdits", "bypassPermissions"],
  },
];

afterEach(() => unmountAll());

describe("autoApprove mapping", () => {
  it("coarse modes map onto the matrix for display", () => {
    assert.equal(autoApproveForMode("default").readProject, true);
    assert.equal(autoApproveForMode("default").editProject, false);
    assert.equal(autoApproveForMode("acceptEdits").editProject, true);
    assert.equal(autoApproveForMode("acceptEdits").editAll, false);
    const full = autoApproveForMode("bypassPermissions");
    assert.ok(full.editAll && full.allCommands && full.web && full.mcp && full.readAll);
  });

  it("toggles pick the launch mode; Claude never goes past acceptEdits", () => {
    const everything = autoApproveForMode("bypassPermissions");
    const edits = normalizeAutoApprove({ readProject: true, editProject: true });
    const reads = normalizeAutoApprove({ readProject: true });
    assert.equal(modeForAutoApprove(reads, "claude", ALL_MODES, "acceptEdits"), "default");
    assert.equal(modeForAutoApprove(edits, "claude", ALL_MODES, "default"), "acceptEdits");
    assert.equal(modeForAutoApprove(everything, "claude", ALL_MODES, "default"), "acceptEdits");
    assert.equal(modeForAutoApprove(everything, "codex", ALL_MODES, "default"), "bypassPermissions");
    assert.equal(modeForAutoApprove(edits, "claude", ALL_MODES, "plan"), "plan");
    // Snaps to what the CLI honours.
    assert.equal(
      modeForAutoApprove(edits, "grok", ["plan", "bypassPermissions"], "default"),
      "bypassPermissions",
    );
  });

  it("children are forced off under an off parent", () => {
    const m = normalizeAutoApprove({ readAll: true, editAll: true, allCommands: true });
    assert.equal(m.readAll || m.editAll || m.allCommands, false);
    assert.equal(m.notify, true);
  });
});

function mountComposer(over: {
  provider?: string;
  permissionMode?: PermissionMode;
  autoApprove?: AutoApprove | null;
  calls?: Array<[AutoApprove, PermissionMode]>;
}) {
  return mount(
    <Composer
      threadId="t1"
      permissionMode={over.permissionMode ?? "default"}
      onPermissionModeChange={() => {}}
      autoApprove={over.autoApprove ?? null}
      onAutoApproveChange={(next, mode) => {
        over.calls?.push([next, mode]);
      }}
      provider={over.provider ?? "claude"}
      model={null}
      reasoningEffort={null}
      providers={PROVIDERS}
      workflows={[]}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSaveWorkflow={async (t) => ({ id: "s", name: t.name, builtin: false, phases: t.phases })}
      onRemoveWorkflow={async () => {}}
      sessionId={null}
      hasWorktree={true}
      onSend={() => {}}
      onBuild={() => {}}
    />,
  );
}

async function openMenu(m: Awaited<ReturnType<typeof mountComposer>>) {
  const pill = Array.from(m.queryAll("button")).find((b) =>
    (b.getAttribute("aria-label") || "").startsWith("Permission:"),
  );
  assert.ok(pill, "permission pill");
  await m.click(pill);
}

const box = (m: Awaited<ReturnType<typeof mountComposer>>, id: string) => {
  const el = m.query(`[data-auto-approve-toggle="${id}"]`) as HTMLInputElement | null;
  assert.ok(el, id);
  return el;
};

describe("Composer permission menu × auto-approve", () => {
  it("renders the matrix from the mode; children disabled until the parent is on", async () => {
    const m = await mountComposer({});
    await openMenu(m);
    assert.ok(m.query('[aria-label="Permission mode"]'), "modes listbox kept");
    assert.ok(m.query("[data-auto-approve]"), "matrix");
    const labels = Array.from(m.queryAll("[data-auto-approve] label")).map((l) =>
      l.textContent?.trim(),
    );
    assert.deepEqual(labels, [
      "Read project files",
      "Read all files",
      "Edit project files",
      "Edit all files",
      "Run safe commands",
      "Run all commands",
      "Browser / web fetch",
      "MCP tools",
      "Notify when an approval is needed",
    ]);
    assert.equal(box(m, "readProject").checked, true, "Ask first reads the project");
    assert.equal(box(m, "readAll").disabled, false);
    assert.equal(box(m, "editProject").checked, false);
    assert.equal(box(m, "editAll").disabled, true, "needs Edit project files");
    assert.equal(box(m, "allCommands").disabled, true, "needs Run safe commands");
    assert.equal(m.query("[data-auto-approve-note]"), null, "Claude enforces");
  });

  it("a toggle stores the matrix with the mode it launches in", async () => {
    const calls: Array<[AutoApprove, PermissionMode]> = [];
    const m = await mountComposer({ calls });
    await openMenu(m);
    await m.click(box(m, "editProject"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].editProject, true);
    assert.equal(calls[0][1], "acceptEdits");
    assert.ok(m.query("[data-auto-approve]"), "menu stays open");
  });

  it("enables a child once its parent is on; the pill says Auto-approve", async () => {
    const m = await mountComposer({
      autoApprove: normalizeAutoApprove({ readProject: true, editProject: true }),
      permissionMode: "acceptEdits",
    });
    const pill = Array.from(m.queryAll("button")).find((b) =>
      (b.getAttribute("aria-label") || "").startsWith("Permission:"),
    );
    assert.equal(pill?.getAttribute("aria-label"), "Permission: Auto-approve");
    await openMenu(m);
    assert.equal(box(m, "editAll").disabled, false);
    assert.equal(box(m, "editAll").checked, false, "stays off until enabled");
  });

  it("turning a parent off sends its children off", async () => {
    const calls: Array<[AutoApprove, PermissionMode]> = [];
    const m = await mountComposer({
      calls,
      autoApprove: normalizeAutoApprove({ safeCommands: true, allCommands: true }),
    });
    await openMenu(m);
    await m.click(box(m, "safeCommands"));
    assert.equal(calls[0][0].safeCommands, false);
    assert.equal(calls[0][0].allCommands, false);
  });

  it("a preset applies its toggles", async () => {
    const calls: Array<[AutoApprove, PermissionMode]> = [];
    const m = await mountComposer({ calls });
    await openMenu(m);
    const preset = m.query('[data-auto-approve-preset="Trusted"]');
    assert.ok(preset);
    await m.click(preset);
    assert.equal(calls[0][0].allCommands, true);
    assert.equal(calls[0][0].editAll, false, "Edit all files is never preset on");
    assert.equal(calls[0][1], "acceptEdits");
  });

  it("other CLIs say best effort and name the nearest mode", async () => {
    const m = await mountComposer({ provider: "codex" });
    await openMenu(m);
    const note = m.query("[data-auto-approve-note]");
    assert.ok(note);
    assert.match(note.textContent || "", /^Best effort: Codex .* Ask first, the nearest mode\.$/);
  });
});
