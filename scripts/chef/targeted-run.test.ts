import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultManifestLayout } from '../browser-fixtures/scripts/prepare-manifest.ts';

import { MANIFEST_PATH, manifestSlugs } from './evidence-plan.ts';
import type { Runner } from './process-runner.ts';
import {
  buildCommand,
  fitUnitPaths,
  inputsFromPlan,
  run,
  UsageError,
  type TargetedDependencies,
} from './targeted-run.ts';
import {
  computeEvidencePlan,
  type EvidenceContext,
  type EvidencePlan,
  type UnitSelection,
} from './verification-plan.ts';

const known = new Set(['approval-card', 'description-list', 'terminal']);

/** A context whose unit selection is each changed `*.test.ts` of a workspace folder, as git sees it. */
function context(paths: string[] = []): EvidenceContext {
  return {
    knownSlugs: known,
    paths: new Set(paths),
    read: () => undefined,
    selectUnitTests: (changed): UnitSelection[] => {
      const byWorkspace = new Map<string, string[]>();
      for (const file of changed) {
        const match =
          /^((?:applications|components|packages|plugins|testing|internal)\/[\w.-]+)\/.+\.test\.ts$/.exec(
            file,
          );
        if (match?.[1] !== undefined)
          byWorkspace.set(match[1], [...(byWorkspace.get(match[1]) ?? []), file]);
      }
      return [...byWorkspace].map(([directory, tests]) => ({ directory, mode: 'partial', tests }));
    },
  };
}

function planOf(changed: string[]): EvidencePlan {
  return computeEvidencePlan(changed, context(changed));
}

function deriveInputs(changed: string[]) {
  return inputsFromPlan(planOf(changed)).inputs;
}

function fake(
  changed: string[],
  existing: string[] = [],
  deleted: string[] = [],
): {
  dependencies: TargetedDependencies;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: Runner = (command) => {
    calls.push(command);
    if (command[1] === 'diff') {
      // `--diff-filter=d` leaves deleted files out, as git does.
      const listed = command.includes('--diff-filter=d') ? changed : [...changed, ...deleted];
      return { code: 0, stdout: `${listed.join('\n')}\n`, stderr: '' };
    }
    if (command[1] === 'rev-parse') return { code: 0, stdout: 'chef/x\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return {
    dependencies: {
      runner,
      exists: (path) => existing.includes(path),
      knownSlugs: () => known,
      context: () => context(changed),
    },
    calls,
  };
}

describe('deriveInputs', () => {
  test('reads components, specs and the busiest workspace of unit files from the diff', () => {
    const inputs = deriveInputs([
      'components/cinder/src/components/approval-card/approval-card.svelte',
      'components/cinder/src/components/not-fixtured/x.svelte',
      'scripts/browser-fixtures/src/fixtures/terminal.svelte',
      'scripts/browser-fixtures/tests/approval-card-input-rows.playwright.ts',
      'applications/interborough/tests/e2e/chat-responsive.spec.ts',
      'components/cinder/src/components/approval-card/approval-card.test.ts',
      'components/cinder/src/components/table/table.test.ts',
      'packages/armorer/src/a.test.ts',
      'README.md',
    ]);
    expect(inputs).toEqual({
      fixtureComponents: ['approval-card', 'terminal'],
      fixtureSpecs: ['scripts/browser-fixtures/tests/approval-card-input-rows.playwright.ts'],
      e2eSpecs: ['tests/e2e/chat-responsive.spec.ts'],
      unitWorkspace: 'components/cinder',
      unitPaths: [
        'src/components/approval-card/approval-card.test.ts',
        'src/components/table/table.test.ts',
      ],
      unitConfig: '',
    });
  });
});

describe('unit lanes', () => {
  test('an Interborough UI test runs under bunfig.ui.toml, a host test under the default', () => {
    expect(
      deriveInputs(['applications/interborough/src/views/standalone-view.test.ts']),
    ).toMatchObject({
      unitWorkspace: 'applications/interborough',
      unitPaths: ['src/views/standalone-view.test.ts'],
      unitConfig: './bunfig.ui.toml',
    });
    expect(
      deriveInputs(['applications/interborough/src/host/panel-build-cache.test.ts']),
    ).toMatchObject({ unitPaths: ['src/host/panel-build-cache.test.ts'], unitConfig: '' });
  });

  test('host and UI tests in one diff never share a run: the busier lane is selected', () => {
    const { inputs, uncovered } = inputsFromPlan(
      planOf([
        'applications/interborough/src/host/a.test.ts',
        'applications/interborough/src/views/b.test.ts',
        'applications/interborough/src/routes/c.test.ts',
      ]),
    );
    expect(inputs.unitPaths).toEqual(['src/routes/c.test.ts', 'src/views/b.test.ts']);
    expect(inputs.unitConfig).toBe('./bunfig.ui.toml');
    expect(uncovered).toEqual(['applications/interborough: 1 test files']);
  });

  test('another workspace keeps its default bunfig', () => {
    expect(deriveInputs(['packages/bureau/src/x.test.ts']).unitConfig).toBe('');
  });

  test('Cinder wins the one unit lane, and the unit tests no lane can carry are reported', () => {
    const plan: EvidencePlan = {
      ...planOf([]),
      unit_tests: [
        { workspace: '', paths: ['scripts/a.test.ts'], full: false },
        {
          workspace: 'applications/interborough',
          paths: ['src/a.test.ts', 'src/b.test.ts'],
          full: false,
        },
        { workspace: 'components/cinder', paths: ['src/api-contract.test.ts'], full: false },
      ],
    };
    const { inputs, uncovered } = inputsFromPlan(plan);
    expect(inputs.unitWorkspace).toBe('components/cinder');
    expect(inputs.unitPaths).toEqual(['src/api-contract.test.ts']);
    expect(uncovered).toEqual(['root: 1 test files', 'applications/interborough: 2 test files']);
  });

  test('unit paths that fit one dispatch are named file by file', () => {
    expect(fitUnitPaths(['src/b.test.ts', 'test/a.test.ts'])).toEqual([
      'src/b.test.ts',
      'test/a.test.ts',
    ]);
  });

  test('unit paths over the dispatch budget become the folders that hold them, never a drop', () => {
    const paths = Array.from(
      { length: 900 },
      (_, index) => `src/components/component-${index % 150}/component-${index}.test.ts`,
    );
    const folders = fitUnitPaths(paths);
    expect(folders.length).toBe(150);
    for (const path of paths) expect(folders.some((folder) => path.startsWith(folder))).toBe(true);
    // A file at the workspace root keeps its name, and a path outside src keeps its folder.
    expect(fitUnitPaths([...paths, 'root.test.ts', 'test/a.test.ts'])).toEqual(
      expect.arrayContaining(['root.test.ts', 'test/']),
    );
  });
});

describe('run', () => {
  test('a unit config without a unit workspace is refused, never checked as an absolute path', () => {
    const checked: string[] = [];
    const { dependencies } = fake([]);
    const tracking = {
      ...dependencies,
      exists: (path: string) => (checked.push(path), false),
    };
    expect(() =>
      run(
        ['--dry-run', '--fixture-components', 'terminal', '--unit-config', './bunfig.ui.toml'],
        tracking,
      ),
    ).toThrow('needs --unit-workspace');
    expect(checked.some((path) => path.startsWith('/'))).toBe(false);
  });

  test('a deleted test is left out of the derived selection instead of refusing the run', () => {
    const { dependencies } = fake(
      ['packages/bureau/src/kept.test.ts'],
      ['packages/bureau/package.json', 'packages/bureau/src/kept.test.ts'],
      ['packages/bureau/src/removed.test.ts'],
    );
    const result = run(['--dry-run', '--json'], dependencies);
    expect(JSON.parse(result.output).inputs.unitPaths).toEqual(['src/kept.test.ts']);
  });

  test('builds the command from the diff and passes only inputs that name something', () => {
    const { dependencies, calls } = fake([
      'scripts/browser-fixtures/src/fixtures/description-list.svelte',
    ]);
    const result = run(['--dry-run'], dependencies);
    expect(result.output).toBe(
      "'gh' 'workflow' 'run' 'targeted-checks.yml' '--ref' 'chef/x' '-f' 'fixture_components=description-list'\n# requires_full_run: false",
    );
    expect(calls.some((call) => call[0] === 'gh')).toBe(false);
  });

  test('--json with no inputs prints { ref, inputs, command, requiresFullRun } from the plan', () => {
    const { dependencies } = fake([
      'packages/bureau/src/http/__fixtures__/wire-golden/local.openrpc.json',
      'components/cinder/src/components/description-list/description-list.svelte',
    ]);
    const parsed = JSON.parse(run(['--dry-run', '--json'], dependencies).output);
    expect(Object.keys(parsed).toSorted()).toEqual(['command', 'inputs', 'ref', 'requiresFullRun']);
    expect(parsed.ref).toBe('chef/x');
    expect(parsed.requiresFullRun).toBe(true);
  });

  test('a plan that requires a full run dispatches main.yml, and says so in text and JSON', () => {
    for (const changed of [
      ['components/cinder/src/components/description-list/description-list.svelte'],
      ['components/cinder/src/tokens/sets/colors.tokens.json'],
      ['packages/weft/src/worker/protocol.ts'],
    ]) {
      const { dependencies, calls } = fake(changed);
      const json = JSON.parse(run(['--dry-run', '--json'], dependencies).output);
      expect(json.command).toEqual(['gh', 'workflow', 'run', 'main.yml', '--ref', 'chef/x']);
      expect(json.requiresFullRun).toBe(true);
      expect(json.inputs.fixtureComponents).toEqual([]);
      const text = run(['--dry-run'], fake(changed).dependencies).output;
      expect(text).toContain("'main.yml'");
      expect(text).toContain('Dispatching main.yml');
      expect(text).toContain('requires_full_run: true');
      run(['--ref', 'b'], dependencies);
      expect(calls.filter((call) => call[0] === 'gh')).toEqual([
        ['gh', 'workflow', 'run', 'main.yml', '--ref', 'b'],
      ]);
    }
  });

  test('a plan without requires_full_run still dispatches targeted-checks.yml', () => {
    const { dependencies } = fake([
      'scripts/browser-fixtures/src/fixtures/description-list.svelte',
    ]);
    const json = JSON.parse(run(['--dry-run', '--json'], dependencies).output);
    expect(json.requiresFullRun).toBe(false);
    expect(json.command.slice(0, 4)).toEqual(['gh', 'workflow', 'run', 'targeted-checks.yml']);
    expect(json.inputs.fixtureComponents).toEqual(['description-list']);
  });

  test('explicit inputs report the whole-suite flag too, yet still dispatch targeted-checks.yml', () => {
    const { dependencies, calls } = fake([
      'components/cinder/src/components/description-list/description-list.svelte',
    ]);
    const json = JSON.parse(
      run(['--dry-run', '--json', '--fixture-components', 'terminal'], dependencies).output,
    );
    expect(json.requiresFullRun).toBe(true);
    expect(json.command[3]).toBe('targeted-checks.yml');
    expect(calls.some((call) => call[0] === 'gh')).toBe(false);
  });

  test('the one-way-door flag is computed for explicit inputs too, and names the rule', () => {
    const { dependencies } = fake(['packages/operative/src/durable/types.ts']);
    const result = run(['--dry-run', '--fixture-components', 'terminal'], dependencies);
    expect(result.output).toContain('requires_full_run: true');
    expect(result.output).toContain('packages/operative/src/durable/types.ts: persisted record');
  });

  test('dispatches once unless it is a dry run', () => {
    const { dependencies, calls } = fake([]);
    run(['--ref', 'b', '--fixture-components', 'approval-card'], dependencies);
    expect(calls.filter((call) => call[0] === 'gh')).toEqual([
      [
        'gh',
        'workflow',
        'run',
        'targeted-checks.yml',
        '--ref',
        'b',
        '-f',
        'fixture_components=approval-card',
      ],
    ]);
  });

  test('refuses an unknown slug with the valid ones, before any dispatch', () => {
    const { dependencies, calls } = fake([]);
    expect(() => run(['--fixture-components', 'approval-crad'], dependencies)).toThrow(
      /unknown component slugs: approval-crad\. Known slugs: approval-card, description-list, terminal/,
    );
    expect(calls.some((call) => call[0] === 'gh')).toBe(false);
  });

  test('refuses a spec or file that is not one the workflow accepts', () => {
    const { dependencies } = fake([], ['tests/e2e/a.spec.ts']);
    expect(() => run(['--fixture-spec', 'scripts/other.ts'], dependencies)).toThrow(UsageError);
    expect(() => run(['--e2e-spec', 'tests/e2e/missing.spec.ts'], dependencies)).toThrow(
      /End-to-end spec/,
    );
    expect(() =>
      run(['--unit-workspace', 'components/nope', '--unit-path', 'a.test.ts'], dependencies),
    ).toThrow(/Unit workspace/);
    expect(() => run(['--unit-path', 'a.test.ts'], dependencies)).toThrow(/Unit workspace/);
  });

  test('accepts existing explicit specs and unit files', () => {
    const { dependencies } = fake(
      [],
      [
        'applications/interborough/tests/e2e/a.spec.ts',
        'components/cinder/package.json',
        'components/cinder/src/a.test.ts',
      ],
    );
    const result = run(
      [
        '--dry-run',
        '--ref',
        'b',
        '--e2e-spec',
        'tests/e2e/a.spec.ts',
        '--unit-workspace',
        'components/cinder',
        '--unit-path',
        'src/a.test.ts',
      ],
      dependencies,
    );
    expect(result.output).toContain('e2e_specs=tests/e2e/a.spec.ts');
    expect(result.output).toContain('unit_workspace=components/cinder');
  });

  test('dispatches with no input when the diff reaches no browser or unit file, for the lint and type-check job', () => {
    const { dependencies, calls } = fake(['packages/bureau/src/table-cell.ts']);
    const result = run(['--ref', 'b'], dependencies);
    expect(result.output).toContain('only lint and type-check');
    expect(calls.filter((call) => call[0] === 'gh')).toEqual([
      ['gh', 'workflow', 'run', 'targeted-checks.yml', '--ref', 'b'],
    ]);
  });
});

describe('the workflow and the manifest', () => {
  test('buildCommand names every input of targeted-checks.yml', async () => {
    const workflow = await Bun.file(
      new URL('../../.github/workflows/targeted-checks.yml', import.meta.url),
    ).text();
    const command = buildCommand('b', {
      fixtureComponents: ['a'],
      fixtureSpecs: ['b'],
      e2eSpecs: ['c'],
      unitWorkspace: 'd',
      unitPaths: ['e'],
      unitConfig: 'f',
    });
    for (const argument of command.filter((value) => value.includes('=')))
      expect(workflow).toContain(`      ${argument.split('=')[0]}:`);
  });

  // The slugs come from the generated manifest the suite reads, not a copy of its fixture roots:
  // a glob of those roots lost `terminal` when the terminal package took over its fixtures.
  test('the slugs are the generated manifest entries, at the path prepare-manifest writes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'targeted-run-manifest-'));
    const path = join(directory, 'manifest.json');
    writeFileSync(
      path,
      JSON.stringify({ digest: 'x', entries: [{ slug: 'terminal' }, { slug: 'button' }] }),
    );
    try {
      expect([...manifestSlugs(path)].toSorted()).toEqual(['button', 'terminal']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(MANIFEST_PATH).toBe(join(defaultManifestLayout.outputDirectory, 'manifest.json'));
  });
});
