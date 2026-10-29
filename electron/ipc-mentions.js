"use strict";

const terminal = require("./terminal.js");
const sources = require("./mentionSources.js");

/**
 * Thread root for a mention source: worktree when bound, else the project
 * checkout. Same resolution as git:diff / terminal:open.
 *
 * @param {any} ctx
 * @param {unknown} threadId
 */
function threadRoot(ctx, threadId) {
  const thread = typeof threadId === "string" ? ctx.store.getThread(threadId) : null;
  if (!thread) throw new Error(`Unknown thread: ${threadId}`);
  const project = ctx.store.getProject(thread.projectId);
  const cwd = thread.worktreePath || (project && project.path);
  if (!cwd) throw new Error(`Unknown project for thread: ${threadId}`);
  return { thread, project, cwd };
}

/** IPC_HANDLERS rows for mentions:* (#1722); ipc.js spreads them in. */
module.exports = {
  "mentions:fetchUrl": async (ctx, input) => {
    threadRoot(ctx, input && input.threadId);
    return sources.fetchUrl(input && input.url);
  },
  "mentions:terminalTail": async (ctx, input) => {
    const threadId = input && input.threadId;
    threadRoot(ctx, threadId);
    const logDir = ctx.userDataPath ? terminal.logDirIn(ctx.userDataPath) : undefined;
    return sources.terminalTail(terminal, threadId, logDir);
  },
  "mentions:runProblems": async (ctx, input) => {
    const { thread, project, cwd } = threadRoot(ctx, input && input.threadId);
    return sources.runProblems({
      requestId: String((input && input.requestId) || ""),
      command: thread.verifyCommand,
      cwd,
      project,
    });
  },
  "mentions:cancelProblems": async (_ctx, input) =>
    sources.cancelProblems(String((input && input.requestId) || "")),
  "mentions:gitChanges": async (ctx, input) => {
    const { project, cwd } = threadRoot(ctx, input && input.threadId);
    return sources.gitChanges(project, cwd);
  },
  "mentions:listCommits": async (ctx, input) => {
    const { project, cwd } = threadRoot(ctx, input && input.threadId);
    return sources.listCommits(project, cwd);
  },
  "mentions:showCommit": async (ctx, input) => {
    const { project, cwd } = threadRoot(ctx, input && input.threadId);
    return sources.showCommit(project, cwd, input && input.sha);
  },
};
