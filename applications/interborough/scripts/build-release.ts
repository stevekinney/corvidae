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
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMcpAppPage } from '../src/host/mcp-app-build.ts';
import { buildApplication } from './build.ts';

const PACKAGE_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, '..', '..');
const SDK = '@lostgradient/interborough-plugin';
const LOCKFILE = join(REPOSITORY_ROOT, 'bun.lock');
export type ReleaseArguments = { readonly version: string; readonly outdir: string };
export type ReleaseManifest = {
  readonly version: string;
  readonly sourceSha: string;
  readonly target: 'darwin-arm64';
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

async function locate(name: string, parent?: string): Promise<string> {
  const relative = name.startsWith('@lostgradient/') ? name.slice('@lostgradient/'.length) : name;
  const workspace = join(
    REPOSITORY_ROOT,
    name.startsWith('@lostgradient/')
      ? relative.startsWith('plugin-')
        ? 'plugins'
        : 'packages'
      : 'node_modules',
    relative,
  );
  if (await Bun.file(join(workspace, 'package.json')).exists()) return workspace;
  for (const installed of [
    ...(parent === undefined
      ? []
      : [
          join(parent, 'node_modules', name),
          join(parent, '..', name),
          join(parent, '..', '..', name),
        ]),
    join(PACKAGE_DIRECTORY, 'node_modules', name),
  ]) {
    if (await Bun.file(join(installed, 'package.json')).exists()) return realpath(installed);
  }
  const store = join(REPOSITORY_ROOT, 'node_modules', '.bun');
  for (const entry of await readdir(store).catch(() => [])) {
    const installed = join(store, entry, 'node_modules', name);
    if (await Bun.file(join(installed, 'package.json')).exists()) return realpath(installed);
  }
  throw new Error(`Cannot resolve ${name}${parent === undefined ? '' : ` required by ${parent}`}`);
}

async function stage(
  name: string,
  nodeModules: string,
  seen: Set<string>,
  parent?: string,
): Promise<void> {
  if (seen.has(name)) return;
  seen.add(name);
  const source = await locate(name, parent);
  const destination = join(nodeModules, name);
  await mkdir(destination, { recursive: true });
  await cp(source, destination, {
    recursive: true,
    filter: (path) =>
      !path.includes(`${sep}node_modules${sep}`) &&
      !path.endsWith(`${sep}node_modules`) &&
      !path
        .split(sep)
        .some((part) =>
          new Set(['test', 'tests', '__tests__', 'fixtures', '.turbo', '.types', 'coverage']).has(
            part,
          ),
        ) &&
      !path.includes('.test.') &&
      !path.includes(`${sep}.types${sep}`),
  });
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    await stage(dependency, nodeModules, seen, source);
}

async function verifyFrozenInstall(): Promise<void> {
  await runCommand(
    [process.execPath, 'install', '--frozen-lockfile', '--dry-run'],
    REPOSITORY_ROOT,
  );
  if (!(await Bun.file(LOCKFILE).exists())) throw new Error('bun.lock is missing');
}

async function verifyRelocatedHost(root: string): Promise<void> {
  const home = await mkdtemp(join('/tmp', 'interborough-release-home-'));
  await writeFile(join(home, 'deployment-id'), '01ARZ3NDEKTSV4RRFFQ69G5FAV\n');
  const plugin = join(home, 'plugins', 'runtime-proof');
  await mkdir(plugin, { recursive: true });
  await writeFile(
    join(plugin, 'plugin.ts'),
    `import { definePlugin } from '@lostgradient/interborough-plugin';
export default definePlugin({ name: 'runtime-proof', title: 'Runtime proof', version: '1.0.0', description: 'Release proof', setup: () => ({ mcpApps: [{ name: 'external-proof', title: 'External proof', uri: 'ui://runtime-proof/external/v1', entry: new URL('./app.ts', import.meta.url), styles: '', allowedTools: [], opensFromTool: 'runtime.proof' }] }) });
`,
  );
  await writeFile(join(plugin, 'app.ts'), 'document.body.textContent = "external runtime";\n');
  const childProcess = Bun.spawn(
    [join(root, 'bin', 'interborough'), 'start', '--port', '0', '--home', home],
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
    const deadline = Date.now() + 20_000;
    const link = join(home, 'plugins', 'node_modules');
    while (Date.now() < deadline) {
      try {
        await lstat(link);
        break;
      } catch {
        await Bun.sleep(100);
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

async function compile(output: string, version: string): Promise<void> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('macOS arm64 is required to build this release');
  await runCommand(
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
  await runCommand(['codesign', '--force', '--sign', '-', output]);
  await runCommand(['codesign', '--verify', '--verbose=2', output]);
}

export async function buildRelease(
  argv: readonly string[] = process.argv.slice(2),
): Promise<string> {
  const options = parseReleaseArguments(argv);
  const status = await new Response(
    Bun.spawn(['git', 'status', '--porcelain'], { cwd: REPOSITORY_ROOT, stdout: 'pipe' }).stdout,
  ).text();
  if (status.trim() !== '') throw new Error('Release inputs are dirty');
  await verifyFrozenInstall();
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
  const staging = await mkdtemp(join(options.outdir, '.interborough-staging-'));
  const root = join(staging, 'interborough');
  try {
    await mkdir(join(root, 'bin'), { recursive: true });
    await mkdir(join(root, 'share', 'interborough'), { recursive: true });
    await compile(join(root, 'bin', 'interborough'), options.version);
    await buildApplication({ outdir: join(root, 'share', 'interborough', 'browser') });
    const mcpApps = join(root, 'share', 'interborough', 'mcp-apps');
    await mkdir(mcpApps, { recursive: true });
    for (const app of [runInspector, pendingReview]) {
      const page = await buildMcpAppPage({
        entry: app.entry.href,
        title: app.title,
        styles: app.styles ?? '',
      });
      await writeFile(join(mcpApps, `${app.name}.json`), JSON.stringify(page));
    }
    const runtime = join(root, 'share', 'interborough', 'plugin-runtime', 'node_modules');
    await mkdir(runtime, { recursive: true });
    await stage(SDK, runtime, new Set());
    await assertContained(join(root, 'share', 'interborough', 'plugin-runtime'));
    await verifyRelocatedHost(root);
    const manifest: ReleaseManifest = {
      version: options.version,
      sourceSha,
      target: 'darwin-arm64',
    };
    await writeFile(join(root, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await runCommand(['tar', '-czf', archive, '-C', staging, 'interborough']);
    await rename(root, targetRoot);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return archive;
}

if (import.meta.main)
  buildRelease()
    .then(console.info)
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
