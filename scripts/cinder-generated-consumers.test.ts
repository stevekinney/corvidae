import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { discoverWorkspaces } from './affected-tests.ts';

// Cinder's token artifacts are generated, not tracked (`components/cinder/.gitignore`), and its
// `src/index.ts` imports them. A task of any workspace that reaches Cinder, however indirectly,
// must therefore run after Cinder's `metadata` task, which writes them.

const root = join(import.meta.dir, '..');
const CINDER = '@lostgradient/cinder';
const TASKS = ['dev', 'build', 'test', 'test:slow', 'test:browser', 'test:coverage', 'lint'];
const TYPE_TASKS = ['types', 'typecheck'];

interface Definition {
  dependsOn?: string[];
}
const configuration = JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf8')) as {
  tasks: Record<string, Definition>;
};
const workspaces = discoverWorkspaces(root);

/** The workspaces whose dependency closure holds Cinder, and Cinder itself. */
function reachingCinder(): Set<string> {
  const reaching = new Set<string>([CINDER]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const workspace of workspaces)
      if (!reaching.has(workspace.name) && workspace.dependencies.some((d) => reaching.has(d))) {
        reaching.add(workspace.name);
        grew = true;
      }
  }
  return reaching;
}

function scriptsOf(directory: string): Record<string, string> {
  return (
    (
      JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      }
    ).scripts ?? {}
  );
}

const effective = (name: string, task: string): string[] =>
  (configuration.tasks[`${name}#${task}`] ?? configuration.tasks[task])?.dependsOn ?? [];

test('every task of a workspace that reaches Cinder waits for Cinder metadata', () => {
  const missing: string[] = [];
  const metadataWaitsForDependencies = (configuration.tasks['metadata']?.dependsOn ?? []).includes(
    '^metadata',
  );
  expect(metadataWaitsForDependencies).toBe(true);
  for (const workspace of workspaces) {
    if (!reachingCinder().has(workspace.name) || workspace.directory === '') continue;
    const scripts = scriptsOf(workspace.directory);
    for (const task of TASKS) {
      if (scripts[task] === undefined) continue;
      // A task with no Turbo definition is never run by Turbo; the paths that run it directly call
      // `ensureCinderGenerated()` (`ensure-cinder-generated.test.ts` and the recovery test).
      if (
        configuration.tasks[`${workspace.name}#${task}`] === undefined &&
        configuration.tasks[task] === undefined
      )
        continue;
      const waits = effective(workspace.name, task).some(
        (entry) =>
          entry === `${CINDER}#metadata` ||
          entry === '^metadata' ||
          // A workspace's own `metadata` waits for its dependencies' (`^metadata`), a task nothing
          // runs for a workspace without a script, so this reaches Cinder's.
          (entry === 'metadata' && metadataWaitsForDependencies),
      );
      if (!waits) missing.push(`${workspace.name}#${task}`);
    }
  }
  expect(missing.toSorted()).toEqual([]);
});

test('type tasks reach Cinder metadata through the types of their dependencies', () => {
  for (const task of TYPE_TASKS) {
    for (const workspace of workspaces) {
      if (!reachingCinder().has(workspace.name) || workspace.directory === '') continue;
      if (scriptsOf(workspace.directory)[task] === undefined) continue;
      const dependsOn = effective(workspace.name, task);
      expect(
        dependsOn.includes('^types') ||
          (workspace.name === CINDER && dependsOn.includes('metadata')),
        `${workspace.name}#${task}`,
      ).toBe(true);
    }
  }
  // `^types` reaches Cinder's `types`, which itself waits for `metadata`.
  expect(effective(CINDER, 'types')).toContain('metadata');
  expect(effective(CINDER, 'typecheck')).toContain('metadata');
});
