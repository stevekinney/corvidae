#!/usr/bin/env bun
// Chef context guard: a Claude Code `PreToolUse` hook that makes the `chef-worker` context limit
// binding. A sentence in the agent's instructions did not bind: in a two-day run six workers told to
// stop at 150K tokens of context ran on to between 157K and 294K. This is a Claude Code hook
// (`.claude/settings.json`), not a Git hook.
//
// For a tool call made inside a subagent whose `agent_type` is `chef-worker` (never the main
// session, a reviewer or any other agent), it reads that subagent's current context size: the input,
// cache-read and cache-creation tokens of the last request in the subagent's own transcript,
// `<session directory>/subagents/agent-<agent_id>.jsonl` beside the main transcript the hook input
// names (`transcript_path`). Only the tail of the file is read.
//   - at or over the limit (`CHEF_WORKER_CONTEXT_LIMIT`, default 150,000): DENIES every tool call but
//     `git add`, `git commit`, `git push` (never forced, deleting or mirroring), `git status`,
//     `git diff --stat` and `git log`, with the instruction to commit, push, and end the turn with a
//     `needs-decision` report. `SubagentHandback`, the tool that delivers a subagent's report, is
//     never denied;
//   - at or over the warning (`CHEF_WORKER_CONTEXT_WARNING`, default 120,000): allows the call and adds
//     a note through `hookSpecificOutput.additionalContext`, which `PreToolUse` supports without a
//     permission decision (so it neither approves nor prompts);
//   - otherwise says nothing.
//
// It fails OPEN: no agent id or type, a transcript that cannot be found, read or parsed, or any
// exception allows the call, because a hook that wrongly blocks stops all work. It reads one file
// tail, installs nothing and uses no network.
//
// Output: JSON on standard output with exit 0 when it denies or warns, nothing otherwise.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename, join } from 'node:path';
import { rootScriptEnvironment } from '../environment-configuration.ts';
import { claudeCodeCalls, contextOf } from './transcript-usage.ts';

export interface HookInput {
  tool_name?: unknown;
  tool_input?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
  transcript_path?: unknown;
}

export interface ContextHookOutput {
  hookSpecificOutput:
    | { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string }
    | { hookEventName: 'PreToolUse'; additionalContext: string };
}

export const DEFAULT_LIMIT = 150_000;
export const DEFAULT_WARNING = 120_000;
/** The only agent type the guard governs. */
export const WORKER_AGENT_TYPE = 'chef-worker';

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d*$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

/** The limit and warning threshold, from the environment, falling back to the defaults. */
export function thresholds(env: Record<string, string | undefined>): {
  limit: number;
  warning: number;
} {
  const limit = positiveInteger(env['CHEF_WORKER_CONTEXT_LIMIT']) ?? DEFAULT_LIMIT;
  const warning = positiveInteger(env['CHEF_WORKER_CONTEXT_WARNING']) ?? DEFAULT_WARNING;
  return { limit, warning: Math.min(warning, limit) };
}

/** Whether the hook input is a tool call made by a `chef-worker` subagent. */
export function isWorkerCall(input: HookInput): boolean {
  return (
    input.agent_type === WORKER_AGENT_TYPE &&
    typeof input.agent_id === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(input.agent_id)
  );
}

/** Where the subagent's own transcript is, or `undefined` when the input does not say. */
export function subagentTranscriptPath(input: HookInput): string | undefined {
  if (!isWorkerCall(input) || typeof input.transcript_path !== 'string') return undefined;
  const transcript = input.transcript_path;
  const file = `agent-${String(input.agent_id)}.jsonl`;
  if (basename(transcript) === file) return transcript;
  if (!transcript.endsWith('.jsonl')) return undefined;
  return join(transcript.slice(0, -'.jsonl'.length), 'subagents', file);
}

/**
 * The context size of the last request in a transcript's text, or `undefined` when none is there.
 * A leading line cut by reading only the tail fails to parse and is skipped.
 */
export function contextFromTail(text: string): number | undefined {
  const entries: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object')
        entries.push(parsed as Record<string, unknown>);
    } catch {
      // A truncated line is skipped.
    }
  }
  const last = claudeCodeCalls(entries).at(-1);
  return last === undefined ? undefined : contextOf(last);
}

/** The tail of a file, `bytes` at most, as text. Throws when the file cannot be read. */
export function readTail(path: string, bytes: number): { text: string; whole: boolean } {
  const descriptor = openSync(path, 'r');
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    return { text: buffer.toString('utf8'), whole: length === size };
  } finally {
    closeSync(descriptor);
  }
}

/** The tail of a transcript with a request in it, widening the read once; `undefined` when none. */
export function tailWithRequest(path: string): string | undefined {
  for (const bytes of [256 * 1024, 4 * 1024 * 1024]) {
    const { text, whole } = readTail(path, bytes);
    if (contextFromTail(text) !== undefined) return text;
    if (whole) return undefined;
  }
  return undefined;
}

type Quote = "'" | '"' | null;

/**
 * The simple commands of a shell command line, each as its words with quotes removed, or `undefined`
 * when the line holds anything but plain commands joined by `&&`, `||`, `;`, `|`, `&` or a newline:
 * a command substitution, a process substitution or a redirection other than `2>&1`.
 */
export function simpleCommands(line: string): string[][] | undefined {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: Quote = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const text = line.replaceAll('2>&1', ' ');
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
    } else if (char === '\\' && quote === null) {
      word += text[index + 1] ?? '';
      inWord = true;
      index += 1;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '`' || (char === '$' && text[index + 1] === '(')) return undefined;
      else if (char === '\\') {
        word += text[index + 1] ?? '';
        index += 1;
      } else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (
      char === '`' ||
      char === '<' ||
      char === '>' ||
      (char === '$' && text[index + 1] === '(')
    )
      return undefined;
    else if (char === ';' || char === '|' || char === '&' || char === '\n') endCommand();
    else if (/\s/.test(char)) endWord();
    else {
      word += char;
      inWord = true;
    }
  }
  if (quote !== null) return undefined;
  endCommand();
  return commands;
}

// Global options a worker over the limit may give. `-c`, `--config-env` and `--exec-path` are not
// here: each can make a later command run a program (`core.editor`, `core.sshCommand`,
// `core.hooksPath`).
const globalOptionsWithValue = new Set(['-C', '--git-dir', '--work-tree']);
const globalOptionsWithoutValue = new Set(['--no-pager']);

/** Options that run a program or write a file, per subcommand; a prefix git would accept counts. */
const runsOrWrites: Record<string, RegExp> = {
  push: /^--(rece|exe|up)/,
  log: /^--(ou|ext|textc)/,
  diff: /^--(ou|ext|textc)/,
};

/** Whether a `git push`'s arguments force, delete or mirror anything. */
function pushIsDestructive(args: string[]): boolean {
  return args.some(
    (argument) =>
      /^--(force|force-with-lease|force-if-includes|mirror|delete|prune)(=|$)/.test(argument) ||
      /^-[a-zA-Z]*[fd]/.test(argument) ||
      argument.startsWith('+') ||
      argument.startsWith(':') ||
      /^[^:]*:\+/.test(argument),
  );
}

/** Whether one simple command is one of the git commands a worker over the limit may run. */
function allowedGit(words: string[]): boolean {
  let index = 0;
  if (words[index] !== 'git') return false;
  index += 1;
  while (index < words.length) {
    const word = words[index] ?? '';
    if (globalOptionsWithValue.has(word)) index += 2;
    else if (globalOptionsWithoutValue.has(word)) index += 1;
    else if (word.startsWith('-')) return false;
    else break;
  }
  const subcommand = words[index];
  const args = words.slice(index + 1);
  const unsafe = runsOrWrites[subcommand ?? ''];
  if (unsafe !== undefined && args.some((argument) => unsafe.test(argument))) return false;
  if (
    subcommand === 'add' ||
    subcommand === 'commit' ||
    subcommand === 'status' ||
    subcommand === 'rev-parse'
  )
    return true;
  if (subcommand === 'log') return true;
  if (subcommand === 'diff') return args.includes('--stat');
  if (subcommand === 'push') return !pushIsDestructive(args);
  return false;
}

/** Whether a Bash command line is only the git commands a worker over the limit may run. */
export function allowedOverTheLimit(input: HookInput): boolean {
  if (input.tool_name === 'SubagentHandback') return true;
  if (input.tool_name !== 'Bash') return false;
  const toolInput = input.tool_input;
  if (toolInput === null || typeof toolInput !== 'object') return false;
  const command = (toolInput as { command?: unknown }).command;
  if (typeof command !== 'string') return false;
  const commands = simpleCommands(command);
  return commands !== undefined && commands.length > 0 && commands.every(allowedGit);
}

const format = (tokens: number) => tokens.toLocaleString('en-US');

/**
 * The hook's answer for `input` given the tail of the subagent's transcript, or `undefined` to say
 * nothing. Pure: the caller reads the tail.
 */
export function decide(
  input: HookInput,
  transcriptTail: string | undefined,
  env: Record<string, string | undefined> = {},
): ContextHookOutput | undefined {
  if (!isWorkerCall(input) || transcriptTail === undefined) return undefined;
  const context = contextFromTail(transcriptTail);
  if (context === undefined) return undefined;
  const { limit, warning } = thresholds(env);
  if (context >= limit) {
    if (allowedOverTheLimit(input)) return undefined;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Context is ${format(context)} tokens, over the limit of ${format(limit)}: commit what you have, push your branch, and end your turn with a \`needs-decision\` report listing what is done and what remains. Commit with \`git add\` and \`git commit -m "<message>"\`, then \`git push origin HEAD:<branch>\` (never forced). Allowed now: \`git add\`, \`git commit\`, \`git push\`, \`git status\`, \`git diff --stat\`, \`git log\`, \`git rev-parse\` and \`git --no-pager\` before any of these. Do not use \`cd\`, pipes, redirection, heredocs or \`git -c\`; to work in another directory use \`git -C <path> <command>\`. Get the head sha for your report with \`git rev-parse HEAD\`. The revert check and the name-only diff are skipped here, because delivery runs the revert check again; say so in your report.`,
      },
    };
  }
  if (context >= warning)
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `Context is ${format(context)} tokens; at ${format(limit)} every tool but git add, commit and push is denied. Finish the smallest complete piece, then commit, push, and report needs-decision with what is done and what remains.`,
      },
    };
  return undefined;
}

if (import.meta.main) {
  try {
    const input = JSON.parse(await Bun.stdin.text()) as HookInput;
    const path = subagentTranscriptPath(input);
    if (path !== undefined) {
      const decision = decide(input, tailWithRequest(path), rootScriptEnvironment());
      if (decision !== undefined) process.stdout.write(`${JSON.stringify(decision)}\n`);
    }
  } catch {
    // Fail open: a hook that cannot read its input or the transcript must not stop the work.
  }
}
