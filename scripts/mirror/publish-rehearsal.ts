import { join } from 'node:path';

import { mirrorTargets, type MirrorTarget } from './manifests.ts';
import { checkTarball, packWorkspace, runCommand, type CommandRunner } from './packaging.ts';
import { cloneTarget, stageSurface, type StageOutcome } from './sync.ts';

/**
 * What it takes to believe a publish rehearsal.
 *
 * `npm publish --dry-run` packs whatever the manifest's `files` allowlist matches on disk and
 * reports what it would upload. That is all it does. Point it at a package that was never built
 * and there is no `dist/`, the allowlist matches nothing under it, and npm exits 0 having
 * rehearsed the publication of a tarball with no entry point in it — a package every consumer
 * would fail to import. A green exit code from that command, on its own, is compatible with a
 * completely broken release, which is why this module exists rather than a bare `run(['npm', …])`.
 *
 * So the rehearsal is four steps and the publish is the last one:
 *
 * - **Build.** The emitted `build` script is what produces the files the allowlist points at.
 *   Nothing downstream means anything until it has run.
 * - **Pack and lint.** `packWorkspace` plus `checkTarball` are the sync's own packaging checks,
 *   reused rather than restated. `publint --strict` reads the packed artifact and rules on every
 *   `exports` entry against the files actually inside it, which is exactly the gap npm's exit code
 *   leaves open.
 * - **Publish, for real, in rehearsal.** The command the acceptance criterion names, judged by its
 *   exit code.
 * - **Read back what npm said it would ship.** `--json` reports npm's own file list, which is the
 *   only view of the tarball *npm* would upload — `publint` read a `bun pm pack` artifact, and the
 *   two are produced by different tools from the same allowlist. Every entry point the manifest
 *   points at has to appear in that list. This is what turns npm's exit code into evidence.
 *
 * What this deliberately does *not* gate on is `attw`, which `checkTarball` runs alongside
 * `publint` and which is reported here rather than asserted. The reason is a measurement, not a
 * preference: every package the mirror publishes fails `attw` today in the form it is published
 * in. `@lostgradient/weft@0.25.0`, `@lostgradient/chat@0.14.0`, `@lostgradient/editor@0.14.0` and
 * `@lostgradient/cinder@0.26.2` were each packed from the registry and checked, and all four exit
 * 1.
 *
 * They fail on *three* independently ignorable rules, not one, and the distinction matters enough
 * that collapsing it would mislead whoever rules on the gate. For weft: `CJSResolvesToESM` (31),
 * because these are ESM-only packages with no `require` condition; `NoResolution` (30), every one
 * `resolutionKind: node10` on a subpath entry point, which `typesVersions` could satisfy and no
 * workspace here declares; and `InternalResolutionError` (157), declaration files importing
 * extensionless specifiers that node16 ESM will not resolve. The first two are consequences of
 * choosing not to support legacy resolution. The third is a genuine defect — and the tarball this
 * module produces carries **zero** of them, against 157 in the published artifact, because this
 * workspace's build emits correct declarations. The mirror's output is better than what is on npm.
 *
 * Gating a publish rehearsal on any of that would make the thing being rehearsed unprovable for
 * every package, transformed or not, which says nothing about the transform. The two rulings are
 * different questions: whether the tarball is *complete* is publint's, and it is the one this
 * module exists to answer; whether its *resolution semantics* serve every consumer is `attw`'s,
 * and `verifyTarget` in `sync.ts` still gates every package on it, untouched. That gate failing
 * for every target today is a finding about the packages, recorded against them rather than
 * worked around here.
 *
 * One thing `npm publish --dry-run` does reach the registry for, which is easy to miss because a
 * package that has never been published never shows it: the version. `@lostgradient/weft@0.25.0`
 * is on npm, the transform carries the target's version through untouched because `version` is
 * target-owned, and so the command exits 1 with "You cannot publish over the previously published
 * versions: 0.25.0" — by construction, for every released package, no matter how complete the
 * tarball is. A rehearsal of a released package is therefore a rehearsal of its *next* version,
 * which is what `version` below is for. It is opt-in and it is printed: left alone, npm's refusal
 * is a correct and loud "nothing here bumped the version".
 *
 * Every command here is judged by its exit code. The human-readable output carries ANSI escapes,
 * so a grep for an error string reports a false green against output that plainly contains errors.
 * The one thing that is parsed is npm's `--json` stdout, which is structured data on its own
 * stream rather than a message to pattern-match.
 */

export class PublishRehearsalError extends Error {}

export interface PublishProbe {
  publicName: string;
  /** The version rehearsed, which is `treeVersion` unless one was named. */
  version: string;
  /** The version the transformed tree carries, which is the target's own. */
  treeVersion: string;
  /** The argument vector, so the report says exactly what was proven. */
  command: string;
  exitCode: number;
  /** The packed artifact `publint` and `attw` read. */
  tarball: string;
  buildExitCode: number;
  publintExitCode: number;
  typeResolutionExitCode: number;
  /** Every path npm reported it would ship, sorted. */
  entries: string[];
  /** The manifest's own entry points, every one of them found among `entries`. */
  entryPoints: string[];
}

interface PublishedManifest {
  version?: string;
  main?: unknown;
  module?: unknown;
  types?: unknown;
  bin?: unknown;
  exports?: unknown;
}

/**
 * Every package-relative file the manifest promises a consumer, from wherever it promises it.
 *
 * Walked rather than read key by key because an `exports` map is arbitrarily nested — conditions
 * inside subpaths inside conditions — and a map with thirty correct targets and one wrong one
 * looks identical at the root. A subpath pattern is skipped for the same reason
 * `importableSpecifiers` skips it: `./dist/*` resolves to whatever matches it rather than to a
 * file, so there is no single path to look for. Everything else is a path some consumer's
 * resolver will ask the tarball for.
 */
export function collectEntryPoints(manifest: unknown): string[] {
  const targets = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith('./') && !value.includes('*')) targets.add(value.slice(2));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) visit(item);
    }
  };
  if (typeof manifest !== 'object' || manifest === null) return [];
  const fields = manifest as PublishedManifest;
  visit(fields.exports);
  visit(fields.main);
  visit(fields.module);
  visit(fields.types);
  visit(fields.bin);
  return [...targets].toSorted();
}

interface NpmDryRunEntry {
  files?: { path?: unknown }[];
}

/**
 * The file list out of `npm publish --dry-run --json`.
 *
 * npm keys the object by package id, so the single value is taken rather than a name being
 * matched: a mismatch between the name asked for and the name reported would be a different
 * failure, and this parse should not be the thing that discovers it.
 */
export function readShippedPaths(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new PublishRehearsalError(
      `npm publish --dry-run --json printed something that is not JSON, so what it would ship cannot be read:\n${stdout}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PublishRehearsalError(`npm publish --dry-run --json printed no report:\n${stdout}`);
  }
  const report = Object.values(parsed as Record<string, NpmDryRunEntry>).at(0);
  const files = report?.files;
  if (!Array.isArray(files)) {
    throw new PublishRehearsalError(
      `npm publish --dry-run --json reported no file list, so the tarball's contents cannot be checked:\n${stdout}`,
    );
  }
  return files
    .map((file) => file.path)
    .filter((path): path is string => typeof path === 'string')
    .toSorted();
}

export interface PublishProbeOptions {
  run?: CommandRunner;
  /** The staged target clone. */
  workDirectory: string;
  outcome: StageOutcome;
  /** Where the tarball is written; outside the clone, so git never sees it. */
  scratchDirectory: string;
  /** Which published package is proven; the first one alphabetically by default. */
  packageName?: string | undefined;
  /** The checkout whose devDependencies supply publint and attw; defaults to this one. */
  toolsRoot?: string | undefined;
  /**
   * The version to rehearse instead of the one the tree carries.
   *
   * Written into the staged manifest before anything builds or packs, which dirties the clone.
   * That is fine everywhere this runs: the clone is disposable, and in `runDryRun` the sync commit
   * has already been made and pushed by the time the probe runs, so the mutation is never
   * committed and never reaches a mirror.
   */
  version?: string | undefined;
}

/** Prove `npm publish --dry-run` against one built, packed and linted package of a staged tree. */
export async function proveNpmPublishDryRun(options: PublishProbeOptions): Promise<PublishProbe> {
  const run = options.run ?? runCommand;
  const published = options.outcome.plan.published.toSorted((left, right) =>
    left.publicName.localeCompare(right.publicName),
  );
  const chosen = options.packageName
    ? published.find((entry) => entry.publicName === options.packageName)
    : published.at(0);
  if (!chosen) {
    throw new PublishRehearsalError(
      options.packageName
        ? `No published package named ${options.packageName} in this target; it publishes ${published.map((entry) => entry.publicName).join(', ')}`
        : 'The transform planned no published package, so there is nothing to prove a publish against',
    );
  }
  const packageDirectory = join(options.workDirectory, chosen.directory);
  const manifestPath = join(packageDirectory, 'package.json');
  const manifest = (await Bun.file(manifestPath).json()) as Record<string, unknown>;
  const treeVersion = (manifest as PublishedManifest).version ?? '';
  const version = options.version ?? treeVersion;
  if (options.version !== undefined && options.version !== treeVersion) {
    manifest['version'] = options.version;
    await Bun.write(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
  }

  // Before anything packs. The allowlist points at build output, so packing first would inspect a
  // tarball that is missing everything the package exists to ship and call the result a rehearsal.
  const build = await run(['bun', 'run', 'build'], { cwd: packageDirectory });
  if (build.exitCode !== 0) {
    throw new PublishRehearsalError(
      `${chosen.publicName}: \`bun run build\` exited ${build.exitCode}, so there is nothing complete to rehearse publishing\n${build.stdout}${build.stderr}`,
    );
  }

  const tarball = await packWorkspace({
    packageDirectory,
    destination: join(options.scratchDirectory, 'tarballs'),
  });
  const report = await checkTarball(chosen.publicName, tarball, options.toolsRoot);
  if (report.publint.exitCode !== 0) {
    throw new PublishRehearsalError(
      `${chosen.publicName}@${version}: publint --strict exited ${report.publint.exitCode} against ${tarball}, so the tarball npm would publish is not complete\n${report.publint.stdout}${report.publint.stderr}`,
    );
  }

  // A prerelease version is refused outright unless a tag is named — npm exits 1 with "You must
  // specify a tag using --tag when publishing a prerelease version" — so the tag is chosen from
  // the version here rather than left to npm's default. `--ignore-scripts` matches what the
  // packing check already does for the same reason: two packages declare a `prepack` gate whose
  // inputs the transform does not carry, and this command inspects the tarball npm would build
  // rather than rehearsing that gate.
  const prerelease = version.includes('-');
  const command = [
    'npm',
    'publish',
    '--dry-run',
    '--ignore-scripts',
    '--tag',
    prerelease ? 'next' : 'latest',
    '--json',
  ];
  const result = await run(command, { cwd: packageDirectory });
  if (result.exitCode !== 0) {
    throw new PublishRehearsalError(
      `${chosen.publicName}: \`${command.join(' ')}\` exited ${result.exitCode}\n${result.stdout}${result.stderr}`,
    );
  }

  const entries = readShippedPaths(result.stdout);
  const entryPoints = collectEntryPoints(manifest);
  const shipped = new Set(entries);
  const missing = entryPoints.filter((path) => !shipped.has(path));
  if (missing.length > 0) {
    throw new PublishRehearsalError(
      `${chosen.publicName}@${version}: npm exited 0, but the tarball it would publish is missing ${missing.length} file(s) the manifest points at:\n${missing
        .map((path) => `  ${path}`)
        .join(
          '\n',
        )}\nIt would ship ${entries.length} file(s). A publish of this tarball would succeed and every consumer of it would fail.`,
    );
  }

  return {
    publicName: chosen.publicName,
    version,
    treeVersion,
    command: command.join(' '),
    exitCode: result.exitCode,
    tarball,
    buildExitCode: build.exitCode,
    publintExitCode: report.publint.exitCode,
    typeResolutionExitCode: report.typeResolution.exitCode,
    entries,
    entryPoints,
  };
}

/** The public repository each target is mirrored to, which is what a local rehearsal clones. */
export function defaultRemote(target: MirrorTarget): string {
  return `https://github.com/stevekinney/${target}.git`;
}

export interface RehearsalOptions {
  corvidaeRoot: string;
  target: MirrorTarget;
  /** Path or URL of the target remote; the public mirror by default. */
  remote?: string | undefined;
  /** Where the clone is made. Disposable: nothing is carried between runs. */
  directory: string;
  /** Where the tarball goes, outside the clone. */
  scratchDirectory: string;
  branch?: string | undefined;
  packageName?: string | undefined;
  /** The version to rehearse instead of the one the target carries. */
  version?: string | undefined;
  installArguments?: readonly string[] | undefined;
  toolsRoot?: string | undefined;
  run?: CommandRunner;
  clone?: typeof cloneTarget;
  stage?: typeof stageSurface;
}

export interface RehearsalReport {
  target: MirrorTarget;
  remote: string;
  directory: string;
  /** Every package this target publishes, so the report says what the one proven was chosen from. */
  published: string[];
  probe: PublishProbe;
}

/**
 * Clone the target, run the transform into it, and prove a publish against what came out.
 *
 * This is the acceptance criterion's "from the transformed tree" taken literally: the tree is
 * materialized by the same `stageSurface` a real sync runs, into a clone of the same repository a
 * real sync would push to, so the package the probe builds and packs is the one the mirror would
 * publish rather than a fixture shaped like it. Nothing is pushed, nothing is published, and no
 * GitHub credential is read — a rehearsal that needed one could not be run by anyone.
 */
export async function rehearsePublish(options: RehearsalOptions): Promise<RehearsalReport> {
  const remote = options.remote ?? defaultRemote(options.target);
  const clone = options.clone ?? cloneTarget;
  const stage = options.stage ?? stageSurface;
  const directory = await clone({
    remote,
    directory: options.directory,
    branch: options.branch,
  });
  const outcome = await stage({
    corvidaeRoot: options.corvidaeRoot,
    target: options.target,
    directory,
    installArguments: options.installArguments,
  });
  const probe = await proveNpmPublishDryRun({
    workDirectory: directory,
    outcome,
    scratchDirectory: options.scratchDirectory,
    packageName: options.packageName,
    toolsRoot: options.toolsRoot,
    version: options.version,
    ...(options.run ? { run: options.run } : {}),
  });
  return {
    target: options.target,
    remote,
    directory,
    published: outcome.plan.published.map((entry) => entry.publicName),
    probe,
  };
}

export function describeRehearsal(report: RehearsalReport): string {
  const { probe } = report;
  const rehearsed =
    probe.version === probe.treeVersion
      ? `${probe.publicName}@${probe.version}`
      : `${probe.publicName}@${probe.version} (the transformed tree carries ${probe.treeVersion}; the rehearsal named a version npm has not seen)`;
  return [
    `${report.target}: rehearsed publishing ${rehearsed} from ${report.remote}`,
    `  transformed into ${report.directory}; this target publishes ${report.published.length} package(s)`,
    `  bun run build exited ${probe.buildExitCode}`,
    `  publint --strict exited ${probe.publintExitCode} and attw exited ${probe.typeResolutionExitCode} against ${probe.tarball}`,
    `  \`${probe.command}\` exited ${probe.exitCode}`,
    `  npm would ship ${probe.entries.length} file(s), covering all ${probe.entryPoints.length} entry point(s) the manifest names`,
  ].join('\n');
}

function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function required(argv: readonly string[], name: string): string {
  const value = readOption(argv, name);
  if (!value) throw new PublishRehearsalError(`Missing required option --${name}`);
  return value;
}

export async function runPublishRehearsalCommand(argv: readonly string[]): Promise<number> {
  try {
    const target = required(argv, 'target');
    if (!mirrorTargets.includes(target as MirrorTarget)) {
      throw new PublishRehearsalError(
        `Unknown --target "${target}"; expected ${mirrorTargets.join(' or ')}`,
      );
    }
    const report = await rehearsePublish({
      corvidaeRoot:
        readOption(argv, 'corvidae-root') ?? new URL('../../', import.meta.url).pathname,
      target: target as MirrorTarget,
      remote: readOption(argv, 'remote'),
      directory: required(argv, 'directory'),
      scratchDirectory: required(argv, 'scratch'),
      branch: readOption(argv, 'branch'),
      packageName: readOption(argv, 'package'),
      version: readOption(argv, 'version'),
    });
    process.stdout.write(`${describeRehearsal(report)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await runPublishRehearsalCommand(Bun.argv.slice(2)));
