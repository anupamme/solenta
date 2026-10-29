"use strict";

const userHooks = require("./user-hooks.js");

/** Hook commands run on this host; only the desktop app may approve or test them. */
function requireDesktop(ctx) {
  if (ctx.transport !== "desktop") {
    throw new Error("Approving and testing hooks requires the desktop app.");
  }
}

function projectPath(ctx, input) {
  const id = input && typeof input.projectId === "string" ? input.projectId : "";
  if (!id) return null;
  const project = ctx.store.getProject(id);
  if (!project) throw new Error(`Unknown project: ${id}`);
  // Remote projects run agents elsewhere; their hooks are not supported yet.
  return project.remoteHost ? null : project.path;
}

/** IPC_HANDLERS rows for hooks:* (#1724); ipc.js spreads them in. */
module.exports = {
  "hooks:list": async (ctx, input) =>
    userHooks.listHooks({
      userDataPath: ctx.userDataPath,
      projectPath: projectPath(ctx, input),
    }),
  "hooks:approve": async (ctx, input) => {
    requireDesktop(ctx);
    const p = projectPath(ctx, input);
    if (!p) throw new Error("Pick a local project to approve its hooks.");
    return userHooks.approveProjectHooks({
      userDataPath: ctx.userDataPath,
      projectPath: p,
      hash: String((input && input.hash) || ""),
    });
  },
  "hooks:test": async (ctx, input) => {
    requireDesktop(ctx);
    return userHooks.testHook({
      userDataPath: ctx.userDataPath,
      projectPath: projectPath(ctx, input),
      id: String((input && input.id) || ""),
    });
  },
};
