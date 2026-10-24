"use strict";
/**
 * Agent-filed Solenta bug reports (#1703): the coder-threads tool
 * solenta_bug_report rides the /feedback path (feedback.js → feedback-api →
 * postgres). No new backend.
 *
 * Privacy: title, body and the last tool error go through the #394 report
 * redactor (secret-card values, guardrail secret shapes, bearer tokens, PEM
 * blocks), then every absolute path is replaced. The thread's worktree and
 * project roots keep their repo-relative tail; anything else becomes <path>.
 * No env, no file contents beyond what the agent wrote in the body.
 */

const os = require("node:os");
const privacyGateway = require("./privacyGateway.js");
const feedback = require("./feedback.js");

const TITLE_MAX = 200;
const TOOL_ERROR_MAX = 300;
const DAILY_MAX = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Absolute POSIX path (two+ segments, not inside a URL or a relative path) or
 * a Windows drive path. `>` keeps the tail after a <worktree> placeholder.
 * ponytail: a path with a space outside the known roots keeps its tail after
 * the space ("<path> Support/x"). Add a quoted-path pass if that leaks.
 */
const ABS_PATH = /(?<![\w.:/~>])~?\/(?:[\w.@+-]+\/)+[\w.@+-]*|\b[A-Za-z]:\\[^\s"'<>|]*/g;

/**
 * @param {string} threadId
 * @param {Array<[string | null | undefined, string]>} roots - [path, placeholder]
 * @returns {(value: unknown) => string}
 */
function scrubber(threadId, roots) {
  const r = privacyGateway.redactor(threadId);
  const known = roots
    .filter(([p]) => typeof p === "string" && p.length > 1)
    // Longest first: the worktree usually sits under home or userData.
    .sort((a, b) => String(b[0]).length - String(a[0]).length);
  return (value) => {
    let s = r.text(value);
    for (const [p, label] of known) s = s.split(String(p)).join(label);
    return s.replace(ABS_PATH, "<path>");
  };
}

/**
 * Last errored tool call on the thread, as "Name: first chars of output".
 * @param {Array<{ role?: string, tool?: { name?: string, output?: string | null, isError?: boolean } }>} messages
 */
function lastToolError(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const tool = messages[i] && messages[i].role === "tool" && messages[i].tool;
    if (tool && tool.isError) {
      const out = String(tool.output || "").replace(/\s+/g, " ").trim();
      return `${tool.name || "tool"}: ${out.slice(0, TOOL_ERROR_MAX)}`;
    }
  }
  return null;
}

/**
 * Pure: the exact feedback payload. Everything in `text` is scrubbed.
 * @param {{
 *   thread: { id: string, provider?: string | null, model?: string | null, worktreePath?: string | null },
 *   messages?: any[],
 *   projectPath?: string | null,
 *   userDataPath?: string | null,
 *   home?: string,
 *   title: unknown,
 *   body: unknown,
 *   version: string,
 *   platform?: string,
 *   osRelease?: string,
 * }} input
 * @returns {{ text: string, version: string, platform: string, title: string }}
 */
function buildBugReport(input) {
  const { thread } = input;
  const scrub = scrubber(thread.id, [
    [thread.worktreePath, "<worktree>"],
    [input.projectPath, "<project>"],
    [input.userDataPath, "<userData>"],
    [input.home ?? os.homedir(), "~"],
  ]);
  const title = scrub(String(input.title ?? "").replace(/\s+/g, " ").trim()).slice(0, TITLE_MAX);
  if (!title) throw new Error("title is required.");
  const platform = input.platform || `${process.platform} ${process.arch}`;
  const toolError = lastToolError(input.messages || []);
  const context = [
    "",
    "--",
    `app: ${input.version}`,
    `os: ${platform} ${input.osRelease ?? os.release()}`,
    `provider: ${thread.provider || "unknown"}`,
    `model: ${thread.model || "default"}`,
    `thread: ${thread.id}`,
    ...(toolError ? [`last tool error: ${scrub(toolError)}`] : []),
  ].join("\n");
  const head = `[agent bug report] ${title}\n\n`;
  const room = feedback.MAX_TEXT - head.length - context.length - 1;
  const body = scrub(String(input.body ?? "").trim()).slice(0, Math.max(0, room));
  return { text: `${head}${body}\n${context}`, version: input.version, platform, title };
}

/**
 * ponytail: in-memory, so a restart resets the allowance. The endpoint's own
 * per-IP limit (5/hour) still holds. Persist on the thread if agents abuse it.
 * @type {Map<string, Array<{ title: string, at: number }>>}
 */
const sent = new Map();

/** @param {string} title */
const titleKey = (title) => title.toLowerCase();

/**
 * Rate limit (DAILY_MAX per thread per rolling day) and per-thread title
 * dedupe, then send. Only a successful send counts against the allowance.
 * @param {string} threadId
 * @param {ReturnType<typeof buildBugReport>} report
 * @param {{ fetch?: typeof fetch, now?: number }} [deps]
 * @returns {Promise<{ sent: boolean, duplicate?: boolean, remainingToday: number }>}
 */
async function fileBugReport(threadId, report, deps = {}) {
  const now = deps.now ?? Date.now();
  const past = sent.get(threadId) || [];
  const today = past.filter((e) => now - e.at < DAY_MS);
  if (past.some((e) => e.title === titleKey(report.title))) {
    return { sent: false, duplicate: true, remainingToday: DAILY_MAX - today.length };
  }
  if (today.length >= DAILY_MAX) {
    throw new Error(
      `Bug report limit reached: ${DAILY_MAX} per thread per day. Mention the defect in your reply instead.`,
    );
  }
  await feedback.sendFeedback(report, { fetch: deps.fetch });
  past.push({ title: titleKey(report.title), at: now });
  sent.set(threadId, past);
  return { sent: true, remainingToday: DAILY_MAX - today.length - 1 };
}

/**
 * Settings toggle, on by default: only an explicit false hides the tool.
 * @param {{ getSettings?: () => { agentBugReports?: boolean } } | null | undefined} store
 */
function bugReportsEnabled(store) {
  if (!store || typeof store.getSettings !== "function") return true;
  return store.getSettings().agentBugReports !== false;
}

/** Tests only. */
function resetBugReportLimits() {
  sent.clear();
}

module.exports = {
  DAILY_MAX,
  buildBugReport,
  bugReportsEnabled,
  fileBugReport,
  lastToolError,
  resetBugReportLimits,
};
