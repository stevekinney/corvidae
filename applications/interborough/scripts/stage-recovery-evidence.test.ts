import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { stageRecoveryEvidence } from './stage-recovery-evidence.ts';

test('uploads only the allowlisted receipts and rejects a symlinked receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-evidence-'));
  try {
    const source = join(root, 'source');
    await mkdir(join(source, 'rehearsal', 'home', 'secrets'), { recursive: true });
    await mkdir(join(source, 'rehearsal', 'backup'), { recursive: true });
    await mkdir(join(source, 'rehearsal', 'restored'), { recursive: true });
    for (const path of [
      'home/database.sqlite',
      'home/database.sqlite-wal',
      'home/secrets/key',
      'backup/database.sqlite',
      'restored/database.sqlite',
      'commands.json',
    ])
      await writeFile(join(source, 'rehearsal', path), 'secret');
    await writeFile(join(source, 'artifacts.txt'), 'safe');
    await writeFile(join(source, 'rehearsal', 'diagnostics.json'), '{}');
    const staged = join(root, 'staged');
    await stageRecoveryEvidence(source, staged);
    const entries = await readdir(staged);
    expect(entries.toSorted()).toEqual(['artifacts.txt', 'rehearsal']);
    expect(await readdir(join(staged, 'rehearsal'))).toEqual(['diagnostics.json']);
    expect(await readFile(join(staged, 'artifacts.txt'), 'utf8')).toBe('safe');
    await symlink(
      join(source, 'rehearsal', 'home', 'secrets', 'key'),
      join(source, 'node-version.txt'),
    );
    expect(
      await throwingRejectionOf(stageRecoveryEvidence(source, join(root, 'rejected'))),
    ).toThrow('Unsafe evidence entry');
    const linkedSource = join(root, 'linked-source');
    await mkdir(linkedSource);
    await symlink(join(source, 'rehearsal'), join(linkedSource, 'rehearsal'));
    expect(
      await throwingRejectionOf(stageRecoveryEvidence(linkedSource, join(root, 'rejected-parent'))),
    ).toThrow('Unsafe rehearsal directory');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
