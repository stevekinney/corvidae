#!/usr/bin/env bun
// Chef context ceiling: a Claude Code `PreToolUse` hook that reminds a session to hand off before
// its context grows expensive. Every call re-reads the whole context; on the 2026-10-22 run sessions
// averaged 470K tokens per call. It only warns: a hard block at a token count stopped one
// coordinator mid-merge with an unread gate failure, and the cleanup cost more than the tokens it
// saved (owner ruling 2026-10-22: warnings only, Claude Code's automatic compaction is the
// backstop). This is a Claude Code hook (`.claude/settings.json`), not a Git hook.
//
// It reads the hook input from standard input, takes the session's current context from the last
// model call in the transcript at `transcript_path` (`lastContext` in `transcript-usage.ts`), and
// answers:
//   - at or below the warn threshold (default 250000): allows the call, prints nothing;
//   - above it, up to the urgent threshold (default 350000): allows the call and adds context
//     telling the agent to write its handoff brief and hand off at the next natural boundary;
//   - above the urgent threshold: allows the call and adds a stronger warning to hand off as soon as
//     the step in hand is finished.
// The handoff is a fresh `start_session` with the brief, never `hand_off_to_session`, which forks
// the whole context.
//
// Environment: CHEF_CONTEXT_WARN_TOKENS, CHEF_CONTEXT_URGENT_TOKENS (positive integers; an invalid
// value keeps the default; the urgent threshold is kept at or above the warn threshold) and
// CHEF_CONTEXT_CEILING=off to disable the hook.
//
// It never denies a call. An unreadable or missing transcript, a transcript with no model call,
// malformed input, a subagent's own call (its context is its own; the transcript is the parent's),
// or any unexpected error prints nothing. It runs on every tool call, so it reads only the tail of
// the transcript, doubling the window until it holds a model call.
//
// Output: JSON on standard output with exit 0. Exit codes: always 0.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { rootScriptEnvironment } from '../environment-configuration.ts';
import { claudeCodeCalls, contextOf } from './transcript-usage.ts';

export const defaultWarnTokens = 250_000;
export const defaultUrgentTokens = 350_000;
const initialWindowBytes = 256 * 1024;
const maximumWindowBytes = 16 * 1024 * 1024;

export interface Thresholds {
  warn: number;
  urgent: number;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d*$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

/** The thresholds from the environment; an urgent threshold below the warn threshold is raised. */
export function thresholdsFrom(environment: Record<string, string | undefined>): Thresholds {
  const warn = positiveInteger(environment['CHEF_CONTEXT_WARN_TOKENS']) ?? defaultWarnTokens;
  const urgent = positiveInteger(environment['CHEF_CONTEXT_URGENT_TOKENS']) ?? defaultUrgentTokens;
  return { warn, urgent: Math.max(urgent, warn) };
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

export interface HookInput {
  transcript_path?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  agent_id?: unknown;
}

export interface HookDecision {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision?: 'allow';
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
  const { warn, urgent } = thresholdsFrom(environment);
  const context = read(input.transcript_path);
  if (context === undefined || context <= warn) return undefined;
  const additionalContext =
    context > urgent
      ? `URGENT: context is ${kilo(context)} tokens, past the ${kilo(urgent)} urgent threshold (AGENTS.md "Parallel runs"). Finish the step in hand, update the run note, write your handoff brief under tmp/chef/, and hand off to a fresh session (start_session with context "fresh", never hand_off_to_session). Do not start new work in this session.`
      : `Context is ${kilo(context)} tokens, past the ${kilo(warn)} handoff threshold (AGENTS.md "Parallel runs"). At the next natural boundary (between pull requests, not mid-merge or mid-gate), write a handoff brief under tmp/chef/ and hand off to a fresh session.`;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext,
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
