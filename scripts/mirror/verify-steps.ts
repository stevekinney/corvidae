import { join } from 'node:path';

import {
  consumerManifest,
  importableSpecifierEntries,
  importableSpecifiers,
  nodeImportableSpecifierEntries,
  resolveTool,
  smokeScript,
  tarballFilename,
  type SmokeTestPackage,
} from './packaging.ts';
import type { PrivateWorkspace, PublishedPackage } from './surface.ts';

/**
 * The one ordered list of commands `verifyTarget` runs against a staged clone, shared with the
 * `mirror-verify.yaml` workflow COR-1286 has the transform emit into the target.
 *
 * Before this module, `verifyTarget` (`sync.ts`) was the only reader of "what verification a mirror
 * sync runs" and it read that list by *being* it — a hand-written sequence of `runCommand` calls.
 * COR-1286 needs a second reader: a rendered GitHub Actions workflow that runs the identical jobs
 * as the target's own pull-request gate. Two readers of one fact is a module, not a second
 * hand-written copy — `sync.ts` is refactored to build its command list by calling
 * {@link buildVerifySteps} exactly as `mirror-verify-workflow.ts` does, so the two can never drift
 * out of step with each other the way a hand-copied list eventually would.
 *
 * What the two callers cannot share is the *environment* a step resolves against: `verifyTarget`
 * runs in-process against a local clone, with `publint`/`attw` resolved to absolute paths under a
 * checkout's `node_modules/.bin` and a scratch directory that is an absolute local path; the
 * rendered workflow runs as shell in the target's own CI, with a fetched `bunx` invocation for
 * tools the target does not carry as a devDependency and a scratch directory that is a GitHub
 * Actions runner-temp expression. Those differences are real and irreducible — `packaging.ts`
 * deliberately keeps the mirror's own verification off `bunx` to stay offline, which is not
 * something the rendered workflow (which always has network access, being GitHub-hosted CI) needs
 * or should copy. `buildVerifySteps` is pure and environment-parametrized by {@link VerifyEnvironment}
 * so that irreducible difference lives in exactly one place — the environment passed in — and
 * everything else about the step list (order, descriptions, working directories, flags) is
 * identical by construction rather than by two authors happening to agree.
 */

/**
 * What role a step plays, so `verifyTarget` can assemble its `TarballReport`/`SmokeTestResult`
 * shapes by matching on a discriminant instead of parsing `description` strings, and so a test can
 * assert step order and grouping without string-sniffing either.
 */
export type VerifyStepKind =
  | 'install'
  | 'build'
  | 'typecheck-published'
  | 'pack'
  | 'pack-relocate'
  | 'publint'
  | 'attw'
  | 'typecheck-private'
  | 'write-consumer-project'
  | 'consumer-install'
  | 'consumer-run'
  | 'consumer-run-node'
  | 'prepack';

/** One command `verifyTarget` runs, or the rendered workflow's job runs as a step. */
export interface VerifyStep {
  readonly kind: VerifyStepKind;
  /** Human-readable name; becomes a GitHub Actions step's `name:`. */
  readonly description: string;
  /** This step's working directory, already resolved by the environment that built the step. */
  readonly cwd: string;
  /** The argument vector. Empty when the step only writes `files` and runs nothing. */
  readonly command: readonly string[];
  /**
   * Files this step writes before running `command`, keyed by a path relative to `cwd`. Only the
   * `write-consumer-project` step uses this — everything else in the list is a command with
   * nothing to write first.
   */
  readonly files?: Readonly<Record<string, string>> | undefined;
  /** The published package this step is scoped to, for `build`/`typecheck-published`/`pack`/`publint`/`attw`. */
  readonly publicName?: string | undefined;
  /** The tarball `publint`/`attw` read, computed ahead of time rather than parsed from `pack`'s output. */
  readonly tarball?: string | undefined;
}

export interface VerifyStepsInputs {
  /** The verification install, e.g. `['bun', 'install', '--frozen-lockfile', ...installArguments]`. */
  readonly installCommand: readonly string[];
  readonly published: readonly PublishedPackage[];
  readonly privateWorkspaces: readonly PrivateWorkspace[];
  /** Extra `bun install` arguments for the consumer smoke test project; defaults to none. */
  readonly installArguments?: readonly string[] | undefined;
}

/** One packaging tool's resolved invocation prefix, before its own fixed flags are appended. */
export type PackagingTool = 'publint' | 'attw';

export interface VerifyEnvironment {
  /** Turns a target-relative package or workspace directory into this environment's real cwd. */
  resolveDirectory(targetRelativeDirectory: string): string;
  /**
   * Where the environment packs tarballs and builds the consumer smoke-test project. Already
   * resolved: an absolute local path for `verifyTarget`, a GitHub Actions runner-temp expression
   * for the rendered workflow.
   */
  readonly scratchDirectory: string;
  /** The argv prefix that invokes one packaging tool in this environment. */
  toolCommand(tool: PackagingTool): readonly string[];
}

/** `publint`'s fixed flags, identical in every environment. */
function publintCommand(env: VerifyEnvironment, tarball: string): readonly string[] {
  return [...env.toolCommand('publint'), '--strict', tarball];
}

/** `attw`'s fixed flags, identical in every environment — see `packaging.ts`'s `checkTarball` for why. */
function attwCommand(env: VerifyEnvironment, tarball: string): readonly string[] {
  return [
    ...env.toolCommand('attw'),
    tarball,
    '--no-definitely-typed',
    '--format',
    'ascii',
    '--ignore-rules',
    'cjs-resolves-to-esm',
    'no-resolution',
  ];
}

/**
 * Raised when the published packages cannot be put in an order that builds every dependency before
 * its consumers — today, only because their intra-target edges form a cycle.
 *
 * This is a hard failure, and deliberately one that reaches further than verification. `planSurface`
 * renders `mirror-verify.yaml` from the same `published` list whenever it has a `targetDirectory` to
 * read the release workflow from — which every `stageSurface` does — so a cycle refuses the *plan*
 * there, not just the run: a target whose packages depend on each other circularly has no build
 * order at all,
 * and a plan that emitted a workflow claiming otherwise would be a workflow that cannot pass. The
 * alternative — ordering what can be ordered and leaving the rest in discovery order — is the
 * defect COR-1289 fixes, reintroduced quietly for the one case where it is guaranteed to bite.
 */
export class VerifyStepOrderError extends Error {}

/**
 * The published packages, reordered so every package follows the packages it depends on.
 *
 * Kahn's algorithm, taking every package whose dependencies are already satisfied in each round and
 * keeping them in the caller's discovery order within the round. Stability matters: discovery order
 * is what the step list used before COR-1289 and what every target with no intra-target edges still
 * gets, so a target that never had the defect sees no change at all.
 */
function orderByDependencies(published: readonly PublishedPackage[]): readonly PublishedPackage[] {
  const byPublicName = new Map(published.map((entry) => [entry.publicName, entry]));
  for (const entry of published) {
    for (const dependency of entry.dependsOn) {
      if (byPublicName.has(dependency)) continue;
      // `surface.ts` narrows `dependsOn` to the published set before it ever reaches here, so a
      // stranger means the two halves disagree about what this target publishes — a defect to
      // surface, not one to route around by ignoring the edge and ordering as if it were absent.
      throw new VerifyStepOrderError(
        `${entry.publicName} depends on ${dependency}, which this target does not publish; dependsOn is expected to name only published packages of the same target`,
      );
    }
  }

  const ordered: PublishedPackage[] = [];
  const built = new Set<string>();
  let remaining = [...published];
  while (remaining.length > 0) {
    const ready = remaining.filter((entry) =>
      entry.dependsOn.every((dependency) => built.has(dependency)),
    );
    if (ready.length === 0) {
      const edges = remaining.flatMap((entry) =>
        entry.dependsOn.map((dependency) => `  ${entry.publicName} -> ${dependency}`),
      );
      throw new VerifyStepOrderError(
        `These published packages depend on each other in a cycle, so no build order satisfies them: ${remaining
          .map((entry) => entry.publicName)
          .join(', ')}\n${edges.join('\n')}`,
      );
    }
    ordered.push(...ready);
    for (const entry of ready) built.add(entry.publicName);
    remaining = remaining.filter((entry) => !ready.includes(entry));
  }
  return ordered;
}

/**
 * The ordered verification steps for one target: install, then every published package's build,
 * then every one's typecheck, then per package pack and packaging checks, then per checkable
 * private workspace typecheck, then the consumer smoke test. Mirrors `verifyTarget`'s own comment
 * on why the order is what it is: the root install first because everything after it depends on a
 * satisfied `node_modules`, then one package at a time rather than a root fan-out, because this
 * list verifies exactly what the plan emits and nothing the target's own root scripts might
 * additionally include.
 *
 * COR-1289 split the per-package loop into phases and reordered the packages within them. A
 * package's `typecheck` resolves an edge to a sibling in the same target through that sibling's
 * `exports`, which name `dist/`; interleaving build and typecheck per package therefore type-checks
 * the first package against siblings that have not been built yet. Building everything first is
 * what closes that, and `orderByDependencies` is what makes "everything" reachable — a dependency
 * later in discovery order than its consumer has to build earlier than it.
 */
export function buildVerifySteps(
  inputs: VerifyStepsInputs,
  env: VerifyEnvironment,
): readonly VerifyStep[] {
  const steps: VerifyStep[] = [
    {
      kind: 'install',
      description: 'install dependencies',
      cwd: env.resolveDirectory('.'),
      command: [...inputs.installCommand],
    },
  ];

  const tarballsDirectory = join(env.scratchDirectory, 'tarballs');
  /**
   * Whether this package's tarball is produced by its own `scripts/pack-for-publish.ts` rather
   * than a plain `bun pm pack`. Mirrors `package-surface.json`'s `build.packedBy` (see
   * `surface.ts`'s {@link isExpectedPackRewrite}): `@lostgradient/cinder`, `chat`, `editor` and
   * `markdown` keep `./src/**` targets in non-`bun` `exports` conditions in their committed
   * manifests, which only `pack-for-publish.ts` rewrites to `dist` equivalents before packing.
   * Packing those four with a bare `bun pm pack` — what this function did before COR-1196 —
   * ships the untransformed manifest, so `publint`/`attw` read a tarball whose `exports` point at
   * source the tarball never contains and every affected subpath 404s. `entry.entry.build` is
   * `undefined` in synthetic fixtures that stub `entry` (see `verify-steps.test.ts`), so this
   * reads optionally rather than asserting the field is always populated.
   */
  const packedByPackScript = (entry: PublishedPackage): boolean =>
    entry.entry.build?.packedBy === 'pack-script';
  /**
   * Every published package's tarball ends up under the shared scratch `tarballsDirectory`,
   * whichever way it was packed — `publint`/`attw` (below) and the consumer smoke-test project
   * (`consumerManifest`) all read from here, and `LocalVerifyEnvironmentOptions` keeps it outside
   * the clone deliberately, so git never sees it. `pack-for-publish.ts` cannot be pointed at it
   * directly: every one of the four repositories' own copies hardcodes `bun pm pack`'s
   * `--destination` as the package root (see `packForPublish`/`runPackCommand`), because that is
   * also where the *real* release pipeline (`publish-release.ts`) expects to find it. A
   * `pack-script` package's pack step therefore writes into its own package directory first, same
   * as release does, and a `pack-relocate` step immediately after moves it here — see the pack
   * loop below. The filename convention is identical either way: `tarballFilename` matches every
   * `pack-for-publish.ts`'s own `getPackFileName`/`tarballFileName` helper byte for byte.
   */
  const tarballFor = (entry: PublishedPackage): string =>
    join(tarballsDirectory, tarballFilename(entry.publicName, entry.version));
  const ordered = orderByDependencies(inputs.published);

  for (const entry of ordered) {
    steps.push({
      kind: 'build',
      description: `build ${entry.publicName}`,
      cwd: env.resolveDirectory(entry.directory),
      command: ['bun', 'run', 'build'],
      publicName: entry.publicName,
    });
  }

  for (const entry of ordered) {
    steps.push({
      kind: 'typecheck-published',
      description: `typecheck ${entry.publicName}`,
      cwd: env.resolveDirectory(entry.directory),
      command: ['bun', 'run', 'typecheck'],
      publicName: entry.publicName,
    });
    // COR-1192: the release workflow runs `bun run prepack` right before `npm publish`, and the first
    // tagged release failed there — twice — on gates nothing before the tag had run. Whatever the
    // published package's recorded `prepack` is, it runs here too, so a tag cannot be the first
    // place it executes. Only for a package whose surface records the script; the surface is the
    // ruling about the published scripts and is what the sync writes onto the manifest.
    if (typeof entry.entry.build?.scripts?.['prepack'] === 'string') {
      steps.push({
        kind: 'prepack',
        description: `prepack ${entry.publicName}`,
        cwd: env.resolveDirectory(entry.directory),
        command: ['bun', 'run', 'prepack'],
        publicName: entry.publicName,
      });
    }
  }

  for (const entry of ordered) {
    const cwd = env.resolveDirectory(entry.directory);
    const packScript = packedByPackScript(entry);
    steps.push({
      kind: 'pack',
      description: `pack ${entry.publicName}`,
      cwd,
      // `--ignore-scripts` on the plain-`bun pm pack` branch is deliberate — see `packaging.ts`'s
      // `packWorkspace` — and does not apply to `pack-for-publish.ts`: that script IS the packing
      // step, invoked directly rather than through a lifecycle hook `bun pm pack` would run.
      command: packScript
        ? ['bun', 'run', 'scripts/pack-for-publish.ts']
        : ['bun', 'pm', 'pack', '--ignore-scripts', '--quiet', '--destination', tarballsDirectory],
      publicName: entry.publicName,
    });
    if (packScript) {
      // `pack-for-publish.ts` always writes into its own package directory (see `tarballFor`'s
      // comment above), so its output has to be moved into the shared `tarballsDirectory` before
      // `publint`/`attw`/the consumer project — which all read `tarballFor(entry)` — can find it.
      // Two argv-only steps rather than one `mkdir -p ... && mv ...`: `VerifyStep.command` is
      // real argv locally (`Bun.spawn`, no shell) but a flat, naively-joined `run:` line in the
      // rendered workflow (`mirror-verify-workflow.ts`'s `renderStep`) — a shell operator embedded
      // in one argv element would run fine locally and render as a broken, unquoted command in the
      // workflow. `mkdir -p` is idempotent, so repeating it once per pack-script package costs
      // nothing.
      const packedTarballName = tarballFilename(entry.publicName, entry.version);
      steps.push({
        kind: 'pack-relocate',
        description: `prepare the shared tarballs directory for ${entry.publicName}`,
        cwd,
        command: ['mkdir', '-p', tarballsDirectory],
        publicName: entry.publicName,
      });
      steps.push({
        kind: 'pack-relocate',
        description: `move ${entry.publicName}'s packed tarball into the shared tarballs directory`,
        cwd,
        command: ['mv', packedTarballName, join(tarballsDirectory, packedTarballName)],
        publicName: entry.publicName,
      });
    }
    const tarball = tarballFor(entry);
    steps.push({
      kind: 'publint',
      description: `publint ${entry.publicName}`,
      cwd: env.resolveDirectory('.'),
      command: publintCommand(env, tarball),
      publicName: entry.publicName,
      tarball,
    });
    steps.push({
      kind: 'attw',
      description: `check ${entry.publicName}'s published types with attw`,
      cwd: env.resolveDirectory('.'),
      command: attwCommand(env, tarball),
      publicName: entry.publicName,
      tarball,
    });
  }

  // Discovery order, not the build order above. Nothing about importing a packed tarball depends on
  // the order the tarballs were produced in — every pack has already run by the time the consumer
  // project is written — and `sync.ts` reports the smoke test's specifiers with `specifiersFor`,
  // which reads `published` as the caller passed it. Deriving this list from `ordered` instead would
  // make the reported specifiers disagree with the ones the script actually imports.
  const smokeTestPackages: SmokeTestPackage[] = inputs.published.map((entry) => ({
    publicName: entry.publicName,
    tarball: tarballFor(entry),
    exports: entry.exports,
    dependsOn: entry.dependsOn,
  }));

  for (const entry of inputs.privateWorkspaces) {
    if (!entry.emitsTypeScript) continue;
    steps.push({
      kind: 'typecheck-private',
      description: `typecheck ${entry.publicName}`,
      cwd: env.resolveDirectory(entry.directory),
      command: ['bun', 'run', 'typecheck'],
      publicName: entry.publicName,
    });
  }

  const consumerDirectory = join(env.scratchDirectory, 'consumer');
  const specifierEntries = smokeTestPackages.flatMap((entry) =>
    importableSpecifierEntries(entry.publicName, entry.exports),
  );
  const nodeSpecifierEntries = smokeTestPackages.flatMap((entry) =>
    nodeImportableSpecifierEntries(entry.publicName, entry.exports),
  );
  steps.push({
    kind: 'write-consumer-project',
    description: 'write the consumer smoke-test project',
    cwd: consumerDirectory,
    command: [],
    files: {
      'package.json': consumerManifest(smokeTestPackages),
      'smoke.mjs': smokeScript(specifierEntries),
      'smoke-node.mjs': smokeScript(nodeSpecifierEntries),
    },
  });
  steps.push({
    kind: 'consumer-install',
    description: 'install the packed tarballs into the consumer project',
    cwd: consumerDirectory,
    command: ['bun', 'install', ...(inputs.installArguments ?? [])],
  });
  steps.push({
    kind: 'consumer-run',
    description: `import ${specifierEntries.length} specifier(s) from the packed tarballs`,
    cwd: consumerDirectory,
    command: ['bun', 'run', 'smoke.mjs'],
  });
  // Under node as well (COR-1192): the packed 0.26.0 tarball imported under bun and failed under
  // node, because Bun's bundler rewrites an inlined CommonJS dependency's `require` to
  // `import.meta.require`, which only bun defines. The script is plain JavaScript so both
  // runtimes execute the same script shape; node's list omits the subpaths whose export map is
  // bun's alone (`types` + `bun`), which node correctly refuses. A resolution node cannot make
  // for a subpath it should is a red step.
  steps.push({
    kind: 'consumer-run-node',
    description: `import ${nodeSpecifierEntries.length} specifier(s) from the packed tarballs under node`,
    cwd: consumerDirectory,
    command: ['node', 'smoke-node.mjs'],
  });

  return steps;
}

/** Every specifier the consumer smoke test imports, in the order `buildVerifySteps` wrote them. */
export function specifiersFor(published: readonly PublishedPackage[]): string[] {
  return published.flatMap((entry) => importableSpecifiers(entry.publicName, entry.exports));
}

export interface LocalVerifyEnvironmentOptions {
  /** The staged clone `verifyTarget` runs against. */
  directory: string;
  /** The checkout whose `devDependencies` supply `publint` and `attw`. */
  toolsRoot: string;
  /** Where tarballs and the consumer project go, outside the clone so git never sees them. */
  scratchDirectory: string;
}

/**
 * The environment `verifyTarget` builds its step list against: directories resolved onto the real
 * clone, tools resolved to the checkout's own `node_modules/.bin` exactly as `checkTarball` always
 * resolved them, kept off `bunx` for the offline reason `packaging.ts` documents on
 * `toolsDirectory`. Async only because tool resolution is — `resolveTool` checks the binary exists
 * — so this runs once, up front, and hands `buildVerifySteps` a plain synchronous environment.
 */
export async function createLocalVerifyEnvironment({
  directory,
  toolsRoot,
  scratchDirectory,
}: LocalVerifyEnvironmentOptions): Promise<VerifyEnvironment> {
  const tools: Record<PackagingTool, string> = {
    publint: await resolveTool(toolsRoot, 'publint'),
    attw: await resolveTool(toolsRoot, 'attw'),
  };
  return {
    resolveDirectory: (targetRelativeDirectory) => join(directory, targetRelativeDirectory),
    scratchDirectory,
    toolCommand: (tool) => [tools[tool]],
  };
}
