import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packageRelease, parsePackageReleaseArguments } from './package-release.ts';

test('stages an archive as an install-script-free macOS arm64 npm package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interborough-package-release-'));
  try {
    const release = join(root, 'interborough');
    const executable = join(release, 'bin', 'interborough');
    await mkdir(join(release, 'share', 'interborough', 'browser'), { recursive: true });
    await mkdir(
      join(
        release,
        'share',
        'interborough',
        'plugin-runtime',
        'node_modules',
        '@lostgradient',
        'interborough-plugin',
      ),
      { recursive: true },
    );
    await mkdir(join(release, 'bin'), { recursive: true });
    await writeFile(executable, '#!/bin/sh\nprintf "0.0.0-test\\n"\n');
    await chmod(executable, 0o755);
    await writeFile(
      join(release, 'release.json'),
      `${JSON.stringify({ version: '0.0.0-test', target: 'darwin-arm64', sourceSha: '0'.repeat(40) })}\n`,
    );
    await writeFile(join(release, 'share', 'interborough', 'browser', 'index.html'), '<html></html>');
    await writeFile(
      join(
        release,
        'share',
        'interborough',
        'plugin-runtime',
        'node_modules',
        '@lostgradient',
        'interborough-plugin',
        'package.json',
      ),
      '{"name":"@lostgradient/interborough-plugin"}\n',
    );
    const archive = join(root, 'interborough-0.0.0-test-darwin-arm64.tar.gz');
    const tar = Bun.spawn(['tar', '-czf', archive, '-C', root, 'interborough']);
    expect(await tar.exited).toBe(0);

    const result = await packageRelease(['--archive', archive, '--outdir', join(root, 'output')]);
    expect(result.version).toBe('0.0.0-test');
    expect(result.integrity).toStartWith('sha512-');
    const manifest = JSON.parse(await readFile(join(root, 'output', 'package', 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      name: 'interborough',
      version: '0.0.0-test',
      files: ['payload'],
      bin: { interborough: 'payload/bin/interborough' },
      os: ['darwin'],
      cpu: ['arm64'],
    });
    expect(manifest.scripts).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('requires both package release inputs', () => {
  expect(() => parsePackageReleaseArguments([])).toThrow('--archive needs a file');
  expect(() => parsePackageReleaseArguments(['--archive', 'release.tar.gz'])).toThrow(
    '--outdir needs a directory',
  );
});
