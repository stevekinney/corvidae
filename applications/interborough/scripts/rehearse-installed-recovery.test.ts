import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { pendingReviewFromList, rehearseInstalledRecovery } from './rehearse-installed-recovery.ts';

test('takes the durable run identity from the single pending review', () => {
  const review = { id: 'approval:durable:call', runId: 'durable', sessionId: 'session' };
  expect(pendingReviewFromList([review], 'run-transport')).toEqual(review);
  expect(() => pendingReviewFromList([], 'run-transport')).toThrow('pending review');
  expect(() => pendingReviewFromList([review, review], 'run-transport')).toThrow('pending review');
});

// spawn-free: identical executables are rejected before the rehearsal can start a process.
test('rejects the same installed executable before creating evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-boundary-'));
  const evidence = join(root, 'evidence');
  try {
    const expected =
      process.platform === 'darwin' && process.arch === 'arm64'
        ? 'must differ'
        : 'requires macOS arm64';
    expect(
      await throwingRejectionOf(
        rehearseInstalledRecovery('/usr/bin/true', '/usr/bin/true', evidence),
      ),
    ).toThrow(expected);
    expect(await rejectionOf(stat(evidence))).toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// spawn-free: matching release identities are rejected before the rehearsal starts a process.
test('rejects separate installations of the same release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-duplicate-release-'));
  const evidence = join(root, 'evidence');
  try {
    const executables: string[] = [];
    for (const name of ['previous', 'candidate']) {
      const directory = join(root, name);
      await mkdir(join(directory, 'bin'), { recursive: true });
      const executable = join(directory, 'bin', 'interborough');
      await writeFile(executable, 'fixture');
      await writeFile(
        join(directory, 'release.json'),
        JSON.stringify({ sourceSha: 'a'.repeat(40), version: '1.0.0', target: 'darwin-arm64' }),
      );
      executables.push(executable);
    }
    const expected =
      process.platform === 'darwin' && process.arch === 'arm64'
        ? 'release identities must differ'
        : 'requires macOS arm64';
    expect(
      await throwingRejectionOf(
        rehearseInstalledRecovery(executables[0]!, executables[1]!, evidence),
      ),
    ).toThrow(expected);
    expect(await rejectionOf(stat(evidence))).toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
