"use strict";

/**
 * "Run safe commands" auto-approve (#1721): the curated read-only list.
 *
 * Judged on parsed argv, never on substrings. Anything the shell would
 * treat as more than one simple command (`;` `&&` `|` `&`, redirects,
 * `$(...)`, backticks, `$VAR`, subshells, a leading `FOO=1`) is not safe,
 * whatever the first word is. Quoted operators are just argument text.
 */

/** Unicode the shell would not show: same class as governance HIDDEN. */
const HIDDEN = /[​-‏‪-‮⁦-⁩﻿]/;

/** Unquoted characters that make it not a single simple command. */
const OPERATORS = new Set([";", "&", "|", "<", ">", "(", ")", "`", "$"]);

/**
 * Split a command into argv like sh would, or null when it is not one plain
 * command. ponytail: no `$'...'`, no heredocs, no line continuations; they
 * all come back null (not safe), which is the right answer for them anyway.
 * @param {string} command
 * @returns {string[] | null}
 */
function parseArgv(command) {
  const s = String(command).normalize("NFKC");
  if (HIDDEN.test(s) || /[\r\n\0]/.test(s)) return null;
  const argv = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += s.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      i++;
      for (; i < s.length && s[i] !== '"'; i++) {
        // `$` and backticks still expand inside double quotes.
        if (s[i] === "$" || s[i] === "`") return null;
        if (s[i] === "\\" && i + 1 < s.length) i++;
        cur += s[i];
      }
      if (i >= s.length) return null;
      inWord = true;
    } else if (c === "\\") {
      if (i + 1 >= s.length) return null;
      cur += s[++i];
      inWord = true;
    } else if (c === " " || c === "\t") {
      if (inWord) argv.push(cur);
      cur = "";
      inWord = false;
    } else if (OPERATORS.has(c)) {
      return null;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) argv.push(cur);
  return argv.length ? argv : null;
}

/** `find` actions that run, delete or write. */
const FIND_UNSAFE = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

/** Listing-only `git branch` flags; anything else could create or delete. */
const GIT_BRANCH_FLAGS = new Set([
  "-a",
  "-r",
  "-v",
  "-vv",
  "-l",
  "--list",
  "--all",
  "--remotes",
  "--verbose",
  "--show-current",
  "--no-color",
]);

/** @param {string[]} args @param {string} flag */
const hasFlag = (args, flag) =>
  args.some((a) => a === flag || a.startsWith(`${flag}=`));

/**
 * The list. Each entry decides on the arguments after the program name.
 * @type {Record<string, (args: string[]) => boolean>}
 */
const SAFE = {
  ls: () => true,
  cat: () => true,
  head: () => true,
  tail: () => true,
  wc: () => true,
  pwd: () => true,
  which: () => true,
  grep: () => true,
  // --pre runs a program on every file it searches.
  rg: (args) => !hasFlag(args, "--pre"),
  find: (args) => !args.some((a) => FIND_UNSAFE.has(a)),
  git: (args) => {
    const [sub, ...rest] = args;
    // No global options: `git -c core.pager=… log` runs a command.
    if (!sub || sub.startsWith("-")) return false;
    // --output writes a file; --ext-diff runs a configured program.
    if (hasFlag(rest, "--output") || rest.includes("--ext-diff")) return false;
    if (sub === "branch") return rest.every((a) => GIT_BRANCH_FLAGS.has(a));
    return ["status", "diff", "log", "show"].includes(sub);
  },
};

/** Names the list covers, for the UI and docs. */
const SAFE_COMMANDS = Object.freeze([
  ...Object.keys(SAFE).filter((k) => k !== "git"),
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
]);

/**
 * Whether this command is on the read-only list, or is exactly one of the
 * project's own known commands (the thread's verify command: its test or
 * typecheck run).
 * @param {unknown} command
 * @param {Array<string | null | undefined>} [known]
 * @returns {boolean}
 */
function isSafeCommand(command, known = []) {
  if (typeof command !== "string" || HIDDEN.test(command)) return false;
  // The user wrote the known command, operators and all: exact text only.
  const flat = (s) => s.replace(/\s+/g, " ").trim();
  if (known.some((k) => typeof k === "string" && flat(k) && flat(k) === flat(command))) {
    return true;
  }
  const argv = parseArgv(command);
  if (!argv) return false;
  // A path to the program (`/tmp/ls`) is a different program.
  const check = Object.prototype.hasOwnProperty.call(SAFE, argv[0])
    ? SAFE[argv[0]]
    : null;
  return Boolean(check && check(argv.slice(1)));
}

module.exports = { isSafeCommand, parseArgv, SAFE_COMMANDS };
