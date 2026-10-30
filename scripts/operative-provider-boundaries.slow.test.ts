import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWithHangGuard } from '../testing/testing/src/hang-guard.ts';
import { outcomeOf, rethrow } from './module-scope-scenario.test-support.ts';

/**
 * COR-1792: the cache-key consequence of the Operative provider split. Editing a provider package
 * leaves `@lostgradient/operative#test` and `@lostgradient/bureau#test` unchanged, so a provider's
 * change or dependency bump reruns only that provider and its importers; editing Operative
 * changes both, which shows the edit reaches the hashes at all.
 *
 * The copy is `git archive HEAD` in a new directory under the system temporary directory with its
 * own `git init` and one commit, and nothing is installed: Turborepo's dry run hashes a copy with
 * no `node_modules`. No worktree is created, nothing is registered in the repository's Git
 * directory, and the checkout this runs from is never written, so a killed run leaves only a
 * temporary directory. It reads the committed tree, so it describes `HEAD`, not uncommitted edits.
 * It is a slow test because the archive is hundreds of megabytes and three dry runs follow it.
 */

const root = join(import.meta.dir, '..');
const turbo = join(root, 'node_modules/.bin/turbo');
const taskIds = ['@lostgradient/operative#test', '@lostgradient/bureau#test'] as const;

async function run(directory: string, command: string[], extraEnvironment = {}): Promise<string> {
  // Every inherited `TURBO_*` variable goes (`TURBO_FORCE`, remote-cache settings, a cache
  // directory), as in `task-cache.test.ts`: the copy gets its own local cache by flag.
  const environment: Record<string, string | undefined> = { ...process.env, ...extraEnvironment };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('TURBO_')) delete environment[key];
  }
  const completed = await runWithHangGuard(command, { cwd: directory, env: environment });
  if (!completed.success) {
    throw new Error(
      `${command.join(' ')} exited ${completed.exitCode}: ${completed.stderr.toString()}`,
    );
  }
  return completed.stdout.toString();
}

/** The hashes of Operative's and Bureau's `test` tasks from one dry run that filters to both. */
async function testHashes(directory: string): Promise<Record<(typeof taskIds)[number], string>> {
  const output = await run(directory, [
    turbo,
    'run',
    'test',
    '--filter=@lostgradient/operative',
    '--filter=@lostgradient/bureau',
    '--dry=json',
    '--cache=local:rw',
    `--cache-dir=${join(directory, '.turbo/cache')}`,
  ]);
  const summary: unknown = JSON.parse(output);
  if (summary === null || typeof summary !== 'object' || !('tasks' in summary)) {
    throw new Error('Turbo summary has no tasks');
  }
  if (!Array.isArray(summary.tasks)) throw new Error('Turbo tasks must be an array');
  const hashes: Partial<Record<(typeof taskIds)[number], string>> = {};
  for (const task of summary.tasks) {
    for (const taskId of taskIds) {
      if (task.taskId === taskId && typeof task.hash === 'string') hashes[taskId] = task.hash;
    }
  }
  for (const taskId of taskIds) {
    if (hashes[taskId] === undefined) throw new Error(`Turbo summary has no ${taskId} hash`);
  }
  return hashes as Record<(typeof taskIds)[number], string>;
}

/** Appends a comment to `file` in the copy, so the file's contents change and nothing else does. */
async function appendComment(directory: string, file: string): Promise<void> {
  const path = join(directory, file);
  // A missing file would append to a new one, which a hash can also see; the edit must be to a
  // file the package really has.
  await stat(path);
  await appendFile(path, '\n// COR-1792 cache-key probe\n');
}

const scenario = await outcomeOf(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-operative-provider-boundaries-'));
  try {
    const archive = join(directory, 'checkout.tar');
    const copy = join(directory, 'copy');
    await run(root, ['git', 'archive', '--format=tar', `--output=${archive}`, 'HEAD']);
    await run(directory, ['mkdir', copy]);
    await run(directory, ['tar', '-x', '-f', archive, '-C', copy]);
    await rm(archive, { force: true });

    // Turbo detects changes through Git, so the copy must be a repository whose cache directory
    // is ignored, or the first dry run's own cache would change the second.
    const gitignore = await Bun.file(join(copy, '.gitignore')).text();
    expect(gitignore).toContain('.turbo/');
    const identity = {
      GIT_AUTHOR_NAME: 'operative-provider-boundaries',
      GIT_AUTHOR_EMAIL: 'operative-provider-boundaries@example.invalid',
      GIT_COMMITTER_NAME: 'operative-provider-boundaries',
      GIT_COMMITTER_EMAIL: 'operative-provider-boundaries@example.invalid',
    };
    await run(copy, ['git', 'init', '--quiet']);
    await run(copy, ['git', 'add', '--all'], identity);
    // Automatic garbage collection is off: after a commit of this many loose objects Git would
    // start `gc` detached in the background, and it keeps writing into `.git` while the
    // directory is removed below, which leaves part of the copy behind.
    await run(
      copy,
      [
        'git',
        '-c',
        'gc.auto=0',
        '-c',
        'maintenance.auto=false',
        'commit',
        '--quiet',
        '--message=copy',
      ],
      identity,
    );

    const before = await testHashes(copy);

    // A provider package neither Operative nor Bureau reaches.
    await appendComment(copy, 'packages/operative-gemini/src/index.ts');
    const afterProvider = await testHashes(copy);
    expect(afterProvider['@lostgradient/operative#test']).toBe(
      before['@lostgradient/operative#test'],
    );
    expect(afterProvider['@lostgradient/bureau#test']).toBe(before['@lostgradient/bureau#test']);

    // Control: the same kind of edit changes both hashes where they do reach the file.
    await appendComment(copy, 'packages/operative/src/index.ts');
    const afterOperative = await testHashes(copy);
    expect(afterOperative['@lostgradient/operative#test']).not.toBe(
      afterProvider['@lostgradient/operative#test'],
    );
    expect(afterOperative['@lostgradient/bureau#test']).not.toBe(
      afterProvider['@lostgradient/bureau#test'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    // `force` hides a removal that stopped part-way, so check that nothing is left.
    expect(existsSync(directory)).toBe(false);
  }
});

test("an edit to a provider package leaves Operative's and Bureau's test hashes unchanged", () =>
  rethrow(scenario));
