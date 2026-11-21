import type { PluginPanel } from '@lostgradient/interborough-plugin';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CINDER_GENERATED_OUTPUTS } from '../../../scripts/ensure-cinder-generated.ts';
import { digestOf } from '../src/host/panel-build.ts';
import { prebuiltPanelSchema } from '../src/host/panel-mounts.ts';
import {
  PANEL_RUNTIME_PACKAGES,
  buildRelease,
  parseReleaseArguments,
  prebuildPanels,
  readRepositoryState,
  runCommand,
  runReleaseCommand,
  workspacePanels,
  type ReleaseOperations,
  type RepositoryState,
  type WorkspacePanel,
} from './build-release.ts';

const FIXTURE_SOURCE_SHA = '0123456789abcdef0123456789abcdef01234567';

/** What the fixture's frozen install holds of each package a runtime panel build needs. */
const PANEL_RUNTIME_FIXTURE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  svelte: {
    'package.json': JSON.stringify({
      name: 'svelte',
      version: '5.0.0',
      exports: { '.': './src/index.js', './compiler': './compiler/index.js' },
    }),
    'src/index.js': 'export {};',
    'compiler/index.js': 'export const compile = () => ({});',
  },
  '@lostgradient/cinder': {
    'package.json': JSON.stringify({
      name: '@lostgradient/cinder',
      version: '0.0.0',
      exports: { './panel': './src/panel/index.ts' },
    }),
    'src/panel/index.ts': 'export const mountPanel = () => {};',
    'src/panel/panel.css': ':root{}',
  },
  '@modelcontextprotocol/ext-apps': {
    'package.json': JSON.stringify({
      name: '@modelcontextprotocol/ext-apps',
      version: '1.0.0',
      main: './dist/index.js',
    }),
    'dist/index.js': 'export {};',
  },
};

function fixturePanel(name: string): PluginPanel {
  return {
    name,
    title: `The ${name} panel`,
    uri: `ui://fixture/${name}/v1`,
    entry: pathToFileURL(join(tmpdir(), `${name}.ts`)),
    styles: '',
    allowedTools: [`bureau.fixture.${name}`],
  };
}

/** Two workspace plugins, three panels: the release prebuilds every one of them. */
const FIXTURE_PANELS: readonly WorkspacePanel[] = [
  { plugin: 'inspectors', app: fixturePanel('run-inspector') },
  { plugin: 'inspectors', app: fixturePanel('pending-review') },
  { plugin: 'reporter', app: fixturePanel('weekly-report') },
];
const cleanRepositoryState = async (): Promise<RepositoryState> => ({
  status: '',
  sourceSha: FIXTURE_SOURCE_SHA,
});

async function disposableRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'interborough-release-repository-'));
  const git = ['git', '-c', 'user.name=Release Test', '-c', 'user.email=release@example.test'];
  const unsigned = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
  await runCommand(['git', 'init', '--quiet'], repository);
  await writeFile(join(repository, 'tracked.txt'), 'tracked\n');
  await runCommand(['git', 'add', 'tracked.txt'], repository);
  await runCommand([...git, ...unsigned, 'commit', '--quiet', '-m', 'fixture'], repository);
  return repository;
}

async function releaseFixture(
  options: {
    readonly invalidExports?: boolean;
    readonly escapingLink?: boolean;
    readonly commandFailure?: boolean;
    readonly recursiveDependency?: boolean;
    readonly missingDependency?: boolean;
    readonly productionEntryInExcludedDirectory?: boolean;
    readonly invalidExportMap?: boolean;
    /** A package of {@link PANEL_RUNTIME_FIXTURE} the frozen install leaves out. */
    readonly missingPanelRuntime?: string;
    readonly runtimeFailure?:
      | 'missing-link'
      | 'wrong-link'
      | 'missing-inspector'
      | 'not-running'
      | 'missing-contribution'
      | 'malformed-html'
      | 'plain-html'
      | 'poll-error';
    readonly markerPath?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'interborough-release-fixture-'));
  const generatedCinder = join(root, 'generated-cinder');
  for (const file of CINDER_GENERATED_OUTPUTS) {
    const target = join(generatedCinder, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `fixture asset: ${file}`);
  }
  const source = join(root, 'source');
  const dependencies = join(root, 'dependencies');
  const sdk = join(dependencies, '@lostgradient', 'interborough-plugin');
  await mkdir(join(sdk, 'src', 'testing'), { recursive: true });
  await mkdir(join(source, 'packages', 'interborough-plugin', 'src', 'testing'), {
    recursive: true,
  });
  await writeFile(
    join(sdk, 'package.json'),
    JSON.stringify({
      name: '@lostgradient/interborough-plugin',
      dependencies: options.recursiveDependency ? { 'fixture-dependency': '1.0.0' } : undefined,
      exports: options.invalidExportMap
        ? []
        : options.invalidExports
          ? { '.': './dist/index.js' }
          : { '.': './src/index.ts', './testing': './src/testing/index.ts' },
    }),
  );
  await writeFile(join(source, 'packages', 'interborough-plugin', 'src', 'index.ts'), 'export {};');
  await writeFile(
    join(source, 'packages', 'interborough-plugin', 'src', 'testing', 'index.ts'),
    'export {};',
  );
  const dependency = join(dependencies, 'fixture-dependency');
  if (options.recursiveDependency && !options.missingDependency) {
    await mkdir(dependency, { recursive: true });
    await writeFile(
      join(dependency, 'package.json'),
      JSON.stringify({
        name: 'fixture-dependency',
        main: options.productionEntryInExcludedDirectory ? './index.ts' : undefined,
      }),
    );
    if (options.productionEntryInExcludedDirectory) {
      await mkdir(join(dependency, 'test'), { recursive: true });
      await writeFile(join(dependency, 'index.ts'), "export { fixture } from './test/index.ts';\n");
      await writeFile(join(dependency, 'test', 'index.ts'), 'export const fixture = true;\n');
    }
  }
  if (options.escapingLink)
    await symlink('/tmp/interborough-release-missing-target', join(sdk, 'escape'));
  const buildArguments: string[][] = [];
  const commands: string[][] = [];
  const command = async (arguments_: string[]): Promise<void> => {
    commands.push(arguments_);
    if (arguments_[1] === 'build') {
      buildArguments.push(arguments_);
      if (options.commandFailure) throw new Error('fixture command failed');
      const output = arguments_[arguments_.indexOf('--outfile') + 1];
      if (output === undefined) throw new Error('missing bundle output');
      if (arguments_.includes('--compile')) {
        await writeFile(
          output,
          `#!${process.execPath}
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const home = process.argv[process.argv.indexOf('--home') + 1];
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
if (port !== 0) throw new Error('The release proof must ask the host for port 0');
const root = dirname(dirname(process.argv[1]));
const runtime = join(root, 'share', 'interborough', 'plugin-runtime', 'node_modules');
const marker = ${JSON.stringify(options.markerPath ?? '')};
const behavior = ${JSON.stringify(options.runtimeFailure ?? '')};
if (marker) {
  process.on('SIGTERM', async () => {
    await writeFile(marker, 'terminated');
    process.exit(0);
  });
  await writeFile(marker, 'started');
}
if (behavior === 'missing-inspector') await rm(join(root, 'share', 'interborough', 'panels', 'run-inspector.json'), { force: true });
// The verifier can stop this process as soon as it sees the link.
if (behavior !== 'missing-link') {
  await mkdir(join(home, 'plugins'), { recursive: true });
  await symlink(${options.runtimeFailure === 'wrong-link' ? 'home' : 'runtime'}, join(home, 'plugins', 'node_modules'));
}
if (behavior === 'poll-error') await Bun.sleep(100);
const server = Bun.serve({ port, fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/host/plugins') return Response.json({ plugins: [{ descriptor: { name: 'runtime-proof' }, status: behavior === 'not-running' ? 'stopped' : 'running', contributions: behavior === 'missing-contribution' ? [] : [{ kind: 'panel', id: 'runtime-proof:external-proof' }] }] });
  if (pathname === '/host/plugins/runtime-proof/apps/external-proof') return Response.json({ html: behavior === 'malformed-html' ? 42 : behavior === 'plain-html' ? '<html>external runtime</html>' : '<html>external runtime<style>:root{--cinder-status-info-background:red}</style></html>' });
  return new Response('not found', { status: 404 });
} });
await writeFile(join(home, 'server-port'), String(server.port));
if (marker && behavior === 'poll-error') await writeFile(marker, 'ready');
console.info('Interborough is listening on http://127.0.0.1:' + server.port);
await new Promise(() => {});
`,
          { mode: 0o755 },
        );
      } else await writeFile(output, 'export {};');
    } else if (arguments_[1] === 'install') {
      // The frozen-install helper is real; only its package-manager process is controlled.
    } else if (arguments_[0] === 'git') {
      // The archive extraction command below populates the isolated source fixture.
    } else if (arguments_[0] === 'tar') {
      if (arguments_[1] === '-xf') {
        const destination = arguments_[arguments_.indexOf('-C') + 1];
        if (destination === undefined) throw new Error('missing extraction destination');
        await mkdir(join(destination, 'packages', 'interborough-plugin'), { recursive: true });
        await cp(
          join(source, 'packages', 'interborough-plugin'),
          join(destination, 'packages', 'interborough-plugin'),
          { recursive: true },
        );
        await writeFile(join(destination, 'bun.lock'), 'fixture lock');
        const installed = join(destination, 'applications', 'interborough', 'node_modules');
        await mkdir(join(installed, '@lostgradient'), { recursive: true });
        await cp(sdk, join(installed, '@lostgradient', 'interborough-plugin'), { recursive: true });
        for (const [name, files] of Object.entries(PANEL_RUNTIME_FIXTURE)) {
          if (options.missingPanelRuntime === name) continue;
          for (const [file, contents] of Object.entries(files)) {
            await mkdir(dirname(join(installed, name, file)), { recursive: true });
            await writeFile(join(installed, name, file), contents);
          }
        }
        if (options.recursiveDependency && !options.missingDependency) {
          const store = join(
            destination,
            'node_modules',
            '.bun',
            'fixture-dependency@1',
            'node_modules',
          );
          await mkdir(store, { recursive: true });
          await cp(dependency, join(store, 'fixture-dependency'), { recursive: true });
        }
        if (
          !(await Bun.file(
            join(installed, '@lostgradient', 'interborough-plugin', 'package.json'),
          ).exists())
        )
          throw new Error(`fixture SDK missing after extraction: ${installed}`);
      } else {
        const output = arguments_[2];
        if (output === undefined) throw new Error('missing archive output');
        await writeFile(output, 'archive');
      }
    }
  };
  const productionOperations: ReleaseOperations = {
    platform: 'darwin',
    architecture: 'arm64',
    runCommand: command,
    generatedCinder,
    buildApplication: async (options) => {
      const outdir = options?.outdir;
      if (outdir === undefined) throw new Error('missing browser output');
      await mkdir(outdir, { recursive: true });
      await writeFile(join(outdir, 'index.html'), '<html>fixture</html>');
      return { directory: outdir, files: ['index.html'], metafile: {} } as never;
    },
    buildPanelPage: async (options) => {
      const html = `<html>${options.title}</html>`;
      return { html, contentDigest: digestOf(html) };
    },
    workspacePanels: async () => FIXTURE_PANELS,
  };
  // Fixtures control repository state so a dirty checkout cannot stop the assertions early.
  const operations: ReleaseOperations = {
    ...productionOperations,
    readRepositoryState: cleanRepositoryState,
  };
  return { root, operations, productionOperations, buildArguments, commands };
}

async function expectRelocatedFailure(
  runtimeFailure: Exclude<
    NonNullable<Parameters<typeof releaseFixture>[0]>['runtimeFailure'],
    undefined
  >,
  message: string,
) {
  const marker = join(await mkdtemp(join(tmpdir(), 'interborough-release-marker-')), 'lifecycle');
  const fixture = await releaseFixture({ markerPath: marker, runtimeFailure });
  const output = await mkdtemp(join(tmpdir(), `interborough-release-${runtimeFailure}-`));
  try {
    // These fixtures reach the verifier's HTTP checks. Keep the real startup clock so a
    // scheduled sleep before the child binds cannot consume the retry window in a tight loop.
    expect(
      await throwingRejectionOf(
        buildRelease(['--version', '0.0.0-test', '--outdir', output], fixture.operations),
      ),
    ).toThrow(message);
    expect(await Bun.file(marker).text()).toBe('terminated');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
    await rm(marker, { force: true });
  }
}

describe('release arguments', () => {
  // spawn-free: direct command coverage uses short, deterministic process fixtures.
  test('runs the default command and reports failures', async () => {
    await runCommand([process.execPath, '-e', 'process.stdout.write("ok")']);
    expect(
      await throwingRejectionOf(
        runCommand([process.execPath, '-e', 'process.stderr.write("bad"); process.exit(3)']),
      ),
    ).toThrow('failed (3): bad');
  });
  test('requires a semver and output directory', () => {
    expect(parseReleaseArguments(['--version', '1.2.3', '--outdir', '/tmp/release'])).toEqual({
      version: '1.2.3',
      outdir: '/tmp/release',
    });
    expect(() => parseReleaseArguments(['--outdir', '/tmp/release'])).toThrow('--version');
    expect(() =>
      parseReleaseArguments(['--version', 'latest', '--outdir', '/tmp/release']),
    ).toThrow('semver');
  });

  test('rejects unknown arguments', () => {
    expect(() => parseReleaseArguments(['--version', '1.2.3', '--nope'])).toThrow(
      'Unknown release argument',
    );
  });

  test('runs the command boundary and logs the archive returned by the release function', async () => {
    const lines: string[] = [];
    const archive = await runReleaseCommand(
      (line) => lines.push(line),
      async (argv) => {
        expect(argv).toEqual(['--version', '0.0.0-test']);
        return '/tmp/interborough.tar.gz';
      },
      ['--version', '0.0.0-test'],
    );
    expect(archive).toBe('/tmp/interborough.tar.gz');
    expect(lines).toEqual(['/tmp/interborough.tar.gz']);
  });

  // spawn-free: the injected release boundary avoids starting the production child process.
  test('uses the command boundary defaults', async () => {
    expect(
      await runReleaseCommand(undefined, async () => '/tmp/interborough-default.tar.gz', [
        '--version',
        '0.0.0-test',
      ]),
    ).toBe('/tmp/interborough-default.tar.gz');
  });

  // spawn-free: the release fixture controls every child process boundary deterministically.
  test('rejects an existing release output before installing or staging', async () => {
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-collision-'));
    try {
      await writeFile(join(output, 'interborough-0.0.0-test-darwin-arm64.tar.gz'), 'sentinel');
      expect(
        await throwingRejectionOf(
          buildRelease(['--version', '0.0.0-test', '--outdir', output], {
            platform: 'darwin',
            architecture: 'arm64',
            readRepositoryState: cleanRepositoryState,
          }),
        ),
      ).toThrow('Release output already exists');
      expect(
        await Bun.file(join(output, 'interborough-0.0.0-test-darwin-arm64.tar.gz')).text(),
      ).toBe('sentinel');
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  // spawn-free: the release fixture controls every child process boundary deterministically.
  test('rejects dirty release inputs before reading or staging them', async () => {
    const fixture = await releaseFixture();
    const output = join(fixture.root, 'release');
    try {
      expect(
        await throwingRejectionOf(
          buildRelease(['--version', '0.0.0-test', '--outdir', output], {
            ...fixture.operations,
            readRepositoryState: async () => ({
              status: ' M applications/interborough/package.json\n',
              sourceSha: FIXTURE_SOURCE_SHA,
            }),
          }),
        ),
      ).toThrow('Release inputs are dirty');
      expect(fixture.commands).toEqual([]);
      expect(await Bun.file(join(output, 'interborough', 'release.json')).exists()).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  // spawn-free: the disposable repository is the only Git process boundary this test reads.
  test('reads the real status and revision of a disposable repository', async () => {
    const repository = await disposableRepository();
    try {
      const clean = await readRepositoryState(repository);
      expect(clean.status).toBe('');
      expect(clean.sourceSha).toMatch(/^[0-9a-f]{40}$/);
      await writeFile(join(repository, 'tracked.txt'), 'modified\n');
      await writeFile(join(repository, 'untracked.txt'), 'untracked\n');
      const dirty = await readRepositoryState(repository);
      expect(dirty.status).toContain('tracked.txt');
      expect(dirty.status).toContain('?? untracked.txt');
      expect(dirty.sourceSha).toBe(clean.sourceSha);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  // spawn-free: a plain temporary directory makes the real Git reader exit nonzero.
  test('fails when Git cannot read the repository state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interborough-release-not-a-repository-'));
    try {
      expect(await throwingRejectionOf(readRepositoryState(directory))).toThrow(
        'git status --porcelain failed',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // spawn-free: the fixture controls every child process boundary except the real Git reader.
  test('reads the real checkout state when no repository reader is injected', async () => {
    const actual = await readRepositoryState();
    const fixture = await releaseFixture();
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-default-reader-'));
    try {
      const release = buildRelease(
        ['--version', '0.0.0-test', '--outdir', output],
        fixture.productionOperations,
      );
      if (actual.status.trim() !== '') {
        expect(await throwingRejectionOf(release)).toThrow('Release inputs are dirty');
        expect(fixture.commands).toEqual([]);
      } else {
        await release;
        const manifestText = await Bun.file(join(output, 'interborough', 'release.json')).text();
        const manifest = JSON.parse(manifestText) as { sourceSha: string };
        expect(manifest.sourceSha).toBe(actual.sourceSha);
        const archiveCommand = fixture.commands.find((arguments_) => arguments_[1] === 'archive');
        expect(archiveCommand?.slice(0, 3)).toEqual(['git', 'archive', actual.sourceSha]);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  // spawn-free: the unsupported target guard runs before any child process can start.
  test('rejects unsupported release targets before reading repository state', async () => {
    expect(
      await throwingRejectionOf(
        buildRelease(['--version', '0.0.0-test', '--outdir', '/tmp/release'], {
          platform: 'linux',
        }),
      ),
    ).toThrow('macOS arm64 is required');
  });

  // spawn-free: the persistent fixture owns and cleans its guarded child process.
  test('stops a persistent relocated host before reporting a missing runtime link', async () => {
    const marker = join(await mkdtemp(join(tmpdir(), 'interborough-release-marker-')), 'lifecycle');
    const fixture = await releaseFixture({ markerPath: marker, runtimeFailure: 'missing-link' });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-missing-link-'));
    let clock = 0;
    try {
      expect(
        await throwingRejectionOf(
          buildRelease(['--version', '0.0.0-test', '--outdir', output], {
            ...fixture.operations,
            now: () => clock,
            sleep: async () => {
              while (!(await Bun.file(marker).exists())) await Bun.sleep(0);
              clock += 100;
            },
          }),
        ),
      ).toThrow('did not create plugin runtime link');
      expect(await Bun.file(marker).text()).toBe('terminated');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
      await rm(marker, { force: true });
    }
  });

  // spawn-free: the persistent fixture owns and cleans its guarded child process.
  test('reports a relocated host linked to the wrong runtime', async () => {
    const marker = join(await mkdtemp(join(tmpdir(), 'interborough-release-marker-')), 'lifecycle');
    const fixture = await releaseFixture({ markerPath: marker, runtimeFailure: 'wrong-link' });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-wrong-link-'));
    try {
      expect(
        await throwingRejectionOf(
          buildRelease(['--version', '0.0.0-test', '--outdir', output], fixture.operations),
        ),
      ).toThrow('targets the wrong runtime');
      expect(await Bun.file(marker).text()).toBe('terminated');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
      await rm(marker, { force: true });
    }
  });

  // spawn-free: the validation fixtures own and clean their guarded child processes.
  test('covers relocated host validation failures', async () => {
    await expectRelocatedFailure('missing-inspector', 'Prebuilt panel run-inspector is missing');
    await expectRelocatedFailure('plain-html', 'was not a self-contained Cinder page');
    const marker = join(await mkdtemp(join(tmpdir(), 'interborough-release-marker-')), 'lifecycle');
    const fixture = await releaseFixture({ markerPath: marker, runtimeFailure: 'not-running' });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-not-running-'));
    let clock = 0;
    try {
      const failure = await throwingRejectionOf(
        buildRelease(['--version', '0.0.0-test', '--outdir', output], {
          ...fixture.operations,
          now: () => clock,
          sleep: async () => {
            while (!(await Bun.file(marker).exists())) await Bun.sleep(0);
            clock += 100;
          },
        }),
      );
      expect(failure).toThrow(
        /did not run[\s\S]*child exit before cleanup: running[\s\S]*child exit after cleanup: 0[\s\S]*standard error:/,
      );
      expect(await Bun.file(marker).text()).toBe('terminated');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
      await rm(marker, { force: true });
    }
    await expectRelocatedFailure('missing-contribution', 'did not register');
    await expectRelocatedFailure('malformed-html', 'did not contain its generated page');
  });

  // spawn-free: the delayed supervisor fixture owns and cleans its guarded child process.
  test('retries when the relocated supervisor has not bound its port', async () => {
    const marker = join(await mkdtemp(join(tmpdir(), 'interborough-release-marker-')), 'lifecycle');
    const fixture = await releaseFixture({ markerPath: marker, runtimeFailure: 'poll-error' });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-poll-error-'));
    let clock = 0;
    try {
      const archive = await buildRelease(['--version', '0.0.0-test', '--outdir', output], {
        ...fixture.operations,
        now: () => clock,
        sleep: async () => {
          await Bun.sleep(10);
          clock += 100;
        },
      });
      expect(await Bun.file(archive).exists()).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
      await rm(marker, { force: true });
    }
  });

  // spawn-free: the delayed supervisor fixture owns and cleans its guarded child process.
  test('checks the relocated host once it reports ready even after the startup clock advances', async () => {
    const markerDirectory = await mkdtemp(join(tmpdir(), 'interborough-release-marker-'));
    const marker = join(markerDirectory, 'lifecycle');
    const fixture = await releaseFixture({ markerPath: marker, runtimeFailure: 'poll-error' });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-ready-'));
    try {
      const archive = await buildRelease(['--version', '0.0.0-test', '--outdir', output], {
        ...fixture.operations,
        now: () => {
          try {
            return readFileSync(marker, 'utf8') === 'ready' ? 20_000 : 0;
          } catch {
            return 0;
          }
        },
      });
      expect(await Bun.file(archive).exists()).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
      await rm(markerDirectory, { recursive: true, force: true });
    }
  });

  // spawn-free: the release fixture controls every child process boundary deterministically.
  test('rejects a dependency absent from the frozen production install', async () => {
    const fixture = await releaseFixture({ recursiveDependency: true, missingDependency: true });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-missing-dependency-'));
    try {
      expect(
        await throwingRejectionOf(
          buildRelease(['--version', '0.0.0-test', '--outdir', output], fixture.operations),
        ),
      ).toThrow('Frozen production install cannot resolve fixture-dependency');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  // spawn-free: the release fixture controls every child process boundary deterministically.
  test('runs staging, SDK export bundling, manifest creation, and cleanup with real files', async () => {
    const fixture = await releaseFixture({ recursiveDependency: true });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-fast-'));
    try {
      const archive = await buildRelease(
        ['--version', '0.0.0-test', '--outdir', output],
        fixture.operations,
      );
      expect(await Bun.file(archive).text()).toBe('archive');
      expect(await Bun.file(join(output, 'interborough', 'release.json')).exists()).toBe(true);
      expect(
        await Bun.file(
          join(
            output,
            'interborough',
            'share/interborough/plugin-runtime/node_modules/@lostgradient/interborough-plugin/testing/index.js',
          ),
        ).exists(),
      ).toBe(true);
      const compileArguments = fixture.buildArguments.find((arguments_) =>
        arguments_.includes('--compile'),
      );
      expect(compileArguments).toContain('--compile-autoload-package-json');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  // spawn-free: the release fixture controls every child process boundary deterministically.
  test('prebuilds every panel of every workspace plugin, each page the host will accept', async () => {
    const fixture = await releaseFixture();
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-prebuilt-'));
    try {
      await buildRelease(['--version', '0.0.0-test', '--outdir', output], fixture.operations);
      const panels = join(output, 'interborough', 'share', 'interborough', 'panels');
      const written = await readdir(panels);
      expect(written.toSorted()).toEqual([
        'pending-review.json',
        'run-inspector.json',
        'weekly-report.json',
      ]);
      for (const { plugin, app } of FIXTURE_PANELS) {
        const prebuilt = prebuiltPanelSchema.parse(
          await Bun.file(join(panels, `${app.name}.json`)).json(),
        );
        expect(prebuilt.uri, `${plugin}: ${app.name}`).toBe(app.uri);
        expect(digestOf(prebuilt.html), `${plugin}: ${app.name}`).toBe(prebuilt.contentDigest);
        expect(prebuilt.html).toContain(app.title);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  // spawn-free: the release fixture controls every child process boundary deterministically.
  test('fails the release when two plugins contribute a panel of one name', async () => {
    const fixture = await releaseFixture();
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-clash-'));
    try {
      expect(
        await throwingRejectionOf(
          buildRelease(['--version', '0.0.0-test', '--outdir', output], {
            ...fixture.operations,
            workspacePanels: async () => [
              ...FIXTURE_PANELS,
              { plugin: 'another', app: fixturePanel('run-inspector') },
            ],
          }),
        ),
      ).toThrow('The plugins inspectors and another both contribute a panel named run-inspector');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  // spawn-free: the release fixture controls every child process boundary deterministically.
  test('refuses to write a page the host would refuse', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interborough-release-refused-'));
    try {
      expect(
        await throwingRejectionOf(
          prebuildPanels(directory, FIXTURE_PANELS.slice(0, 1), async () => ({
            html: '<html></html>',
            contentDigest: 'sha256:fixture',
          })),
        ),
      ).toThrow();
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // spawn-free: the release fixture controls every child process boundary deterministically.
  test('stages the Svelte compiler, Svelte, Cinder source and the MCP Apps SDK for runtime panel builds', async () => {
    expect(PANEL_RUNTIME_PACKAGES).toEqual([
      'svelte',
      '@lostgradient/cinder',
      '@modelcontextprotocol/ext-apps',
    ]);
    const fixture = await releaseFixture();
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-staged-'));
    try {
      await buildRelease(['--version', '0.0.0-test', '--outdir', output], fixture.operations);
      expect(fixture.commands).toEqual(
        expect.arrayContaining([
          expect.arrayContaining(['components/cinder/scripts/tokens/generate-validators.ts']),
          expect.arrayContaining([
            'components/cinder/scripts/tokens/generate-artifacts.ts',
            '--ignored-only',
          ]),
        ]),
      );
      const runtime = join(
        output,
        'interborough',
        'share',
        'interborough',
        'plugin-runtime',
        'node_modules',
      );
      for (const [name, files] of Object.entries(PANEL_RUNTIME_FIXTURE)) {
        for (const file of Object.keys(files)) {
          expect(await Bun.file(join(runtime, name, file)).exists(), `${name}/${file}`).toBe(true);
        }
      }
      for (const file of CINDER_GENERATED_OUTPUTS) {
        expect(await Bun.file(join(runtime, '@lostgradient', 'cinder', file)).text()).toBe(
          `fixture asset: ${file}`,
        );
      }
      // The staged files the host reads: the compiler and the panel kit's entry.
      expect(await Bun.file(join(runtime, 'svelte', 'compiler', 'index.js')).exists()).toBe(true);
      expect(
        await Bun.file(
          join(runtime, '@lostgradient', 'cinder', 'src', 'panel', 'index.ts'),
        ).exists(),
      ).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  // spawn-free: the release fixture controls every child process boundary deterministically.
  // spawn-free: missing runtime packages fail during mocked staging before the relocated host can start.
  test.each(PANEL_RUNTIME_PACKAGES.map((name) => [name]))(
    'rejects a release whose frozen install has no %s to stage',
    async (name) => {
      const fixture = await releaseFixture({ missingPanelRuntime: name });
      const output = await mkdtemp(join(tmpdir(), 'interborough-release-missing-runtime-'));
      try {
        expect(
          await throwingRejectionOf(
            buildRelease(['--version', '0.0.0-test', '--outdir', output], fixture.operations),
          ),
        ).toThrow(`Frozen production install cannot resolve ${name}`);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
        await rm(output, { recursive: true, force: true });
      }
    },
  );

  // spawn-free: reading the workspace plugins' panels starts no process.
  test('reads the panels of the real workspace plugins, the inspectors among them', async () => {
    const panels = await workspacePanels();
    const byPlugin = Object.groupBy(panels, ({ plugin }) => plugin);
    expect(byPlugin['inspectors']?.map(({ app }) => app.name)).toEqual([
      'run-inspector',
      'pending-review',
      'workflow-revision-review',
    ]);
    // Names are unique across the workspace, so a prebuilt page is named by its panel alone.
    const names = panels.map(({ app }) => app.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // spawn-free: the release fixture controls every child process boundary deterministically.
  test('retains production source under a directory named test', async () => {
    const fixture = await releaseFixture({
      recursiveDependency: true,
      productionEntryInExcludedDirectory: true,
    });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-production-source-'));
    try {
      await buildRelease(['--version', '0.0.0-test', '--outdir', output], fixture.operations);
      const stagedDependency = join(
        output,
        'interborough',
        'share/interborough/plugin-runtime/node_modules/fixture-dependency',
      );
      expect(await Bun.file(join(stagedDependency, 'index.ts')).text()).toContain(
        "'./test/index.ts'",
      );
      expect(await Bun.file(join(stagedDependency, 'test', 'index.ts')).exists()).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  // spawn-free: the release fixture controls every child process boundary deterministically.
  test('rejects malformed SDK exports through the production bundling path', async () => {
    const fixture = await releaseFixture({ invalidExports: true });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-invalid-'));
    try {
      expect(
        await throwingRejectionOf(
          buildRelease(['--version', '0.0.0-test', '--outdir', output], fixture.operations),
        ),
      ).toThrow('not a runtime TypeScript entry');
      expect(await Bun.file(join(output, 'interborough')).exists()).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  // spawn-free: the release fixture controls every child process boundary deterministically.
  test('rejects a non-object SDK export map through the production bundling path', async () => {
    const fixture = await releaseFixture({ invalidExportMap: true });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-invalid-map-'));
    try {
      expect(
        await throwingRejectionOf(
          buildRelease(['--version', '0.0.0-test', '--outdir', output], fixture.operations),
        ),
      ).toThrow('must declare an exports map');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  // spawn-free: the release fixture controls every child process boundary deterministically.
  test('rejects escaping runtime symlinks and removes staging after command failure', async () => {
    const fixture = await releaseFixture({ escapingLink: true });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-escape-'));
    try {
      expect(
        await throwingRejectionOf(
          buildRelease(['--version', '0.0.0-test', '--outdir', output], fixture.operations),
        ),
      ).toThrow('Runtime symlink escapes archive');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  // spawn-free: the release fixture controls every child process boundary deterministically.
  test('cleans staging when a production bundling command fails', async () => {
    const fixture = await releaseFixture({ commandFailure: true });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-command-failure-'));
    try {
      expect(
        await throwingRejectionOf(
          buildRelease(['--version', '0.0.0-test', '--outdir', output], fixture.operations),
        ),
      ).toThrow('fixture command failed');
      const entries = await readdir(output);
      expect(entries.filter((entry) => entry.startsWith('.interborough-staging-'))).toEqual([]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });
});
