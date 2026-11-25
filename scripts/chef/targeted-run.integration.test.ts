import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { REPOSITORY_ROOT, repositoryContext } from './evidence-plan.ts';
import type { Runner } from './process-runner.ts';
import type { TargetedDependencies } from './targeted-inputs.ts';
import { run } from './targeted-run.ts';

// The real repository's file tree and import graph, as the evidence plan reads them (it runs git).
function dispatchFor(changed: string[]) {
  const runner: Runner = (command) => ({
    code: 0,
    stdout: command[1] === 'rev-parse' ? 'chef/x\n' : `${changed.join('\n')}\n`,
    stderr: '',
  });
  const dependencies: TargetedDependencies = {
    runner,
    exists: (path) => existsSync(join(REPOSITORY_ROOT, path)),
    knownSlugs: () => new Set(),
    context: (slugs) => repositoryContext(REPOSITORY_ROOT, slugs),
  };
  return JSON.parse(run(['--dry-run', '--json'], dependencies).output);
}

const groom = dispatchFor(['scripts/groom/groom.ts']);

describe('a plan reaching scripts/groom', () => {
  test('dispatches targeted-checks.yml, not main.yml, with its own unit lane', () => {
    expect(groom.command.slice(0, 4)).toEqual(['gh', 'workflow', 'run', 'targeted-checks.yml']);
    expect(groom.requiresFullRun).toBe(false);
    expect(groom.inputs.unitLanes.map((lane: { workspace: string }) => lane.workspace)).toContain(
      'scripts/groom',
    );
  });
});
