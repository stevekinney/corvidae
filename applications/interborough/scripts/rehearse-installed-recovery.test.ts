import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rehearseInstalledRecovery } from './rehearse-installed-recovery.ts';

test('rejects the same installed executable before creating evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-boundary-'));
  const evidence = join(root, 'evidence');
  try {
    const expected =
      process.platform === 'darwin' && process.arch === 'arm64'
        ? 'must differ'
        : 'requires macOS arm64';
    await expect(
      rehearseInstalledRecovery('/usr/bin/true', '/usr/bin/true', evidence),
    ).rejects.toThrow(expected);
    await expect(stat(evidence)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
