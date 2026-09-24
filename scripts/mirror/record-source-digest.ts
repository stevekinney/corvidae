import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverWorkspaces } from './manifests.ts';
import { loadPackageMap, type PackageMap } from './package-map.ts';
import { runCommand, type CommandRunner } from './packaging.ts';
import { collectDigestedFiles, hashDigestedFiles } from './source-digest.ts';

/**
 * Records `package-map.json`'s `sourceDigest` for one published workspace, after checking the
 * digest it is about to record against what the registry actually shipped.
 *
 *   bun scripts/mirror/record-source-digest.ts --workspace @lostgradient/operative
 *
 * A digest recorded without that check would be exactly as trustworthy as no digest at all — it
 * would say "this is what got published" on nothing but corvidae's own say-so, which is the same
 * unverified claim `assertEdgeNotStale` (source-digest.ts) exists to refuse. So before writing
 * anything, this downloads `lastPublishedVersion`'s tarball and compares it against corvidae's
 * current tree for every file the two can actually be compared on.
 *
 * **What "compared" means in practice.** A published package's tarball ships `package.json`,
 * `LICENSE`, `README.md` and a *built* `dist/` — never `src/`, which is what corvidae actually
 * carries and what most of a digest's scope is (`source-digest.ts`'s `collectDigestedFiles`).
 * Verified against the real `conversationalist@1.2.0`, `@lostgradient/operative@0.12.0` and
 * `@lostgradient/weft@0.26.0` tarballs: `README.md` and `LICENSE` are the whole of the overlap in
 * every case. So this check is real but narrow — it confirms the two front-page files a consumer
 * actually reads verbatim still match, and it cannot see whether `src/`'s compiled output matches
 * `dist/`'s, because nothing on either side hands it two comparable copies of that. A package whose
 * tarball shares nothing with `collectDigestedFiles`' scope (an empty overlap) is not refused —
 * nothing differs when there is nothing to compare — but `recordSourceDigest`'s result says so
 * explicitly (`comparedPaths: []`), and the CLI prints it, rather than letting a silent pass read
 * as a stronger guarantee than it is.
 *
 * **Two false-positive modes, both observed against the real registry, neither papered over.**
 * `LICENSE` carries a copyright year range (`2024–2026`) that moves independently of any package's
 * actual source — every one of the three real tarballs checked above has an older, narrower range,
 * so a byte-exact `LICENSE` comparison refuses on a date bump nobody would call a real staleness
 * signal. `README.md` can refuse for the opposite reason `formatEmittedFile`'s own doc comment
 * describes: `@lostgradient/weft`'s real tarball carries a README whose markdown tables are padded
 * to column width by weft's own prettier configuration, while corvidae's copy — and the one this
 * command reads — is prettier-clean under corvidae's own `proseWrap: "never"` rule and unpadded;
 * the two are the same content, differently formatted, and this comparison calls that a mismatch.
 * Both are real limitations of a byte-exact check with no target clone to reformat against, not
 * bugs to silently work around: the alternative (checking out each target, running its prettier
 * over corvidae's copy before comparing, or building `dist/` locally to compare against the
 * tarball's) is real additional engineering this change does not do. The command refuses in both
 * cases — favoring a false refusal a human can inspect and override by hand over a false pass that
 * silently records the wrong claim — and its error message says exactly which file mismatched, so
 * the two causes are distinguishable from a genuine content change without re-deriving this
 * analysis.
 */

export class RegistryVerificationError extends Error {}

const registry = 'https://registry.npmjs.org';

interface VersionManifest {
  dist?: { tarball?: string };
}

/** The tarball URL npm's own version manifest names, rather than one guessed from a naming convention. */
export async function fetchTarballUrl(
  name: string,
  version: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImplementation(`${registry}/${name.replace('/', '%2f')}/${version}`);
  if (!response.ok) {
    throw new RegistryVerificationError(
      `${name}@${version}: registry returned HTTP ${response.status} for the version manifest`,
    );
  }
  const manifest = (await response.json()) as VersionManifest;
  const tarball = manifest.dist?.tarball;
  if (!tarball) {
    throw new RegistryVerificationError(`${name}@${version}: version manifest has no dist.tarball`);
  }
  return tarball;
}

/** The tarball's raw bytes, fetched from the URL `fetchTarballUrl` resolved. */
export async function downloadTarball(
  url: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<Uint8Array> {
  const response = await fetchImplementation(url);
  if (!response.ok) {
    throw new RegistryVerificationError(`${url}: registry returned HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Extract a `.tgz` into `destination`, via the system `tar` the same way `packaging.ts` shells out. */
export async function extractTarball(
  tarballPath: string,
  destination: string,
  runner: CommandRunner = runCommand,
): Promise<void> {
  const result = await runner(['tar', '-xzf', tarballPath, '-C', destination], {
    cwd: destination,
  });
  if (result.exitCode !== 0) {
    throw new RegistryVerificationError(
      `extracting ${tarballPath}: \`${result.command}\` exited ${result.exitCode}\n${result.stdout}${result.stderr}`,
    );
  }
}

/** Where one digested file would sit inside an npm tarball, or `undefined` for one that never ships there. */
function tarballPathFor(digestedPath: string): string | undefined {
  if (digestedPath === 'README.md') return 'package/README.md';
  if (digestedPath === '../LICENSE') return 'package/LICENSE';
  return undefined;
}

export interface RegistryComparison {
  /** Digested paths present on both sides and compared byte-for-byte. */
  comparedPaths: string[];
  /** Digested paths present on both sides whose bytes differed. */
  mismatchedPaths: string[];
}

/**
 * Compare corvidae's digested files against an extracted tarball, for the paths that exist on
 * both sides. `src/**` is never one of them — see this module's own doc comment for why.
 */
export async function compareAgainstExtractedTarball(
  corvidaeFiles: readonly { path: string; bytes: Uint8Array }[],
  extractedDirectory: string,
): Promise<RegistryComparison> {
  const comparedPaths: string[] = [];
  const mismatchedPaths: string[] = [];
  for (const file of corvidaeFiles) {
    const tarballPath = tarballPathFor(file.path);
    if (tarballPath === undefined) continue;
    const candidate = Bun.file(join(extractedDirectory, tarballPath));
    if (!(await candidate.exists())) continue;
    comparedPaths.push(file.path);
    const published = new Uint8Array(await candidate.arrayBuffer());
    if (Buffer.compare(Buffer.from(file.bytes), Buffer.from(published)) !== 0) {
      mismatchedPaths.push(file.path);
    }
  }
  return { comparedPaths: comparedPaths.toSorted(), mismatchedPaths: mismatchedPaths.toSorted() };
}

export interface RecordOptions {
  corvidaeRoot: string;
  /** The workspace's corvidae name, as `package-map.json` keys it — not its public npm name. */
  workspace: string;
  fetchImplementation?: typeof fetch;
  runner?: CommandRunner;
}

export interface RecordResult {
  workspace: string;
  publicName: string;
  version: string;
  digest: string;
  previouslyRecorded: string | undefined;
  comparison: RegistryComparison;
}

/**
 * Compute a workspace's current source digest and verify it against the registry, without writing
 * anything. `run` below is what writes; this is the part worth calling directly from a test or a
 * report, since it never touches `package-map.json`.
 */
export async function recordSourceDigest({
  corvidaeRoot,
  workspace,
  fetchImplementation = fetch,
  runner = runCommand,
}: RecordOptions): Promise<RecordResult> {
  const map = await loadPackageMap();
  const entry = map.workspaces[workspace];
  if (entry === undefined) {
    throw new RegistryVerificationError(`${workspace}: no entry in package-map.json`);
  }
  if (entry.disposition !== 'publish-as') {
    throw new RegistryVerificationError(
      `${workspace}: disposition is "${entry.disposition}", not "publish-as" — only a published workspace has a registry version to record a digest against`,
    );
  }
  if (entry.lastPublishedVersion === null) {
    throw new RegistryVerificationError(
      `${workspace}: lastPublishedVersion is null — publish ${entry.name} at least once before recording a digest for it`,
    );
  }

  const files = await collectDigestedFiles({
    corvidaeRoot,
    corvidaeDirectory: await directoryFor(corvidaeRoot, workspace),
  });
  const digest = hashDigestedFiles(files);

  const tarballUrl = await fetchTarballUrl(
    entry.name,
    entry.lastPublishedVersion,
    fetchImplementation,
  );
  const tarballBytes = await downloadTarball(tarballUrl, fetchImplementation);

  const scratch = await mkdtemp(join(tmpdir(), 'corvidae-source-digest-'));
  try {
    const tarballPath = join(scratch, 'package.tgz');
    await Bun.write(tarballPath, tarballBytes);
    await extractTarball(tarballPath, scratch, runner);
    const comparison = await compareAgainstExtractedTarball(files, scratch);
    if (comparison.mismatchedPaths.length > 0) {
      throw new RegistryVerificationError(
        `${workspace}: corvidae's current ${comparison.mismatchedPaths.join(', ')} does not match what ${entry.name}@${entry.lastPublishedVersion} actually shipped. Refusing to record a digest that claims a state the registry does not confirm; resolve the drift (or publish a new version) before recording.`,
      );
    }
    return {
      workspace,
      publicName: entry.name,
      version: entry.lastPublishedVersion,
      digest,
      previouslyRecorded: entry.sourceDigest,
      comparison,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** A workspace's corvidae directory, read from `discoverWorkspaces`' own view of the tree. */
async function directoryFor(corvidaeRoot: string, workspace: string): Promise<string> {
  const discovered = await discoverWorkspaces(corvidaeRoot);
  const found = discovered.find((candidate) => candidate.name === workspace);
  if (found === undefined) {
    throw new RegistryVerificationError(`${workspace}: no workspace directory found in corvidae`);
  }
  return found.directory;
}

function readOption(argv: readonly string[], name: string): string {
  const index = argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value) throw new RegistryVerificationError(`Missing required option --${name}`);
  return value;
}

/** Write the recorded digest into `package-map.json`, preserving every other byte the file carries. */
function withRecordedDigest(map: PackageMap, workspace: string, digest: string): PackageMap {
  const entry = map.workspaces[workspace];
  if (entry === undefined || entry.disposition !== 'publish-as') {
    throw new RegistryVerificationError(`${workspace}: not a publish-as entry`);
  }
  return {
    ...map,
    workspaces: { ...map.workspaces, [workspace]: { ...entry, sourceDigest: digest } },
  };
}

export async function run(argv: readonly string[]): Promise<number> {
  try {
    const workspace = readOption(argv, 'workspace');
    const corvidaeRoot = new URL('../../', import.meta.url).pathname;
    const result = await recordSourceDigest({ corvidaeRoot, workspace });
    const mapFile = new URL('./package-map.json', import.meta.url);
    const current = JSON.parse(await Bun.file(mapFile).text()) as PackageMap;
    const updated = withRecordedDigest(current, workspace, result.digest);
    await Bun.write(mapFile, `${JSON.stringify(updated, undefined, 2)}\n`);
    process.stdout.write(
      `Recorded sourceDigest for ${workspace} (${result.publicName}@${result.version}): ${result.digest}\n` +
        `Verified against the registry on ${result.comparison.comparedPaths.length} file(s): ${result.comparison.comparedPaths.join(', ') || '(none — src/ has no counterpart in a published tarball, so nothing was independently verifiable)'}\n` +
        (result.previouslyRecorded ? `Previous digest was ${result.previouslyRecorded}\n` : ''),
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await run(Bun.argv.slice(2)));
