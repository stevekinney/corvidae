import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { rehearseInstalledRecovery } from './rehearse-installed-recovery.ts';

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
