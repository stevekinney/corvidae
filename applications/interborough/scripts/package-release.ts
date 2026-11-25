import { cp, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

const APPLICATION_DIRECTORY = resolve(import.meta.dir, '..');
const REPOSITORY_ROOT = resolve(APPLICATION_DIRECTORY, '..', '..');
const PACKAGE_NAME = 'interborough';
const PACKAGE_FILES = ['payload'] as const;

type PackageReleaseArguments = { readonly archive: string; readonly outdir: string };
type PackResult = {
  readonly tarball: string;
  readonly integrity: string;
  readonly version: string;
};

type ReleaseManifest = { readonly version: unknown; readonly target: unknown };
type PackedFile = { readonly path?: unknown };
type PackedPackage = {
  readonly filename?: unknown;
  readonly integrity?: unknown;
  readonly files?: unknown;
};

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

async function run(command: string[], cwd = REPOSITORY_ROOT): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(`${command.join(' ')} failed (${exitCode}): ${stderr || stdout}`);
  return stdout;
}

async function preparePayloadFiles(directory: string, prefix = 'payload'): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const child = join(prefix, entry.name);
    if (entry.isDirectory()) paths.push(...(await preparePayloadFiles(path, child)));
    else if (entry.isFile()) {
      // npm would apply these authoring rules to generated files in the frozen runtime closure.
      if (entry.name === '.npmignore' || entry.name === '.gitignore') await rm(path);
      else paths.push(child);
    } else
      throw new Error(`Package staging contains unsupported entry: ${relative(directory, path)}`);
  }
  return paths;
}

function releaseVersion(manifest: ReleaseManifest): string {
  if (
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)
  )
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
    repository: { type: 'git', url: 'git+https://github.com/stevekinney/corvidae.git' },
    files: PACKAGE_FILES,
    bin: { interborough: 'payload/bin/interborough' },
    os: ['darwin'],
    cpu: ['arm64'],
  };
}

async function assertManifest(directory: string, version: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
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

function assertPackedFiles(payloadFiles: readonly string[], packed: PackedPackage): void {
  if (!Array.isArray(packed.files)) throw new Error('npm pack did not report files');
  const actual = packed.files
    .map((entry) => {
      const path =
        typeof entry === 'object' && entry !== null ? (entry as PackedFile).path : undefined;
      if (typeof path !== 'string') throw new Error('npm pack returned a file without a path');
      return path;
    })
    .toSorted();
  const expected = ['LICENSE', 'README.md', 'package.json', ...payloadFiles].toSorted();
  if (actual.length === expected.length && actual.every((path, index) => path === expected[index]))
    return;
  const packedNames = new Set(actual);
  const stagedNames = new Set(expected);
  const missing = expected.filter((path) => !packedNames.has(path));
  const unexpected = actual.filter((path) => !stagedNames.has(path));
  throw new Error(
    `npm pack file list differs from staged allowlist: expected ${expected.length}, packed ${actual.length}, missing ${missing.length} ${JSON.stringify(missing.slice(0, 20))}, unexpected ${unexpected.length} ${JSON.stringify(unexpected.slice(0, 20))}`,
  );
}

async function packageRelease(
  argv: readonly string[] = process.argv.slice(2),
): Promise<PackResult> {
  const { archive, outdir } = parsePackageReleaseArguments(argv);
  if (!(await Bun.file(archive).exists()))
    throw new Error(`Release archive does not exist: ${archive}`);
  await mkdir(dirname(outdir), { recursive: true });
  try {
    await mkdir(outdir);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new Error(`Package output already exists: ${outdir}`, { cause: error });
    throw error;
  }
  const extracted = join(outdir, 'archive');
  const staging = join(outdir, 'package');
  try {
    await mkdir(extracted, { recursive: true });
    await run(['tar', '-xzf', archive, '-C', extracted]);
    const release = join(extracted, 'interborough');
    const manifest = JSON.parse(
      await readFile(join(release, 'release.json'), 'utf8'),
    ) as ReleaseManifest;
    const version = releaseVersion(manifest);
    await mkdir(staging, { recursive: true });
    const payload = join(staging, 'payload');
    await rename(release, payload);
    const payloadFiles = await preparePayloadFiles(payload);
    await cp(join(REPOSITORY_ROOT, 'README.md'), join(staging, 'README.md'));
    await cp(join(REPOSITORY_ROOT, 'LICENSE'), join(staging, 'LICENSE'));
    await Bun.write(
      join(staging, 'package.json'),
      `${JSON.stringify(packageManifest(version), null, 2)}\n`,
    );
    await assertManifest(staging, version);
    const packedOutput = await run(['npm', 'pack', '--ignore-scripts', '--json'], staging);
    // npm emits a list or an object keyed by package name, depending on its version.
    const packed = Object.values(JSON.parse(packedOutput) as Record<string, PackedPackage>);
    const [entry] = packed;
    if (
      packed.length !== 1 ||
      entry === undefined ||
      typeof entry.filename !== 'string' ||
      typeof entry.integrity !== 'string'
    )
      throw new Error('npm pack did not report its filename and integrity');
    assertPackedFiles(payloadFiles, entry);
    const tarball = join(outdir, basename(entry.filename));
    await rename(join(staging, entry.filename), tarball);
    const result = { tarball, integrity: entry.integrity, version };
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
