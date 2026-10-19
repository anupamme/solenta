/**
 * Hard budget cap card (#286): opens from the thread menu, appears on its
 * own once the thread is over its cap, and saves through onSetBudget.
 *
 * Run: npm run test:renderer -- test/budgetCard.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import { budgetReached, budgetToDraft, draftToBudget } from "../src/budget";
import type {
  ProjectInfo,
  ProviderInfo,
  SessionUsage,
  ThreadBudget,
  ThreadDetail,
  ThreadInfo,
} from "../src/shared/ipc";

const project: ProjectInfo = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
};

const providers: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

function thread(extra: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t1",
    projectId: "p1",
    title: "budget card",
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "done",
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    muted: false,
    ejected: false,
    notes: "",
    queued: null,
    lastVisitedAt: null,
    prState: null,
    verifyCommand: null,
    verify: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: null,
    handoffFrom: null,
    ...extra,
  };
}

function detail(
  extra: Partial<ThreadInfo> = {},
  usage: SessionUsage | null = null,
): ThreadDetail {
  return {
    thread: thread(extra),
    messages: [],
    workLog: [],
    workflow: null,
    usage,
    pendingPermission: null,
  };
}

async function mountView(
  d: ThreadDetail,
  extras: {
    onSetBudget?: (threadId: string, budget: ThreadBudget | null) => Promise<void>;
  } = {},
) {
  const view = await mount(
    <ThreadView
      detail={d}
      project={project}
      providers={providers}
      workflows={[]}
      hasProjects={true}
      onAddProject={() => {}}
      onStartRun={() => {}}
      onStartWorkflow={() => {}}
      onSaveWorkflow={async () => ({ id: "w", name: "s", phases: [] })}
      onRemoveWorkflow={async () => {}}
      onStopRun={() => {}}
      onSetPermissionMode={() => {}}
      onRespondPermission={() => {}}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onDeleteThread={() => {}}
      onSetBudget={extras.onSetBudget}
      changesOpen={false}
      changesNonce={0}
      onCloseChanges={() => {}}
      onFetchDiff={async () => ({ files: [], patch: "" })}
      onCommitChanges={async () => ({ subject: "" })}
      onRevertFile={async () => ({ path: "" })}
      onSuggestCommitMessage={async () => ({ message: "" })}
    />,
  );
  await view.flush();
  return view;
}

const spent: SessionUsage = {
  model: null,
  inputTokens: 100,
  outputTokens: 50,
  costUsd: 2.5,
  turns: 3,
};

describe("budget draft helpers", () => {
  it("round-trips, drops blanks, rejects junk", () => {
    assert.deepEqual(draftToBudget(budgetToDraft({ usd: 1.5, minutes: 30 })), {
      usd: 1.5,
      minutes: 30,
    });
    assert.equal(draftToBudget(budgetToDraft(null)), null);
    assert.throws(
      () => draftToBudget({ ...budgetToDraft(null), turns: "0" }),
      /Turns cap must be a positive number/,
    );
  });

  it("budgetReached mirrors the backend lifetime axes", () => {
    assert.equal(budgetReached({ usd: 3 }, spent), null);
    assert.equal(budgetReached({ usd: 2.5 }, spent), "$2.50 of $2.50");
    assert.equal(budgetReached({ tokens: 150 }, spent), "150 of 150 tokens");
    assert.equal(budgetReached({ turns: 3 }, spent), "3 of 3 turns");
    assert.equal(budgetReached({ minutes: 1 }, spent), null);
  });
});

describe("BudgetCard", () => {
  it("stays hidden under the cap until opened from the thread menu", async () => {
    const calls: Array<[string, ThreadBudget | null]> = [];
    const view = await mountView(detail({ budget: { usd: 10 } }, spent), {
      onSetBudget: async (id, b) => {
        calls.push([id, b]);
      },
    });
    assert.equal(view.query("[data-budget-card]"), null);
    await view.click(view.query("[data-thread-title-menu]"));
    const item = view.query("[data-budget-menu]");
    assert.match(item?.textContent ?? "", /Edit budget cap/);
    await view.click(item);
    assert.ok(view.query("[data-budget-card]"), "opened");
    assert.match(view.text(), /Hitting any limit stops the run and asks you/);
    await view.type(view.query('[data-budget-field="turns"]'), "12");
    await view.click(view.query("[data-budget-save]"));
    assert.deepEqual(calls, [["t1", { usd: 10, turns: 12 }]]);
    view.unmount();
  });

  it("asks on its own once the thread is over its cap; raise or clear", async () => {
    const calls: Array<[string, ThreadBudget | null]> = [];
    const view = await mountView(detail({ status: "idle", budget: { usd: 2 } }, spent), {
      onSetBudget: async (id, b) => {
        calls.push([id, b]);
      },
    });
    assert.ok(view.query("[data-budget-card]"));
    assert.match(view.text(), /Budget cap reached: \$2\.50 of \$2\.00/);
    assert.equal(view.query("[data-budget-close]"), null, "no dismiss while over");
    await view.click(view.query("[data-budget-clear]"));
    assert.deepEqual(calls, [["t1", null]]);
    view.unmount();
  });

  it("shows a rejected value inline and does not save", async () => {
    const calls: unknown[] = [];
    const view = await mountView(detail({ status: "idle", budget: { usd: 2 } }, spent), {
      onSetBudget: async (...a) => {
        calls.push(a);
      },
    });
    await view.type(view.query('[data-budget-field="usd"]'), "-4");
    await view.click(view.query("[data-budget-save]"));
    assert.equal(calls.length, 0);
    assert.match(view.query("[data-budget-error]")?.textContent ?? "", /USD cap must be a positive number/);
    view.unmount();
  });

  it("is absent without a handler and on Ask threads", async () => {
    const none = await mountView(detail({ budget: { usd: 1 } }, spent));
    assert.equal(none.query("[data-budget-card]"), null);
    none.unmount();
    const ask = await mountView(detail({ ask: true, budget: { usd: 1 } }, spent), {
      onSetBudget: async () => {},
    });
    assert.equal(ask.query("[data-budget-card]"), null);
    ask.unmount();
  });
});
