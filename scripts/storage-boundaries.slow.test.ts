import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWithHangGuard } from '../testing/testing/src/hang-guard.ts';
import { outcomeOf, rethrow } from './module-scope-scenario.test-support.ts';

/**
 * COR-1780: the cache-key consequence of the storage split. Editing an adapter that Weft does not
 * use leaves `@lostgradient/weft#test`'s hash unchanged, so that adapter's change or dependency
 * bump reruns only the adapter and its importers; editing Weft, or an adapter Weft does use,
 * changes it, which shows the edit reaches the hash at all.
 *
 * The copy is `git archive HEAD` in a new directory under the system temporary directory with its
 * own `git init` and one commit, and nothing is installed: Turborepo's dry run hashes a copy with
 * no `node_modules`. No worktree is created, nothing is registered in the repository's Git
 * directory, and the checkout this runs from is never written, so a killed run leaves only a
 * temporary directory. It is a slow test because the archive is hundreds of megabytes and three
 * dry runs follow it.
 */

const root = join(import.meta.dir, '..');
const turbo = join(root, 'node_modules/.bin/turbo');
const weftTest = '@lostgradient/weft#test';

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

/** The hash of Weft's `test` task from a dry run that filters to Weft. */
async function weftTestHash(directory: string): Promise<string> {
  const output = await run(directory, [
    turbo,
    'run',
    'test',
    '--filter=@lostgradient/weft',
    '--dry=json',
    '--cache=local:rw',
    `--cache-dir=${join(directory, '.turbo/cache')}`,
  ]);
  const summary: unknown = JSON.parse(output);
  if (summary === null || typeof summary !== 'object' || !('tasks' in summary)) {
    throw new Error('Turbo summary has no tasks');
  }
  if (!Array.isArray(summary.tasks)) throw new Error('Turbo tasks must be an array');
  for (const task of summary.tasks) {
    if (task.taskId === weftTest && typeof task.hash === 'string') return task.hash;
  }
  throw new Error(`Turbo summary has no ${weftTest} hash`);
}

/** Appends a comment to `file` in the copy, so the file's contents change and nothing else does. */
async function appendComment(directory: string, file: string): Promise<void> {
  const path = join(directory, file);
  // A missing file would append to a new one, which a hash can also see; the edit must be to a
  // file the package really has.
  await stat(path);
  await appendFile(path, '\n// COR-1780 cache-key probe\n');
}

const scenario = await outcomeOf(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-storage-boundaries-'));
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
      GIT_AUTHOR_NAME: 'storage-boundaries',
      GIT_AUTHOR_EMAIL: 'storage-boundaries@example.invalid',
      GIT_COMMITTER_NAME: 'storage-boundaries',
      GIT_COMMITTER_EMAIL: 'storage-boundaries@example.invalid',
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

    const before = await weftTestHash(copy);

    // An adapter Weft does not use: LMDB is a Weft dependency of nothing.
    await appendComment(copy, 'packages/storage-lmdb/src/index.ts');
    const afterUnusedAdapter = await weftTestHash(copy);
    expect(afterUnusedAdapter).toBe(before);

    // Controls: the same kind of edit changes the hash where Weft does reach the file.
    await appendComment(copy, 'packages/storage-bun-sqlite/src/index.ts');
    const afterUsedAdapter = await weftTestHash(copy);
    expect(afterUsedAdapter).not.toBe(afterUnusedAdapter);

    await appendComment(copy, 'packages/weft/src/index.ts');
    const afterWeft = await weftTestHash(copy);
    expect(afterWeft).not.toBe(afterUsedAdapter);
  } finally {
    await rm(directory, { recursive: true, force: true });
    // `force` hides a removal that stopped part-way, so check that nothing is left.
    expect(existsSync(directory)).toBe(false);
  }
});

test("an edit to an adapter Weft does not use leaves Weft's test hash unchanged", () =>
  rethrow(scenario));
