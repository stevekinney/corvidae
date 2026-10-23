#!/usr/bin/env bun
// Chef stash guard: a Claude Code `PreToolUse` hook for Bash that denies a bare `git stash` and
// `git stash pop`. The stash stack is shared by every worktree of a repository, so a bare stash
// from one session can be popped by another, and a bare pop applies whichever entry is on top. This
// is a Claude Code hook (`.claude/settings.json`), not a Git hook.
//
// It reads the hook input from standard input and looks at `tool_input.command`. Compound commands
// joined with `&&`, `||`, `;`, `|` or a newline are checked segment by segment, and `git -C <dir>`,
// `git -c <key=value>` and `--git-dir`/`--work-tree` options before the subcommand are skipped.
//   - DENIED: `git stash`, `git stash push` and `git stash save` without a message (`-m`,
//     `--message`, or save's message argument), and `git stash pop`.
//     The reason says to use a WIP commit, or `git stash push -u -m <unique-tag>` and later
//     `git stash apply <sha>`;
//   - ALLOWED: `git stash push -u -m <tag>`, `git stash -u -m <tag>`, `list`, `show`, `apply`, `drop`,
//     `branch`, `create`, `store`, `clear`, `save <message>`, and every command that is not a stash.
//
// It fails open: malformed input, a missing command, or any unexpected error prints nothing. A
// quoted `git stash` inside a longer string (an echo, a commit message) can still be matched; a
// guard that errs toward asking for a WIP commit is cheap, and quoting is not parsed here.
//
// Output: JSON on standard output with exit 0 when it denies, nothing otherwise. Exit codes: always 0.

export interface HookInput {
  tool_name?: unknown;
  tool_input?: unknown;
}

export interface HookDecision {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

const reason =
  "A bare `git stash` or `git stash pop` is denied: the stash stack is shared by every worktree and session, so you could pop another session's changes. Set work aside with a temporary WIP commit instead. If you must stash, use `git stash push -u -m <unique-tag>`, capture your entry's SHA with `git stash list --format='%H %gs'`, restore it with `git stash apply <sha>`, and drop it by its re-found `stash@{n}`.";

/** Options of `git` that take a separate value and may precede the subcommand. */
const globalOptionsWithValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const messageFlags = new Set(['-m', '--message']);

function words(segment: string): string[] {
  return segment
    .replace(/[`(){}]/g, ' ')
    .replace(/\$/g, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^['"]+|['"]+$/g, ''))
    .filter((word) => word !== '');
}

/** Whether one command segment is a denied stash. */
function deniedSegment(segment: string): boolean {
  const tokens = words(segment);
  let index = 0;
  while (
    index < tokens.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '') ||
      ['command', 'sudo', 'env', 'time', 'exec'].includes(tokens[index] ?? ''))
  )
    index += 1;
  if (tokens[index] !== 'git') return false;
  index += 1;
  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    if (globalOptionsWithValue.has(token)) index += 2;
    else if (token.startsWith('-')) index += 1;
    else break;
  }
  if (tokens[index] !== 'stash') return false;
  const rest = tokens.slice(index + 1);
  const subcommand = rest[0];
  if (subcommand === 'pop') return true;
  const stores = subcommand === 'push' || subcommand === 'save';
  if (subcommand !== undefined && !subcommand.startsWith('-') && !stores) return false;
  // A push (explicit or implied by options alone) must carry a message; `save` takes it as its
  // last positional argument.
  const options = stores ? rest.slice(1) : rest;
  const hasFlag = options.some(
    (word) => messageFlags.has(word) || word.startsWith('--message=') || /^-[a-zA-Z]*m/.test(word),
  );
  const hasSaveMessage = subcommand === 'save' && options.some((word) => !word.startsWith('-'));
  return !(hasFlag || hasSaveMessage);
}

/** The hook's answer for `input`, or `undefined` to say nothing (allow silently). */
export function decide(input: HookInput): HookDecision | undefined {
  if (input.tool_name !== undefined && input.tool_name !== 'Bash') return undefined;
  const toolInput = input.tool_input;
  if (toolInput === null || typeof toolInput !== 'object') return undefined;
  const command = (toolInput as { command?: unknown }).command;
  if (typeof command !== 'string') return undefined;
  if (!command.split(/&&|\|\||;|\||\n/).some(deniedSegment)) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

if (import.meta.main) {
  try {
    const input = JSON.parse(await Bun.stdin.text()) as HookInput;
    const decision = decide(input);
    if (decision !== undefined) process.stdout.write(`${JSON.stringify(decision)}\n`);
  } catch {
    // Fail open: a hook that cannot read its input must not stop the session's work.
  }
}
