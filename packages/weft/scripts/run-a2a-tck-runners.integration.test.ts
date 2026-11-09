/**
 * The process runners `test:a2a-tck` binds to `runA2ATck`: the command runner, the `git` checkout
 * of the TCK, and the start of the example agent. `run-a2a-tck.test.ts` runs the decisions with
 * stand-ins for these; here the runners themselves run, against a local repository that stands in
 * for the TCK's and a small script that stands in for the example agent. Only the TCK's own clone
 * and `uv run` are left for the opt-in `test:a2a-tck`.
 *
 * A process is the behavior under test, so each scenario runs at module scope, where no
 * per-test clock applies, and the tests assert on what it recorded. Every process the test file
 * starts itself goes through `runWithHangGuard`.
 */
import { afterAll, describe, expect, test } from 'bun:test';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import {
  A2A_TCK_CHECKOUT,
  ensureCheckout,
  processDependencies,
  runGit,
  spawnAndWait,
  startExample,
} from './run-a2a-tck.ts';

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'weft-a2a-tck-runners-'));
  directories.push(directory);
  return directory;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runWithHangGuard(
    ['git', '-c', 'user.name=Weft Test', '-c', 'user.email=weft@example.test', ...args],
    { cwd },
  );
  if (!result.success) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A repository with `commits` empty commits, standing in for the TCK's. Returns each commit. */
async function repositoryWithCommits(commits: number): Promise<{ path: string; shas: string[] }> {
  const path = await temporaryDirectory();
  await git(path, 'init', '--quiet');
  const shas: string[] = [];
  for (let index = 0; index < commits; index += 1) {
    await git(path, 'commit', '--quiet', '--allow-empty', '--message', `commit ${index}`);
    shas.push(await git(path, 'rev-parse', 'HEAD'));
  }
  return { path, shas };
}

async function exampleScript(source: string): Promise<string> {
  const path = join(await temporaryDirectory(), 'example.ts');
  await writeFile(path, source);
  return path;
}

const scratch = await temporaryDirectory();
await writeFile(join(scratch, 'left'), 'left');
await writeFile(join(scratch, 'right'), 'right');

// spawnAndWait
const failingExitCode = await spawnAndWait([process.execPath, '-e', 'process.exit(3)'], scratch);
const succeedingExitCode = await spawnAndWait([process.execPath, '-e', 'process.exit(0)'], scratch);

// runGit
const identicalFilesResolved = await runGit(
  ['diff', '--quiet', '--no-index', 'left', 'left'],
  scratch,
  'the file differs',
).then(
  () => true,
  () => false,
);
const differingFilesRejection = await rejectionOf(
  runGit(['diff', '--quiet', '--no-index', 'left', 'right'], scratch, 'the files differ'),
);

// ensureCheckout: clone, leave a matching checkout alone, and move a stale one
const { path: repository, shas } = await repositoryWithCommits(1);
const checkout = join(await temporaryDirectory(), 'nested', 'checkout');
const firstCommit = shas[0] as string;
await ensureCheckout(checkout, { repository, commit: firstCommit });
const headAfterClone = await git(checkout, 'rev-parse', 'HEAD');
// A checkout already at the commit is not touched: the repository can vanish without notice.
await ensureCheckout(checkout, { repository: join(repository, 'missing'), commit: firstCommit });
const headAfterMatchingCheckout = await git(checkout, 'rev-parse', 'HEAD');
await git(repository, 'commit', '--quiet', '--allow-empty', '--message', 'commit 1');
const secondCommit = await git(repository, 'rev-parse', 'HEAD');
await ensureCheckout(checkout, { repository, commit: secondCommit });
const headAfterFetch = await git(checkout, 'rev-parse', 'HEAD');

// startExample
const listeningEntry = await exampleScript(
  [
    "console.log('A2A agent listening at http://127.0.0.1:4242');",
    // It keeps printing, which the runner keeps reading so the example never blocks on a pipe.
    "setInterval(() => console.log('still serving'), 10);",
    'await new Promise(() => {});',
  ].join('\n'),
);
const runningExample = await startExample(listeningEntry);
const startedUrl = runningExample.url;
await runningExample.stop();
const exitedEntry = await exampleScript("console.log('crashed while starting'); process.exit(1);");
const exitedBeforeListening = await rejectionOf(startExample(exitedEntry));

describe('spawnAndWait', () => {
  test('resolves with the exit code of the command', () => {
    expect(failingExitCode).toBe(3);
    expect(succeedingExitCode).toBe(0);
  });
});

describe('runGit', () => {
  test('resolves when git succeeds and throws the failure message when it does not', () => {
    expect(identicalFilesResolved).toBe(true);
    expect(differingFilesRejection).toEqual(new Error('the files differ'));
  });
});

describe('ensureCheckout', () => {
  test('clones the repository at the commit, leaves a matching checkout alone, and moves a stale one', () => {
    expect(headAfterClone).toBe(firstCommit);
    expect(headAfterMatchingCheckout).toBe(firstCommit);
    expect(headAfterFetch).toBe(secondCommit);
  });
});

describe('startExample', () => {
  test('resolves with the URL the example prints, and stops it on request', () => {
    expect(startedUrl).toBe('http://127.0.0.1:4242');
  });

  test('rejects with what the example printed when it exits before listening', () => {
    expect(exitedBeforeListening).toBeInstanceOf(Error);
    expect((exitedBeforeListening as Error).message).toMatch(
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
