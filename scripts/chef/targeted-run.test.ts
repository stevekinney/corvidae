import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultManifestLayout } from '../browser-fixtures/scripts/prepare-manifest.ts';

import {
  MANIFEST_PATH,
  manifestSlugs,
  REPOSITORY_ROOT,
  repositoryContext,
} from './evidence-plan.ts';
import { landingPlan } from './landing-plan.ts';
import type { Runner } from './process-runner.ts';
import {
  buildCommand,
  fitUnitLanes,
  inputsFromPlan,
  OVERSIZE_RULE,
  run,
  UsageError,
  WHOLE_SUITE_FILE_LIMIT,
  WORKSPACE,
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
      // The repository root's own `scripts/` tests are a lane of directory ''.
      const root = changed.filter((file) => /^scripts\/.+\.test\.ts$/.test(file));
      return [
        ...(root.length === 0 ? [] : [{ directory: '', mode: 'partial' as const, tests: root }]),
        ...[...byWorkspace].map(([directory, tests]) => ({
          directory,
          mode: 'partial' as const,
          tests,
        })),
      ];
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
      unitLanes: [
        {
          workspace: 'components/cinder',
          paths: [
            'src/components/approval-card/approval-card.test.ts',
            'src/components/table/table.test.ts',
          ],
          config: '',
        },
        { workspace: 'packages/armorer', paths: ['src/a.test.ts'], config: '' },
      ],
    });
  });
});

describe('unit lanes', () => {
  test('an Interborough UI test runs under bunfig.ui.toml, a host test under the default', () => {
    expect(
      deriveInputs(['applications/interborough/src/views/standalone-view.test.ts']).unitLanes,
    ).toEqual([
      {
        workspace: 'applications/interborough',
        paths: ['src/views/standalone-view.test.ts'],
        config: './bunfig.ui.toml',
      },
    ]);
    expect(
      deriveInputs(['applications/interborough/src/host/panel-build-cache.test.ts']).unitLanes,
    ).toEqual([
      {
        workspace: 'applications/interborough',
        paths: ['src/host/panel-build-cache.test.ts'],
        config: '',
      },
    ]);
  });

  test('host and UI tests in one diff become two lanes, none dropped', () => {
    const { inputs, undispatchable } = inputsFromPlan(
      planOf([
        'applications/interborough/src/host/a.test.ts',
        'applications/interborough/src/views/b.test.ts',
        'applications/interborough/src/routes/c.test.ts',
      ]),
    );
    expect(inputs.unitLanes).toEqual([
      {
        workspace: 'applications/interborough',
        paths: ['src/routes/c.test.ts', 'src/views/b.test.ts'],
        config: './bunfig.ui.toml',
      },
      { workspace: 'applications/interborough', paths: ['src/host/a.test.ts'], config: '' },
    ]);
    expect(undispatchable).toEqual([]);
  });

  test('another workspace keeps its default bunfig', () => {
    expect(deriveInputs(['packages/bureau/src/x.test.ts']).unitLanes[0]?.config).toBe('');
  });

  test('every lane is dispatched: the root, Interborough and Cinder together, none left on stderr', () => {
    const plan: EvidencePlan = {
      ...planOf([]),
      unit_tests: [
        { workspace: '', paths: ['scripts/a.test.ts', 'scripts/groom/b.test.ts'], full: false },
        {
          workspace: 'applications/interborough',
          paths: ['src/a.test.ts', 'src/b.test.ts'],
          full: false,
        },
        { workspace: 'components/cinder', paths: ['src/api-contract.test.ts'], full: false },
      ],
    };
    const { inputs, undispatchable } = inputsFromPlan(plan);
    expect(undispatchable).toEqual([]);
    expect(inputs.unitLanes).toEqual([
      { workspace: '.', paths: ['scripts/a.test.ts', 'scripts/groom/b.test.ts'], config: '' },
      {
        workspace: 'applications/interborough',
        paths: ['src/a.test.ts', 'src/b.test.ts'],
        config: './bunfig.ui.toml',
      },
      { workspace: 'components/cinder', paths: ['src/api-contract.test.ts'], config: '' },
    ]);
    const command = buildCommand('b', inputs);
    const sent = command.find((value) => value.startsWith('unit_lanes='));
    expect(JSON.parse(sent?.slice('unit_lanes='.length) ?? '[]')).toEqual(inputs.unitLanes);
  });

  test('a lane that wants its whole suite, or a workspace the workflow cannot enter, is undispatchable', () => {
    const whole = inputsFromPlan({
      ...planOf([]),
      unit_tests: [{ workspace: 'components/cinder', paths: [], full: true }],
    });
    expect(whole.undispatchable).toEqual(['components/cinder: its whole suite']);
    const outside = inputsFromPlan({
      ...planOf([]),
      unit_tests: [{ workspace: 'tools/elsewhere', paths: ['a.test.ts'], full: false }],
    });
    expect(outside.undispatchable[0]).toContain('cannot enter');
  });

  test('a plan reaching scripts/groom stays targeted, and so does every workspace the manifest lists', () => {
    const groom = inputsFromPlan({
      ...planOf([]),
      unit_tests: [{ workspace: 'scripts/groom', paths: ['groom.test.ts'], full: false }],
    });
    expect(groom.undispatchable).toEqual([]);
    expect(groom.inputs.unitLanes).toEqual([
      { workspace: 'scripts/groom', paths: ['groom.test.ts'], config: '' },
    ]);
    const root = join(import.meta.dir, '..', '..');
    const manifest: { workspaces: string[] } = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    );
    const workspaces = manifest.workspaces.flatMap((pattern) =>
      pattern.endsWith('/*')
        ? readdirSync(join(root, pattern.slice(0, -2)), { withFileTypes: true })
            .filter(
              (entry) =>
                entry.isDirectory() &&
                existsSync(join(root, pattern.slice(0, -2), entry.name, 'package.json')),
            )
            .map((entry) => `${pattern.slice(0, -2)}/${entry.name}`)
        : [pattern],
    );
    expect(workspaces).toContain('scripts/groom');
    for (const workspace of workspaces) expect(WORKSPACE.test(workspace)).toBe(true);
  });

  test('lanes that fit one dispatch are named file by file', () => {
    const lanes = [
      { workspace: 'packages/a', paths: ['src/b.test.ts', 'test/a.test.ts'], config: '' },
    ];
    expect(fitUnitLanes(lanes)).toEqual(lanes);
  });

  test('lanes over the dispatch budget become the folders that hold them, never a drop', () => {
    const paths = Array.from(
      { length: 900 },
      (_, index) => `src/components/component-${index % 150}/component-${index}.test.ts`,
    );
    const fitted = fitUnitLanes([
      {
        workspace: 'components/cinder',
        paths: [...paths, 'root.test.ts', 'test/a.test.ts'],
        config: '',
      },
    ]);
    const folders = fitted?.[0]?.paths ?? [];
    for (const path of paths) expect(folders.some((folder) => path.startsWith(folder))).toBe(true);
    // A file at the workspace root keeps its name, and a path outside src keeps its folder.
    expect(folders).toEqual(expect.arrayContaining(['root.test.ts', 'test/']));
  });

  test('lanes that do not fit even as folders fit nothing: undefined, never a truncation', () => {
    const paths = Array.from(
      { length: 4000 },
      (_, index) => `src/area-${index}/deeper-${index}/file-${index}.test.ts`,
    );
    expect(fitUnitLanes([{ workspace: 'packages/a', paths, config: '' }])).toBeUndefined();
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
    expect(JSON.parse(result.output).inputs.unitLanes).toEqual([
      { workspace: 'packages/bureau', paths: ['src/kept.test.ts'], config: '' },
    ]);
  });

  test('builds the command from the diff and passes only inputs that name something', () => {
    const { dependencies, calls } = fake([
      'scripts/browser-fixtures/src/fixtures/description-list.svelte',
    ]);
    const result = run(['--dry-run'], dependencies);
    expect(result.output).toBe(
      `'gh' 'workflow' 'run' 'targeted-checks.yml' '--ref' 'chef/x' '-f' 'plan_digest=${landingPlan(['scripts/browser-fixtures/src/fixtures/description-list.svelte']).digest}' '-f' 'fixture_components=description-list'\n# requires_full_run: false`,
    );
    expect(calls.some((call) => call[0] === 'gh')).toBe(false);
  });

  test('a plan with root, Interborough and Cinder lanes dispatches all of them whole, with a digest', () => {
    const changed = [
      'scripts/chef/a.test.ts',
      'applications/interborough/src/views/b.test.ts',
      'components/cinder/src/components/table/table.test.ts',
    ];
    const { dependencies } = fake(changed, [
      'scripts/chef/a.test.ts',
      'applications/interborough/package.json',
      'applications/interborough/./bunfig.ui.toml',
      'applications/interborough/src/views/b.test.ts',
      'components/cinder/package.json',
      'components/cinder/src/components/table/table.test.ts',
    ]);
    const parsed = JSON.parse(run(['--dry-run', '--json'], dependencies).output);
    expect(parsed.requiresFullRun).toBe(false);
    expect(parsed.inputs.unitLanes.map((lane: { workspace: string }) => lane.workspace)).toEqual([
      '.',
      'applications/interborough',
      'components/cinder',
    ]);
    const sent = parsed.command.find((value: string) => value.startsWith('unit_lanes='));
    expect(JSON.parse(sent.slice('unit_lanes='.length))).toEqual(parsed.inputs.unitLanes);
    expect(parsed.command).toContain(`plan_digest=${landingPlan(changed).digest}`);
  });

  test('a plan the dispatch would have to truncate dispatches main.yml, names the rule, and carries no digest', () => {
    const changed = Array.from(
      { length: 4000 },
      (_, index) => `packages/big/src/area-${index}/deeper-${index}/file-${index}.test.ts`,
    );
    const { dependencies, calls } = fake(changed, ['packages/big/package.json']);
    const result = run(['--dry-run', '--json'], dependencies);
    const parsed = JSON.parse(result.output);
    expect(parsed.requiresFullRun).toBe(true);
    expect(parsed.command.slice(0, 5)).toEqual(['gh', 'workflow', 'run', 'main.yml', '--ref']);
    expect(parsed.command.join(' ')).not.toContain('plan_digest');
    expect(run(['--dry-run'], dependencies).output).toContain(OVERSIZE_RULE);
    expect(calls.some((call) => call[0] === 'gh')).toBe(false);
  });

  test('an explicit selection names no plan: it carries no digest, so landing never counts it', () => {
    const { dependencies } = fake(
      [],
      ['components/cinder/package.json', 'components/cinder/src/a.test.ts'],
    );
    const parsed = JSON.parse(
      run(
        [
          '--dry-run',
          '--json',
          '--unit-workspace',
          'components/cinder',
          '--unit-path',
          'src/a.test.ts',
        ],
        dependencies,
      ).output,
    );
    expect(parsed.command.join(' ')).not.toContain('plan_digest');
  });

  test('passes the digest of the plan over the diff with every status, deletions included', () => {
    const golden = 'packages/bureau/src/http/__fixtures__/wire-golden/local.openrpc.json';
    const { dependencies } = fake(['scripts/chef/a.ts'], [], [golden]);
    const command = run(['--dry-run', '--json'], dependencies).output;
    expect(JSON.parse(command).command).toContain(
      `plan_digest=${landingPlan(['scripts/chef/a.ts', golden]).digest}`,
    );
    expect(landingPlan(['scripts/chef/a.ts', golden]).digest).not.toBe(
      landingPlan(['scripts/chef/a.ts']).digest,
    );
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

  test('a real plan reaching scripts/groom dispatches targeted-checks.yml, not main.yml', () => {
    const { dependencies } = fake(['scripts/groom/groom.ts']);
    const real: TargetedDependencies = {
      ...dependencies,
      exists: (path) => existsSync(join(REPOSITORY_ROOT, path)),
      context: (slugs) => repositoryContext(REPOSITORY_ROOT, slugs),
    };
    const json = JSON.parse(run(['--dry-run', '--json'], real).output);
    expect(json.command.slice(0, 4)).toEqual(['gh', 'workflow', 'run', 'targeted-checks.yml']);
    expect(json.requiresFullRun).toBe(false);
    expect(json.inputs.unitLanes.map((lane: { workspace: string }) => lane.workspace)).toContain(
      'scripts/groom',
    );
  });

  test('a whole suite of a few files stays targeted; a large one wants the full run', () => {
    const lane = (count: number) => ({
      ...planOf([]),
      unit_tests: [
        {
          workspace: 'plugins/demo',
          paths: Array.from({ length: count }, (_, index) => `src/${index}.test.ts`),
          full: true,
        },
      ],
    });
    expect(inputsFromPlan(lane(WHOLE_SUITE_FILE_LIMIT)).undispatchable).toEqual([]);
    expect(inputsFromPlan(lane(WHOLE_SUITE_FILE_LIMIT + 1)).undispatchable).toEqual([
      'plugins/demo: its whole suite',
    ]);
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
    expect(result.output).toContain(
      `unit_lanes=[{"workspace":"components/cinder","paths":["src/a.test.ts"],"config":""}]`,
    );
  });

  test('dispatches with no input when the diff reaches no browser or unit file, for the lint and type-check job', () => {
    const { dependencies, calls } = fake(['packages/bureau/src/table-cell.ts']);
    const result = run(['--ref', 'b'], dependencies);
    expect(result.output).toContain('only lint and type-check');
    expect(calls.filter((call) => call[0] === 'gh')).toEqual([
      [
        'gh',
        'workflow',
        'run',
        'targeted-checks.yml',
        '--ref',
        'b',
        '-f',
        `plan_digest=${landingPlan(['packages/bureau/src/table-cell.ts']).digest}`,
      ],
    ]);
  });
});

describe('the workflow and the manifest', () => {
  test('buildCommand names every input of targeted-checks.yml', async () => {
    const workflow = await Bun.file(
      new URL('../../.github/workflows/targeted-checks.yml', import.meta.url),
    ).text();
    const command = buildCommand(
      'b',
      {
        fixtureComponents: ['a'],
        fixtureSpecs: ['b'],
        e2eSpecs: ['c'],
        unitLanes: [{ workspace: '.', paths: ['e'], config: '' }],
      },
      'f'.repeat(64),
    );
    for (const argument of command.filter((value) => value.includes('=')))
      expect(workflow).toContain(`      ${argument.split('=')[0]}:`);
  });

  test('the unit job runs every lane as a matrix, the root through bun-test.ts, with no single-lane input left', async () => {
    const workflow = await Bun.file(
      new URL('../../.github/workflows/targeted-checks.yml', import.meta.url),
    ).text();
    const job = workflow.slice(workflow.indexOf('\n  unit:\n'));
    expect(job).toContain('lane: ${{ fromJSON(inputs.unit_lanes) }}');
    expect(job).toContain('fail-fast: false');
    expect(job).toContain('bun scripts/bun-test.ts $UNIT_PATHS');
    for (const retired of ['unit_workspace', 'unit_paths', 'unit_config'])
      expect(workflow).not.toContain(`      ${retired}:`);
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
