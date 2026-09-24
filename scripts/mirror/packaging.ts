import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  flattenExportTarget,
  type ExportTarget,
  type SurfaceExportsMap,
} from './package-surface.ts';

/**
 * What a packed tarball is checked with before anything published leaves the mirror.
 *
 * The transform synthesizes `exports` maps — cinder's is regenerated outright, and the four
 * never-published packages carry a proposed convention rather than a port — so the failure mode
 * this guards against is a map that looks right and resolves wrong. `publint` reads the tarball
 * the way npm publishes it and `are-the-types-wrong` resolves every entry point the way each
 * consumer's module resolver would. Both read a `.tgz` directly, so nothing has to be published,
 * installed from a registry, or even unpacked by this module.
 *
 * Every check here is judged by exit code. Their output carries ANSI escapes, so a grep for an
 * error string reports a false green against output that plainly contains errors; the text is
 * captured only to put in a failure message.
 */

export class PackagingError extends Error {}

export interface CommandResult {
  /** The argument vector, joined, for a failure message. */
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd: string;
  /** Replaces the inherited environment entirely when supplied. */
  env?: Record<string, string | undefined> | undefined;
}

/** Run one command to completion, capturing both streams and its exit code. */
export async function runCommand(
  command: readonly string[],
  { cwd, env }: CommandOptions,
): Promise<CommandResult> {
  const spawned = Bun.spawn([...command], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    ...(env ? { env } : {}),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(spawned.stdout).text(),
    new Response(spawned.stderr).text(),
    spawned.exited,
  ]);
  return { command: command.join(' '), exitCode, stdout, stderr };
}

/**
 * How a command is run, so a caller can drive one without spawning a process.
 *
 * Declared next to `runCommand` rather than in whichever module first needed to inject one: the
 * shape belongs to the runner, and three modules now take one.
 */
export type CommandRunner = (
  command: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;

/** `PackagingError` naming the command and both streams, so a failure is diagnosable in one read. */
export function assertSucceeded(result: CommandResult, context: string): void {
  if (result.exitCode === 0) return;
  throw new PackagingError(
    `${context}: \`${result.command}\` exited ${result.exitCode}\n${result.stdout}${result.stderr}`,
  );
}

/**
 * The repository whose `devDependencies` supply `publint` and `attw`.
 *
 * This is the checkout running the sync, which is not the same thing as the corvidae tree being
 * transformed: the checkers belong to the mirror tooling and are pinned by it, so pointing them
 * at whatever source tree a run happens to read would make them unresolvable the moment the two
 * differ. In a real sync they coincide; in a test they do not.
 */
export const defaultToolsRoot = new URL('../../', import.meta.url).pathname;

/** Where `publint` and `attw` live. Resolving them by path keeps the check off `bunx`, which
 * would reach the registry on a cold cache. */
export function toolsDirectory(toolsRoot: string = defaultToolsRoot): string {
  return join(toolsRoot, 'node_modules', '.bin');
}

/**
 * Resolve one packaging tool's binary path, failing loudly rather than falling through to `bunx`.
 *
 * Exported (COR-1286) so `verify-steps.ts` can resolve `publint`'s and `attw`'s paths once, up
 * front, and build a synchronous local {@link VerifyEnvironment} from the result — the shared step
 * list itself stays a pure function with no filesystem access of its own.
 */
export async function resolveTool(toolsRoot: string, name: string): Promise<string> {
  const path = join(toolsDirectory(toolsRoot), name);
  if (await Bun.file(path).exists()) return path;
  throw new PackagingError(
    `${name} is not installed at ${path}; run bun install in ${toolsRoot} before packaging checks`,
  );
}

export interface PackOptions {
  /** The package directory inside the target clone. */
  packageDirectory: string;
  /** Where the tarball is written, kept outside the clone so it cannot show up in git status. */
  destination: string;
  /**
   * When supplied, the pack's own filename is computed with {@link tarballFilename} and asserted
   * against what `bun pm pack` actually printed, rather than trusted from stdout alone. COR-1286
   * needs this: a shared step list that both `verifyTarget` and the rendered `mirror-verify.yaml`
   * workflow read has nowhere to capture a runtime-parsed path in the rendered YAML, so the
   * tarball's location there has to be a name computed ahead of time from `publicName` and
   * `version`, the same way this option computes it. Optional and unused by every caller that
   * predates COR-1286, so packing with only `packageDirectory`/`destination` behaves exactly as it
   * always has.
   */
  publicName?: string;
  version?: string;
}

/**
 * The filename `bun pm pack` writes for one package, computed rather than parsed.
 *
 * Verified against a real `bun pm pack` run (`bun pm pack` v1.4.2): `@lostgradient/weft@1.2.3`
 * packs to `lostgradient-weft-1.2.3.tgz` — the `@` dropped and the scope separator turned into a
 * hyphen, matching npm's own tarball-naming convention. `packWorkspace` still reads `bun pm pack`'s
 * actual stdout and asserts it agrees with this, so a naming-convention change upstream fails loud
 * here rather than silently producing a workflow step that reads a tarball nothing wrote.
 */
export function tarballFilename(publicName: string, version: string): string {
  return `${publicName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

/**
 * Pack one package and return the tarball path.
 *
 * `--ignore-scripts` is deliberate. Two packages declare a `prepack` that runs a gate script
 * (`scripts/run-gates.ts`) which `package-surface.json` does not list among their
 * `requiredInputs`, so packing with scripts enabled fails on a clone that is otherwise complete.
 * Packing is being used here to produce an artifact to inspect, not to rehearse the release, so
 * the gate is out of scope; the missing `requiredInputs` entry is reported rather than papered
 * over.
 */
export async function packWorkspace({
  packageDirectory,
  destination,
  publicName,
  version,
}: PackOptions): Promise<string> {
  await mkdir(destination, { recursive: true });
  const result = await runCommand(
    ['bun', 'pm', 'pack', '--ignore-scripts', '--quiet', '--destination', destination],
    { cwd: packageDirectory },
  );
  assertSucceeded(result, `packing ${packageDirectory}`);
  const tarball = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.tgz'))
    .at(-1);
  if (tarball === undefined) {
    throw new PackagingError(
      `bun pm pack printed no tarball path for ${packageDirectory}:\n${result.stdout}${result.stderr}`,
    );
  }
  if (publicName !== undefined && version !== undefined) {
    const expected = join(destination, tarballFilename(publicName, version));
    if (expected !== tarball) {
      throw new PackagingError(
        `bun pm pack wrote ${tarball} for ${publicName}@${version}, but tarballFilename computed ${expected}. The shared verification step list (COR-1286) depends on this name being predictable from the public name and version alone; a mismatch means \`bun pm pack\`'s naming convention changed underneath it.`,
      );
    }
  }
  return tarball;
}

export interface TarballReport {
  publicName: string;
  tarball: string;
  publint: CommandResult;
  typeResolution: CommandResult;
}

/**
 * Lint one tarball with `publint` and resolve it with `attw`.
 *
 * `--strict` promotes publint's warnings to errors; its suggestions (a missing `engines.node`, a
 * missing `license` field) stay advisory and do not fail, because neither changes how the package
 * resolves. `--no-definitely-typed` stops `attw` looking up a DefinitelyTyped package on the
 * registry, which is what keeps this check offline; every package the mirror publishes ships its
 * own declarations, so there is nothing for that lookup to find anyway.
 *
 * COR-1230 ruled `--ignore-rules cjs-resolves-to-esm no-resolution`, no `--profile`: `attw`'s two
 * remaining default findings are not defects in these packages, and the third is. `cjs-resolves-to-esm`
 * is ignored because these packages are ESM-only by design and declare no `require` condition, so a
 * `require()` resolving to ESM is the intended shape, not a mistake. `no-resolution` is ignored
 * because every finding is `resolutionKind: node10`, a legacy resolution mode these packages choose
 * not to support; `typesVersions` was considered as the fix and rejected as a manifest surface the
 * mirror should not author on a package's behalf. `internal-resolution-error` stays fatal because it
 * is a genuine declaration defect: a `.d.ts` importing a sibling module resolution cannot follow.
 *
 * `--ignore-rules` is variadic (`<rules...>`) and greedily consumes every argument after it,
 * including a positional one; the tarball is passed before any flag so it is never swallowed by
 * that list. Verified against the installed `@arethetypeswrong/cli@0.18.5`'s `--help` output.
 */
export async function checkTarball(
  publicName: string,
  tarball: string,
  toolsRoot: string = defaultToolsRoot,
): Promise<TarballReport> {
  const publint = await runCommand([await resolveTool(toolsRoot, 'publint'), '--strict', tarball], {
    cwd: toolsRoot,
  });
  const typeResolution = await runCommand(
    [
      await resolveTool(toolsRoot, 'attw'),
      tarball,
      '--no-definitely-typed',
      '--format',
      'ascii',
      '--ignore-rules',
      'cjs-resolves-to-esm',
      'no-resolution',
    ],
    { cwd: toolsRoot },
  );
  return { publicName, tarball, publint, typeResolution };
}

/** Every report whose `publint` or `attw` run failed, named together in one message. */
export function assertTarballsPublishable(reports: readonly TarballReport[]): void {
  const lines: string[] = [];
  for (const report of reports) {
    if (report.publint.exitCode !== 0) {
      lines.push(`  ${report.publicName}: publint exited ${report.publint.exitCode}`);
      lines.push(indent(report.publint.stdout || report.publint.stderr));
    }
    if (report.typeResolution.exitCode !== 0) {
      lines.push(`  ${report.publicName}: attw exited ${report.typeResolution.exitCode}`);
      lines.push(indent(report.typeResolution.stdout || report.typeResolution.stderr));
    }
  }
  if (lines.length > 0) {
    throw new PackagingError(`These tarballs are not publishable:\n${lines.join('\n')}`);
  }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

/** One subpath's specifier, and whether its resolved target needs a JSON import attribute. */
export interface ImportableSpecifier {
  specifier: string;
  /** Whether every runtime-reachable leaf of this subpath's export target is a `.json` file. */
  json: boolean;
}

/** Every subpath's `[subpath, target]` pair a consumer could actually import. */
function importableSubpathEntries(exports: SurfaceExportsMap): [string, ExportTarget][] {
  return Object.entries(exports).filter(
    ([subpath]) => !subpath.includes('*') && subpath !== './package.json',
  );
}

function specifierFor(publicName: string, subpath: string): string {
  return subpath === '.' ? publicName : `${publicName}/${subpath.slice(2)}`;
}

const sortBySpecifier = (a: ImportableSpecifier, b: ImportableSpecifier): number =>
  a.specifier < b.specifier ? -1 : a.specifier > b.specifier ? 1 : 0;

/**
 * Whether a `flattenExportTarget` condition path names the `types` condition at any depth —
 * `types`, `types[0]`, or nested under another condition (`import.types`, the shape `soundPackage`
 * in `packaging.test.ts` and every real dual-CJS/ESM entry in `package-surface.json` actually use).
 * A plain `condition !== 'types'` check only catches the unnested case; every dot-joined segment
 * has to be compared with its array-index suffix stripped.
 */
function isTypesCondition(condition: string): boolean {
  return condition.split('.').some((segment) => segment.replace(/\[\d+\]$/, '') === 'types');
}

/**
 * Whether one subpath's export target resolves exclusively to `.json` file(s) — the file Node
 * refuses to load without `with { type: 'json' }` on the importing statement (`ERR_IMPORT_ATTRIBUTE_MISSING`,
 * verified against Node 26 and Bun 1.4.2). Decided from the target's own leaves, via the same
 * {@link flattenExportTarget} `checkTargetCoverage` already reads, rather than from the subpath's
 * spelling — a `*.examples.json` sidecar and a `./manifest` subpath both resolve to a plain-string
 * `.json` target, and cinder's own generator (`jsonSidecarExport`) instead emits a conditional
 * `{ import, default }` object naming the same `.json` file twice.
 *
 * A `types` leaf never votes: it names a `.d.ts` declaration nothing ever imports as a module, so
 * a subpath like `{ types: './x.d.ts', default: './x.json' }` is still JSON-only. A target whose
 * remaining leaves disagree — some `.json`, some not — has no single correct attribute for one
 * import statement, which is a defect in the exports map this surfaces rather than routes around.
 */
function exportsResolveToJson(publicName: string, subpath: string, target: ExportTarget): boolean {
  const leaves = flattenExportTarget(target).filter(([condition]) => !isTypesCondition(condition));
  const jsonLeaves = leaves.filter(([, file]) => file.endsWith('.json'));
  if (jsonLeaves.length === 0) return false;
  if (jsonLeaves.length === leaves.length) return true;
  const named = subpath === '.' ? publicName : `${publicName}${subpath.slice(1)}`;
  throw new PackagingError(
    `${named} resolves to both a .json file and a non-.json file depending on which condition ` +
      `an importer's resolver picks, so one import statement's attribute cannot be correct for ` +
      `both: ${leaves.map(([condition, file]) => `${condition} -> ${file}`).join(', ')}`,
  );
}

/** The consumer smoke script: import every specifier and refuse one that is not a module. */
export function smokeScript(specifiers: readonly ImportableSpecifier[]): string {
  return (
    `${specifiers
      .map((entry, index) =>
        entry.json
          ? `import * as module${index} from '${entry.specifier}' with { type: 'json' };`
          : `import * as module${index} from '${entry.specifier}';`,
      )
      .join('\n')}\n` +
    `const loaded = [${specifiers.map((_, index) => `module${index}`).join(', ')}];\n` +
    `for (const [index, module] of loaded.entries()) {\n` +
    `  if (typeof module !== 'object' || module === null) {\n` +
    `    throw new Error(\`\${${JSON.stringify(specifiers.map((entry) => entry.specifier))}[index]} did not resolve to a module\`);\n` +
    `  }\n` +
    `}\n`
  );
}

/** Every importable specifier of an emitted `exports` map, paired with its JSON-attribute need. */
export function importableSpecifierEntries(
  publicName: string,
  exports: SurfaceExportsMap,
): ImportableSpecifier[] {
  return importableSubpathEntries(exports)
    .map(([subpath, target]) => ({
      specifier: specifierFor(publicName, subpath),
      json: exportsResolveToJson(publicName, subpath, target),
    }))
    .toSorted(sortBySpecifier);
}

/**
 * The specifiers a consumer can import, derived from an emitted `exports` map.
 *
 * A subpath pattern resolves to whatever matches it rather than to one module, so it is not an
 * importable specifier and is skipped; `./package.json` is data, not a module. Everything else is
 * something somebody downstream will write in an import statement.
 */
export function importableSpecifiers(publicName: string, exports: SurfaceExportsMap): string[] {
  return importableSpecifierEntries(publicName, exports).map((entry) => entry.specifier);
}

/**
 * The subset of {@link importableSpecifierEntries} node can resolve: a subpath whose export target
 * is a string, or whose conditions include one node honours (`node`, `import`, `require`,
 * `default`), recursively. A `types` + `bun` entry — weft's `./storage/sqlite/bun` and
 * `./storage/testing` — is bun's alone by design, and importing it under node is
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`, which would be the smoke test refusing a correct export map
 * rather than a broken one.
 */
export function nodeImportableSpecifierEntries(
  publicName: string,
  exports: SurfaceExportsMap,
): ImportableSpecifier[] {
  return importableSubpathEntries(exports)
    .filter(([, target]) => resolvesUnderNode(target))
    .map(([subpath, target]) => ({
      specifier: specifierFor(publicName, subpath),
      json: exportsResolveToJson(publicName, subpath, target),
    }))
    .toSorted(sortBySpecifier);
}

const nodeConditions = ['node', 'import', 'require', 'default'] as const;

function resolvesUnderNode(target: ExportTarget | undefined): boolean {
  if (target === undefined || target === null) return false;
  if (typeof target === 'string') return true;
  if (Array.isArray(target)) return target.some((entry) => resolvesUnderNode(entry));
  return nodeConditions.some((condition) => resolvesUnderNode(target[condition]));
}

export interface SmokeTestPackage {
  publicName: string;
  tarball: string;
  exports: SurfaceExportsMap;
  /** Published packages of the same target this one depends on, by public name. */
  dependsOn?: readonly string[] | undefined;
}

/**
 * The consumer smoke-test project's `package.json`: the one writer both the sync's step list and
 * `runConsumerSmokeTest` use, so the two cannot drift.
 *
 * Every published package is a `file:` dependency on its tarball. That alone is not enough for a
 * first publish (COR-1292): a packed tarball rewrites its `workspace:*` edge to a registry range,
 * and for a sibling published in this same run the registry has no such version yet, so the
 * install fetched it from npm and got a 404. Each package another one depends on is therefore
 * also overridden to its own tarball. The `overrides` key is written only when such an edge
 * exists, so a single-package target like weft renders exactly what it always did.
 */
export function consumerManifest(packages: readonly SmokeTestPackage[]): string {
  const tarballs = new Map(packages.map((entry) => [entry.publicName, `file:${entry.tarball}`]));
  const dependencies = Object.fromEntries(tarballs);
  const siblings = new Set(
    packages.flatMap((entry) => (entry.dependsOn ?? []).filter((name) => tarballs.has(name))),
  );
  const overrides = Object.fromEntries(
    [...siblings].toSorted().map((name) => [name, tarballs.get(name) ?? '']),
  );
  const manifest = {
    name: 'mirror-consumer-smoke-test',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies,
    ...(siblings.size > 0 ? { overrides } : {}),
  };
  return `${JSON.stringify(manifest, undefined, 2)}\n`;
}

export interface SmokeTestOptions {
  /** A scratch directory; the consumer project is created inside it. */
  directory: string;
  packages: readonly SmokeTestPackage[];
  /** Extra `bun install` arguments, for example `--offline` to prove no registry was reached. */
  installArguments?: readonly string[];
}

export interface SmokeTestResult {
  directory: string;
  specifiers: string[];
}

/**
 * Install the packed tarballs into a scratch project and import every specifier they publish.
 *
 * This is the check that a synthesized `exports` map survives contact with a real installer and a
 * real resolver. `publint` and `attw` read the tarball statically; this one installs it from a
 * `file:` specifier — the same code path a registry install takes once the tarball is unpacked —
 * and then imports every subpath rather than just the root, because a map with 30 correct entries
 * and one wrong one looks identical at the root.
 */
export async function runConsumerSmokeTest({
  directory,
  packages,
  installArguments = [],
}: SmokeTestOptions): Promise<SmokeTestResult> {
  const project = join(directory, 'consumer');
  await mkdir(project, { recursive: true });
  await Bun.write(join(project, 'package.json'), consumerManifest(packages));

  const specifierEntries = packages.flatMap((entry) =>
    importableSpecifierEntries(entry.publicName, entry.exports),
  );
  if (specifierEntries.length === 0) {
    throw new PackagingError('The smoke test was given no importable specifier to check');
  }
  const nodeSpecifierEntries = packages.flatMap((entry) =>
    nodeImportableSpecifierEntries(entry.publicName, entry.exports),
  );
  const specifiers = specifierEntries.map((entry) => entry.specifier);
  await Bun.write(join(project, 'smoke.mjs'), smokeScript(specifierEntries));
  await Bun.write(join(project, 'smoke-node.mjs'), smokeScript(nodeSpecifierEntries));

  assertSucceeded(
    await runCommand(['bun', 'install', ...installArguments], { cwd: project }),
    'installing the packed tarballs into the consumer project',
  );
  assertSucceeded(
    await runCommand(['bun', 'run', 'smoke.mjs'], { cwd: project }),
    `importing ${specifierEntries.length} specifier(s) from the packed tarballs`,
  );
  assertSucceeded(
    await runCommand(['node', 'smoke-node.mjs'], { cwd: project }),
    `importing ${nodeSpecifierEntries.length} specifier(s) from the packed tarballs under node`,
  );
  return { directory: project, specifiers };
}
