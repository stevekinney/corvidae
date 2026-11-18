import { describe, expect, test } from 'bun:test';

import type { Runner } from './process-runner.ts';
import {
  buildCommand,
  deriveInputs,
  manifestSlugs,
  run,
  UsageError,
  type TargetedDependencies,
} from './targeted-run.ts';

const known = new Set(['approval-card', 'description-list', 'terminal']);

function fake(
  changed: string[],
  existing: string[] = [],
): {
  dependencies: TargetedDependencies;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: Runner = (command) => {
    calls.push(command);
    if (command[1] === 'diff') return { code: 0, stdout: `${changed.join('\n')}\n`, stderr: '' };
    if (command[1] === 'rev-parse') return { code: 0, stdout: 'chef/x\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return {
    dependencies: {
      runner,
      exists: (path) => existing.includes(path),
      knownSlugs: () => known,
    },
    calls,
  };
}

describe('deriveInputs', () => {
  test('reads components, specs and the busiest workspace of unit files from the diff', () => {
    const inputs = deriveInputs(
      [
        'components/cinder/src/components/approval-card/approval-card.svelte',
        'components/cinder/src/components/not-fixtured/x.svelte',
        'scripts/browser-fixtures/src/fixtures/terminal.svelte',
        'scripts/browser-fixtures/tests/approval-card-input-rows.playwright.ts',
        'applications/interborough/tests/e2e/chat-responsive.spec.ts',
        'components/cinder/src/components/approval-card/approval-card.test.ts',
        'components/cinder/src/components/table/table.test.ts',
        'packages/armorer/src/a.test.ts',
        'README.md',
      ],
      known,
    );
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

describe('run', () => {
  test('builds the command from the diff and passes only inputs that name something', () => {
    const { dependencies, calls } = fake([
      'components/cinder/src/components/description-list/description-list.svelte',
    ]);
    const result = run(['--dry-run'], dependencies);
    expect(result.output).toBe(
      "'gh' 'workflow' 'run' 'targeted-checks.yml' '--ref' 'chef/x' '-f' 'fixture_components=description-list'",
    );
    expect(calls.some((call) => call[0] === 'gh')).toBe(false);
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
    const { dependencies, calls } = fake([
      'components/cinder/src/components/table/table-cell.svelte',
    ]);
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

  test('the repository manifest holds slugs the fixture suite knows', () => {
    const slugs = manifestSlugs();
    expect(slugs.has('button')).toBe(true);
    expect(slugs.has('terminal')).toBe(true);
    expect(slugs.has('chat-stress')).toBe(true);
  });
});
