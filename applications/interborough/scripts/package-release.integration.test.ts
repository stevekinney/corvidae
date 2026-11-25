import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
) as {
  jobs: Record<
    'package' | 'publish' | 'verify',
    { steps: WorkflowStep[]; 'runs-on': string; if?: string }
  >;
};

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
    const pack = await runWithHangGuard([
      process.execPath,
      script,
      '--archive',
      archive,
      '--outdir',
      output,
    ]);
    if (!pack.success)
      throw new Error((pack.stderr.length > 0 ? pack.stderr : pack.stdout).toString());
    const result = JSON.parse(await readFile(join(output, 'package-result.json'), 'utf8')) as {
      tarball: string;
      version: string;
      integrity: string;
    };
    const packed = join(root, 'packed');
    await mkdir(packed);
    const unpack = await runWithHangGuard(['tar', '-xzf', result.tarball, '-C', packed]);
    if (!unpack.success) throw new Error(unpack.stderr.toString());
    const packageRoot = join(packed, 'package');
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const sdkInTarball = join(packageRoot, 'payload', sdkPath);
    const binaryInTarball = join(packageRoot, 'payload', 'bin', 'interborough');
    const executableStat = await stat(binaryInTarball);
    return {
      result,
      manifest,
      generatedStyles: await readFile(join(sdkInTarball, 'generated.css'), 'utf8'),
      ignoredMetadata: await Bun.file(join(sdkInTarball, '.gitignore')).exists(),
      executableMode: executableStat.mode,
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

test('packs generated runtime assets that nested ignore files would exclude', () => {
  expect(packaging.generatedStyles).toBe(':root { --fixture-color: red; }\n');
  expect(packaging.ignoredMetadata).toBe(false);
  expect(packaging.executableMode & 0o111).toBe(0o111);
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

test('requires a native offline install and smoke before uploading the package', () => {
  const { package: job } = workflow.jobs;
  expect(job['runs-on']).toBe('macos-15');
  const step = job.steps.findIndex((step) => step.name === 'Test offline install on macOS arm64');
  const upload = job.steps.findIndex((step) => step.name === 'Upload tested package');
  expect(step).toBeGreaterThanOrEqual(0);
  expect(upload).toBeGreaterThan(step);
  expect(job.steps[step]?.run).toContain('npm install --global --offline --ignore-scripts');
  expect(job.steps[step]?.run).toContain('test-installed-release.ts');
});

const publishInputResults = await (async () => {
  const validate = workflow.jobs.package.steps.find(
    (step) => step.name === 'Validate immutable inputs',
  )?.run;
  if (validate === undefined) throw new Error('The release workflow has no validation command');
  const directory = await mkdtemp(join(tmpdir(), 'interborough-package-inputs-'));
  try {
    const source = 'a'.repeat(40);
    const validateInputs = (publish: boolean, protectedRef: boolean, version = '1.0.0') =>
      runWithHangGuard(['bash', '-e', '-o', 'pipefail', '-c', validate], {
        env: {
          ...rootScriptEnvironment(),
          SOURCE_SHA: source,
          VERSION: version,
          PUBLISH: String(publish),
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REF_PROTECTED: String(protectedRef),
          GITHUB_SHA: source,
          GITHUB_OUTPUT: join(directory, 'outputs'),
        },
      });
    const unprotected = await validateInputs(true, false);
    const protectedMain = await validateInputs(true, true);
    const rehearsal = await validateInputs(false, false);
    const emptyVersion = await validateInputs(true, true, '');
    const multiline = await validateInputs(false, false, '1.0.0\nextra');
    const carriageReturn = await validateInputs(false, false, '1.0.0\rextra');
    const verify = workflow.jobs.publish.steps[0]?.run;
    if (verify === undefined) throw new Error('The publish workflow has no source check');
    const verifySource = (tested: string) =>
      runWithHangGuard(['bash', '-e', '-c', verify], {
        env: { ...rootScriptEnvironment(), SOURCE_SHA: tested, GITHUB_SHA: source },
      });
    const matchingSource = await verifySource(source);
    const mismatchedSource = await verifySource('b'.repeat(40));
    return {
      unprotected,
      protectedMain,
      rehearsal,
      emptyVersion,
      multiline,
      carriageReturn,
      matchingSource,
      mismatchedSource,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();

test('only protected main can validate a pinned source for npm publishing', () => {
  expect(publishInputResults.unprotected.success).toBe(false);
  expect(publishInputResults.protectedMain.success).toBe(true);
  expect(publishInputResults.rehearsal.success).toBe(true);
  expect(workflow.jobs.publish.if).toBe(
    "${{ github.event_name == 'workflow_dispatch' && inputs.publish && github.ref == 'refs/heads/main' && github.ref_protected }}",
  );
  expect(workflow.jobs.verify.if).toBe(workflow.jobs.publish.if);
});

test('rejects empty versions and line breaks before exporting release outputs', () => {
  expect(publishInputResults.emptyVersion.success).toBe(false);
  expect(publishInputResults.multiline.success).toBe(false);
  expect(publishInputResults.carriageReturn.success).toBe(false);
});

test('publishing independently checks that the tested source matches the dispatch', () => {
  expect(workflow.jobs.publish.steps[0]?.name).toBe('Verify tested source matches the dispatch');
  expect(publishInputResults.matchingSource.success).toBe(true);
  expect(publishInputResults.mismatchedSource.success).toBe(false);
});

test('rehearses only a main push that changes the npm workflow', async () => {
  const releaseWorkflow = await readFile(
    resolve(import.meta.dir, '../../../.github/workflows/interborough-npm-release.yml'),
    'utf8',
  );
  expect(releaseWorkflow).toContain(
    '  push:\n    branches: [main]\n    paths: [.github/workflows/interborough-npm-release.yml]',
  );
  expect(releaseWorkflow).toContain(
    "SOURCE_SHA: ${{ github.event_name == 'push' && github.sha || inputs.source_sha }}",
  );
  expect(releaseWorkflow).toContain(
    "VERSION: ${{ github.event_name == 'push' && '0.0.0-candidate.0' || inputs.version }}",
  );
  expect(releaseWorkflow).toContain(
    "PUBLISH: ${{ github.event_name == 'workflow_dispatch' && inputs.publish }}",
  );
  expect(releaseWorkflow).toContain('version: ${{ steps.release-inputs.outputs.version }}');
});

test('the package, publish and verify jobs use the same versioned artifact name', () => {
  expect(
    workflow.jobs.package.steps.find((step) => step.name === 'Upload tested package')?.with?.name,
  ).toBe('interborough-${{ steps.release-inputs.outputs.version }}-darwin-arm64-npm-package');
  for (const job of [workflow.jobs.publish, workflow.jobs.verify])
    expect(
      job.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'))?.with?.name,
    ).toBe('interborough-${{ needs.package.outputs.version }}-darwin-arm64-npm-package');
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
