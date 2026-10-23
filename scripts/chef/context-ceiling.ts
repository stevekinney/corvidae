#!/usr/bin/env bun
// Chef context ceiling: a Claude Code `PreToolUse` hook that enforces the handoff rule the chef
// skill and AGENTS.md "Parallel runs" state but nothing enforced: a session whose context passes
// about 250K tokens writes a brief and hands off to a fresh one. On the 2026-10-22 run, sessions
// averaged 470K tokens per call and peaked at 1.4-1.8M, and about 88% of the spend was re-reading
// context. This is a Claude Code hook (`.claude/settings.json`), not a Git hook.
//
// It reads the hook input from standard input, takes the session's current context from the last
// model call in the transcript at `transcript_path` (`lastContext` in `transcript-usage.ts`), and
// answers:
//   - at or below the warn threshold (default 250000): allows the call, prints nothing;
//   - above it: allows the call and adds context telling the agent to write its handoff brief;
//   - above the block threshold (default 400000): denies every call except what a handoff needs:
//     writing a file under `tmp/chef/`, the session-start and handoff tools, `SendMessage`, the
//     turn wrap-up tools, and `git` status, add, commit, push, log, diff and rev-parse.
//
// Environment: CHEF_CONTEXT_WARN_TOKENS, CHEF_CONTEXT_BLOCK_TOKENS (positive integers; an invalid
// value keeps the default) and CHEF_CONTEXT_CEILING=off to disable the hook.
//
// It fails open: an unreadable or missing transcript, a transcript with no model call, malformed
// input, a subagent call (its own context is small; the transcript is the parent's), or any
// unexpected error allows the call. It runs on every tool call, so it reads only the tail of the
// transcript, doubling the window until it holds a model call.
//
// Output: JSON on standard output with exit 0. Exit codes: always 0.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { rootScriptEnvironment } from '../environment-configuration.ts';
import { claudeCodeCalls, contextOf } from './transcript-usage.ts';

export const defaultWarnTokens = 250_000;
export const defaultBlockTokens = 400_000;
const initialWindowBytes = 256 * 1024;
const maximumWindowBytes = 16 * 1024 * 1024;

export interface Thresholds {
  warn: number;
  block: number;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d*$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

/** The thresholds from the environment; a block threshold below the warn threshold is ignored. */
export function thresholdsFrom(environment: Record<string, string | undefined>): Thresholds {
  const warn = positiveInteger(environment['CHEF_CONTEXT_WARN_TOKENS']) ?? defaultWarnTokens;
  const block = positiveInteger(environment['CHEF_CONTEXT_BLOCK_TOKENS']) ?? defaultBlockTokens;
  return block >= warn ? { warn, block } : { warn, block: Math.max(defaultBlockTokens, warn) };
}

/**
 * The context size of the transcript's last model call, or `undefined` when none can be read.
 * Only the tail is read, because a long session's transcript runs to tens of megabytes.
 */
export function currentContext(path: string): number | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(descriptor).size;
    for (let window = initialWindowBytes; ; window *= 4) {
      const length = Math.min(window, size);
      const buffer = Buffer.alloc(length);
      readSync(descriptor, buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n');
      // A window that starts mid-file begins inside a line; drop that fragment.
      if (length < size) lines.shift();
      const entries: Record<string, unknown>[] = [];
      for (const line of lines) {
        if (line.trim() === '') continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (parsed !== null && typeof parsed === 'object')
            entries.push(parsed as Record<string, unknown>);
        } catch {
          // A line being written, or cut by the window, is skipped.
        }
      }
      const calls = claudeCodeCalls(entries);
      const last = calls[calls.length - 1];
      if (last !== undefined) return contextOf(last);
      if (length >= size || window >= maximumWindowBytes) return undefined;
    }
  } catch {
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

const handoffTools = [
  /^mcp__ccd_session__(start_session|hand_off_to_session|dismiss_task|list_start_targets)$/,
  /^mcp__ccd_session_mgmt__(list_sessions|get_session|send_message)$/,
  /^mcp__ccd_turn__(update_plan|wrap_up)$/,
  /^SendMessage$/,
];
const writeTools = new Set(['Write', 'Edit']);
const gitHandoff =
  /^git(?: -C \S+)? (?:status|add|commit|push|log|diff|rev-parse|branch)(?: [^;&|`$<>\n\\]*)?$/;

function insideChefTemporaryDirectory(path: unknown): boolean {
  return (
    typeof path === 'string' &&
    !path.split('/').includes('..') &&
    /(^|\/)tmp\/chef\/[^/]/.test(path)
  );
}

/** Whether a call is one a handoff needs, and so passes above the block threshold. */
export function isHandoffCall(toolName: string, toolInput: unknown): boolean {
  if (handoffTools.some((pattern) => pattern.test(toolName))) return true;
  const input = (toolInput ?? {}) as Record<string, unknown>;
  if (writeTools.has(toolName)) return insideChefTemporaryDirectory(input['file_path']);
  if (toolName === 'Bash')
    return typeof input['command'] === 'string' && gitHandoff.test(input['command'].trim());
  return false;
}

export interface HookInput {
  transcript_path?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  agent_id?: unknown;
}

export interface HookDecision {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision?: 'allow' | 'deny';
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

const kilo = (tokens: number) => `${Math.round(tokens / 1000)}K`;

/** The hook's answer for `input`, or `undefined` to say nothing (allow silently). */
export function decide(
  input: HookInput,
  environment: Record<string, string | undefined>,
  read: (path: string) => number | undefined = currentContext,
): HookDecision | undefined {
  if (environment['CHEF_CONTEXT_CEILING'] === 'off') return undefined;
  if (typeof input.agent_id === 'string' && input.agent_id !== '') return undefined;
  if (typeof input.transcript_path !== 'string' || input.transcript_path === '') return undefined;
  const { warn, block } = thresholdsFrom(environment);
  const context = read(input.transcript_path);
  if (context === undefined || context <= warn) return undefined;
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  if (context > block && !isHandoffCall(toolName, input.tool_input))
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `This session's context is ${kilo(context)} tokens, past the ${kilo(block)} ceiling (AGENTS.md "Parallel runs"). Stop the work. Write a handoff brief under tmp/chef/ (the task, what is done, what is left, the branch, commit and pull request, the exact next commands and evidence paths), commit and push any work, then start a fresh session from that brief and end this one. Only that handoff is allowed now: Write or Edit under tmp/chef/, git status/add/commit/push/log/diff, SendMessage, and the session-start and handoff tools.`,
      },
    };
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: `Context is ${kilo(context)} tokens, past the ${kilo(warn)} handoff threshold (AGENTS.md "Parallel runs"). Finish the step in hand, write a handoff brief under tmp/chef/, and hand off to a fresh session. Tool calls other than the handoff are blocked above ${kilo(block)}.`,
    },
  };
}

if (import.meta.main) {
  try {
    const input = JSON.parse(await Bun.stdin.text()) as HookInput;
    const decision = decide(input, rootScriptEnvironment());
    if (decision !== undefined) process.stdout.write(`${JSON.stringify(decision)}\n`);
  } catch {
    // Fail open: a hook that cannot read its input must not stop the session's work.
  }
}
