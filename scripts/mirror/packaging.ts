import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { SurfaceExportsMap } from './package-surface.ts';

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

async function resolveTool(toolsRoot: string, name: string): Promise<string> {
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
 * own declarations, so there is nothing for that lookup to find anyway. No `--profile` and no
 * `--ignore-rules`: a resolution these packages cannot satisfy is a ruling for the owner, not a
 * flag for this module to set.
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
    [await resolveTool(toolsRoot, 'attw'), '--no-definitely-typed', '--format', 'ascii', tarball],
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

/**
 * The specifiers a consumer can import, derived from an emitted `exports` map.
 *
 * A subpath pattern resolves to whatever matches it rather than to one module, so it is not an
 * importable specifier and is skipped; `./package.json` is data, not a module. Everything else is
 * something somebody downstream will write in an import statement.
 */
export function importableSpecifiers(publicName: string, exports: SurfaceExportsMap): string[] {
  return Object.keys(exports)
    .filter((subpath) => !subpath.includes('*') && subpath !== './package.json')
    .map((subpath) => (subpath === '.' ? publicName : `${publicName}/${subpath.slice(2)}`))
    .toSorted();
}

export interface SmokeTestPackage {
  publicName: string;
  tarball: string;
  exports: SurfaceExportsMap;
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
  const dependencies = Object.fromEntries(
    packages.map((entry) => [entry.publicName, `file:${entry.tarball}`]),
  );
  await Bun.write(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'mirror-consumer-smoke-test', version: '0.0.0', private: true, type: 'module', dependencies }, undefined, 2)}\n`,
  );

  const specifiers = packages.flatMap((entry) =>
    importableSpecifiers(entry.publicName, entry.exports),
  );
  if (specifiers.length === 0) {
    throw new PackagingError('The smoke test was given no importable specifier to check');
  }
  await Bun.write(
    join(project, 'smoke.ts'),
    `${specifiers.map((specifier, index) => `import * as module${index} from '${specifier}';`).join('\n')}\n` +
      `const loaded = [${specifiers.map((_, index) => `module${index}`).join(', ')}];\n` +
      `for (const [index, module] of loaded.entries()) {\n` +
      `  if (typeof module !== 'object' || module === null) {\n` +
      `    throw new Error(\`\${${JSON.stringify(specifiers)}[index]} did not resolve to a module\`);\n` +
      `  }\n` +
      `}\n`,
  );

  assertSucceeded(
    await runCommand(['bun', 'install', ...installArguments], { cwd: project }),
    'installing the packed tarballs into the consumer project',
  );
  assertSucceeded(
    await runCommand(['bun', 'run', 'smoke.ts'], { cwd: project }),
    `importing ${specifiers.length} specifier(s) from the packed tarballs`,
  );
  return { directory: project, specifiers };
}
