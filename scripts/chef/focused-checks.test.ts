import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import {
  diffSize,
  FILE_LIMIT,
  FIXTURE_SPEC_LIMIT,
  FIXTURE_SPECS_COMMAND,
  FIXTURE_SUITE_COMMAND,
  fixtureSpecAdvice,
  launchesBrowser,
  LINE_LIMIT,
  planSteps,
  prettierReadable,
  run,
  runChecks,
  sizeWarnings,
  touchesRootTypecheck,
  UsageError,
  workspaceOf,
  type FocusedDependencies,
  type WorkspaceReference,
} from './focused-checks.ts';
import type { Runner } from './process-runner.ts';

const workspaces: WorkspaceReference[] = [
  { name: '@lostgradient/weft', directory: 'packages/weft' },
  { name: '@lostgradient/operative', directory: 'packages/operative' },
  { name: '@lostgradient/browser-fixtures', directory: 'scripts/browser-fixtures' },
];

const planInput = (changed: string[], extra: { selectsIsolatedTest?: boolean } = {}) => ({
  changed,
  existing: changed,
  workspaces,
  base: 'abc123',
  selectsIsolatedTest: false,
  ...extra,
});

const names = (changed: string[], extra = {}) =>
  planSteps(planInput(changed, extra)).map((step) => step.name);

describe('workspaceOf', () => {
  test('picks the owning workspace and nothing for root or unrelated files', () => {
    expect(workspaceOf('packages/weft/src/a.ts', workspaces)?.name).toBe('@lostgradient/weft');
    expect(workspaceOf('scripts/browser-fixtures/x.ts', workspaces)?.name).toBe(
      '@lostgradient/browser-fixtures',
    );
    expect(workspaceOf('scripts/chef/a.ts', workspaces)).toBeUndefined();
    expect(workspaceOf('packages/weft-other/a.ts', workspaces)).toBeUndefined();
    expect(workspaceOf('package.json', workspaces)).toBeUndefined();
  });
});

describe('touchesRootTypecheck', () => {
  test('is true for root files and scripts, false inside other directories', () => {
    expect(touchesRootTypecheck('turbo.json')).toBe(true);
    expect(touchesRootTypecheck('scripts/chef/a.ts')).toBe(true);
    expect(touchesRootTypecheck('packages/weft/a.ts')).toBe(false);
  });
});

describe('planSteps', () => {
  test('a workspace change runs prettier, the root lint, turbo and the quick tier', () => {
    expect(names(['packages/weft/src/a.ts'])).toEqual(['prettier', 'lint:root', 'turbo', 'tests']);
  });

  test('a scripts change adds the root type-check and no turbo step', () => {
    expect(names(['scripts/chef/a.ts'])).toEqual([
      'prettier',
      'lint:root',
      'typecheck:root',
      'tests',
    ]);
  });

  test('one turbo step filters every changed workspace once, in name order', () => {
    const turbo = planSteps(
      planInput([
        'packages/weft/a.ts',
        'packages/weft/b.ts',
        'packages/operative/a.ts',
        'scripts/browser-fixtures/a.ts',
      ]),
    ).find((step) => step.name === 'turbo');
    expect(turbo?.command).toEqual([
      'bunx',
      'turbo',
      'run',
      'lint',
      'typecheck',
      '--filter=@lostgradient/browser-fixtures',
      '--filter=@lostgradient/operative',
      '--filter=@lostgradient/weft',
    ]);
  });

  test('prettier takes only files that exist, and is skipped when none do', () => {
    const steps = planSteps({
      ...planInput(['a.ts', 'gone.ts']),
      existing: ['a.ts'],
    });
    expect(steps[0]?.command).toEqual(['bunx', 'prettier', '--check', '--ignore-unknown', 'a.ts']);
    expect(planSteps({ ...planInput(['gone.ts']), existing: [] })[0]?.name).toBe('lint:root');
  });

  test('the quick tier carries the base, and the isolated lane only when selected', () => {
    const quick = planSteps(planInput(['a.ts']));
    expect(quick.at(-1)?.command).toEqual([
      'bun',
      'scripts/affected-tests.ts',
      'run',
      '--base',
      'abc123',
    ]);
    const both = planSteps(planInput(['a.ts'], { selectsIsolatedTest: true }));
    expect(both.at(-1)).toEqual({
      name: 'tests:isolated',
      command: ['bun', 'scripts/affected-tests.ts', 'run', '--isolated', '--base', 'abc123'],
    });
  });
});

describe('fixture spec advice', () => {
  const specs = new Map([
    ['citation.playwright.ts', 'test("Citation rows")'],
    ['chat-harness.playwright.ts', 'await page.locator(".cinder-citation"); // the Citation list'],
    ['chat-claim-sources.playwright.ts', 'test("claims")'],
    ['banner-glyph-alignment.playwright.ts', 'test("glyph")'],
    ['button-group-joins.playwright.ts', 'test("joins")'],
    ['components.playwright.ts', 'runFixtureSweep()'],
    ['markdown-editor-toolbar.playwright.ts', 'test("toolbar")'],
  ]);
  const cinder = (name: string, file = `${name}.svelte`) =>
    `components/cinder/src/components/${name}/${file}`;

  test('is silent for a change outside Cinder, Chat and Editor source', () => {
    expect(fixtureSpecAdvice(['packages/weft/src/a.ts', 'scripts/a.ts'], specs)).toBeUndefined();
  });

  test('is silent for a change to tests and documents alone', () => {
    const changed = [cinder('citation', 'citation.test.ts'), cinder('citation', 'README.md')];
    expect(fixtureSpecAdvice(changed, specs)).toBeUndefined();
  });

  test('names the specs whose file or source names a changed Cinder component, without the sweep', () => {
    const advice = fixtureSpecAdvice([cinder('citation')], specs);
    expect(advice).toContain(
      `${FIXTURE_SPECS_COMMAND} chat-harness.playwright.ts citation.playwright.ts\``,
    );
    expect(advice).toContain('workers never run a browser on the host');
  });

  test('matches a file name on whole words, so butt is not button', () => {
    expect(fixtureSpecAdvice([cinder('butt')], specs)).toContain('which no fixture spec names');
    expect(fixtureSpecAdvice([cinder('button-group')], specs)).toContain(
      'button-group-joins.playwright.ts',
    );
  });

  test('names a Chat change by the specs with chat in their file name', () => {
    const advice = fixtureSpecAdvice(['components/chat/src/lib/components/chat/chat.css'], specs);
    expect(advice).toContain(
      `${FIXTURE_SPECS_COMMAND} chat-claim-sources.playwright.ts chat-harness.playwright.ts\``,
    );
  });

  test('names an Editor change by its component directory', () => {
    const changed = ['components/editor/src/lib/components/markdown-editor/toolbar.svelte'];
    expect(fixtureSpecAdvice(changed, specs)).toContain(
      `${FIXTURE_SPECS_COMMAND} markdown-editor-toolbar.playwright.ts\``,
    );
  });

  test('asks for the whole suite when Cinder styles, tokens or shared code change', () => {
    for (const path of ['styles/foundation.css', 'tokens/space.ts', '_internal/frame.svelte']) {
      const advice = fixtureSpecAdvice(
        [`components/cinder/src/${path}`, cinder('citation')],
        specs,
      );
      expect(advice).toContain(`\`${FIXTURE_SUITE_COMMAND}\``);
      expect(advice).not.toContain(FIXTURE_SPECS_COMMAND);
    }
  });

  test('asks for the whole suite above the limit, and when no spec names the change', () => {
    const many = new Map(
      Array.from({ length: FIXTURE_SPEC_LIMIT + 1 }, (_, index) => [
        `card-${index}.playwright.ts`,
        '',
      ]),
    );
    expect(fixtureSpecAdvice([cinder('card')], many)).toContain(
      `which ${FIXTURE_SPEC_LIMIT + 1} fixture specs name`,
    );
    const atLimit = new Map([...many].slice(0, FIXTURE_SPEC_LIMIT));
    expect(fixtureSpecAdvice([cinder('card')], atLimit)).toContain(FIXTURE_SPECS_COMMAND);
    const none = fixtureSpecAdvice(['components/chat/src/lib/a.svelte'], new Map());
    expect(none).toContain('which no fixture spec names');
    expect(none).toContain(FIXTURE_SUITE_COMMAND);
  });
});

describe('size warnings', () => {
  test('counts lines outside test files and files together', () => {
    const numstat = ['500\t100\tsrc/a.ts', '900\t0\tsrc/a.test.ts', '-\t-\timage.png'].join('\n');
    expect(diffSize(numstat, new Map([['new.ts', 10]]))).toEqual({ files: 4, codeLines: 610 });
  });

  test('warns above either limit and is quiet at the limits', () => {
    expect(sizeWarnings({ files: FILE_LIMIT, codeLines: LINE_LIMIT })).toEqual([]);
    expect(sizeWarnings({ files: 1, codeLines: LINE_LIMIT + 1 })).toHaveLength(1);
    expect(sizeWarnings({ files: FILE_LIMIT + 1, codeLines: LINE_LIMIT + 1 })).toHaveLength(2);
  });
});

/** A runner answering git and the selection from a table; nothing starts a process. */
function fakeRunner(
  options: { changed?: string[]; untracked?: string[]; numstat?: string; tests?: string[] } = {},
): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = (command) => {
    calls.push(command);
    const text = command.join(' ');
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    if (text.startsWith('git merge-base')) return ok('base-sha\n');
    if (text.startsWith('git diff --name-only')) return ok((options.changed ?? []).join('\n'));
    if (text.startsWith('git ls-files')) return ok((options.untracked ?? []).join('\n'));
    if (text.startsWith('git diff --numstat'))
      return ok(
        options.numstat ?? (options.changed ?? []).map((path) => `1\t0\t${path}`).join('\n'),
      );
    if (text.includes('affected-tests.ts --json'))
      return ok(JSON.stringify({ view: [{ tests: options.tests ?? [] }] }));
    if (text === 'git rev-parse --show-toplevel') return ok('/repo\n');
    return { code: 1, stdout: '', stderr: `unexpected ${text}` };
  };
  return { runner, calls };
}

function dependencies(
  runner: Runner,
  exitCodes: Record<string, number> = {},
): FocusedDependencies & { executed: string[] } {
  const executed: string[] = [];
  return {
    runner,
    executed,
    execute: (command) => {
      const text = command.join(' ');
      executed.push(text);
      const hit = Object.entries(exitCodes).find(([key]) => text.includes(key));
      return hit?.[1] ?? 0;
    },
    exists: () => true,
    readText: () => 'a\nb\n',
    workspaces: () => workspaces,
    fixtureSpecs: () => new Map(),
    log: () => {},
  };
}

describe('runChecks', () => {
  const options = { base: 'origin/main', json: false, dryRun: false };

  test('runs every step, keeps going after a failure and names the failed ones', async () => {
    const { runner } = fakeRunner({ changed: ['scripts/chef/a.ts'] });
    const deps = dependencies(runner, { 'lint:root': 1, typecheck: 2 });
    const result = await runChecks('/repo', options, deps);
    expect(deps.executed).toHaveLength(4);
    expect(result.code).toBe(1);
    expect(result.output).toBe('focused-checks: 2 passed, 2 failed (lint:root, typecheck:root)');
  });

  test('reports a step ended by a signal as killed, with exit code 3 and not as failed', async () => {
    const { runner } = fakeRunner({ changed: ['scripts/chef/a.ts'] });
    const deps = {
      ...dependencies(runner),
      execute: (command: string[]) => (command.includes('lint:root') ? { signal: 'SIGTERM' } : 0),
    };
    const result = await runChecks('/repo', options, deps);
    expect(result.code).toBe(3);
    expect(result.output).toContain('focused-checks: lint:root: killed by SIGTERM');
    expect(result.output).toContain('3 passed, 0 failed, 1 killed by a signal');
    expect(result.output).not.toContain('(lint:root)');
  });

  test('reports a step with no result as hung with exit code 4, and a signal outranks it', async () => {
    const { runner } = fakeRunner({ changed: ['scripts/chef/a.ts'] });
    const hung = {
      ...dependencies(runner),
      execute: (command: string[]) => (command.includes('lint:root') ? { hung: true as const } : 1),
    };
    const result = await runChecks('/repo', options, hung);
    expect(result.code).toBe(4);
    expect(result.output).toContain('focused-checks: lint:root: hung');
    expect(result.output).toContain('3 failed');
    const both = {
      ...dependencies(runner),
      execute: (command: string[]) =>
        command.includes('lint:root')
          ? { hung: true as const }
          : command.includes('prettier')
            ? { signal: 'SIGKILL' }
            : 0,
    };
    const bothResult = await runChecks('/repo', options, both);
    expect(bothResult.code).toBe(3);
  });

  test('carries the signal and the hang in the --json steps, with ok false', async () => {
    const { runner } = fakeRunner({ changed: ['scripts/chef/a.ts'] });
    const deps = {
      ...dependencies(runner),
      execute: (command: string[]) => (command.includes('lint:root') ? { signal: 'SIGTERM' } : 0),
    };
    const jsonResult = await runChecks('/repo', { ...options, json: true }, deps);
    const parsed = JSON.parse(jsonResult.output) as {
      ok: boolean;
      steps: { name: string; exitCode: number | null; signal?: string }[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.steps.find((step) => step.name === 'lint:root')).toMatchObject({
      exitCode: null,
      signal: 'SIGTERM',
    });
  });

  test('excludes only the browser-launching test from the isolated lane, and names the CI command', async () => {
    const { runner } = fakeRunner({
      changed: ['testing/testing/src/a.ts'],
      tests: [
        'testing/testing/src/probe.integration.test.ts',
        'testing/testing/src/c.slow.test.ts',
        'testing/testing/src/b.test.ts',
      ],
    });
    const deps = {
      ...dependencies(runner),
      readText: (path: string) =>
        path.includes('probe') ? 'const browser = await chromium.launch();\n' : 'a\n',
    };
    const result = await runChecks('/repo', options, deps);
    expect(deps.executed.at(-1)).toBe(
      'bun scripts/affected-tests.ts run --isolated --exclude testing/testing/src/probe.integration.test.ts --base base-sha',
    );
    expect(result.output).toContain(
      'tests:isolated excludes testing/testing/src/probe.integration.test.ts',
    );
    expect(result.output).toContain('`gh workflow run main.yml --ref <branch>`');
    expect(result.code).toBe(0);
  });

  test('keeps the isolated lane for a selected test whose browser launch is gated', async () => {
    const { runner } = fakeRunner({
      changed: ['packages/weft/a.ts'],
      tests: ['packages/weft/src/x.integration.test.ts'],
    });
    const deps = {
      ...dependencies(runner),
      readText: () =>
        "describe.skipIf(!enabled)('x', () => { chromium.launch({ headless: true }); });",
    };
    await runChecks('/repo', options, deps);
    expect(deps.executed.at(-1)).toContain('--isolated');
  });

  test('recognizes a test that launches a browser', () => {
    expect(launchesBrowser('const b = await chromium.launch();')).toBe(true);
    expect(launchesBrowser('await chromium.launchPersistentContext(dir, {})')).toBe(true);
    expect(launchesBrowser("import type { Page } from 'playwright';")).toBe(false);
  });

  test('exits 0 with a passed summary when every step passes', async () => {
    const { runner } = fakeRunner({ changed: ['packages/weft/a.ts'] });
    const result = await runChecks('/repo', options, dependencies(runner));
    expect(result).toEqual({ code: 0, output: 'focused-checks: 4 passed, 0 failed' });
  });

  test('plans against the merge base and adds the isolated lane when the selection reaches one', async () => {
    const { runner, calls } = fakeRunner({
      changed: ['packages/weft/a.ts'],
      tests: ['packages/weft/src/x.integration.test.ts'],
    });
    const deps = dependencies(runner);
    await runChecks('/repo', options, deps);
    expect(calls[0]).toEqual(['git', 'merge-base', 'origin/main', 'HEAD']);
    expect(deps.executed.at(-1)).toBe(
      'bun scripts/affected-tests.ts run --isolated --base base-sha',
    );
  });

  test('includes untracked files and drops duplicates', async () => {
    const { runner } = fakeRunner({ changed: ['a.ts'], untracked: ['a.ts', 'b.ts'] });
    const dry = await runChecks('/repo', { ...options, dryRun: true }, dependencies(runner));
    expect(dry.output).toContain('prettier: bunx prettier --check --ignore-unknown a.ts b.ts');
  });

  test('--dry-run runs nothing and exits 0', async () => {
    const { runner } = fakeRunner({ changed: ['scripts/a.ts'] });
    const deps = dependencies(runner);
    const result = await runChecks('/repo', { ...options, dryRun: true }, deps);
    expect(deps.executed).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.output).toContain('lint:root: bun run lint:root');
    expect(result.output).toContain('dry run, 4 steps planned');
  });

  test('--json reports ok, steps and warnings; an oversized diff warns without failing', async () => {
    const { runner } = fakeRunner({
      changed: ['scripts/a.ts'],
      numstat: `${LINE_LIMIT + 1}\t0\tscripts/a.ts`,
    });
    const result = await runChecks('/repo', { ...options, json: true }, dependencies(runner));
    const parsed = JSON.parse(result.output);
    expect(result.code).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.steps[0]).toEqual({
      name: 'prettier',
      command: 'bunx prettier --check --ignore-unknown scripts/a.ts',
      exitCode: 0,
    });
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain('consider splitting');
  });

  test('a text run prints the warning above the summary', async () => {
    const { runner } = fakeRunner({
      changed: Array.from({ length: FILE_LIMIT + 1 }, (_, index) => `f${index}.md`),
    });
    const result = await runChecks('/repo', options, dependencies(runner));
    expect(result.output.split('\n')[0]).toContain('warning');
    expect(result.code).toBe(0);
  });

  test('a component change warns with its fixture specs and runs no browser step', async () => {
    const { runner } = fakeRunner({
      changed: ['components/cinder/src/components/citation/citation.svelte'],
    });
    const deps = {
      ...dependencies(runner),
      fixtureSpecs: () => new Map([['citation.playwright.ts', '']]),
    };
    const result = await runChecks('/repo', { ...options, json: true }, deps);
    const parsed = JSON.parse(result.output);
    expect(parsed.warnings).toEqual([expect.stringContaining('citation.playwright.ts')]);
    expect(deps.executed.some((command) => command.includes('playwright test'))).toBe(false);
    expect(result.code).toBe(0);
  });

  test('an unreadable changed set fails with exit 1', async () => {
    const runner: Runner = () => ({ code: 128, stdout: '', stderr: 'fatal: bad revision' });
    const result = await runChecks('/repo', options, dependencies(runner));
    expect(result.code).toBe(1);
    expect(result.output).toContain('could not read the changed files');
  });
});

describe('run', () => {
  test('rejects unknown options and positionals with a UsageError', async () => {
    const { runner } = fakeRunner();
    expect(await rejectionOf(run(['--nope'], { runner }, '/repo'))).toBeInstanceOf(UsageError);
    expect(await rejectionOf(run(['extra'], { runner }, '/repo'))).toBeInstanceOf(UsageError);
    expect(await rejectionOf(run(['--base'], { runner }, '/repo'))).toBeInstanceOf(UsageError);
  });

  test('passes --base through and resolves the checkout from Git when no root is given', async () => {
    const { runner, calls } = fakeRunner({ changed: ['a.md'] });
    const deps = dependencies(runner);
    const result = await run(['--base', 'main', '--dry-run'], deps);
    expect(result.code).toBe(0);
    expect(calls[0]).toEqual(['git', 'rev-parse', '--show-toplevel']);
    expect(calls[1]).toEqual(['git', 'merge-base', 'main', 'HEAD']);
  });
});

describe('prettierReadable', () => {
  test('names a file that exists, and neither a deleted file nor a symbolic link', () => {
    const root = mkdtempSync(join(tmpdir(), 'focused-checks-'));
    try {
      mkdirSync(join(root, 'skill'));
      writeFileSync(join(root, 'skill', 'SKILL.md'), '# Skill\n');
      symlinkSync('skill', join(root, 'linked'));
      expect(prettierReadable(root, 'skill/SKILL.md')).toBe(true);
      expect(prettierReadable(root, 'linked')).toBe(false);
      expect(prettierReadable(root, 'gone.md')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
