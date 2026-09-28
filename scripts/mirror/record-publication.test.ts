import { expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { throwingRejectionOf } from '../promise-outcome.test-support.ts';
import { loadPackageMap } from './package-map.ts';
import { readPackagePayload } from './package-payload.ts';
import { runCommand, type CommandRunner } from './packaging.ts';
import { requireGit } from './publication-history.ts';
import { recordSourceDigest, type RecordOptions } from './record-source-digest.ts';
import { committedPublicationManifest } from './registry-manifest.ts';
import { publicationInputContract } from './source-digest.ts';

const workspace = '@lostgradient/operative';
const sourceRoot = join(import.meta.dir, '../..');
const json = (value: unknown) => `${JSON.stringify(value)}\n`;

async function initialize(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await requireGit(directory, ['init', '--quiet', '--initial-branch=main']);
  await requireGit(directory, ['config', 'user.email', 'fixture@example.test']);
  await requireGit(directory, ['config', 'user.name', 'Fixture']);
}

async function commit(directory: string, message: string, mirror = false): Promise<string> {
  await requireGit(directory, ['add', '-A']);
  await requireGit(directory, [
    'commit',
    '--quiet',
    ...(mirror
      ? [
          '--author=lost-gradient-mirror-sync[bot] <331123939+lost-gradient-mirror-sync[bot]@users.noreply.github.com>',
        ]
      : []),
    '-m',
    message,
  ]);
  return requireGit(directory, ['rev-parse', 'HEAD']);
}

async function withPublication(
  body: (fixture: {
    options: RecordOptions;
    historical: string;
    current: string;
    target: string;
    sourceCommit: string;
    gitHead: string;
    registry: Record<string, unknown>;
    setRegistry: (
      manifest: Record<string, unknown>,
      tamper?: boolean,
      files?: Record<string, string>,
    ) => Promise<void>;
  }) => Promise<void>,
  historicalExtra = false,
  targetConfiguration: { mirrorTarget: string; targetDirectory: string } = {
    mirrorTarget: 'agent-bureau',
    targetDirectory: 'packages/operative',
  },
): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'publication-proof-'));
  try {
    const historical = join(scratch, 'historical');
    const current = join(scratch, 'current');
    const target = join(scratch, 'target');
    const targetPackage = (path: string) => join(target, targetConfiguration.targetDirectory, path);
    await initialize(historical);
    const sourceManifest = await Bun.file(join(sourceRoot, 'package.json')).json();
    await Bun.write(
      join(historical, 'package.json'),
      json({
        name: 'corvidae',
        private: true,
        workspaces: ['packages/*'],
        catalog: sourceManifest.catalog,
      }),
    );
    await Bun.write(
      join(historical, 'packages/operative/package.json'),
      json({ name: workspace, private: true, type: 'module' }),
    );
    await Bun.write(
      join(historical, 'packages/operative/src/index.ts'),
      'export const value = 1;\n',
    );
    await Bun.write(join(historical, 'packages/operative/runtime.wasm'), 'published extra input');
    await Bun.write(
      join(historical, 'scripts/mirror/source.ts'),
      `export const sourceTree = 'src'; export const versionConstants = {}; export const additionalSourceRoots = ${historicalExtra ? `{"${workspace}":[{"paths":["runtime.wasm"]}]}` : '{}'}; export const isSourceFile = (name: string) => name.endsWith('.ts');`,
    );
    const surface = await Bun.file(join(sourceRoot, 'scripts/mirror/package-surface.json')).json();
    if (historicalExtra) surface.packages[workspace].files.push('runtime.wasm');
    await Bun.write(join(historical, 'scripts/mirror/package-surface.json'), json(surface));
    const map = await loadPackageMap();
    await Bun.write(join(historical, 'scripts/mirror/package-map.json'), json(map));
    await Bun.write(
      join(historical, 'scripts/mirror/target-owned.json'),
      await Bun.file(join(sourceRoot, 'scripts/mirror/target-owned.json')).text(),
    );
    for (const file of ['target-definitions.ts', 'layout-map.json']) {
      await Bun.write(
        join(historical, 'scripts/mirror', file),
        await Bun.file(join(sourceRoot, 'scripts/mirror', file)).text(),
      );
    }
    if (
      targetConfiguration.mirrorTarget !== 'agent-bureau' ||
      targetConfiguration.targetDirectory !== 'packages/operative'
    ) {
      if (targetConfiguration.mirrorTarget !== 'agent-bureau') {
        await Bun.write(
          join(historical, 'scripts/mirror/target-definitions.ts'),
          `export const targetFor = (_workspace: string) => '${targetConfiguration.mirrorTarget}';\n`,
        );
      }
      const historicalLayoutPath = join(historical, 'scripts/mirror/layout-map.json');
      const historicalLayout = await Bun.file(historicalLayoutPath).json();
      historicalLayout.workspaces[workspace].targetDirectory = targetConfiguration.targetDirectory;
      await Bun.write(historicalLayoutPath, json(historicalLayout));
    }
    await mkdir(join(historical, 'internal/typescript'), { recursive: true });
    await Bun.write(
      join(historical, 'packages/operative/tsconfig.json'),
      json({ extends: '@lostgradient/typescript/library.json' }),
    );
    for (const file of ['base.json', 'library.json', 'browser.json']) {
      await Bun.write(join(historical, 'internal/typescript', file), json({}));
    }
    const sourceCommit = await commit(historical, 'source');
    await cp(historical, current, { recursive: true, filter: (path) => !path.includes('/.git') });
    // Current policy declares no operative additional root: the historical extra must be detected.
    const currentSurface = structuredClone(surface);
    currentSurface.packages[workspace].files = currentSurface.packages[workspace].files.filter(
      (path: string) => path !== 'runtime.wasm',
    );
    await Bun.write(join(current, 'scripts/mirror/package-surface.json'), json(currentSurface));
    await initialize(target);
    await Bun.write(
      join(target, 'package.json'),
      json({ private: true, workspaces: ['packages/*'] }),
    );
    await Bun.write(targetPackage('src/index.ts'), 'export const value = 1;\n');
    await Bun.write(targetPackage('runtime.wasm'), 'published extra input');
    const registry: Record<string, unknown> = {
      name: workspace,
      version: '0.12.1',
      files: ['dist'],
      type: 'module',
    };
    await Bun.write(targetPackage('src/index.ts'), 'export const value = "old-default";\n');
    await Bun.write(targetPackage('package.json'), json({ ...registry, version: '0.12.1' }));
    await commit(target, 'Target default before mirror');
    await Bun.write(targetPackage('src/index.ts'), 'export const value = 1;\n');
    await Bun.write(targetPackage('package.json'), json({ ...registry, version: '0.12.0' }));
    const mirrorCommit = await commit(
      target,
      `Sync ${targetConfiguration.mirrorTarget} from corvidae\n\nCorvidae-Commit: ${sourceCommit.slice(0, 12)}`,
      true,
    );
    await Bun.write(targetPackage('package.json'), json(registry));
    const gitHead = await commit(target, 'Version packages');
    let tarball = new Uint8Array();
    let integrity = '';
    const builtFiles = {
      'dist/index.js': 'export const value = 1;\n',
      'dist/index.d.ts': 'export declare const value = 1;\n',
    };
    const packFixture = async (
      manifest: Record<string, unknown>,
      files: Record<string, string>,
      label: string,
    ) => {
      const directory = join(scratch, label);
      await Bun.write(join(directory, 'package/package.json'), json(manifest));
      for (const [path, bytes] of Object.entries(files)) {
        await Bun.write(join(directory, 'package', path), bytes);
      }
      const packed = await runCommand(
        [
          'tar',
          '-czf',
          join(directory, 'package.tgz'),
          '-C',
          directory,
          'package/package.json',
          ...Object.keys(files).map((path) => `package/${path}`),
        ],
        { cwd: scratch },
      );
      if (packed.exitCode !== 0) throw new Error(packed.stderr);
      return new Uint8Array(await Bun.file(join(directory, 'package.tgz')).arrayBuffer());
    };
    const setRegistry = async (
      manifest: Record<string, unknown>,
      tamper = false,
      files: Record<string, string> = builtFiles,
    ) => {
      tarball = await packFixture(manifest, files, 'registry');
      integrity = `sha512-${new Bun.CryptoHasher('sha512').update(tarball).digest('base64')}`;
      if (tamper) tarball[0] = tarball[0]! ^ 1;
    };
    await setRegistry(registry);
    const registryRunner: CommandRunner = async (command) => ({
      command: command.join(' '),
      exitCode: 0,
      stderr: '',
      stdout: command.includes('gitHead')
        ? gitHead
        : json({ dist: { tarball: 'https://registry.npmjs.org/fixture.tgz', integrity } }),
    });
    const fetcher = Object.assign(async () => new Response(tarball), { preconnect() {} });
    const options: RecordOptions = {
      corvidaeRoot: current,
      publishedSourceRoot: historical,
      mirrorCommit,
      workspace,
      targetRepositoryDirectory: target,
      packageMap: map,
      registryRunner,
      fetcher,
      buildPublishedPackage: async ({ gitHead: releaseCommit, targetDirectory }) => {
        expect(targetDirectory).toBe(targetConfiguration.targetDirectory);
        const manifest = await committedPublicationManifest(
          target,
          releaseCommit,
          targetConfiguration.targetDirectory,
        );
        const archive = await packFixture(manifest, builtFiles, 'clean-build');
        return { manifest, payload: await readPackagePayload(archive) };
      },
      buildHistoricalSurface: async () => ({
        [`${targetConfiguration.targetDirectory}/src/index.ts`]: 'export const value = 1;\n',
        ...(historicalExtra
          ? { [`${targetConfiguration.targetDirectory}/runtime.wasm`]: 'published extra input' }
          : {}),
      }),
    };
    await body({
      options,
      historical,
      current,
      target,
      sourceCommit,
      gitHead,
      registry,
      setRegistry,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test('historical declared roots cannot disappear behind the current collector', async () => {
  await withPublication(async ({ options }) => {
    expect(await throwingRejectionOf(recordSourceDigest(options))).toThrow(
      'historical source paths or bytes',
    );
  }, true);
});

test('binds a version-only target release to its historical private source and actual tarball', async () => {
  await withPublication(async ({ options, sourceCommit, gitHead }) => {
    const result = await recordSourceDigest(options);
    expect(result.snapshot.version).toBe('0.12.1');
    expect(result.snapshot.gitHead).toBe(gitHead);
    expect(result.snapshot.corvidaeCommit).toBe(sourceCommit);
    expect(result.snapshot.source.paths).toEqual(['src/index.ts']);
    expect(result.snapshot.registryManifestContract.digest).not.toBe(
      result.snapshot.publicationInputContract.digest,
    );
  });
});

test('recorder uses the historical target for provenance verification', async () => {
  await withPublication(
    async ({ options }) => {
      const result = await recordSourceDigest(options);
      expect(result.snapshot.corvidaeCommit).toHaveLength(40);
    },
    false,
    { mirrorTarget: 'cinder', targetDirectory: 'packages/operative' },
  );
});

test('recorder uses the historical directory for commit comparison', async () => {
  await withPublication(
    async ({ options }) => {
      const result = await recordSourceDigest(options);
      expect(result.snapshot.corvidaeCommit).toHaveLength(40);
    },
    false,
    { mirrorTarget: 'agent-bureau', targetDirectory: 'packages/operative-legacy' },
  );
});

test('rejects changed historical input, source bytes, dirty checkout, and wrong historical HEAD', async () => {
  await withPublication(async ({ options, current, historical }) => {
    const path = join(current, 'packages/operative/package.json');
    const initial = await Bun.file(path).text();
    await Bun.write(
      path,
      json({ ...JSON.parse(initial), imports: { '#worker': './src/worker.ts' } }),
    );
    expect(await throwingRejectionOf(recordSourceDigest(options))).toThrow(
      'historical publication inputs differ',
    );
    await Bun.write(path, initial);
    await Bun.write(join(current, 'packages/operative/src/index.ts'), 'export const value = 2;\n');
    expect(await throwingRejectionOf(recordSourceDigest(options))).toThrow(
      'historical source paths or bytes',
    );
    await Bun.write(join(current, 'packages/operative/src/index.ts'), 'export const value = 1;\n');
    await Bun.write(join(historical, 'unexpected'), 'dirty');
    expect(await throwingRejectionOf(recordSourceDigest(options))).toThrow('must be clean');
    await commit(historical, 'different source revision');
    expect(await throwingRejectionOf(recordSourceDigest(options))).toThrow('HEAD must equal');
  });
});

test('rejects tampered tarballs and mismatched registry manifests', async () => {
  await withPublication(async ({ options, registry, setRegistry }) => {
    await setRegistry(registry, true);
    expect(await throwingRejectionOf(recordSourceDigest(options))).toThrow('integrity mismatch');
    await setRegistry({ ...registry, files: ['src'] });
    expect(await throwingRejectionOf(recordSourceDigest(options))).toThrow(
      'registry manifest differs',
    );
  });
});

test('rejects altered JavaScript and declarations despite matching manifest and valid registry integrity', async () => {
  await withPublication(async ({ options, registry, setRegistry }) => {
    for (const path of ['dist/index.js', 'dist/index.d.ts']) {
      await setRegistry(registry, false, {
        'dist/index.js': 'export const value = 1;\n',
        'dist/index.d.ts': 'export declare const value = 1;\n',
        [path]: 'altered published payload\n',
      });
      expect(await throwingRejectionOf(recordSourceDigest(options))).toThrow(
        'registry payload differs',
      );
    }
  });
});

test('rejects source changes between the mirror and release commits', async () => {
  await withPublication(async ({ options, target }) => {
    await Bun.write(
      join(target, 'packages/operative/src/index.ts'),
      'export const changed = true;\n',
    );
    const changedCommit = await commit(target, 'change source after mirroring');
    const registryRunner = options.registryRunner!;
    options.registryRunner = (command, settings) =>
      command.includes('gitHead')
        ? Promise.resolve({
            command: command.join(' '),
            exitCode: 0,
            stderr: '',
            stdout: changedCommit,
          })
        : registryRunner(command, settings);
    expect(await throwingRejectionOf(recordSourceDigest(options))).toThrow('non-target-owned path');
  });
});

test('rejects missing registry commits and invalid publication-map entries', async () => {
  await withPublication(async ({ options }) => {
    const registryRunner: CommandRunner = async (command) => ({
      command: command.join(' '),
      exitCode: 0,
      stderr: '',
      stdout: '',
    });
    expect(await throwingRejectionOf(recordSourceDigest({ ...options, registryRunner }))).toThrow(
      'no recorded gitHead',
    );
    expect(
      await throwingRejectionOf(
        recordSourceDigest({
          ...options,
          registryRunner: async (command) => ({
            command: command.join(' '),
            exitCode: 0,
            stderr: '',
            stdout: '0'.repeat(40),
          }),
        }),
      ),
    ).toThrow(/is not in .* history/);
    expect(
      await throwingRejectionOf(
        recordSourceDigest({ ...options, workspace: '@lostgradient/nonexistent' }),
      ),
    ).toThrow('no entry');
    expect(
      await throwingRejectionOf(
        recordSourceDigest({ ...options, workspace: '@lostgradient/weft-ui' }),
      ),
    ).toThrow('not "publish-as"');
    const map = options.packageMap!;
    const entry = map.workspaces[workspace];
    if (entry?.disposition !== 'publish-as') throw new Error('Fixture package must publish');
    expect(
      await throwingRejectionOf(
        recordSourceDigest({
          ...options,
          packageMap: {
            ...map,
            workspaces: {
              ...map.workspaces,
              [workspace]: { ...entry, lastPublishedVersion: null },
            },
          },
        }),
      ),
    ).toThrow('lastPublishedVersion is null');
  });
});

test('publication inputs resolve only referenced catalog values and preserve import condition order', async () => {
  await withPublication(async ({ current }) => {
    const rootPath = join(current, 'package.json');
    const packagePath = join(current, 'packages/operative/package.json');
    const root = await Bun.file(rootPath).json();
    const manifest = await Bun.file(packagePath).json();
    const read = () =>
      publicationInputContract({
        corvidaeRoot: current,
        corvidaeDirectory: 'packages/operative',
        workspace,
      });
    const initial = await read();
    root.catalog.unused = '^1.0.0';
    await Bun.write(rootPath, json(root));
    expect(await read()).toEqual(initial);
    manifest.dependencies = { external: 'catalog:' };
    root.catalog.external = '^1.0.0';
    await Bun.write(packagePath, json(manifest));
    await Bun.write(rootPath, json(root));
    const referenced = await read();
    root.catalog.external = '^2.0.0';
    await Bun.write(rootPath, json(root));
    expect(await read()).not.toEqual(referenced);
    manifest.imports = { '#worker': { browser: './browser.js', default: './default.js' } };
    await Bun.write(packagePath, json(manifest));
    const ordered = await read();
    manifest.imports = { '#worker': { default: './default.js', browser: './browser.js' } };
    await Bun.write(packagePath, json(manifest));
    expect(await read()).not.toEqual(ordered);
  });
});

test('explicit mirror boundary rejects copied provenance trailers and runtime manifest edits', async () => {
  for (const field of ['type', 'imports']) {
    await withPublication(async ({ options, target, sourceCommit, registry }) => {
      const path = join(target, 'packages/operative/package.json');
      const change =
        field === 'type' ? { type: 'commonjs' } : { imports: { '#worker': './worker.js' } };
      await Bun.write(path, json({ ...registry, ...change }));
      const changedCommit = await commit(
        target,
        `Sync agent-bureau from corvidae\n\nCorvidae-Commit: ${sourceCommit}`,
        true,
      );
      const registryRunner = options.registryRunner!;
      options.registryRunner = (command, settings) =>
        command.includes('gitHead')
          ? Promise.resolve({
              command: command.join(' '),
              exitCode: 0,
              stderr: '',
              stdout: changedCommit,
            })
          : registryRunner(command, settings);
      expect(await throwingRejectionOf(recordSourceDigest(options))).toThrow(
        `source-owned manifest field packages/operative/package.json:${field}`,
      );
    });
  }
});

for (const field of ['scripts', 'devDependencies', 'packageManager']) {
  test(`rejects a historical build input change: ${field}`, async () => {
    await withPublication(async ({ options, target, registry, setRegistry }) => {
      const path = join(target, 'packages/operative/package.json');
      const change =
        field === 'scripts'
          ? { scripts: { build: 'bun run changed-build.ts' } }
          : field === 'devDependencies'
            ? { devDependencies: { builder: '^2.0.0' } }
            : { packageManager: 'bun@9.9.9' };
      await Bun.write(path, json({ ...registry, ...change }));
      await setRegistry({ ...registry, ...change });
      const changedCommit = await commit(target, `Change ${field}`, false);
      const registryRunner = options.registryRunner!;
      options.registryRunner = (command, settings) =>
        command.includes('gitHead')
          ? Promise.resolve({
              command: command.join(' '),
              exitCode: 0,
              stderr: '',
              stdout: changedCommit,
            })
          : registryRunner(command, settings);
      expect(await throwingRejectionOf(recordSourceDigest(options))).toThrow(
        `source-owned manifest field packages/operative/package.json:${field}`,
      );
    });
  });
}

test('allows a release metadata change beside historical build inputs', async () => {
  await withPublication(async ({ options, target, registry, setRegistry }) => {
    const path = join(target, 'packages/operative/package.json');
    await Bun.write(path, json({ ...registry, description: 'release metadata' }));
    await setRegistry({ ...registry, description: 'release metadata' });
    const changedCommit = await commit(target, 'Describe release', false);
    const registryRunner = options.registryRunner!;
    options.registryRunner = (command, settings) =>
      command.includes('gitHead')
        ? Promise.resolve({
            command: command.join(' '),
            exitCode: 0,
            stderr: '',
            stdout: changedCommit,
          })
        : registryRunner(command, settings);
    const result = await recordSourceDigest(options);
    expect(result.snapshot.gitHead).toBe(changedCommit);
  });
});

test('accepts a verified mirror commit merged into the old default branch', async () => {
  await withPublication(async ({ options, target, registry }) => {
    const mirrored = await requireGit(target, ['rev-parse', 'HEAD~1']);
    const oldDefault = await requireGit(target, ['rev-parse', `${mirrored}^`]);
    await requireGit(target, ['checkout', '-b', 'merge-default', oldDefault]);
    await Bun.write(join(target, 'CHANGELOG.md'), '# Release notes\n');
    await commit(target, 'Target release notes');
    await requireGit(target, ['merge', '--no-ff', '--no-edit', mirrored]);
    const mergeCommit = await requireGit(target, ['rev-parse', 'HEAD']);
    const parents = await requireGit(target, ['show', '-s', '--format=%P', mergeCommit]);
    expect(parents.split(' ').filter(Boolean)).toHaveLength(2);
    await Bun.write(
      join(target, 'packages/operative/package.json'),
      json({ ...registry, version: '0.12.1' }),
    );
    const mergedRelease = await commit(target, 'Version packages after mirror merge');
    const registryRunner = options.registryRunner!;
    options.registryRunner = (command, settings) =>
      command.includes('gitHead')
        ? Promise.resolve({
            command: command.join(' '),
            exitCode: 0,
            stderr: '',
            stdout: mergedRelease,
          })
        : registryRunner(command, settings);

    const result = await recordSourceDigest(options);
    expect(result.snapshot.gitHead).toBe(mergedRelease);
  });
});

const mergeSideChangeCases: {
  name: string;
  mutateAfterMerge?: (target: string) => Promise<void>;
  mutateSideBranch?: (target: string) => Promise<void>;
  mutateOldDefault?: (target: string) => Promise<void>;
  expected: string;
}[] = [
  {
    name: 'merge resolution source change',
    mutateAfterMerge: async (target: string) => {
      await Bun.write(
        join(target, 'packages/operative/src/index.ts'),
        'export const value = "resolved-maliciously";\n',
      );
    },
    expected: 'non-target-owned path packages/operative/src/index.ts',
  },
  {
    name: 'side branch build input',
    mutateSideBranch: async (target: string) => {
      const manifest = JSON.parse(
        await Bun.file(join(target, 'packages/operative/package.json')).text(),
      );
      await Bun.write(
        join(target, 'packages/operative/package.json'),
        json({ ...manifest, scripts: { build: 'bun run bad.ts' } }),
      );
    },
    expected: 'source-owned manifest field packages/operative/package.json:scripts',
  },
  {
    name: 'old default side branch build input',
    mutateOldDefault: async (target: string) => {
      const manifest = JSON.parse(
        await Bun.file(join(target, 'packages/operative/package.json')).text(),
      );
      await Bun.write(
        join(target, 'packages/operative/package.json'),
        json({ ...manifest, scripts: { build: 'bun run old-default-bad.ts' } }),
      );
    },
    expected: 'source-owned manifest field packages/operative/package.json:scripts',
  },
  {
    name: 'transient source change reverted on a descendant branch',
    mutateSideBranch: async (target: string) => {
      await Bun.write(
        join(target, 'packages/operative/src/index.ts'),
        'export const value = "transient";\n',
      );
      await commit(target, 'Transient source change');
      await Bun.write(join(target, 'packages/operative/src/index.ts'), 'export const value = 1;\n');
    },
    expected: 'non-target-owned path packages/operative/src/index.ts',
  },
  {
    name: 'manifest field add and delete',
    mutateSideBranch: async (target: string) => {
      const manifest = JSON.parse(
        await Bun.file(join(target, 'packages/operative/package.json')).text(),
      );
      await Bun.write(
        join(target, 'packages/operative/package.json'),
        json({ ...manifest, imports: { '#bad': './bad.ts' } }),
      );
      await commit(target, 'Add source-owned manifest field');
      await Bun.write(join(target, 'packages/operative/package.json'), json(manifest));
    },
    expected: 'source-owned manifest field packages/operative/package.json:imports',
  },
];

for (const testCase of mergeSideChangeCases) {
  test(`rejects a merge-side change: ${testCase.name}`, async () => {
    await withPublication(async ({ options, target, registry }) => {
      const slug = testCase.name.replaceAll(' ', '-');
      const mirrored = await requireGit(target, ['rev-parse', 'HEAD~1']);
      const oldDefault = await requireGit(target, ['rev-parse', `${mirrored}^`]);
      let mergedCommit: string | undefined;
      if (testCase.mutateOldDefault) {
        await requireGit(target, ['checkout', '-b', `malicious-${slug}`, oldDefault]);
        await testCase.mutateOldDefault(target);
        await commit(target, `Complete ${testCase.name}`);
        await requireGit(target, ['checkout', '-B', `merge-${slug}`, `malicious-${slug}`]);
        await requireGit(target, ['merge', '--no-ff', '--no-commit', '-X', 'ours', mirrored]);
        await commit(target, `Complete ${testCase.name} merge`);
        mergedCommit = await requireGit(target, ['rev-parse', 'HEAD']);
      } else if (testCase.mutateSideBranch) {
        await requireGit(target, ['checkout', '-b', `malicious-${slug}`, mirrored]);
        await testCase.mutateSideBranch(target);
        await commit(target, `Complete ${testCase.name}`);
        await requireGit(target, ['checkout', '-B', `merge-${slug}`, oldDefault]);
        await Bun.write(join(target, 'CHANGELOG.md'), '# Release notes\n');
        await commit(target, 'Target release notes');
        await requireGit(target, ['merge', '--no-ff', '--no-edit', `malicious-${slug}`]);
      } else {
        await requireGit(target, ['checkout', '-b', `merge-${slug}`, oldDefault]);
        await Bun.write(join(target, 'CHANGELOG.md'), '# Release notes\n');
        await commit(target, 'Target release notes');
        if (testCase.mutateAfterMerge) {
          await requireGit(target, ['merge', '--no-ff', '--no-commit', mirrored]);
          await testCase.mutateAfterMerge(target);
          await commit(target, `Complete ${testCase.name} merge`);
          mergedCommit = await requireGit(target, ['rev-parse', 'HEAD']);
        } else {
          await requireGit(target, ['merge', '--no-ff', '--no-edit', mirrored]);
        }
      }
      if (testCase.mutateAfterMerge) {
        const parents = await requireGit(target, ['show', '-s', '--format=%P', mergedCommit!]);
        expect(parents.split(' ').filter(Boolean)).toHaveLength(2);
      }
      await Bun.write(
        join(target, 'packages/operative/package.json'),
        json({ ...registry, version: '0.12.1' }),
      );
      const release = await commit(target, `Release after ${testCase.name}`);
      const registryRunner = options.registryRunner!;
      options.registryRunner = (command, settings) =>
        command.includes('gitHead')
          ? Promise.resolve({
              command: command.join(' '),
              exitCode: 0,
              stderr: '',
              stdout: release,
            })
          : registryRunner(command, settings);
      expect(await throwingRejectionOf(recordSourceDigest(options))).toThrow(testCase.expected);
    });
  });
}

test('publication inputs include emitted build scripts and resolved toolchain versions', async () => {
  await withPublication(async ({ current }) => {
    const surfacePath = join(current, 'scripts/mirror/package-surface.json');
    const surface = await Bun.file(surfacePath).json();
    const read = () =>
      publicationInputContract({
        corvidaeRoot: current,
        corvidaeDirectory: 'packages/operative',
        workspace,
      });
    const initial = await read();
    surface.packages[workspace].build.scripts.build = 'bun run alternate-build.ts';
    await Bun.write(surfacePath, json(surface));
    expect(await read()).not.toEqual(initial);
    surface.packages[workspace].build.toolchain = { builder: 'catalog:' };
    await Bun.write(surfacePath, json(surface));
    const rootPath = join(current, 'package.json');
    const root = await Bun.file(rootPath).json();
    root.catalog.builder = '^1.0.0';
    await Bun.write(rootPath, json(root));
    const firstToolchain = await read();
    root.catalog.builder = '^2.0.0';
    await Bun.write(rootPath, json(root));
    expect(await read()).not.toEqual(firstToolchain);
  });
});

test('publication inputs include effective emitted TypeScript configuration', async () => {
  for (const configuration of ['library', 'browser'] as const) {
    await withPublication(async ({ current }) => {
      await mkdir(join(current, 'internal/typescript'), { recursive: true });
      await Bun.write(
        join(current, 'packages/operative/tsconfig.json'),
        json({
          extends: `@lostgradient/typescript/${configuration}.json`,
          compilerOptions: { declaration: true },
        }),
      );
      await Bun.write(
        join(current, 'internal/typescript/base.json'),
        json({ compilerOptions: { strict: true } }),
      );
      await Bun.write(
        join(current, 'internal/typescript/library.json'),
        json({ extends: './base.json', compilerOptions: { declaration: true } }),
      );
      await Bun.write(
        join(current, 'internal/typescript/browser.json'),
        json({ extends: './base.json', compilerOptions: { lib: ['DOM'] } }),
      );
      await Bun.write(
        join(current, 'packages/operative/examples/tsconfig.json'),
        json({ compilerOptions: { strict: false } }),
      );

      const read = () =>
        publicationInputContract({
          corvidaeRoot: current,
          corvidaeDirectory: 'packages/operative',
          workspace,
        });
      const initial = await read();

      await Bun.write(
        join(current, 'packages/operative/tsconfig.json'),
        json({
          extends: `@lostgradient/typescript/${configuration}.json`,
          compilerOptions: { declaration: false },
        }),
      );
      const afterWorkspaceConfiguration = await read();
      expect(afterWorkspaceConfiguration).not.toEqual(initial);

      await Bun.write(
        join(current, `internal/typescript/${configuration}.json`),
        json({ extends: './base.json', compilerOptions: { declaration: false } }),
      );
      const afterSharedConfiguration = await read();
      expect(afterSharedConfiguration).not.toEqual(afterWorkspaceConfiguration);

      await Bun.write(
        join(current, 'internal/typescript/base.json'),
        json({ compilerOptions: { strict: false } }),
      );
      const afterBaseConfiguration = await read();
      expect(afterBaseConfiguration).not.toEqual(afterSharedConfiguration);

      await Bun.write(
        join(current, 'packages/operative/examples/tsconfig.json'),
        json({ compilerOptions: { strict: true } }),
      );
      expect(await read()).toEqual(afterBaseConfiguration);
      await cp(join(current, 'packages/operative'), join(current, 'components/operative'), {
        recursive: true,
      });
      const layoutPath = join(current, 'scripts/mirror/layout-map.json');
      const layout = await Bun.file(layoutPath).json();
      layout.workspaces[workspace].corvidaeDirectory = 'components/operative';
      await Bun.write(layoutPath, json(layout));
      expect(
        await publicationInputContract({
          corvidaeRoot: current,
          corvidaeDirectory: 'components/operative',
          workspace,
        }),
      ).toEqual(afterBaseConfiguration);
    });
  }
});

test('publication inputs use the historical layout', async () => {
  await withPublication(async ({ current, historical }) => {
    const writeCompilerInputs = async (root: string) => {
      await mkdir(join(root, 'internal/typescript'), { recursive: true });
      await Bun.write(
        join(root, 'packages/operative/tsconfig.json'),
        json({ extends: '@lostgradient/typescript/library.json' }),
      );
      for (const file of ['base.json', 'library.json', 'browser.json']) {
        await Bun.write(join(root, 'internal/typescript', file), json({}));
      }
    };
    await writeCompilerInputs(current);
    await writeCompilerInputs(historical);
    const read = (root: string) =>
      publicationInputContract({
        corvidaeRoot: root,
        corvidaeDirectory: 'packages/operative',
        workspace,
      });
    const currentContract = await read(current);
    const equivalentHistoricalContract = await read(historical);
    expect(equivalentHistoricalContract.digest).toBe(currentContract.digest);

    const historicalLayoutPath = join(historical, 'scripts/mirror/layout-map.json');
    const historicalLayout = await Bun.file(historicalLayoutPath).json();
    historicalLayout.workspaces[workspace].targetDirectory = 'packages/operative-legacy';
    await Bun.write(historicalLayoutPath, json(historicalLayout));
    const relocatedHistoricalContract = await read(historical);
    expect(relocatedHistoricalContract.digest).not.toBe(currentContract.digest);
  });
});

test('publication inputs use the historical target routing', async () => {
  await withPublication(async ({ current, historical }) => {
    const writeCompilerInputs = async (root: string) => {
      await mkdir(join(root, 'internal/typescript'), { recursive: true });
      await Bun.write(
        join(root, 'packages/operative/tsconfig.json'),
        json({ extends: '@lostgradient/typescript/library.json' }),
      );
      for (const file of ['base.json', 'library.json', 'browser.json']) {
        await Bun.write(join(root, 'internal/typescript', file), json({}));
      }
    };
    await writeCompilerInputs(current);
    await writeCompilerInputs(historical);
    const read = (root: string) =>
      publicationInputContract({
        corvidaeRoot: root,
        corvidaeDirectory: 'packages/operative',
        workspace,
      });
    const currentContract = await read(current);
    await Bun.write(
      join(historical, 'scripts/mirror/target-definitions.ts'),
      `export const targetFor = (_workspace: string) => 'cinder';\n`,
    );
    const reroutedHistoricalContract = await read(historical);
    expect(reroutedHistoricalContract.digest).not.toBe(currentContract.digest);
  });
});

test('publication inputs load historical target routing from manifests', async () => {
  await withPublication(async ({ current, historical }) => {
    const writeCompilerInputs = async (root: string) => {
      await mkdir(join(root, 'internal/typescript'), { recursive: true });
      await Bun.write(
        join(root, 'packages/operative/tsconfig.json'),
        json({ extends: '@lostgradient/typescript/library.json' }),
      );
      for (const file of ['base.json', 'library.json', 'browser.json']) {
        await Bun.write(join(root, 'internal/typescript', file), json({}));
      }
    };
    await writeCompilerInputs(current);
    await writeCompilerInputs(historical);
    await rm(join(historical, 'scripts/mirror/target-definitions.ts'));
    await Bun.write(
      join(historical, 'scripts/mirror/manifests.ts'),
      `export const targetFor = (_workspace: string) => 'cinder';\n`,
    );
    const currentContract = await publicationInputContract({
      corvidaeRoot: current,
      corvidaeDirectory: 'packages/operative',
      workspace,
    });
    const historicalContract = await publicationInputContract({
      corvidaeRoot: historical,
      corvidaeDirectory: 'packages/operative',
      workspace,
    });
    expect(historicalContract.digest).not.toBe(currentContract.digest);
  });
});

test('publication inputs use historical routing for workspace dependency ranges', async () => {
  await withPublication(async ({ current, historical }) => {
    for (const root of [current, historical]) {
      await mkdir(join(root, 'internal/typescript'), { recursive: true });
      await Bun.write(
        join(root, 'packages/operative/tsconfig.json'),
        json({ extends: '@lostgradient/typescript/library.json' }),
      );
      for (const file of ['base.json', 'library.json', 'browser.json']) {
        await Bun.write(join(root, 'internal/typescript', file), json({}));
      }
      const manifestPath = join(root, 'packages/operative/package.json');
      const manifest = await Bun.file(manifestPath).json();
      manifest.dependencies = { '@lostgradient/lifecycle': 'workspace:*' };
      await Bun.write(manifestPath, json(manifest));
      const map = await Bun.file(join(root, 'scripts/mirror/package-map.json')).json();
      map.workspaces['@lostgradient/lifecycle'].lastPublishedVersion = '1.0.0';
      await Bun.write(join(root, 'scripts/mirror/package-map.json'), json(map));
    }
    const read = (root: string) =>
      publicationInputContract({
        corvidaeRoot: root,
        corvidaeDirectory: 'packages/operative',
        workspace,
      });
    const currentContract = await read(current);
    await Bun.write(
      join(historical, 'scripts/mirror/target-definitions.ts'),
      `export const targetFor = (workspace: string) => workspace === '@lostgradient/lifecycle' || workspace === '@lostgradient/typescript' ? 'cinder' : 'agent-bureau';\n`,
    );
    const historicalContract = await read(historical);
    expect(historicalContract.digest).not.toBe(currentContract.digest);
  });
});

test('publication inputs fail closed when historical routing facts are missing', async () => {
  await withPublication(async ({ historical }) => {
    await rm(join(historical, 'scripts/mirror/layout-map.json'));
    expect(
      await throwingRejectionOf(
        publicationInputContract({
          corvidaeRoot: historical,
          corvidaeDirectory: 'packages/operative',
          workspace,
        }),
      ),
    ).toThrow('historical layout is missing');
  });
});

test('publication inputs fail closed when historical routing modules are missing', async () => {
  await withPublication(async ({ historical }) => {
    await rm(join(historical, 'scripts/mirror/target-definitions.ts'));
    expect(
      await throwingRejectionOf(
        publicationInputContract({
          corvidaeRoot: historical,
          corvidaeDirectory: 'packages/operative',
          workspace,
        }),
      ),
    ).toThrow('historical target routing is missing');
  });
});

test('publication inputs bind workspace dependencies to their recorded published versions', async () => {
  await withPublication(async ({ current }) => {
    const manifestPath = join(current, 'packages/operative/package.json');
    const manifest = await Bun.file(manifestPath).json();
    manifest.dependencies = { '@lostgradient/lifecycle': 'workspace:*' };
    await Bun.write(manifestPath, json(manifest));
    const mapPath = join(current, 'scripts/mirror/package-map.json');
    const map = await Bun.file(mapPath).json();
    const read = () =>
      publicationInputContract({
        corvidaeRoot: current,
        corvidaeDirectory: 'packages/operative',
        workspace,
      });
    map.workspaces['@lostgradient/lifecycle'].lastPublishedVersion = '1.0.0';
    await Bun.write(mapPath, json(map));
    const before = await read();
    map.workspaces['@lostgradient/lifecycle'].lastPublishedVersion = '1.0.1';
    await Bun.write(mapPath, json(map));
    const after = await read();
    expect(after).not.toEqual(before);
    map.workspaces['@lostgradient/lifecycle'].lastPublishedVersion = null;
    await Bun.write(mapPath, json(map));
    expect(await throwingRejectionOf(read())).toThrow('no recorded published version');
    expect(
      await publicationInputContract({
        corvidaeRoot: current,
        corvidaeDirectory: 'packages/operative',
        workspace,
        publishedWorkspaceVersions: new Map([['@lostgradient/lifecycle', '1.0.1']]),
      }),
    ).toEqual(after);
  });
});

test('publication inputs match the mirror effective cross-target range', async () => {
  await withPublication(async ({ current }) => {
    const manifestPath = join(current, 'packages/operative/package.json');
    const manifest = await Bun.file(manifestPath).json();
    const map = await Bun.file(join(current, 'scripts/mirror/package-map.json')).json();
    const read = () =>
      publicationInputContract({
        corvidaeRoot: current,
        corvidaeDirectory: 'packages/operative',
        workspace,
      });
    manifest.dependencies = { '@lostgradient/weft': 'workspace:*' };
    await Bun.write(manifestPath, json(manifest));
    const workspaceInput = await read();
    manifest.dependencies = {
      '@lostgradient/weft': `^${map.workspaces['@lostgradient/weft'].lastPublishedVersion}`,
    };
    await Bun.write(manifestPath, json(manifest));
    expect(await read()).toEqual(workspaceInput);
  });
});
