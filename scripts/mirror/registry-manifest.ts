import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, type CommandRunner } from './packaging.ts';
import type { PublicationInputContract } from './source-digest.ts';

export function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a manifest object');
  }
  return value as Record<string, unknown>;
}

/** Ordinary maps are unordered; conditional imports/exports and arrays are not. */
export function canonicalManifest(value: unknown, ordered = false): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalManifest(item, ordered));
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value);
  if (!ordered) entries.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(
    entries.map(([key, entry]) => [
      key,
      canonicalManifest(entry, ordered || key === 'exports' || key === 'imports'),
    ]),
  );
}

export function normalizePublishedManifest(
  manifest: Record<string, unknown>,
  root: Record<string, unknown>,
  workspaceVersions: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const normalized = { ...manifest };
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'devDependencies',
    'peerDependencies',
  ]) {
    if (manifest[field] === undefined) continue;
    normalized[field] = Object.fromEntries(
      Object.entries(objectRecord(manifest[field])).map(([name, input]) => {
        if (typeof input !== 'string') throw new Error(`${name}: invalid dependency range`);
        let range = input;
        if (range.startsWith('catalog:')) {
          const catalogName = range.slice('catalog:'.length);
          const catalog = catalogName
            ? objectRecord(root['catalogs'])[catalogName]
            : root['catalog'];
          const resolved = objectRecord(catalog)[name];
          if (typeof resolved !== 'string')
            throw new Error(`${name}: unresolved catalog dependency`);
          range = resolved;
        }
        if (range.startsWith('workspace:')) {
          const version = workspaceVersions.get(name);
          if (!version) throw new Error(`${name}: no committed workspace version`);
          const suffix = range.slice('workspace:'.length);
          range =
            suffix === '*'
              ? version
              : suffix === '^' || suffix === '~'
                ? `${suffix}${version}`
                : suffix;
        }
        return [name, range];
      }),
    );
  }
  return normalized;
}

export function verifyRegistryManifest(
  registry: Record<string, unknown>,
  target: Record<string, unknown>,
): PublicationInputContract {
  const actual = JSON.stringify(canonicalManifest(registry));
  const expected = JSON.stringify(canonicalManifest(target));
  if (actual !== expected) {
    const keys = [...new Set([...Object.keys(registry), ...Object.keys(target)])].filter(
      (key) =>
        JSON.stringify(canonicalManifest(registry[key], key === 'exports' || key === 'imports')) !==
        JSON.stringify(canonicalManifest(target[key], key === 'exports' || key === 'imports')),
    );
    throw new Error(
      `registry manifest differs from the committed publication manifest: ${keys.join(', ')}`,
    );
  }
  return {
    algorithm: 'sha256-json-v1',
    digest: new Bun.CryptoHasher('sha256').update(actual).digest('hex'),
  };
}

export async function readGitJson(
  directory: string,
  commit: string,
  path: string,
  runner: CommandRunner = runCommand,
): Promise<Record<string, unknown>> {
  const result = await runner(['git', 'show', `${commit}:${path}`], { cwd: directory });
  if (result.exitCode !== 0) throw new Error(`Cannot read committed manifest ${commit}:${path}`);
  return objectRecord(JSON.parse(result.stdout));
}

export async function committedPublicationManifest(
  directory: string,
  commit: string,
  packageDirectory: string,
  runner: CommandRunner = runCommand,
): Promise<Record<string, unknown>> {
  const root = await readGitJson(directory, commit, 'package.json', runner);
  const listed = await runner(['git', 'ls-tree', '-r', '--name-only', commit], { cwd: directory });
  if (listed.exitCode !== 0) throw new Error(`Cannot list manifests at ${commit}`);
  const workspaceVersions = new Map<string, string>();
  const workspaceDeclaration = root['workspaces'];
  const workspacePatterns = Array.isArray(workspaceDeclaration)
    ? workspaceDeclaration
    : objectRecord(workspaceDeclaration)['packages'];
  if (
    !Array.isArray(workspacePatterns) ||
    workspacePatterns.some((pattern) => typeof pattern !== 'string')
  )
    throw new Error('Invalid target workspace declaration');
  for (const path of listed.stdout.trim().split('\n')) {
    if (!path.endsWith('/package.json')) continue;
    const workspaceDirectory = path.slice(0, -'/package.json'.length);
    if (!workspacePatterns.some((pattern) => new Bun.Glob(pattern).match(workspaceDirectory)))
      continue;
    const manifest = await readGitJson(directory, commit, path, runner);
    if (typeof manifest['name'] === 'string' && typeof manifest['version'] === 'string')
      workspaceVersions.set(manifest['name'], manifest['version']);
  }
  return normalizePublishedManifest(
    await readGitJson(directory, commit, `${packageDirectory}/package.json`, runner),
    root,
    workspaceVersions,
  );
}

/** Verify SRI before extracting exactly one archive member to stdout. */
export async function fetchPublishedManifest(
  name: string,
  version: string,
  runner: CommandRunner = runCommand,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const info = await runner(['bun', 'info', `${name}@${version}`, '--json'], {
    cwd: process.cwd(),
  });
  if (info.exitCode !== 0) throw new Error(`${name}@${version}: unable to read registry metadata`);
  const dist = objectRecord(objectRecord(JSON.parse(info.stdout))['dist']);
  if (
    typeof dist['tarball'] !== 'string' ||
    typeof dist['integrity'] !== 'string' ||
    !dist['integrity'].startsWith('sha512-')
  )
    throw new Error(`${name}@${version}: registry metadata has no SHA512 tarball integrity`);
  const url = new URL(dist['tarball']);
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org')
    throw new Error('Unexpected registry tarball origin');
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`${name}@${version}: tarball returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = new Bun.CryptoHasher('sha512').update(bytes).digest('base64');
  if (`sha512-${actual}` !== dist['integrity'])
    throw new Error(`${name}@${version}: tarball integrity mismatch`);
  const scratch = await mkdtemp(join(tmpdir(), 'corvidae-registry-manifest-'));
  try {
    const archive = join(scratch, 'package.tgz');
    await Bun.write(archive, bytes);
    const extract = await runCommand(['tar', '-xOf', archive, 'package/package.json'], {
      cwd: scratch,
    });
    if (extract.exitCode !== 0)
      throw new Error(`${name}@${version}: tarball has no package/package.json`);
    const manifest = objectRecord(JSON.parse(extract.stdout));
    if (manifest['name'] !== name || manifest['version'] !== version)
      throw new Error('Registry tarball package identity mismatch');
    return manifest;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
