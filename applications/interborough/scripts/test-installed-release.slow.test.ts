import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRelease } from './build-release.ts';
import { runInstalledRelease } from './test-installed-release.ts';

// load-proof: builds the real signed artifact and exercises installed process and browser boundaries.
// spawn-free: real archive and supervised lifecycle are the acceptance subject, under the approved slow-test deadline.
test('runs the installed release journey from the built archive and npm bin link', async () => {
  expect(Bun.which('bun', { PATH: '/usr/bin:/bin' })).toBeNull();
  expect(Bun.which('node', { PATH: '/usr/bin:/bin' })).toBeNull();
  const output = await mkdtemp(join(tmpdir(), 'interborough-installed-release-build-'));
  const commandRoot = await mkdtemp(join(tmpdir(), 'interborough-installed-release-command-'));
  try {
    const archive = await buildRelease(['--version', '0.0.0-test', '--outdir', output]);
    const archiveEvidence = await runInstalledRelease([
      '--archive',
      archive,
      '--evidence',
      join(output, 'evidence'),
    ]);
    expect(archiveEvidence).toMatch(/installed-release-.*\.json$/);
    const extracted = await runWithHangGuard(['tar', '-xzf', archive, '-C', commandRoot]);
    expect(extracted.exitCode).toBe(0);
    const npmBin = join(commandRoot, 'node_modules', '.bin');
    await mkdir(npmBin, { recursive: true });
    await symlink(
      join(commandRoot, 'interborough', 'bin', 'interborough'),
      join(npmBin, 'interborough'),
    );
    const commandEvidence = await runInstalledRelease([
      '--command',
      join(npmBin, 'interborough'),
      '--evidence',
      join(output, 'evidence'),
    ]);
    expect(commandEvidence).toMatch(/installed-release-.*\.json$/);
  } finally {
    await rm(output, { recursive: true, force: true });
    await rm(commandRoot, { recursive: true, force: true });
  }
}, 240_000);
