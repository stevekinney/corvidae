import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { runWithHangGuard } from '../hang-guard.ts';
import { decide } from './stash-guard.ts';

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
const denied = (command: string) => decide(bash(command)) !== undefined;

describe('stash-guard decide', () => {
  test('denies a bare stash and a pop, in every spelling', () => {
    for (const command of [
      'git stash',
      'git stash pop',
      'git stash pop stash@{1}',
      'git -C /some/dir stash',
      'git -C /some/dir stash pop',
      'git -c user.name=x stash',
      'git stash -u',
      'git stash >/tmp/stash.log',
      'git stash 2>&1 | tail',
      'git stash > log',
      'git stash & echo hi',
      'git stash clear',
      'git stash apply',
      'git stash drop',
      'git stash drop -q',
      'git stash push',
      'git stash push -u',
      'git stash save',
      'git stash save -u',
      'git -C /d stash push --include-untracked',
      'git add -A && git stash',
      'cd /repo; git stash pop',
      'git status || git stash',
      'echo hi\ngit stash',
      'FOO=1 git stash',
      '(git stash)',
    ]) {
      expect(denied(command)).toBe(true);
    }
  });

  test('the reason names the safe alternatives', () => {
    const reason = decide(bash('git stash'))?.hookSpecificOutput.permissionDecisionReason ?? '';
    expect(reason).toContain('WIP commit');
    expect(reason).toContain('git stash push -u -m <unique-tag>');
    expect(reason).toContain('git stash apply <sha>');
    expect(decide(bash('git stash'))?.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('allows a tagged push and the read-only and by-reference subcommands', () => {
    for (const command of [
      'git stash push -m tag',
      'git stash save wip-tag',
      'git stash save -u wip-tag',
      'git stash push -u -m tag',
      'git stash -u -m tag',
      'git stash --message=tag',
      'git -C /dir stash push -u -m tag',
      'git stash list',
      'git stash list 2>&1',
      'git stash apply abc123 2>&1',
      'git stash list --format="%H %gs"',
      'git stash show -p stash@{0}',
      'git stash apply abc123',
      'git stash drop stash@{2}',
      'git stash branch fix',
      'git commit -m "stash the pop"',
      'git log stash@{0}',
      'git status && git diff',
      'ls',
    ]) {
      expect(denied(command)).toBe(false);
    }
  });

  test('ignores other tools, a missing command and malformed input', () => {
    expect(decide({ tool_name: 'Read', tool_input: { command: 'git stash' } })).toBeUndefined();
    expect(decide({ tool_name: 'Bash', tool_input: {} })).toBeUndefined();
    expect(decide({ tool_name: 'Bash', tool_input: { command: 5 } })).toBeUndefined();
    expect(decide({ tool_name: 'Bash' })).toBeUndefined();
    expect(decide({})).toBeUndefined();
  });
});

/** The `import.meta.main` block, run at module scope: a child per case, assertions below. */
async function runHook(stdin: string) {
  const result = await runWithHangGuard(['bun', join(import.meta.dir, 'stash-guard.ts')], {
    stdin: Buffer.from(stdin),
  });
  return { code: result.exitCode, stdout: result.stdout.toString() };
}

const denial = await runHook(JSON.stringify(bash('git stash pop')));
const allowance = await runHook(JSON.stringify(bash('git stash list')));
const garbage = await runHook('not json');

describe('stash-guard command line', () => {
  test('prints a deny decision for a bare pop', () => {
    expect(denial.code).toBe(0);
    expect(JSON.parse(denial.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('prints nothing for an allowed command or garbage', () => {
    expect(allowance).toEqual({ code: 0, stdout: '' });
    expect(garbage).toEqual({ code: 0, stdout: '' });
  });
});
