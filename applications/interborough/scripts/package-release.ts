import { cp, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

const APPLICATION_DIRECTORY = resolve(import.meta.dir, '..');
const REPOSITORY_ROOT = resolve(APPLICATION_DIRECTORY, '..', '..');
const PACKAGE_NAME = 'interborough';
const PACKAGE_FILES = ['payload'] as const;

export type PackageReleaseArguments = { readonly archive: string; readonly outdir: string };
export type PackResult = {
  readonly tarball: string;
  readonly integrity: string;
  readonly prefix: string;
  readonly version: string;
};

type ReleaseManifest = { readonly version: unknown; readonly target: unknown };
type PackedFile = { readonly path?: unknown };
type PackedPackage = { readonly filename?: unknown; readonly integrity?: unknown; readonly files?: unknown };

export function parsePackageReleaseArguments(argv: readonly string[]): PackageReleaseArguments {
  let archive: string | undefined;
  let outdir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--archive') archive = argv[++index];
    else if (argument === '--outdir') outdir = argv[++index];
    else throw new Error(`Unknown package release argument: ${argument}`);
  }
  if (archive === undefined || archive.trim() === '') throw new Error('--archive needs a file');
  if (outdir === undefined || outdir.trim() === '') throw new Error('--outdir needs a directory');
  return { archive: resolve(archive), outdir: resolve(outdir) };
}

async function run(command: readonly string[], cwd?: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(' ')} failed (${exitCode}): ${stderr || stdout}`);
  return stdout;
}

async function pathsIn(directory: string, prefix = ''): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const child = join(prefix, entry.name);
    if (entry.isDirectory()) paths.push(...(await pathsIn(path, child)));
    else if (entry.isFile()) paths.push(child);
    else throw new Error(`Package staging contains unsupported entry: ${relative(directory, path)}`);
  }
  return paths;
}

function releaseVersion(manifest: ReleaseManifest): string {
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version))
    throw new Error('Release manifest has no semver version');
  if (manifest.target !== 'darwin-arm64') throw new Error('Release manifest is not darwin-arm64');
  return manifest.version;
}

function packageManifest(version: string) {
  return {
    name: PACKAGE_NAME,
    version,
    description: 'Interborough for macOS arm64',
    license: 'MIT',
    files: PACKAGE_FILES,
    bin: { interborough: 'payload/bin/interborough' },
    os: ['darwin'],
    cpu: ['arm64'],
  };
}

async function assertManifest(directory: string, version: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Record<string, unknown>;
  const expected = packageManifest(version);
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(manifest[key]) !== JSON.stringify(value))
      throw new Error(`Generated package manifest has wrong ${key}`);
  }
  const scripts = manifest['scripts'];
  if (
    typeof scripts === 'object' &&
    scripts !== null &&
    ['preinstall', 'install', 'postinstall'].some((name) => Object.hasOwn(scripts, name))
  )
    throw new Error('Generated package manifest has an install lifecycle script');
}

async function assertPackedFiles(
  staging: string,
  packed: PackedPackage,
): Promise<void> {
  if (!Array.isArray(packed.files)) throw new Error('npm pack did not report files');
  const actual = packed.files
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as PackedFile).path : undefined))
    .filter((path): path is string => typeof path === 'string')
    .sort();
  const stagedPayload = (await pathsIn(join(staging, 'payload'))).map((path) => `payload/${path}`);
  const expected = ['LICENSE', 'README.md', 'package.json', ...stagedPayload].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`npm pack file list differs from staged allowlist: ${JSON.stringify({ actual, expected })}`);
}

async function assertInstalled(prefix: string, version: string): Promise<void> {
  const executable = join(prefix, 'bin', 'interborough');
  const executableStat = await stat(executable);
  if ((executableStat.mode & 0o111) === 0) throw new Error('Offline npm install removed executable bit');
  const sdk = join(
    prefix,
    'lib',
    'node_modules',
    PACKAGE_NAME,
    'payload',
    'share',
    'interborough',
    'plugin-runtime',
    'node_modules',
    '@lostgradient',
    'interborough-plugin',
    'package.json',
  );
  if (!(await Bun.file(sdk).exists())) throw new Error('Offline npm install omitted the SDK runtime');
  const child = Bun.spawn([executable, '--version'], {
    env: { PATH: '/usr/bin:/bin', HOME: prefix, INTERBOROUGH_HOME: prefix },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0 || stdout.trim() !== version)
    throw new Error(`Installed CLI version differs from manifest: ${stderr || stdout}`);
}

export async function packageRelease(
  argv: readonly string[] = process.argv.slice(2),
): Promise<PackResult> {
  const { archive, outdir } = parsePackageReleaseArguments(argv);
  if (!(await Bun.file(archive).exists())) throw new Error(`Release archive does not exist: ${archive}`);
  if (await Bun.file(outdir).exists()) throw new Error(`Package output already exists: ${outdir}`);
  await mkdir(outdir, { recursive: true });
  const extracted = join(outdir, 'archive');
  const staging = join(outdir, 'package');
  const prefix = join(outdir, 'prefix');
  try {
    await mkdir(extracted, { recursive: true });
    await run(['tar', '-xzf', archive, '-C', extracted]);
    const release = join(extracted, 'interborough');
    const manifest = JSON.parse(await readFile(join(release, 'release.json'), 'utf8')) as ReleaseManifest;
    const version = releaseVersion(manifest);
    await mkdir(staging, { recursive: true });
    await cp(release, join(staging, 'payload'), { recursive: true, preserveTimestamps: true });
    await cp(join(REPOSITORY_ROOT, 'README.md'), join(staging, 'README.md'));
    await cp(join(REPOSITORY_ROOT, 'LICENSE'), join(staging, 'LICENSE'));
    await Bun.write(join(staging, 'package.json'), `${JSON.stringify(packageManifest(version), null, 2)}\n`);
    await assertManifest(staging, version);
    const packedOutput = await run(['npm', 'pack', '--ignore-scripts', '--json'], staging);
    const packed = JSON.parse(packedOutput) as PackedPackage[];
    const entry = packed[0];
    if (entry === undefined || typeof entry.filename !== 'string' || typeof entry.integrity !== 'string')
      throw new Error('npm pack did not report its filename and integrity');
    await assertPackedFiles(staging, entry);
    const tarball = join(outdir, basename(entry.filename));
    await rename(join(staging, entry.filename), tarball);
    await run(['npm', 'install', '--global', '--offline', '--ignore-scripts', '--prefix', prefix, tarball]);
    await assertInstalled(prefix, version);
    const result = { tarball, integrity: entry.integrity, prefix, version };
    await Bun.write(join(outdir, 'package-result.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) {
    await rm(outdir, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const result = await packageRelease();
  console.info(JSON.stringify({ ...result, tarball: relative(process.cwd(), result.tarball) }));
}
