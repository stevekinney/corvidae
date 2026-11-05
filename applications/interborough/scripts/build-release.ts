import { pendingReview, runInspector } from '@lostgradient/plugin-inspectors';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMcpAppPage } from '../src/host/mcp-app-build.ts';
import { buildApplication } from './build.ts';

const PACKAGE_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, '..', '..');
const SDK = '@lostgradient/interborough-plugin';
export type ReleaseArguments = { readonly version: string; readonly outdir: string };
export type ReleaseManifest = {
  readonly version: string;
  readonly sourceSha: string;
  readonly target: 'darwin-arm64';
};
type ReleaseCommand = (arguments_: string[], cwd?: string) => Promise<void>;
export type ReleaseOperations = {
  readonly runCommand?: ReleaseCommand;
  readonly buildApplication?: typeof buildApplication;
  readonly buildMcpAppPage?: typeof buildMcpAppPage;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

export function parseReleaseArguments(argv: readonly string[]): ReleaseArguments {
  let version: string | undefined;
  let outdir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--version') version = argv[++index];
    else if (argument === '--outdir') outdir = argv[++index];
    else throw new Error(`Unknown release argument: ${argument}`);
  }
  if (
    version === undefined ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  )
    throw new Error('--version needs a semver');
  if (outdir === undefined || outdir.trim() === '') throw new Error('--outdir needs a directory');
  return { version, outdir: resolve(outdir) };
}

async function runCommand(arguments_: string[], cwd = REPOSITORY_ROOT): Promise<void> {
  const childProcess = Bun.spawn(arguments_, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    childProcess.exited,
    new Response(childProcess.stdout).text(),
    new Response(childProcess.stderr).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(`${arguments_.join(' ')} failed (${exitCode}): ${stderr || stdout}`);
}

async function locateFromProductionInstall(
  name: string,
  dependencies: string,
  parent?: string,
): Promise<string> {
  for (const candidate of [
    join(dependencies, name),
    ...(parent === undefined ? [] : [join(parent, 'node_modules', name)]),
  ]) {
    if (await Bun.file(join(candidate, 'package.json')).exists()) return realpath(candidate);
  }
  const store = resolve(dependencies, '../../../node_modules/.bun');
  for (const entry of await readdir(store).catch(() => [])) {
    const candidate = join(store, entry, 'node_modules', name);
    if (await Bun.file(join(candidate, 'package.json')).exists()) return realpath(candidate);
  }
  throw new Error(`Frozen production install cannot resolve ${name}`);
}

async function stage(
  name: string,
  nodeModules: string,
  seen: Set<string>,
  dependencies: string,
  parent?: string,
): Promise<void> {
  if (seen.has(name)) return;
  seen.add(name);
  const source = await locateFromProductionInstall(name, dependencies, parent);
  const destination = join(nodeModules, name);
  await mkdir(destination, { recursive: true });
  await cp(source, destination, {
    recursive: true,
    filter: (path) => {
      const parts = relative(source, path).split(sep);
      return (
        !parts.includes('node_modules') &&
        !parts.some((part) =>
          new Set(['test', 'tests', '__tests__', 'fixtures', '.turbo', '.types', 'coverage']).has(
            part,
          ),
        ) &&
        !path.includes('.test.') &&
        !path.includes(`${sep}.types${sep}`)
      );
    },
  });
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    await stage(dependency, nodeModules, seen, dependencies, source);
}

async function verifyFrozenInstall(
  sourceSha: string,
  command: ReleaseCommand = runCommand,
): Promise<{ root: string; source: string; dependencies: string }> {
  const root = await mkdtemp(join('/tmp', 'interborough-release-source-'));
  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  const archive = join(root, 'source.tar');
  await command(['git', 'archive', sourceSha, '-o', archive]);
  await command(['tar', '-xf', archive, '-C', source]);
  await command(
    [
      process.execPath,
      'install',
      '--frozen-lockfile',
      '--production',
      '--ignore-scripts',
      '--no-progress',
      '--no-summary',
      '--filter',
      '@lostgradient/interborough...',
    ],
    source,
  );
  if (!(await Bun.file(join(source, 'bun.lock')).exists())) throw new Error('bun.lock is missing');
  return {
    root,
    source,
    dependencies: join(source, 'applications', 'interborough', 'node_modules'),
  };
}

async function bundleSdk(
  runtime: string,
  source: string,
  command: ReleaseCommand = runCommand,
): Promise<void> {
  const sdk = join(runtime, SDK);
  const manifest = JSON.parse(await readFile(join(sdk, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const exportsMap = manifest['exports'];
  if (typeof exportsMap !== 'object' || exportsMap === null || Array.isArray(exportsMap))
    throw new Error('The SDK package must declare an exports map');
  const bundledExports: Record<string, string> = {};
  for (const [specifier, target] of Object.entries(exportsMap)) {
    if (typeof target !== 'string' || !target.startsWith('./src/') || !target.endsWith('.ts'))
      throw new Error(`The SDK export ${specifier} is not a runtime TypeScript entry`);
    const output = `./${target.slice('./src/'.length, -'.ts'.length)}.js`;
    await mkdir(join(sdk, output.slice(2, output.lastIndexOf('/')) || '.'), { recursive: true });
    await command(
      [
        process.execPath,
        'build',
        '--target',
        'bun',
        '--format',
        'esm',
        '--outfile',
        join(sdk, output.slice(2)),
        join(source, 'packages', 'interborough-plugin', target.slice('./'.length)),
      ],
      source,
    );
    bundledExports[specifier] = output;
  }
  await writeFile(
    join(sdk, 'package.json'),
    `${JSON.stringify({ ...manifest, exports: bundledExports }, null, 2)}\n`,
  );
}

async function verifyRelocatedHost(
  root: string,
  now: () => number = Date.now,
  sleep: (milliseconds: number) => Promise<void> = Bun.sleep,
): Promise<void> {
  const home = await mkdtemp(join('/tmp', 'interborough-release-home-'));
  await writeFile(join(home, 'deployment-id'), '01ARZ3NDEKTSV4RRFFQ69G5FAV\n');
  const plugin = join(home, 'plugins', 'runtime-proof');
  await mkdir(plugin, { recursive: true });
  await writeFile(
    join(plugin, 'plugin.ts'),
    `import { definePlugin } from '@lostgradient/interborough-plugin';
import { canonicalJson } from '@lostgradient/interborough-plugin/testing';
const testingExportProof = canonicalJson({ release: 'proof' });
if (testingExportProof !== '{"release":"proof"}') throw new Error('Testing export map is broken');
export default definePlugin({ name: 'runtime-proof', title: 'Runtime proof', version: '1.0.0', description: 'Release proof', setup: () => ({ mcpApps: [{ name: 'external-proof', title: 'External proof', uri: 'ui://runtime-proof/external/v1', entry: new URL('./app.ts', import.meta.url), styles: '', allowedTools: ['bureau.workflows-list'], opensFromTool: 'bureau.workflows-list' }] }) });
`,
  );
  await writeFile(join(plugin, 'app.ts'), 'document.body.textContent = "external runtime";\n');
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port;
  await reservation.stop();
  const childProcess = Bun.spawn(
    [join(root, 'bin', 'interborough'), 'start', '--port', String(port), '--home', home],
    {
      cwd: '/tmp',
      env: { PATH: '', HOME: home, INTERBOROUGH_HOME: home, INTERBOROUGH_PORT: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const stdout = new Response(childProcess.stdout).text();
  const stderr = new Response(childProcess.stderr).text();
  try {
    const deadline = now() + 20_000;
    const link = join(home, 'plugins', 'node_modules');
    while (now() < deadline) {
      try {
        await lstat(link);
        break;
      } catch {
        await sleep(100);
      }
    }
    try {
      await lstat(link);
    } catch {
      const [, errorOutput] = await Promise.all([stdout, stderr]);
      throw new Error(
        `Relocated host did not create plugin runtime link (exit ${childProcess.exitCode ?? 'running'}): ${errorOutput}`,
      );
    }
    const target = await readlink(link);
    const expected = join(
      await realpath(root),
      'share',
      'interborough',
      'plugin-runtime',
      'node_modules',
    );
    if ((await realpath(resolve(join(home, 'plugins'), target))) !== (await realpath(expected)))
      throw new Error(`Relocated plugin link targets the wrong runtime: ${target} !== ${expected}`);
    if (
      !(await Bun.file(
        join(root, 'share', 'interborough', 'mcp-apps', 'run-inspector.json'),
      ).exists())
    )
      throw new Error('Prebuilt inspector is missing');
    let listing: Record<string, unknown> | undefined;
    let snapshot: Record<string, unknown> | undefined;
    while (now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/host/plugins`);
        if (response.ok) {
          snapshot = (await response.json()) as Record<string, unknown>;
          const plugins = Array.isArray(snapshot['plugins']) ? snapshot['plugins'] : [];
          listing = plugins.find(
            (entry): entry is Record<string, unknown> =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof Reflect.get(Reflect.get(entry, 'descriptor'), 'name') === 'string' &&
              Reflect.get(Reflect.get(entry, 'descriptor'), 'name') === 'runtime-proof',
          );
          if (listing !== undefined) break;
        }
      } catch {
        // The supervisor may not have bound its port yet.
      }
      await sleep(100);
    }
    if (listing === undefined || Reflect.get(listing, 'status') !== 'running')
      throw new Error(`Relocated SDK plugin did not run: ${JSON.stringify(snapshot)}`);
    const contributions = Reflect.get(listing, 'contributions');
    if (
      !Array.isArray(contributions) ||
      !contributions.some(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          Reflect.get(entry, 'kind') === 'mcp-app' &&
          Reflect.get(entry, 'id') === 'runtime-proof:external-proof',
      )
    )
      throw new Error('Relocated SDK plugin did not register its external MCP app');
    const appResponse = await fetch(
      `http://127.0.0.1:${port}/host/plugins/runtime-proof/apps/external-proof`,
    );
    if (!appResponse.ok) throw new Error(`External MCP app response was ${appResponse.status}`);
    const app = (await appResponse.json()) as { html?: unknown };
    if (typeof app.html !== 'string' || !app.html.includes('external runtime'))
      throw new Error('External MCP app response did not contain its generated page');
  } finally {
    childProcess.kill('SIGTERM');
    await childProcess.exited;
    await Promise.all([stdout, stderr]);
    await rm(home, { recursive: true, force: true });
  }
}

async function assertContained(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isSymbolicLink()) continue;
    const path = join(entry.parentPath, entry.name);
    const target = await readlink(path);
    if (!resolve(entry.parentPath, target).startsWith(`${resolve(root)}${sep}`))
      throw new Error(`Runtime symlink escapes archive: ${path}`);
  }
}

async function compile(
  output: string,
  version: string,
  command: ReleaseCommand = runCommand,
): Promise<void> {
  await command(
    [
      process.execPath,
      'build',
      '--compile',
      '--no-compile-autoload-dotenv',
      '--no-compile-autoload-bunfig',
      '--compile-exec-argv=--no-install',
      '--define',
      `INTERBOROUGH_RELEASE_VERSION=${JSON.stringify(version)}`,
      '--outfile',
      output,
      join(PACKAGE_DIRECTORY, 'src/host/cli.ts'),
    ],
    PACKAGE_DIRECTORY,
  );
  await command(['codesign', '--force', '--sign', '-', output]);
  await command(['codesign', '--verify', '--verbose=2', output]);
}

export async function buildRelease(
  argv: readonly string[] = process.argv.slice(2),
  operations: ReleaseOperations = {},
): Promise<string> {
  const options = parseReleaseArguments(argv);
  if (
    (operations.platform ?? process.platform) !== 'darwin' ||
    (operations.architecture ?? process.arch) !== 'arm64'
  )
    throw new Error('macOS arm64 is required to build this release');
  const status = await new Response(
    Bun.spawn(['git', 'status', '--porcelain'], { cwd: REPOSITORY_ROOT, stdout: 'pipe' }).stdout,
  ).text();
  if (status.trim() !== '') throw new Error('Release inputs are dirty');
  const revisionProcess = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    stdout: 'pipe',
  });
  const revisionText = await new Response(revisionProcess.stdout).text();
  const sourceSha = revisionText.trim();
  await mkdir(options.outdir, { recursive: true });
  const targetRoot = join(options.outdir, 'interborough');
  const archive = join(options.outdir, `interborough-${options.version}-darwin-arm64.tar.gz`);
  if (
    (await Bun.file(join(targetRoot, 'release.json')).exists()) ||
    (await Bun.file(archive).exists())
  )
    throw new Error(`Release output already exists: ${options.outdir}`);
  const command = operations.runCommand ?? runCommand;
  const productionInstall = await verifyFrozenInstall(sourceSha, command);
  const staging = await mkdtemp(join(options.outdir, '.interborough-staging-'));
  const root = join(staging, 'interborough');
  try {
    await mkdir(join(root, 'bin'), { recursive: true });
    await mkdir(join(root, 'share', 'interborough'), { recursive: true });
    await compile(join(root, 'bin', 'interborough'), options.version, command);
    await (operations.buildApplication ?? buildApplication)({
      outdir: join(root, 'share', 'interborough', 'browser'),
    });
    const mcpApps = join(root, 'share', 'interborough', 'mcp-apps');
    await mkdir(mcpApps, { recursive: true });
    for (const app of [runInspector, pendingReview]) {
      const page = await (operations.buildMcpAppPage ?? buildMcpAppPage)({
        entry: app.entry.href,
        title: app.title,
        styles: app.styles ?? '',
      });
      await writeFile(join(mcpApps, `${app.name}.json`), JSON.stringify(page));
    }
    const runtime = join(root, 'share', 'interborough', 'plugin-runtime', 'node_modules');
    await mkdir(runtime, { recursive: true });
    await stage(SDK, runtime, new Set(), productionInstall.dependencies);
    await bundleSdk(runtime, productionInstall.source, command);
    await assertContained(join(root, 'share', 'interborough', 'plugin-runtime'));
    await verifyRelocatedHost(root, operations.now, operations.sleep);
    const manifest: ReleaseManifest = {
      version: options.version,
      sourceSha,
      target: 'darwin-arm64',
    };
    await writeFile(join(root, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await command(['tar', '-czf', archive, '-C', staging, 'interborough']);
    await rename(root, targetRoot);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(productionInstall.root, { recursive: true, force: true });
  }
  return archive;
}

/** The command-line boundary, matching the browser build script's injectable command runner. */
export async function runReleaseCommand(
  log: (line: string) => void = console.info,
  runRelease: typeof buildRelease = buildRelease,
  argv: readonly string[] = process.argv.slice(2),
): Promise<string> {
  const archive = await runRelease(argv);
  log(archive);
  return archive;
}

if (import.meta.main) await runReleaseCommand();
