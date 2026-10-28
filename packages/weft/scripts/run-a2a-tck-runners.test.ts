/**
 * The process runners `test:a2a-tck` binds to `runA2ATck`: the command runner, the `git` checkout
 * of the TCK, and the start of the example agent. `run-a2a-tck.test.ts` runs the decisions with
 * stand-ins for these; here the runners themselves run, against a local repository that stands in
 * for the TCK's and a small script that stands in for the example agent. Only the TCK's own clone
 * and `uv run` are left for the opt-in `test:a2a-tck`.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import {
  A2A_TCK_CHECKOUT,
  ensureCheckout,
  processDependencies,
  runGit,
  spawnAndWait,
  startExample,
} from './run-a2a-tck.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'weft-a2a-tck-runners-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ['git', '-c', 'user.name=Weft Test', '-c', 'user.email=weft@example.test', ...args],
    { cwd, stderr: 'pipe' },
  );
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A repository with `commits` empty commits, standing in for the TCK's. Returns each commit. */
async function repositoryWithCommits(commits: number): Promise<{ path: string; shas: string[] }> {
  const path = await temporaryDirectory();
  git(path, 'init', '--quiet');
  const shas: string[] = [];
  for (let index = 0; index < commits; index += 1) {
    git(path, 'commit', '--quiet', '--allow-empty', '--message', `commit ${index}`);
    shas.push(git(path, 'rev-parse', 'HEAD'));
  }
  return { path, shas };
}

async function exampleScript(source: string): Promise<string> {
  const path = join(await temporaryDirectory(), 'example.ts');
  await writeFile(path, source);
  return path;
}

describe('spawnAndWait', () => {
  test('resolves with the exit code of the command', async () => {
    const directory = await temporaryDirectory();

    expect(await spawnAndWait([process.execPath, '-e', 'process.exit(3)'], directory)).toBe(3);
    expect(await spawnAndWait([process.execPath, '-e', 'process.exit(0)'], directory)).toBe(0);
  });
});

describe('runGit', () => {
  test('resolves when git succeeds and throws the failure message when it does not', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'left'), 'left');
    await writeFile(join(directory, 'right'), 'right');

    await runGit(['diff', '--quiet', '--no-index', 'left', 'left'], directory, 'the file differs');
    expect(
      await throwingRejectionOf(
        runGit(['diff', '--quiet', '--no-index', 'left', 'right'], directory, 'the files differ'),
      ),
    ).toThrow('the files differ');
  });
});

describe('ensureCheckout', () => {
  test('clones the repository at the commit, leaves a matching checkout alone, and moves a stale one', async () => {
    const { path: repository, shas } = await repositoryWithCommits(1);
    const checkout = join(await temporaryDirectory(), 'nested', 'checkout');
    const first = shas[0] as string;

    await ensureCheckout(checkout, { repository, commit: first });
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(first);

    // A checkout already at the commit is not touched: the repository can vanish without notice.
    await ensureCheckout(checkout, { repository: join(repository, 'missing'), commit: first });
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(first);

    // A checkout at another commit fetches, then moves to the commit.
    git(repository, 'commit', '--quiet', '--allow-empty', '--message', 'commit 1');
    const second = git(repository, 'rev-parse', 'HEAD');
    await ensureCheckout(checkout, { repository, commit: second });
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(second);
  });
});

describe('startExample', () => {
  test('resolves with the URL the example prints and stops it on request', async () => {
    const entry = await exampleScript(
      [
        "console.log('A2A agent listening at http://127.0.0.1:4242');",
        // It keeps printing, which the runner keeps reading so the example never blocks on a pipe.
        "setInterval(() => console.log('still serving'), 10);",
        'await new Promise(() => {});',
      ].join('\n'),
    );

    const running = await startExample(entry);
    try {
      expect(running.url).toBe('http://127.0.0.1:4242');
    } finally {
      await running.stop();
    }
  });

  test('rejects with what the example printed when it exits before listening', async () => {
    const entry = await exampleScript("console.log('crashed while starting'); process.exit(1);");

    expect(await throwingRejectionOf(startExample(entry))).toThrow(
      /The example exited before listening:\ncrashed while starting/,
    );
  });
});

describe('processDependencies', () => {
  test('binds the real runners and the TCK checkout', () => {
    const dependencies = processDependencies();

    expect(dependencies.runCommand).toBe(spawnAndWait);
    expect(dependencies.ensureCheckout).toBe(ensureCheckout);
    expect(dependencies.startExample).toBe(startExample);
    expect(dependencies.checkout).toBe(A2A_TCK_CHECKOUT);
    expect(dependencies.log).toBe(console.info);
  });
});
