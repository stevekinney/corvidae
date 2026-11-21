import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWithHangGuard } from '@lostgradient/testing/hang-guard';

import { parsePackageReleaseArguments } from './package-release.ts';

const script = join(import.meta.dir, 'package-release.ts');

const packaging = await (async () => {
  const root = await mkdtemp(join(tmpdir(), 'interborough-package-release-'));
  try {
    const release = join(root, 'interborough');
    const executable = join(release, 'bin', 'interborough');
    await mkdir(join(release, 'share', 'interborough', 'browser'), { recursive: true });
    const sdkPath = join(
      'share',
      'interborough',
      'plugin-runtime',
      'node_modules',
      '@lostgradient',
      'interborough-plugin',
    );
    const sdk = join(release, sdkPath);
    await mkdir(sdk, { recursive: true });
    await mkdir(join(release, 'bin'), { recursive: true });
    await writeFile(executable, '#!/bin/sh\nprintf "0.0.0-test\\n"\n');
    await chmod(executable, 0o755);
    await writeFile(
      join(release, 'release.json'),
      `${JSON.stringify({ version: '0.0.0-test', target: 'darwin-arm64', sourceSha: '0'.repeat(40) })}\n`,
    );
    await writeFile(
      join(release, 'share', 'interborough', 'browser', 'index.html'),
      '<html></html>',
    );
    await writeFile(join(sdk, 'package.json'), '{"name":"@lostgradient/interborough-plugin"}\n');
    await writeFile(join(sdk, '.gitignore'), 'generated.css\n');
    await writeFile(join(sdk, 'generated.css'), ':root { --fixture-color: red; }\n');
    const archive = join(root, 'interborough-0.0.0-test-darwin-arm64.tar.gz');
    const tar = await runWithHangGuard(['tar', '-czf', archive, '-C', root, 'interborough']);
    if (!tar.success) throw new Error(tar.stderr.toString());

    const output = join(root, 'output');
    const pack = await runWithHangGuard(
      [process.execPath, script, '--archive', archive, '--outdir', output],
      { env: { ...process.env, npm_config_os: 'darwin', npm_config_cpu: 'arm64' } },
    );
    if (!pack.success)
      throw new Error((pack.stderr.length > 0 ? pack.stderr : pack.stdout).toString());
    const result = JSON.parse(await readFile(join(output, 'package-result.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(join(output, 'package', 'package.json'), 'utf8'));
    const installedSdk = join(
      output,
      'prefix',
      'lib',
      'node_modules',
      'interborough',
      'payload',
      sdkPath,
    );
    return {
      result,
      manifest,
      generatedStyles: await readFile(join(installedSdk, 'generated.css'), 'utf8'),
      ignoredMetadata: await Bun.file(join(installedSdk, '.gitignore')).exists(),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
})();

test('stages an archive as an install-script-free macOS arm64 npm package', () => {
  expect(packaging.result.version).toBe('0.0.0-test');
  expect(packaging.result.integrity).toStartWith('sha512-');
  expect(packaging.manifest).toMatchObject({
    name: 'interborough',
    version: '0.0.0-test',
    repository: { type: 'git', url: 'git+https://github.com/stevekinney/corvidae.git' },
    files: ['payload'],
    bin: { interborough: 'payload/bin/interborough' },
    os: ['darwin'],
    cpu: ['arm64'],
  });
  expect(packaging.manifest.scripts).toBeUndefined();
});

test('installs generated runtime assets that nested ignore files would exclude', () => {
  expect(packaging.generatedStyles).toBe(':root { --fixture-color: red; }\n');
  expect(packaging.ignoredMetadata).toBe(false);
});

test('requires both package release inputs', () => {
  expect(() => parsePackageReleaseArguments([])).toThrow('--archive needs a file');
  expect(() => parsePackageReleaseArguments(['--archive', 'release.tar.gz'])).toThrow(
    '--outdir needs a directory',
  );
});

const existingOutput = await (async () => {
  const root = await mkdtemp(join(tmpdir(), 'interborough-package-release-'));
  try {
    const output = join(root, 'output');
    const marker = join(output, 'keep.txt');
    const archive = join(root, 'invalid.tar.gz');
    await mkdir(output);
    await writeFile(marker, 'existing output');
    await writeFile(archive, 'Invalid tar file');

    const pack = await runWithHangGuard([
      process.execPath,
      script,
      '--archive',
      archive,
      '--outdir',
      output,
    ]);
    return {
      exitCode: pack.exitCode,
      stderr: pack.stderr.toString(),
      marker: (await Bun.file(marker).exists()) ? await readFile(marker, 'utf8') : undefined,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
})();

test('refuses to reuse an output directory and preserves its contents', () => {
  expect(existingOutput.exitCode).toBe(1);
  expect(existingOutput.stderr).toContain('Package output already exists');
  expect(existingOutput.marker).toBe('existing output');
});
