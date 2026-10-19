/**
 * ApprovalsView (#291): cross-thread queue, inline vs open-in-thread rows,
 * batch answers target only the selected requestIds.
 *
 * Run: npm run test:renderer -- test/approvalsView.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom.ts";
import { ApprovalsView } from "../src/components/ApprovalsView";
import type { PendingApprovalInfo, ProjectInfo } from "../src/shared/ipc";

function row(over: Partial<PendingApprovalInfo> & Pick<PendingApprovalInfo, "requestId" | "threadId">): PendingApprovalInfo {
  return {
    toolName: "Bash",
    summary: `Bash: ${over.requestId}`,
    input: "{}",
    command: null,
    threadTitle: over.threadId === "a" ? "Thread A" : "Thread B",
    projectId: "p1",
    provider: "claude",
    since: null,
    ...over,
  };
}

const projects = [{ id: "p1", name: "acme" }] as unknown as ProjectInfo[];

async function view(rows: PendingApprovalInfo[]) {
  const calls: Array<{ threadId: string; requestId: string; decision: string }> = [];
  const opened: string[] = [];
  const m = await mount(
    <ApprovalsView
      projects={projects}
      threads={[]}
      loadApprovals={async () => rows}
      respond={async (input) => {
        calls.push({ threadId: input.threadId, requestId: input.requestId, decision: input.decision });
      }}
      onSelectThread={(id) => opened.push(id)}
    />,
  );
  return { m, calls, opened };
}

describe("ApprovalsView (#291)", () => {
  it("shows an empty state", async () => {
    const { m } = await view([]);
    assert.ok(m.text().includes("Nothing is waiting on you."));
    m.unmount();
  });

  it("groups by thread and sends rich prompts to their thread", async () => {
    const { m, calls, opened } = await view([
      row({ threadId: "a", requestId: "a1", command: "npm test" }),
      row({ threadId: "a", requestId: "plan", toolName: "ExitPlanMode", summary: "Plan approval", plan: "# do it" }),
      row({ threadId: "b", requestId: "b1" }),
    ]);
    const text = m.text();
    assert.ok(text.includes("Approvals · 3"));
    assert.ok(text.includes("Thread A") && text.includes("Thread B"));
    assert.ok(text.includes("npm test"));
    // Two inline rows + select all; the plan row has no checkbox.
    assert.equal(m.queryAll('input[type="checkbox"]').length, 3);
    await m.click(m.byText("Open thread to answer"));
    assert.deepEqual(opened, ["a"]);
    assert.deepEqual(calls, []);
    m.unmount();
  });

  it("answers one row without touching the others", async () => {
    const { m, calls } = await view([
      row({ threadId: "a", requestId: "a1" }),
      row({ threadId: "b", requestId: "b1" }),
    ]);
    const denies = m.queryAll("button").filter((b) => b.textContent === "Deny");
    await m.click(denies[1]);
    assert.deepEqual(calls, [{ threadId: "b", requestId: "b1", decision: "deny" }]);
    m.unmount();
  });

  it("batch-allows only the selected rows", async () => {
    const { m, calls } = await view([
      row({ threadId: "a", requestId: "a1" }),
      row({ threadId: "a", requestId: "a2" }),
      row({ threadId: "b", requestId: "b1" }),
    ]);
    await m.click(m.query('input[aria-label="Select Bash: a2"]'));
    await m.click(m.query('input[aria-label="Select Bash: b1"]'));
    await m.click(m.byText("Allow 2"));
    assert.deepEqual(calls, [
      { threadId: "a", requestId: "a2", decision: "allow" },
      { threadId: "b", requestId: "b1", decision: "allow" },
    ]);
    m.unmount();
  });

  it("hides Allow for session where the thread card would", async () => {
    const { m } = await view([
      row({ threadId: "a", requestId: "a1", guardrail: { rule: null, reason: "always confirm", layer: "profile.ask" } }),
    ]);
    assert.ok(m.text().includes("always confirm"));
    assert.equal(m.byText("Allow for session"), null);
    m.unmount();
  });
});
