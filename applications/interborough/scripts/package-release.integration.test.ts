import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { runWithHangGuard } from '@lostgradient/testing/hang-guard';

import { rootScriptEnvironment } from '../../../scripts/environment-configuration.ts';
import { parsePackageReleaseArguments } from './package-release.ts';

const script = join(import.meta.dir, 'package-release.ts');
type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  with?: { name?: string };
};
const workflow = Bun.YAML.parse(
  await readFile(
    resolve(import.meta.dir, '../../../.github/workflows/interborough-npm-release.yml'),
    'utf8',
  ),
) as { jobs: Record<'package' | 'publish' | 'verify', { steps: WorkflowStep[] }> };

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

test('the package, publish and verify jobs use the same versioned artifact name', () => {
  const name = 'interborough-${{ inputs.version }}-darwin-arm64-npm-package';
  expect(
    workflow.jobs.package.steps.find((step) => step.name === 'Upload tested package')?.with?.name,
  ).toBe(name);
  for (const job of [workflow.jobs.publish, workflow.jobs.verify])
    expect(
      job.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'))?.with?.name,
    ).toBe(name);
});

const publishDecisions = await (async () => {
  const root = await mkdtemp(join(tmpdir(), 'interborough-package-publish-'));
  try {
    const publish = workflow.jobs.publish.steps.find(
      (step) => step.name === 'Publish the tested tarball',
    )?.run;
    if (publish === undefined) throw new Error('The release workflow has no publish command');
    const npm = join(root, 'npm');
    // The probe exercises the workflow's shell command without invoking npm or the registry.
    await writeFile(npm, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    await chmod(npm, 0o755);
    const packageDirectory = join(root, 'interborough-package');
    await mkdir(packageDirectory);
    const bytes = 'fixture tarball contents';
    const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
    await writeFile(join(packageDirectory, 'package-result.json'), JSON.stringify({ integrity }));
    const environment = rootScriptEnvironment();
    const runPublish = (version: string) =>
      runWithHangGuard(['bash', '-e', '-o', 'pipefail', '-c', publish], {
        env: {
          ...environment,
          PATH: [root, environment['PATH']].filter(Boolean).join(delimiter),
          RUNNER_TEMP: root,
          VERSION: version,
        },
      });
    const decisions: { version: string; tag: string | undefined; exitCode: number | null }[] = [];
    for (const version of ['1.0.0', '1.0.0-beta.1', '1.0.0+build-note']) {
      await writeFile(join(packageDirectory, `interborough-${version}.tgz`), bytes);
      const child = await runPublish(version);
      if (!child.success)
        throw new Error(`Publish command failed for ${version}: ${child.stderr.toString()}`);
      const arguments_ = child.stdout.toString().split('\n');
      const tagPosition = arguments_.indexOf('--tag');
      decisions.push({
        version,
        tag: tagPosition === -1 ? undefined : arguments_[tagPosition + 1],
        exitCode: child.exitCode,
      });
    }
    await writeFile(join(packageDirectory, 'interborough-1.0.0.tgz'), 'different bytes');
    return { decisions, changedTarball: await runPublish('1.0.0') };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
})();

test('stable versions publish to latest and prereleases publish to next', () => {
  expect(publishDecisions.decisions).toEqual([
    { version: '1.0.0', tag: 'latest', exitCode: 0 },
    { version: '1.0.0-beta.1', tag: 'next', exitCode: 0 },
    { version: '1.0.0+build-note', tag: 'latest', exitCode: 0 },
  ]);
});

test('the publish job reports a changed tarball and stops before calling npm', () => {
  const { changedTarball } = publishDecisions;
  expect(changedTarball.exitCode).toBe(1);
  expect(changedTarball.stdout.toString()).toBe('');
  expect(changedTarball.stderr.toString()).toContain('Tested npm tarball integrity mismatch');
});
