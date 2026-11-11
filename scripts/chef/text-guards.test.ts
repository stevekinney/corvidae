import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner, RunnerResult } from './process-runner.ts';
import {
  findingsOf,
  GUARD_CLEANUP,
  GUARD_SETUP,
  parseGuardList,
  runTextGuards,
  waivedBy,
  type GuardsResult,
} from './text-guards.ts';

const reply = (stdout = '', code = 0, stderr = ''): RunnerResult => ({ code, stdout, stderr });
const REVISION = 'e'.repeat(40);
const rootPackageJson = readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8');

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'text-guards-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** Output captured from the real guards, with the checkout's path replaced by `<root>`. */
const WAIT_FOR_STDERR = [
  'check-wait-for-element-assertions — absence or identity assertion on a DOM element inside waitFor.',
  "waitFor's first poll usually runs before the change flushes, and bun serializes the",
  '',
  '  await waitFor(() => expect(queryMenu()?.outerHTML ?? null).toBeNull());',
  '',
  '  applications/interborough/src/routes/capabilities/source-detail.test.ts:517 — expect(document.body.querySelector(\'[data-testid="connect-form"]\')).toBeNull()',
  "  components/chat/src/lib/components/chat/chat-sources.test.ts:229 — expect(document.activeElement).toBe(messageArticle(container, 'assistant-a'))",
  '',
].join('\n');
const PLUGIN_IDENTITIES_STDERR =
  'The baseline ref "origin/main" does not resolve. Set CORVIDAE_PLUGIN_IDENTITY_BASE to a ref that exists in this checkout (HEAD compares a plugin with itself); the guard never skips the comparison.\n';
const HIDDEN_LABELS_STDOUT =
  'check-hidden-labels - stale allowlist entry, lower or remove: applications/interborough/src/routes/agents/agent-chats.svelte - lists 1 but holds 0\n';
const HIDDEN_LABELS_STDERR =
  'check-hidden-labels - a control hides its visible label.\n\n  applications/interborough/src/routes/capabilities/source-detail.svelte:465 - labelVisible={false}\n';

describe('parseGuardList', () => {
  test('reads every guard of the root lint:guards script, in order, one process each', () => {
    const guards = parseGuardList(rootPackageJson);
    if (typeof guards === 'string') throw new Error(guards);
    const script =
      (JSON.parse(rootPackageJson) as { scripts: Record<string, string> }).scripts['lint:guards'] ??
      '';
    expect(guards.map((guard) => guard.command.join(' ')).join(' && ')).toBe(script);
    expect(guards.length).toBeGreaterThanOrEqual(10);
    expect(guards[0]).toEqual({
      name: 'check-wait-for-element-assertions',
      command: ['bun', 'scripts/check-wait-for-element-assertions.ts'],
    });
    expect(guards.map((guard) => guard.name)).toContain('check-plugin-identities');
  });

  test('refuses a segment it cannot run as one guard, and a missing script, instead of skipping', () => {
    const script = (value: string) => JSON.stringify({ scripts: { 'lint:guards': value } });
    expect(parseGuardList(script('bun scripts/check-a.ts && echo hi'))).toContain('"echo hi"');
    expect(parseGuardList(script('bun scripts/check-a.ts || true'))).toContain('which is not');
    expect(parseGuardList(JSON.stringify({ scripts: {} }))).toContain('no "lint:guards"');
    expect(parseGuardList('{')).toContain('not valid JSON');
  });
});

describe('findingsOf', () => {
  test('keeps every non-blank line of real guard output, wherever the guard wrote it', () => {
    const waitFor = findingsOf(reply('', 1, WAIT_FOR_STDERR), '/tmp/x/tree');
    expect(waitFor).toContain(
      'applications/interborough/src/routes/capabilities/source-detail.test.ts:517 — expect(document.body.querySelector(\'[data-testid="connect-form"]\')).toBeNull()',
    );
    expect(waitFor).toContain(
      'check-wait-for-element-assertions — absence or identity assertion on a DOM element inside waitFor.',
    );
    expect(waitFor).not.toContain('');
    // check-plugin-identities prints its one finding bare, with no indentation and no guard name.
    expect(findingsOf(reply('', 1, PLUGIN_IDENTITIES_STDERR), '/tmp/x/tree')).toHaveLength(1);
    // check-hidden-labels writes a finding to standard output and the rest to standard error.
    const hidden = findingsOf(reply(HIDDEN_LABELS_STDOUT, 1, HIDDEN_LABELS_STDERR), '/tmp/x/tree');
    expect(hidden).toHaveLength(3);
    expect(hidden[0]).toContain('stale allowlist entry');
  });

  test('replaces the tree path and collapses whitespace, so two directories agree', () => {
    const here = findingsOf(reply('', 1, 'error: /tmp/a/tree/x.ts   broke\n'), '/tmp/a/tree');
    const there = findingsOf(reply('', 1, 'error: /tmp/b/tree/x.ts broke\n'), '/tmp/b/tree');
    expect(here).toEqual(['error: <root>/x.ts broke']);
    expect(there).toEqual(here);
  });
});

describe('waivedBy', () => {
  const result = (guard: string, findings: string[]): GuardsResult => ({
    ok: false,
    failures: [{ guard, findings, output: '' }],
  });

  test('matches when each failing guard also fails on the base with a superset of its findings', () => {
    expect(waivedBy(result('check-a', ['x', 'y']), result('check-a', ['x', 'y', 'z']))).toEqual({
      guards: ['check-a'],
      findings: 2,
    });
  });

  test('does not match by guard name alone, an empty finding set, or an extra failing guard', () => {
    expect(waivedBy(result('check-a', ['x', 'new']), result('check-a', ['x']))).toBeNull();
    expect(waivedBy(result('check-a', ['x']), result('check-b', ['x']))).toBeNull();
    expect(waivedBy(result('check-a', []), result('check-a', []))).toBeNull();
    expect(waivedBy(result('check-a', ['x']), { ok: true, failures: [] })).toBeNull();
    expect(waivedBy({ ok: true, failures: [] }, { ok: true, failures: [] })).toBeNull();
    const two: GuardsResult = {
      ok: false,
      failures: [...result('check-a', ['x']).failures, ...result('check-b', ['y']).failures],
    };
    expect(waivedBy(two, result('check-a', ['x']))).toBeNull();
    const leaked: GuardsResult = {
      ok: false,
      failures: [
        ...result('check-a', ['x']).failures,
        { guard: GUARD_CLEANUP, findings: [], output: 'could not remove' },
      ],
    };
    expect(waivedBy(result('check-a', ['x']), leaked)).toBeNull();
  });
});

/** A fake `git` and `bun` that creates the worktree directory with a package.json in it. */
function fakeRunner(
  options: {
    guardList?: string;
    codes?: Record<string, number>;
    stdout?: Record<string, string>;
    removeCode?: number;
    addCode?: number;
    onGuard?: () => void;
  } = {},
) {
  const calls: { command: string[]; cwd: string | undefined }[] = [];
  const runner: Runner = (command, runnerOptions) => {
    calls.push({ command, cwd: runnerOptions?.cwd });
    if (command[0] === 'git' && command[1] === 'worktree' && command[2] === 'add') {
      if (options.addCode !== undefined) return reply('', options.addCode, 'fatal: bad revision');
      const tree = command[4] ?? '';
      mkdirSync(tree, { recursive: true });
      writeFileSync(
        join(tree, 'package.json'),
        JSON.stringify({
          scripts: {
            'lint:guards':
              options.guardList ??
              'bun scripts/check-one.ts && bun scripts/check-two.ts && bun scripts/check-three.ts',
          },
        }),
      );
      return reply();
    }
    if (command[0] === 'git' && command[1] === 'worktree' && command[2] === 'remove')
      return reply('', options.removeCode ?? 0, options.removeCode ? 'fatal: locked' : '');
    if (command[0] === 'bun') {
      options.onGuard?.();
      const name = (command[1] ?? '').replace('scripts/', '').replace('.ts', '');
      return reply(options.stdout?.[name] ?? `${name} — OK\n`, options.codes?.[name] ?? 0);
    }
    return reply();
  };
  return { runner, calls };
}

describe('runTextGuards', () => {
  test('adds a detached worktree, runs each guard as its own process there, and removes it', () => {
    mkdirSync(join(sandbox, 'node_modules'));
    const { runner, calls } = fakeRunner();
    const result = runTextGuards(runner, sandbox, REVISION);
    expect(result).toEqual({ ok: true, failures: [] });
    expect(calls.map((call) => call.command.slice(0, 4).join(' '))).toEqual([
      'git worktree add --detach',
      'bun scripts/check-one.ts',
      'bun scripts/check-two.ts',
      'bun scripts/check-three.ts',
      'git worktree remove --force',
    ]);
    const add = calls[0]?.command ?? [];
    expect(add).toContain('--detach');
    expect(add.at(-1)).toBe(REVISION);
    expect(calls[0]?.cwd).toBe(sandbox);
    const tree = add.at(-2) ?? '';
    // Every guard ran in the worktree, and `git worktree remove --force` named the same directory.
    expect(calls.slice(1, 4).every((call) => call.cwd === tree)).toBe(true);
    expect(calls[4]?.command.at(-1)).toBe(tree);
    expect(tree.startsWith(sandbox)).toBe(false);
  });

  test('names the failing guard from the process that failed, not from what other guards printed', () => {
    const { runner } = fakeRunner({
      codes: { 'check-three': 1 },
      stdout: { 'check-three': 'check-one — OK\ncheck-two — OK\n' },
    });
    const result = runTextGuards(runner, sandbox, REVISION);
    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.guard)).toEqual(['check-three']);
    expect(result.failures[0]?.output).toContain('check-one');
  });

  test('runs every guard after a failure, and only the named ones when asked', () => {
    const { runner, calls } = fakeRunner({ codes: { 'check-one': 1, 'check-three': 2 } });
    const all = runTextGuards(runner, sandbox, REVISION);
    expect(all.failures.map((failure) => failure.guard)).toEqual(['check-one', 'check-three']);
    expect(calls.filter((call) => call.command[0] === 'bun')).toHaveLength(3);
    const narrowed = fakeRunner({ codes: { 'check-one': 1, 'check-three': 2 } });
    const some = runTextGuards(narrowed.runner, sandbox, REVISION, ['check-three']);
    expect(some.failures.map((failure) => failure.guard)).toEqual(['check-three']);
    expect(narrowed.calls.filter((call) => call.command[0] === 'bun')).toHaveLength(1);
    // A name the tree does not have runs nothing, so it cannot match a failure on the branch.
    const missing = runTextGuards(fakeRunner().runner, sandbox, REVISION, ['check-ghost']);
    expect(missing).toEqual({ ok: true, failures: [] });
  });

  test('removes the worktree when a guard cannot run, and names a failed removal', () => {
    const { runner, calls } = fakeRunner({
      onGuard: () => {
        throw new Error('spawn blew up');
      },
    });
    expect(() => runTextGuards(runner, sandbox, REVISION)).toThrow('spawn blew up');
    expect(calls.at(-1)?.command.slice(0, 4)).toEqual(['git', 'worktree', 'remove', '--force']);
    const tree = calls[0]?.command.at(-2) ?? '';
    expect(existsSync(tree)).toBe(false);

    const stuck = fakeRunner({ removeCode: 128 });
    const result = runTextGuards(stuck.runner, sandbox, REVISION);
    expect(result.ok).toBe(false);
    expect(result.failures.at(-1)?.guard).toBe(GUARD_CLEANUP);
    expect(result.failures.at(-1)?.output).toContain('git worktree remove --force');
    expect(stuck.calls.some((call) => call.command.join(' ') === 'git worktree prune')).toBe(true);
  });

  test('reports a worktree that cannot be added, and a guard list it cannot read, as setup failures', () => {
    const added = fakeRunner({ addCode: 128 });
    const refused = runTextGuards(added.runner, sandbox, REVISION);
    expect(refused.failures).toHaveLength(1);
    expect(refused.failures[0]).toMatchObject({ guard: GUARD_SETUP, findings: [] });
    expect(refused.failures[0]?.output).toContain('git worktree add');
    // Nothing was added, so nothing is removed.
    expect(added.calls.some((call) => call.command[2] === 'remove')).toBe(false);

    const garbled = fakeRunner({ guardList: 'bun scripts/check-one.ts && echo hi' });
    expect(runTextGuards(garbled.runner, sandbox, REVISION).failures[0]).toMatchObject({
      guard: GUARD_SETUP,
    });
    expect(garbled.calls.filter((call) => call.command[0] === 'bun')).toHaveLength(0);
  });
});
