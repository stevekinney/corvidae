import { expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPackageMap } from './package-map.ts';
import { runCommand, type CommandRunner } from './packaging.ts';
import { requireGit } from './publication-history.ts';
import { recordSourceDigest, type RecordOptions } from './record-source-digest.ts';
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
    setRegistry: (manifest: Record<string, unknown>, tamper?: boolean) => Promise<void>;
  }) => Promise<void>,
  historicalExtra = false,
): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'publication-proof-'));
  try {
    const historical = join(scratch, 'historical');
    const current = join(scratch, 'current');
    const target = join(scratch, 'target');
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
    await Bun.write(join(target, 'packages/operative/src/index.ts'), 'export const value = 1;\n');
    await Bun.write(join(target, 'packages/operative/runtime.wasm'), 'published extra input');
    const registry: Record<string, unknown> = {
      name: workspace,
      version: '0.12.1',
      files: ['dist'],
      type: 'module',
    };
    await Bun.write(
      join(target, 'packages/operative/package.json'),
      json({ ...registry, version: '0.12.0' }),
    );
    const mirrorCommit = await commit(
      target,
      `Sync agent-bureau from corvidae\n\nCorvidae-Commit: ${sourceCommit.slice(0, 12)}`,
      true,
    );
    await Bun.write(join(target, 'packages/operative/package.json'), json(registry));
    const gitHead = await commit(target, 'Version packages');
    let tarball = new Uint8Array();
    let integrity = '';
    const setRegistry = async (manifest: Record<string, unknown>, tamper = false) => {
      await Bun.write(join(scratch, 'payload/package/package.json'), json(manifest));
      const packed = await runCommand(
        [
          'tar',
          '-czf',
          join(scratch, 'package.tgz'),
          '-C',
          join(scratch, 'payload'),
          'package/package.json',
        ],
        { cwd: scratch },
      );
      if (packed.exitCode !== 0) throw new Error(packed.stderr);
      tarball = new Uint8Array(await Bun.file(join(scratch, 'package.tgz')).arrayBuffer());
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
    await expect(recordSourceDigest(options)).rejects.toThrow('historical source paths or bytes');
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

test('rejects changed historical input, source bytes, dirty checkout, and wrong historical HEAD', async () => {
  await withPublication(async ({ options, current, historical }) => {
    const path = join(current, 'packages/operative/package.json');
    const initial = await Bun.file(path).text();
    await Bun.write(
      path,
      json({ ...JSON.parse(initial), imports: { '#worker': './src/worker.ts' } }),
    );
    await expect(recordSourceDigest(options)).rejects.toThrow(
      'historical publication inputs differ',
    );
    await Bun.write(path, initial);
    await Bun.write(join(current, 'packages/operative/src/index.ts'), 'export const value = 2;\n');
    await expect(recordSourceDigest(options)).rejects.toThrow('historical source paths or bytes');
    await Bun.write(join(current, 'packages/operative/src/index.ts'), 'export const value = 1;\n');
    await Bun.write(join(historical, 'unexpected'), 'dirty');
    await expect(recordSourceDigest(options)).rejects.toThrow('must be clean');
    await commit(historical, 'different source revision');
    await expect(recordSourceDigest(options)).rejects.toThrow('HEAD must equal');
  });
});

test('rejects tampered tarballs and mismatched registry manifests', async () => {
  await withPublication(async ({ options, registry, setRegistry }) => {
    await setRegistry(registry, true);
    await expect(recordSourceDigest(options)).rejects.toThrow('integrity mismatch');
    await setRegistry({ ...registry, files: ['src'] });
    await expect(recordSourceDigest(options)).rejects.toThrow('registry manifest differs');
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
    await expect(recordSourceDigest(options)).rejects.toThrow('non-target-owned path');
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
    await expect(recordSourceDigest({ ...options, registryRunner })).rejects.toThrow(
      'no recorded gitHead',
    );
    await expect(
      recordSourceDigest({
        ...options,
        registryRunner: async (command) => ({
          command: command.join(' '),
          exitCode: 0,
          stderr: '',
          stdout: '0'.repeat(40),
        }),
      }),
    ).rejects.toThrow(/is not in .* history/);
    await expect(
      recordSourceDigest({ ...options, workspace: '@lostgradient/nonexistent' }),
    ).rejects.toThrow('no entry');
    await expect(
      recordSourceDigest({ ...options, workspace: '@lostgradient/weft-ui' }),
    ).rejects.toThrow('not "publish-as"');
    const map = options.packageMap!;
    const entry = map.workspaces[workspace];
    if (entry?.disposition !== 'publish-as') throw new Error('Fixture package must publish');
    await expect(
      recordSourceDigest({
        ...options,
        packageMap: {
          ...map,
          workspaces: { ...map.workspaces, [workspace]: { ...entry, lastPublishedVersion: null } },
        },
      }),
    ).rejects.toThrow('lastPublishedVersion is null');
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
      await expect(recordSourceDigest(options)).rejects.toThrow(
        `source-owned manifest field packages/operative/package.json:${field}`,
      );
    });
  }
});

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
    await expect(read()).rejects.toThrow('no recorded published version');
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
