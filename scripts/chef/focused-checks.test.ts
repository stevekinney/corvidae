import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import type { Manifest } from '../affected-tests-manifest.ts';
import {
  diffSize,
  directManifest,
  directTests,
  FILE_LIMIT,
  FIXTURE_SPEC_LIMIT,
  FIXTURE_SPECS_COMMAND,
  FIXTURE_SUITE_COMMAND,
  fixtureSpecAdvice,
  launchesBrowser,
  LINE_LIMIT,
  planSteps,
  prettierReadable,
  readScriptTests,
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
  { name: '@lostgradient/testing', directory: 'testing/testing' },
  { name: '@lostgradient/browser-fixtures', directory: 'scripts/browser-fixtures' },
];

const planInput = (changed: string[]) => ({
  changed,
  existing: changed,
  workspaces,
  base: 'abc123',
});

const names = (changed: string[]) => planSteps(planInput(changed)).map((step) => step.name);

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
  test('a scripts change adds the root type-check and no turbo step', () => {
    expect(names(['scripts/chef/a.ts'])).toEqual(['prettier', 'lint:root', 'typecheck:root']);
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

  test('the test lanes read the direct manifest, and the isolated lanes only when selected', () => {
    const direct = { digest: 'dig', filters: ['@lostgradient/weft'], root: true, isolated: false };
    const quick = planSteps({ ...planInput(['a.ts']), direct }).filter((step) =>
      step.name.startsWith('tests'),
    );
    expect(quick).toEqual([
      {
        name: 'tests',
        command: [
          'env',
          'CORVIDAE_TEST_SELECTION=dig',
          'CORVIDAE_TEST_POOL_WAIT_SECONDS=300',
          'bunx',
          'turbo',
          'run',
          'test',
          '--filter=@lostgradient/weft',
        ],
      },
      {
        name: 'tests:root',
        command: [
          'env',
          'CORVIDAE_TEST_SELECTION=dig',
          'CORVIDAE_TEST_POOL_WAIT_SECONDS=300',
          'bunx',
          'turbo',
          'run',
          'test:self',
          '--filter=//',
        ],
      },
    ]);
    const both = planSteps({ ...planInput(['a.ts']), direct: { ...direct, isolated: true } });
    expect(both.map((step) => step.name).filter((name) => name.startsWith('tests'))).toEqual([
      'tests',
      'tests:root',
      'tests:isolated',
      'tests:root:isolated',
    ]);
    expect(both.at(-1)?.command.slice(-3)).toEqual([
      'test:self:slow',
      '--filter=//',
      '--concurrency=1',
    ]);
  });

  test('no direct test plans no test step, and never the dependency graph', () => {
    expect(names(['packages/weft/src/a.ts'])).toEqual(['prettier', 'lint:root', 'turbo']);
    const direct = { digest: 'd', filters: ['x'], root: true, isolated: true };
    const commands = planSteps({ ...planInput(['a.ts']), direct }).map((s) => s.command.join(' '));
    expect(commands.some((command) => command.includes('affected-tests'))).toBe(false);
  });
});

describe('direct test selection', () => {
  const present = (...paths: string[]) => {
    const known = new Set(paths);
    return (path: string) => known.has(path);
  };

  test('a changed source file selects its sibling tests, in its directory and with its stem', () => {
    const exists = present(
      'packages/weft/src/a.ts',
      'packages/weft/src/a.test.ts',
      'packages/weft/src/a.integration.test.ts',
      'packages/weft/src/b.test.ts',
      'packages/weft/other/a.test.ts',
    );
    expect(directTests(['packages/weft/src/a.ts'], exists)).toEqual([
      'packages/weft/src/a.integration.test.ts',
      'packages/weft/src/a.test.ts',
    ]);
  });

  test('a changed test file selects itself, and a deleted or documentation file selects nothing', () => {
    const exists = present('scripts/x.test.ts', 'scripts/x.test.ts', 'scripts/y.test.ts');
    expect(directTests(['scripts/x.test.ts', 'gone.ts', 'scripts/y.md'], exists)).toEqual([
      'scripts/x.test.ts',
    ]);
  });

  test('a governed process document selects the tests that guard it', () => {
    const documents = [
      'AGENTS.md',
      '.agents/skills/chef/SKILL.md',
      '.agents/skills/chef/references/planning-and-routing.md',
      '.claude/agents/chef-worker.md',
      '.codex/agents/chef-worker.toml',
    ];
    // The selection is derived from what each test's source names, so a new document test joins it.
    const scriptTests = new Map([
      ['scripts/process-docs-budget.test.ts', "readFileSync('AGENTS.md'); '.agents/skills/chef'"],
      ['scripts/process-docs-moved-rules.test.ts', "read('AGENTS.md')"],
      ['scripts/process-docs-references.test.ts', "'.claude/agents' '.codex/agents'"],
      ['scripts/chef/future-document.integration.test.ts', "'.codex/agents/chef-worker.toml'"],
      ['scripts/chef/unrelated.test.ts', 'nothing about documents'],
    ]);
    const exists = present(...documents, ...scriptTests.keys(), 'README.md');
    expect(directTests(['AGENTS.md'], exists, scriptTests)).toEqual([
      'scripts/process-docs-budget.test.ts',
      'scripts/process-docs-moved-rules.test.ts',
    ]);
    expect(directTests(['.codex/agents/chef-worker.toml'], exists, scriptTests)).toEqual([
      'scripts/chef/future-document.integration.test.ts',
      'scripts/process-docs-references.test.ts',
    ]);
    expect(directTests(['.agents/skills/chef/SKILL.md'], exists, scriptTests)).toEqual([
      'scripts/process-docs-budget.test.ts',
    ]);
    for (const path of documents)
      expect(directTests([path], exists, scriptTests).length, path).toBeGreaterThan(0);
    expect(
      directTests(['documentation/repository/guards.md', 'README.md'], exists, scriptTests),
    ).toEqual([]);
    expect(directTests(['AGENTS.md'], (path) => path !== 'AGENTS.md', scriptTests)).toEqual([]);
  });

  test('the repository document tests are picked up when a governed document changes', () => {
    const tests = readScriptTests(join(import.meta.dir, '../..'));
    const selected = directTests(['AGENTS.md'], () => true, tests);
    for (const name of [
      'scripts/process-docs-budget.test.ts',
      'scripts/process-docs-moved-rules.test.ts',
      'scripts/process-docs-references.test.ts',
      'scripts/chef/brief.test.ts',
    ])
      expect(selected, name).toContain(name);
  });

  test('a component file selects the test beside it', () => {
    const exists = present('c/a.svelte', 'c/a.test.ts', 'c/a.svelte.test.ts');
    expect(directTests(['c/a.svelte'], exists)).toEqual(['c/a.test.ts']);
  });

  test('an unrelated workspace is not selected', () => {
    const manifest = directManifest(
      directTests(
        ['packages/weft/src/a.ts'],
        present(
          'packages/weft/src/a.ts',
          'packages/weft/src/a.test.ts',
          'packages/operative/src/a.test.ts',
        ),
      ),
      workspaces,
    );
    expect(manifest?.filters).toEqual(['@lostgradient/weft']);
    expect(manifest?.root).toBe(false);
    expect(manifest?.manifest.workspaces).toEqual({
      'packages/weft': { mode: 'partial', files: ['src/a.test.ts'] },
    });
  });

  test('root tests stay root-relative, isolated ones are noted, browser fixtures are left to CI', () => {
    const manifest = directManifest(
      [
        'scripts/browser-fixtures/scripts/z.test.ts',
        'scripts/chef/a.integration.test.ts',
        'scripts/chef/a.test.ts',
      ],
      workspaces,
    );
    expect(manifest).toMatchObject({ filters: [], root: true, isolated: true });
    expect(manifest?.manifest.workspaces).toEqual({
      '.': {
        mode: 'partial',
        files: ['scripts/chef/a.integration.test.ts', 'scripts/chef/a.test.ts'],
      },
    });
    expect(
      directManifest(['scripts/browser-fixtures/scripts/z.test.ts'], workspaces),
    ).toBeUndefined();
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
function fakeRunner(options: { changed?: string[]; untracked?: string[]; numstat?: string } = {}): {
  runner: Runner;
  calls: string[][];
} {
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
    // Every changed file and its plain sibling test exist; isolated siblings only when named.
    exists: (path) => !path.includes('.slow.') && !path.includes('.integration.'),
    writeSelection: () => 'digest',
    readText: () => 'a\nb\n',
    workspaces: () => workspaces,
    fixtureSpecs: () => new Map(),
    scriptTests: () => new Map(),
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

  test('keeps a pool-admission result pending and never calls it passed', async () => {
    const { runner } = fakeRunner({ changed: ['scripts/chef/a.ts'] });
    const deps = dependencies(runner, { 'lint:root': 75 });
    const result = await runChecks('/repo', { ...options, json: true }, deps);
    expect(result.code).toBe(1);
    const output = JSON.parse(result.output) as { ok: boolean; steps: unknown[] };
    expect(output.ok).toBe(false);
    const pending = output.steps.find(
      (step): step is { name: string; command: string; exitCode: number; pending?: boolean } =>
        typeof step === 'object' &&
        step !== null &&
        (step as { name?: unknown }).name === 'lint:root',
    );
    expect(pending).toBeDefined();
    expect(pending).toMatchObject({ name: 'lint:root', exitCode: 75, pending: true });
    expect(pending?.command).toBe('bun run lint:root');
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

  test('leaves the browser-launching test out of every lane, and names the CI command', async () => {
    const { runner } = fakeRunner({
      changed: [
        'testing/testing/src/probe.integration.test.ts',
        'testing/testing/src/c.slow.test.ts',
      ],
    });
    const written: Manifest[] = [];
    const deps = {
      ...dependencies(runner),
      exists: () => true,
      writeSelection: (manifest: Manifest) => (written.push(manifest), 'digest'),
      readText: (path: string) =>
        path.includes('probe') ? 'const browser = await chromium.launch();\n' : 'a\n',
    };
    const result = await runChecks('/repo', options, deps);
    expect(written[0]?.workspaces['testing/testing']?.files).toEqual(['src/c.slow.test.ts']);
    expect(deps.executed.at(-1)).toBe(
      'env CORVIDAE_TEST_SELECTION=digest CORVIDAE_TEST_POOL_WAIT_SECONDS=300 bunx turbo run test:slow --filter=@lostgradient/testing --concurrency=1',
    );
    expect(result.output).toContain(
      'testing/testing/src/probe.integration.test.ts launch a browser',
    );
    expect(result.output).toContain('`gh workflow run main.yml --ref <branch>`');
    expect(result.code).toBe(0);
  });

  test('keeps a selected test whose browser launch is gated', async () => {
    const { runner } = fakeRunner({ changed: ['packages/weft/src/x.integration.test.ts'] });
    const deps = {
      ...dependencies(runner),
      exists: () => true,
      readText: () =>
        "describe.skipIf(!enabled)('x', () => { chromium.launch({ headless: true }); });",
    };
    await runChecks('/repo', options, deps);
    expect(deps.executed.at(-1)).toContain('test:slow');
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

  test('plans against the merge base, runs the direct tests and never the dependency graph', async () => {
    const { runner, calls } = fakeRunner({ changed: ['packages/weft/src/x.integration.test.ts'] });
    const deps = { ...dependencies(runner), exists: () => true };
    await runChecks('/repo', options, deps);
    expect(calls[0]).toEqual(['git', 'merge-base', 'origin/main', 'HEAD']);
    expect(deps.executed.some((command) => command.includes('affected-tests'))).toBe(false);
    expect(deps.executed.at(-1)).toBe(
      'env CORVIDAE_TEST_SELECTION=digest CORVIDAE_TEST_POOL_WAIT_SECONDS=300 bunx turbo run test:slow --filter=@lostgradient/weft --concurrency=1',
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
