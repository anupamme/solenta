/**
 * #1716: the composer's model pill shows both models while plan mode runs on
 * a separate plan model, and the picker's "Plan with…" selector only exists
 * for providers that resume one session across models.
 *
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/planModelChip.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll, inAct } from "./support/dom.ts";
import { Composer } from "../src/components/Composer";
import { planActTriggerLabel } from "../src/modelPicker";
import type { PermissionMode, ProviderInfo } from "../src/shared/ipc";

const CLAUDE: ProviderInfo = {
  id: "claude",
  name: "Claude Code",
  available: true,
  supportsResume: true,
  supportsPlanModel: true,
  models: ["claude-sonnet-5-5", "claude-opus-5-5"],
  modelInfo: [
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5", description: "", vendor: "Anthropic" },
    { id: "claude-opus-5-5", label: "Opus 5.5", description: "", vendor: "Anthropic" },
  ],
  efforts: [],
  permissionModes: ["default", "plan"],
};

const GROK: ProviderInfo = {
  ...CLAUDE,
  id: "grok",
  name: "Grok",
  supportsPlanModel: undefined,
  models: ["grok-4.7"],
  modelInfo: [{ id: "grok-4.7", label: "Grok 4.7", description: "", vendor: "xAI" }],
};

afterEach(() => unmountAll());

function view(
  over: {
    provider?: string;
    permissionMode?: PermissionMode;
    planModel?: string | null;
    onSetPlanModel?: (model: string | null) => void;
  } = {},
) {
  return (
    <Composer
      threadId="t1"
      permissionMode={over.permissionMode ?? "plan"}
      onPermissionModeChange={() => {}}
      provider={over.provider ?? "claude"}
      model="claude-sonnet-5-5"
      reasoningEffort={null}
      providers={[CLAUDE, GROK]}
      workflows={[]}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onApplyAgentProfile={() => {}}
      planModel={over.planModel === undefined ? "claude-opus-5-5" : over.planModel}
      onSetPlanModel={over.onSetPlanModel ?? (() => {})}
      onSaveWorkflow={async (t) => ({ id: "s", name: t.name, builtin: false, phases: t.phases })}
      onRemoveWorkflow={async () => {}}
      sessionId={null}
      disabled={false}
      busy={false}
      onSend={() => {}}
      onBuild={() => {}}
    />
  );
}

const pillLabel = (m: Awaited<ReturnType<typeof mount>>) =>
  m.query('button[aria-label^="Model:"]')?.getAttribute("aria-label");

describe("plan/act model pill (#1716)", () => {
  it("shows both models in plan mode with a plan model", async () => {
    const m = await mount(view());
    assert.equal(pillLabel(m), "Model: Plan: Opus 5.5 · Act: Sonnet 5.5");
  });

  it("shows only the act model outside plan mode or without a plan model", async () => {
    const m = await mount(view({ permissionMode: "default" }));
    assert.equal(pillLabel(m), "Model: Sonnet 5.5");
    const n = await mount(view({ planModel: null }));
    assert.equal(pillLabel(n), "Model: Sonnet 5.5");
  });

  it("ignores a plan model on a provider without supportsPlanModel", () => {
    assert.equal(planActTriggerLabel("plan", "grok-4.7", "grok-4.7", GROK), null);
  });

  it("offers Plan with… in the picker and saves the pick", async () => {
    const picks: (string | null)[] = [];
    const m = await mount(view({ planModel: null, onSetPlanModel: (id) => picks.push(id) }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    const select = m.query("[data-picker-plan] select") as HTMLSelectElement | null;
    assert.ok(select, "Plan with… is offered for claude");
    await inAct(() => {
      select.value = "claude-opus-5-5";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.deepEqual(picks, ["claude-opus-5-5"]);
  });

  it("hides Plan with… for providers that cannot resume across models", async () => {
    const m = await mount(view({ provider: "grok", planModel: null }));
    await m.click(m.query('button[aria-label^="Model:"]'));
    assert.ok(m.query('[role="dialog"][aria-label="Model picker"]'));
    assert.equal(m.query("[data-picker-plan]"), null);
  });
});
