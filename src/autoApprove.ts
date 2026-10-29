import type { AutoApprove, PermissionMode } from "./shared/ipc";
import { PERMISSION_MODE_LABELS, snapToHonouredPermissionMode } from "./format";

/**
 * Auto-approve toggles (#1721). Twin of electron/autoApprove.js (ids,
 * labels, parents); keep in lockstep. The electron side compiles them to
 * governance rules; this side renders them and picks the coarse mode the
 * CLI is launched with.
 */

export type AutoApproveId = keyof AutoApprove;

export const AUTO_APPROVE_TOGGLES: ReadonlyArray<{
  id: AutoApproveId;
  label: string;
  /** Child toggle: disabled (and off) until this one is on. */
  parent?: AutoApproveId;
}> = [
  { id: "readProject", label: "Read project files" },
  { id: "readAll", label: "Read all files", parent: "readProject" },
  { id: "editProject", label: "Edit project files" },
  { id: "editAll", label: "Edit all files", parent: "editProject" },
  { id: "safeCommands", label: "Run safe commands" },
  { id: "allCommands", label: "Run all commands", parent: "safeCommands" },
  { id: "web", label: "Browser / web fetch" },
  { id: "mcp", label: "MCP tools" },
  { id: "notify", label: "Notify when an approval is needed" },
];

const OFF: AutoApprove = {
  readProject: false,
  readAll: false,
  editProject: false,
  editAll: false,
  safeCommands: false,
  allCommands: false,
  web: false,
  mcp: false,
  notify: true,
};

/** Children forced off under an off parent; same rule as the electron side. */
export function normalizeAutoApprove(m: Partial<AutoApprove>): AutoApprove {
  const out = { ...OFF, ...m };
  for (const t of AUTO_APPROVE_TOGGLES) {
    if (t.parent && !out[t.parent]) out[t.id] = false;
  }
  return out;
}

/** What a coarse mode means, for threads with no toggles of their own. */
export function autoApproveForMode(mode: PermissionMode): AutoApprove {
  if (mode === "bypassPermissions") {
    return normalizeAutoApprove({
      readProject: true,
      readAll: true,
      editProject: true,
      editAll: true,
      safeCommands: true,
      allCommands: true,
      web: true,
      mcp: true,
    });
  }
  const edits = mode === "acceptEdits" || mode === "auto";
  return normalizeAutoApprove({ readProject: true, editProject: edits });
}

export const AUTO_APPROVE_PRESETS: ReadonlyArray<{ name: string; value: AutoApprove }> = [
  { name: "Ask first", value: normalizeAutoApprove({ readProject: true }) },
  {
    name: "Project edits",
    value: normalizeAutoApprove({ readProject: true, editProject: true, safeCommands: true }),
  },
  {
    name: "Trusted",
    value: normalizeAutoApprove({
      readProject: true,
      readAll: true,
      editProject: true,
      safeCommands: true,
      allCommands: true,
      web: true,
      mcp: true,
    }),
  },
];

/**
 * Only Claude answers every tool call through Solenta (can_use_tool); other
 * CLIs get the nearest coarse mode and the toggles are best effort.
 */
export function enforcesAutoApprove(provider: string | null | undefined): boolean {
  return (provider ?? "").split(":")[0] === "claude";
}

/** Same "best effort" wording as the MCP per-tool rules (#1729). */
export function autoApproveBestEffort(name: string, mode: PermissionMode): string {
  return `Best effort: ${name} has no per-call approval hook, so it runs in ${PERMISSION_MODE_LABELS[mode]}, the nearest mode.`;
}

/**
 * Mode the CLI is launched with for these toggles. Never more permissive
 * than the toggles on Claude (the rules add the rest per call). Elsewhere
 * the nearest honoured mode. Plan stays plan.
 */
export function modeForAutoApprove(
  m: AutoApprove,
  provider: string | null | undefined,
  honoured: PermissionMode[],
  current: PermissionMode,
): PermissionMode {
  if (current === "plan") return "plan";
  const everything =
    m.readAll && m.editAll && m.allCommands && m.web && m.mcp;
  const mode: PermissionMode =
    !enforcesAutoApprove(provider) && everything
      ? "bypassPermissions"
      : m.editProject
        ? "acceptEdits"
        : "default";
  return snapToHonouredPermissionMode(honoured, mode);
}

/** True when two matrices are the same toggles. */
export function sameAutoApprove(a: AutoApprove, b: AutoApprove): boolean {
  return AUTO_APPROVE_TOGGLES.every((t) => a[t.id] === b[t.id]);
}
