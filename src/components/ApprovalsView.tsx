import { useCallback, useEffect, useMemo, useState } from "react";
import { errorMessage } from "../coder/errorMessage";
import { formatElapsed } from "../format";
import type {
  CoderApi,
  PendingApprovalInfo,
  PermissionDecision,
  ProjectInfo,
  ThreadInfo,
} from "../shared/ipc";
import styles from "./ApprovalsView.module.css";

export interface ApprovalsViewProps {
  projects: readonly ProjectInfo[];
  /** Refetch trigger: every threads:changed push replaces this array. */
  threads: readonly ThreadInfo[];
  loadApprovals: () => Promise<PendingApprovalInfo[]>;
  respond: CoderApi["threads"]["respondPermission"];
  onSelectThread: (id: string) => void;
}

const keyOf = (a: PendingApprovalInfo) => `${a.threadId}\u0000${a.requestId}`;

/**
 * Plain tool prompts can be answered from a row. Questions, typed input,
 * plans, Codex diffs and the CI sign-off need their card in the thread.
 */
export function answerableInline(a: PendingApprovalInfo): boolean {
  return (
    !a.questions?.length &&
    !a.inputRequest &&
    !a.plan &&
    !a.fileChange &&
    a.guardrail?.rule !== "CI_WORKFLOW"
  );
}

/** Allow for session is offered only where the thread card offers it. */
function canAllowAlways(a: PendingApprovalInfo): boolean {
  return a.acceptAlways !== false && a.guardrail?.layer !== "profile.ask";
}

/**
 * Approval inbox (#291): every pending prompt across threads in one queue.
 * Each answer targets one requestId, so resolving a row never advances an
 * unrelated one; the list refetches from the host after every push.
 */
export function ApprovalsView({
  projects,
  threads,
  loadApprovals,
  respond,
  onSelectThread,
}: ApprovalsViewProps) {
  const [items, setItems] = useState<PendingApprovalInfo[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadApprovals().then(
      (rows) => {
        if (!live) return;
        setItems(rows);
        // Drop selections whose prompt is gone; keep the rest untouched.
        const keys = new Set(rows.map(keyOf));
        setSelected((prev) => new Set([...prev].filter((k) => keys.has(k))));
      },
      (err) => live && setError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [loadApprovals, threads]);

  const answer = useCallback(
    async (rows: readonly PendingApprovalInfo[], decision: PermissionDecision) => {
      const keys = rows.map(keyOf);
      setBusy((prev) => new Set([...prev, ...keys]));
      const failures: string[] = [];
      // ponytail: sequential, one IPC per row; a batch call when queues get long.
      for (const a of rows) {
        try {
          await respond({ threadId: a.threadId, requestId: a.requestId, decision });
        } catch (err) {
          failures.push(`${a.summary}: ${errorMessage(err)}`);
        }
      }
      setBusy((prev) => new Set([...prev].filter((k) => !keys.includes(k))));
      setSelected((prev) => new Set([...prev].filter((k) => !keys.includes(k))));
      setError(failures.length ? failures.join("\n") : null);
    },
    [respond],
  );

  const projectName = useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects],
  );
  const groups = useMemo(() => {
    const byThread = new Map<string, PendingApprovalInfo[]>();
    for (const a of items ?? []) {
      const list = byThread.get(a.threadId) ?? [];
      list.push(a);
      byThread.set(a.threadId, list);
    }
    return [...byThread.values()];
  }, [items]);
  const inline = (items ?? []).filter(answerableInline);
  const picked = inline.filter((a) => selected.has(keyOf(a)));
  const allPicked = inline.length > 0 && picked.length === inline.length;

  const toggle = (k: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <main className={styles.main} aria-label="Approvals">
      <header className={styles.header}>
        <h1 className={styles.title}>
          Approvals{items && items.length > 0 ? ` · ${items.length}` : ""}
        </h1>
        {inline.length > 0 && (
          <div className={styles.controls}>
            <label className={styles.selectAll}>
              <input
                type="checkbox"
                checked={allPicked}
                onChange={() =>
                  setSelected(allPicked ? new Set() : new Set(inline.map(keyOf)))
                }
              />
              Select all
            </label>
            <button
              type="button"
              className={styles.button}
              disabled={picked.length === 0}
              onClick={() => void answer(picked, "allow")}
            >
              Allow {picked.length || ""}
            </button>
            <button
              type="button"
              className={styles.button}
              data-deny
              disabled={picked.length === 0}
              onClick={() => void answer(picked, "deny")}
            >
              Deny {picked.length || ""}
            </button>
          </div>
        )}
      </header>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.list}>
        {items == null ? null : items.length === 0 ? (
          <p className={styles.empty}>Nothing is waiting on you.</p>
        ) : (
          groups.map((rows) => {
            const head = rows[0];
            return (
              <section key={head.threadId} className={styles.group}>
                <h2 className={styles.groupHeader}>
                  <button
                    type="button"
                    className={styles.threadLink}
                    onClick={() => onSelectThread(head.threadId)}
                  >
                    {head.threadTitle}
                  </button>
                  <span className={styles.groupMeta}>
                    {projectName.get(head.projectId) ?? ""} · {head.provider}
                    {head.since != null ? ` · ${formatElapsed(head.since)}` : ""}
                  </span>
                </h2>
                {rows.map((a) => {
                  const k = keyOf(a);
                  const quick = answerableInline(a);
                  const working = busy.has(k);
                  return (
                    <div key={k} className={styles.row} data-risky={a.guardrail ? "" : undefined}>
                      <div className={styles.rowTop}>
                        {quick && (
                          <input
                            type="checkbox"
                            aria-label={`Select ${a.summary}`}
                            checked={selected.has(k)}
                            disabled={working}
                            onChange={() => toggle(k)}
                          />
                        )}
                        <span className={styles.summary}>{a.summary}</span>
                      </div>
                      {a.command && <code className={styles.command}>{a.command}</code>}
                      {a.guardrail && (
                        <p className={styles.reason}>{a.guardrail.reason}</p>
                      )}
                      <div className={styles.actions}>
                        {quick ? (
                          <>
                            <button
                              type="button"
                              className={styles.button}
                              disabled={working}
                              onClick={() => void answer([a], "allow")}
                            >
                              Allow
                            </button>
                            {canAllowAlways(a) && (
                              <button
                                type="button"
                                className={styles.button}
                                disabled={working}
                                onClick={() => void answer([a], "allowAlways")}
                              >
                                Allow for session
                              </button>
                            )}
                            <button
                              type="button"
                              className={styles.button}
                              data-deny
                              disabled={working}
                              onClick={() => void answer([a], "deny")}
                            >
                              Deny
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className={styles.button}
                            onClick={() => onSelectThread(a.threadId)}
                          >
                            Open thread to answer
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </section>
            );
          })
        )}
      </div>
    </main>
  );
}
