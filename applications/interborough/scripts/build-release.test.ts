import { describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRelease,
  parseReleaseArguments,
  runCommand,
  runReleaseCommand,
  type ReleaseOperations,
} from './build-release.ts';

async function releaseFixture(
  options: {
    readonly invalidExports?: boolean;
    readonly escapingLink?: boolean;
    readonly commandFailure?: boolean;
    readonly recursiveDependency?: boolean;
    readonly missingDependency?: boolean;
    readonly invalidExportMap?: boolean;
    readonly runtimeFailure?:
      | 'missing-link'
      | 'wrong-link'
      | 'missing-inspector'
      | 'not-running'
      | 'missing-contribution'
      | 'malformed-html'
      | 'poll-error';
    readonly markerPath?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'interborough-release-fixture-'));
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
      JSON.stringify({ name: 'fixture-dependency' }),
    );
  }
  if (options.escapingLink)
    await symlink('/tmp/interborough-release-missing-target', join(sdk, 'escape'));
  const command = async (arguments_: string[]): Promise<void> => {
    if (arguments_[1] === 'build') {
      if (options.commandFailure) throw new Error('fixture command failed');
      const output = arguments_[arguments_.indexOf('--outfile') + 1];
      if (output === undefined) throw new Error('missing bundle output');
      if (arguments_.includes('--compile')) {
        await writeFile(
          output,
          `#!/opt/homebrew/bin/bun
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const home = process.argv[process.argv.indexOf('--home') + 1];
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const root = dirname(dirname(process.argv[1]));
const runtime = join(root, 'share', 'interborough', 'plugin-runtime', 'node_modules');
const marker = ${JSON.stringify(options.markerPath ?? '')};
const behavior = ${JSON.stringify(options.runtimeFailure ?? '')};
if (behavior !== 'missing-link') {
  await mkdir(join(home, 'plugins'), { recursive: true });
  await symlink(${options.runtimeFailure === 'wrong-link' ? 'home' : 'runtime'}, join(home, 'plugins', 'node_modules'));
}
if (behavior === 'missing-inspector') await rm(join(root, 'share', 'interborough', 'mcp-apps', 'run-inspector.json'), { force: true });
if (marker) {
  await writeFile(marker, 'started');
  process.on('SIGTERM', async () => {
    await writeFile(marker, 'terminated');
    process.exit(0);
  });
}
if (behavior === 'poll-error') await Bun.sleep(100);
const server = Bun.serve({ port, fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/host/plugins') return Response.json({ plugins: [{ descriptor: { name: 'runtime-proof' }, status: behavior === 'not-running' ? 'stopped' : 'running', contributions: behavior === 'missing-contribution' ? [] : [{ kind: 'mcp-app', id: 'runtime-proof:external-proof' }] }] });
  if (pathname === '/host/plugins/runtime-proof/apps/external-proof') return Response.json({ html: behavior === 'malformed-html' ? 42 : '<html>external runtime</html>' });
  return new Response('not found', { status: 404 });
} });
await writeFile(join(home, 'server-port'), String(server.port));
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
  const operations: ReleaseOperations = {
    runCommand: command,
    buildApplication: async (options) => {
      const outdir = options?.outdir;
      if (outdir === undefined) throw new Error('missing browser output');
      await mkdir(outdir, { recursive: true });
      await writeFile(join(outdir, 'index.html'), '<html>fixture</html>');
      return { directory: outdir, files: ['index.html'], metafile: {} } as never;
    },
    buildMcpAppPage: async () =>
      ({ html: '<html>app</html>', contentDigest: 'sha256:fixture' }) as never,
  };
  return { root, operations };
}

async function expectRelocatedFailure(
  runtimeFailure: NonNullable<Parameters<typeof releaseFixture>[0]>['runtimeFailure'],
  message: string,
) {
  const marker = join(await mkdtemp(join(tmpdir(), 'interborough-release-marker-')), 'lifecycle');
  const fixture = await releaseFixture({ markerPath: marker, runtimeFailure });
  const output = await mkdtemp(join(tmpdir(), `interborough-release-${runtimeFailure}-`));
  let clock = 0;
  try {
    await expect(
      buildRelease(['--version', '0.0.0-test', '--outdir', output], {
        ...fixture.operations,
        now: () => clock,
        sleep: async () => {
          while (!(await Bun.file(marker).exists())) await Bun.sleep(0);
          clock += 100;
        },
      }),
    ).rejects.toThrow(message);
    expect(await Bun.file(marker).text()).toBe('terminated');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
    await rm(marker, { force: true });
  }
}

describe('release arguments', () => {
  test('runs the default command and reports failures', async () => {
    await runCommand([process.execPath, '-e', 'process.stdout.write("ok")']);
    await expect(
      runCommand([process.execPath, '-e', 'process.stderr.write("bad"); process.exit(3)']),
    ).rejects.toThrow('failed (3): bad');
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

  test('uses the command boundary defaults', async () => {
    await expect(
      runReleaseCommand(undefined, async () => '/tmp/interborough-default.tar.gz', [
        '--version',
        '0.0.0-test',
      ]),
    ).resolves.toBe('/tmp/interborough-default.tar.gz');
  });

  test('rejects an existing release output before installing or staging', async () => {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-collision-'));
    try {
      await writeFile(join(output, 'interborough-0.0.0-test-darwin-arm64.tar.gz'), 'sentinel');
      await expect(buildRelease(['--version', '0.0.0-test', '--outdir', output])).rejects.toThrow(
        'Release output already exists',
      );
      expect(
        await Bun.file(join(output, 'interborough-0.0.0-test-darwin-arm64.tar.gz')).text(),
      ).toBe('sentinel');
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  test('rejects dirty release inputs before reading or staging them', async () => {
    const marker = join(import.meta.dir, '.release-dirty-input');
    await writeFile(marker, 'dirty');
    try {
      await expect(
        buildRelease(['--version', '0.0.0-test', '--outdir', '/tmp/release']),
      ).rejects.toThrow('Release inputs are dirty');
    } finally {
      await rm(marker, { force: true });
    }
  });

  test('rejects unsupported release targets before reading repository state', async () => {
    await expect(
      buildRelease(['--version', '0.0.0-test', '--outdir', '/tmp/release'], {
        platform: 'linux',
      }),
    ).rejects.toThrow('macOS arm64 is required');
  });

  test('stops a persistent relocated host before reporting a missing runtime link', async () => {
    const marker = join(await mkdtemp(join(tmpdir(), 'interborough-release-marker-')), 'lifecycle');
    const fixture = await releaseFixture({ markerPath: marker, runtimeFailure: 'missing-link' });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-missing-link-'));
    let clock = 0;
    try {
      await expect(
        buildRelease(['--version', '0.0.0-test', '--outdir', output], {
          ...fixture.operations,
          now: () => clock,
          sleep: async () => {
            while (!(await Bun.file(marker).exists())) await Bun.sleep(0);
            clock += 100;
          },
        }),
      ).rejects.toThrow('did not create plugin runtime link');
      expect(await Bun.file(marker).text()).toBe('terminated');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
      await rm(marker, { force: true });
    }
  });

  test('reports a relocated host linked to the wrong runtime', async () => {
    const marker = join(await mkdtemp(join(tmpdir(), 'interborough-release-marker-')), 'lifecycle');
    const fixture = await releaseFixture({ markerPath: marker, runtimeFailure: 'wrong-link' });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-wrong-link-'));
    try {
      await expect(
        buildRelease(['--version', '0.0.0-test', '--outdir', output], fixture.operations),
      ).rejects.toThrow('targets the wrong runtime');
      expect(await Bun.file(marker).text()).toBe('terminated');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
      await rm(marker, { force: true });
    }
  });

  test('covers relocated host validation failures', async () => {
    await expectRelocatedFailure('missing-inspector', 'Prebuilt inspector is missing');
    await expectRelocatedFailure('not-running', 'did not run');
    await expectRelocatedFailure('missing-contribution', 'did not register');
    await expectRelocatedFailure('malformed-html', 'did not contain its generated page');
  });

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

  test('rejects a dependency absent from the frozen production install', async () => {
    const fixture = await releaseFixture({ recursiveDependency: true, missingDependency: true });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-missing-dependency-'));
    try {
      await expect(
        buildRelease(['--version', '0.0.0-test', '--outdir', output], fixture.operations),
      ).rejects.toThrow('Frozen production install cannot resolve fixture-dependency');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

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
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  test('rejects malformed SDK exports through the production bundling path', async () => {
    const fixture = await releaseFixture({ invalidExports: true });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-invalid-'));
    try {
      await expect(
        buildRelease(['--version', '0.0.0-test', '--outdir', output], fixture.operations),
      ).rejects.toThrow('not a runtime TypeScript entry');
      expect(await Bun.file(join(output, 'interborough')).exists()).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  test('rejects a non-object SDK export map through the production bundling path', async () => {
    const fixture = await releaseFixture({ invalidExportMap: true });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-invalid-map-'));
    try {
      await expect(
        buildRelease(['--version', '0.0.0-test', '--outdir', output], fixture.operations),
      ).rejects.toThrow('must declare an exports map');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  test('rejects escaping runtime symlinks and removes staging after command failure', async () => {
    const fixture = await releaseFixture({ escapingLink: true });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-escape-'));
    try {
      await expect(
        buildRelease(['--version', '0.0.0-test', '--outdir', output], fixture.operations),
      ).rejects.toThrow('Runtime symlink escapes archive');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  test('cleans staging when a production bundling command fails', async () => {
    const fixture = await releaseFixture({ commandFailure: true });
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-command-failure-'));
    try {
      await expect(
        buildRelease(['--version', '0.0.0-test', '--outdir', output], fixture.operations),
      ).rejects.toThrow('fixture command failed');
      expect((await Bun.$`find ${output} -name '.interborough-staging-*'`.text()).trim()).toBe('');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });
});
