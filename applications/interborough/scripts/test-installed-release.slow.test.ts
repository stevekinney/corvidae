import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRelease } from './build-release.ts';
import { runInstalledRelease } from './test-installed-release.ts';

test('runs the installed release journey from the built archive and npm bin link', async () => {
  const output = await mkdtemp(join(tmpdir(), 'interborough-installed-release-build-'));
  const commandRoot = await mkdtemp(join(tmpdir(), 'interborough-installed-release-command-'));
  try {
    const archive = await buildRelease(['--version', '0.0.0-test', '--outdir', output]);
    const archiveEvidence = await runInstalledRelease(['--archive', archive]);
    expect(archiveEvidence).toMatch(/installed-release-.*\.json$/);
    await Bun.spawnSync(['tar', '-xzf', archive, '-C', commandRoot]);
    const npmBin = join(commandRoot, 'node_modules', '.bin');
    await mkdir(npmBin, { recursive: true });
    await symlink(
      join(commandRoot, 'interborough', 'bin', 'interborough'),
      join(npmBin, 'interborough'),
    );
    const commandEvidence = await runInstalledRelease(['--command', join(npmBin, 'interborough')]);
    expect(commandEvidence).toMatch(/installed-release-.*\.json$/);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(commandRoot, { recursive: true, force: true });
  }
}, 240_000);
