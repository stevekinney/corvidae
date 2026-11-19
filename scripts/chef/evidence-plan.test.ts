import { describe, expect, test } from 'bun:test';

import { run, UsageError, type EvidencePlanDependencies } from './evidence-plan.ts';
import type { Runner } from './process-runner.ts';

function fake(
  changed: string[],
  code = 0,
): { dependencies: EvidencePlanDependencies; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = (command) => {
    calls.push(command);
    return { code, stdout: `${changed.join('\n')}\n`, stderr: code === 0 ? '' : 'bad revision' };
  };
  return {
    dependencies: {
      runner,
      knownSlugs: () => new Set(['card']),
      context: (knownSlugs) => ({
        knownSlugs,
        paths: new Set(),
        read: () => undefined,
        selectUnitTests: () => [],
      }),
      readLines: () => ['packages/operative/src/durable/types.ts'],
    },
    calls,
  };
}

describe('evidence-plan', () => {
  test('reads the existing files that differ from the base, three dots', () => {
    const { dependencies, calls } = fake(['scripts/browser-fixtures/src/fixtures/card.svelte']);
    const plan = JSON.parse(run(['--json', '--base', 'origin/dev'], dependencies).output);
    expect(calls).toEqual([['git', 'diff', '--name-only', '--diff-filter=d', 'origin/dev...HEAD']]);
    expect(plan.fixture_slugs).toEqual(['card']);
    expect(plan.requires_full_run).toBe(false);
  });

  test('--changed-from replays a list, and the text names the rule that set requires_full_run', () => {
    const { dependencies, calls } = fake([]);
    const { output } = run(['--changed-from', 'landing.txt'], dependencies);
    expect(calls).toEqual([]);
    expect(output).toContain('requires_full_run: true');
    expect(output).toContain('packages/operative/src/durable/types.ts: persisted record');
  });

  test('a failed git diff is refused, with nothing planned', () => {
    expect(() => run([], fake([], 128).dependencies)).toThrow(UsageError);
    expect(() => run(['extra'], fake([]).dependencies)).toThrow(UsageError);
  });
});
