import { describe, expect, spyOn, test } from 'bun:test';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRelease,
  parseReleaseArguments,
  runReleaseCommand,
  type ReleaseOperations,
} from './build-release.ts';

async function releaseFixture(
  options: {
    readonly invalidExports?: boolean;
    readonly escapingLink?: boolean;
    readonly commandFailure?: boolean;
    readonly recursiveDependency?: boolean;
    readonly invalidExportMap?: boolean;
    readonly runtimeFailure?:
      | 'missing-link'
      | 'wrong-link'
      | 'missing-inspector'
      | 'poll-error'
      | 'not-running'
      | 'missing-contribution'
      | 'non-ok-app'
      | 'malformed-html';
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
  if (options.recursiveDependency) {
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
const behavior = ${JSON.stringify(options.runtimeFailure ?? 'success')};
if (behavior === 'missing-inspector') await rm(join(root, 'share', 'interborough', 'mcp-apps', 'run-inspector.json'), { force: true });
if (behavior !== 'missing-link') {
  await mkdir(join(home, 'plugins'), { recursive: true });
  await symlink(behavior === 'wrong-link' ? home : runtime, join(home, 'plugins', 'node_modules'));
}
if (behavior === 'missing-link') {
  await Bun.sleep(50);
  process.exit(0);
}
if (behavior === 'wrong-link') {
  await rm(runtime, { recursive: true, force: true });
  await Bun.sleep(1000);
  process.exit(0);
}
process.on('SIGTERM', () => process.exit(0));
if (behavior === 'poll-error') await Bun.sleep(100);
const server = Bun.serve({ port, fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/host/plugins') return Response.json({ plugins: [{ descriptor: { name: 'runtime-proof' }, status: behavior === 'not-running' ? 'stopped' : 'running', contributions: behavior === 'missing-contribution' ? [] : [{ kind: 'mcp-app', id: 'runtime-proof:external-proof' }] }] });
  if (pathname === '/host/plugins/runtime-proof/apps/external-proof') return behavior === 'non-ok-app' ? new Response('missing', { status: 404 }) : Response.json({ html: behavior === 'malformed-html' ? 42 : '<html>external runtime</html>' });
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
        if (options.recursiveDependency) {
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

async function expectRuntimeFailure(
  runtimeFailure: NonNullable<Parameters<typeof releaseFixture>[0]>['runtimeFailure'],
  message: string,
) {
  const fixture = await releaseFixture({ runtimeFailure });
  const output = await mkdtemp(join(tmpdir(), `interborough-release-${runtimeFailure}-`));
  let clock = 0;
  try {
    await expect(
      buildRelease(['--version', '0.0.0-test', '--outdir', output], {
        ...fixture.operations,
        now: () => (clock += 100),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(message);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
}

describe('release arguments', () => {
  test('covers the relocated verifier failure paths with finite startup fixtures', async () => {
    await expectRuntimeFailure('missing-link', 'did not create plugin runtime link');
    await expectRuntimeFailure('wrong-link', 'targets the wrong runtime');
    await expectRuntimeFailure('missing-inspector', 'Prebuilt inspector is missing');
    await expectRuntimeFailure('poll-error', 'did not run');
    await expectRuntimeFailure('not-running', 'did not run');
    await expectRuntimeFailure('missing-contribution', 'did not register');
    await expectRuntimeFailure('non-ok-app', 'External MCP app response was 404');
    await expectRuntimeFailure('malformed-html', 'did not contain its generated page');
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
