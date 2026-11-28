// Cinder's generated files (token artifacts and `.metadata/`) are not in version control, and
// `components/cinder/src/index.ts` imports them. Turborepo orders every task after Cinder's
// `metadata` task (`scripts/cinder-generated-consumers.test.ts` enforces it), but a path that
// bypasses Turbo (a Playwright web server, a design-review capture, a `bun test` run inside a
// Cinder folder) has to make sure the files exist itself. They call `ensureCinderGenerated()`.
//
// It does nothing while every output exists and none is older than an input, and otherwise runs
// Cinder's own `metadata` script (the token seed, the token generator and the component
// artifacts) once, under a lock, so parallel test workers do not each regenerate.
//
// Cinder owns this file: it lives beside the generators it watches. The repository-wide pieces it
// uses (the process lease, the process group and the environment) stay at the repository root.
// The workspace is found by its package name, `@lostgradient/cinder`, never by its directory.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  acquireOwnedProcessLease,
  OwnedProcessGroupUnverifiedError,
  runOwnedProcessGroup,
} from '../../../packages/process-lease/src/index.ts';
import { rootScriptEnvironment } from '../../../scripts/environment-configuration.ts';

/** A workspace sits two directories below the repository root, and this file sits in its `scripts`. */
const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../..');

/** The name that identifies the Cinder workspace, whatever directory it lives in. */
export const CINDER_PACKAGE_NAME = '@lostgradient/cinder';

/** A manifest as an object, or `undefined` when the file is missing, unreadable or not an object. */
function readManifest(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    // A directory without a readable manifest is not a workspace.
    return undefined;
  }
}

/**
 * The directory of the workspace named `@lostgradient/cinder` below `root`: the workspaces are the
 * ones the root `package.json` lists, and the one with Cinder's package name is Cinder.
 */
export function findCinderDirectory(root: string): string {
  const listed = readManifest(join(root, 'package.json'))?.['workspaces'];
  const patterns = Array.isArray(listed)
    ? listed.filter((pattern): pattern is string => typeof pattern === 'string')
    : [];
  for (const pattern of patterns) {
    for (const manifest of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })) {
      const name = readManifest(join(root, manifest))?.['name'];
      if (name === CINDER_PACKAGE_NAME) return dirname(join(root, manifest));
    }
  }
  throw new Error(
    `No workspace named ${CINDER_PACKAGE_NAME} is listed in the workspaces of ${join(root, 'package.json')}.`,
  );
}

/** The generated outputs, relative to the Cinder package. The generator's own `--list` covers the same. */
export const CINDER_GENERATED_OUTPUTS = [
  'src/styles/tokens-base.css',
  'src/styles/token-utilities.css',
  'src/tokens/index.json',
  'src/tokens/registry.generated.json',
  'src/tokens/registry.generated.ts',
  'src/tokens/resolved/light.json',
  'src/tokens/resolved/dark.json',
  'src/tokens/resolved/light-reduced-motion.json',
  'src/tokens/resolved/dark-reduced-motion.json',
  'src/tokens/runtime/authoring-catalogue.generated.ts',
  'src/tokens/runtime/base-corpus.generated.ts',
  'src/tokens/runtime/package-version.generated.ts',
  'src/tokens/runtime/format-validator.generated.js',
  'src/tokens/runtime/format-validator.generated.d.ts',
  'src/tokens/runtime/resolver-validator.generated.js',
  'src/tokens/runtime/resolver-validator.generated.d.ts',
  '.metadata/components.json',
];

const SKIPPED = new Set(['node_modules', '.metadata', '.types', '.turbo', 'coverage']);

export interface EnsureOptions {
  /** The repository root; tests point it at a fixture. */
  root?: string;
  /** Runs the generator; tests replace it. Returns the exit code. */
  generate?: (cinder: string) => number | Promise<number>;
  /** Send the generator's output to standard error when standard output is an artifact. */
  stdout?: 'inherit' | number;
  /** Test seam before a child identity is recorded. */
  beforeRegistration?: (pid: number) => void | Promise<void>;
  /** Test seam after staging the owner and before publishing its lease. */
  beforeLeasePublication?: () => void | Promise<void>;
}

function newestInput(directory: string, outputs: ReadonlySet<string>): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestInput(path, outputs));
    else if (entry.isFile() && !outputs.has(path) && !/\.test\.[cm]?[jt]s$/.test(entry.name)) {
      // A fixture can disappear between listing and reading its modification time.
      const input = statSync(path, { throwIfNoEntry: false });
      if (input !== undefined) newest = Math.max(newest, input.mtimeMs);
    }
  }
  return newest;
}

/** Why the generated files need regenerating, or `undefined` when they are present and fresh. */
export function cinderGeneratedStaleness(cinder: string): string | undefined {
  const root = resolve(cinder, '..', '..');
  const tooling = join(root, 'packages/component-tooling');
  const outputs = CINDER_GENERATED_OUTPUTS.map((path) => join(cinder, path));
  const missing = outputs.find((path) => !existsSync(path));
  if (missing !== undefined) return `${relative(cinder, missing)} is missing`;
  const oldest = Math.min(...outputs.map((path) => statSync(path).mtimeMs));
  const absolute = new Set(outputs);
  const input = Math.max(
    newestInput(join(cinder, 'src'), absolute),
    newestInput(join(cinder, 'scripts'), absolute),
    newestInput(join(tooling, 'scripts'), absolute),
    newestInput(join(tooling, 'src'), absolute),
    ...[
      join(cinder, 'package.json'),
      join(tooling, 'package.json'),
      join(root, 'package.json'),
      join(root, 'bun.lock'),
    ].map((path) => statSync(path).mtimeMs),
  );
  return input > oldest ? 'an input is newer than the oldest output' : undefined;
}

/** Generate Cinder's ignored files when one is missing or stale. Returns whether it generated. */
export async function ensureCinderGenerated(options: EnsureOptions = {}): Promise<boolean> {
  const { generate, stdout, beforeRegistration, beforeLeasePublication } = options;
  const root = options.root ?? REPOSITORY_ROOT;
  const environment = { ...rootScriptEnvironment() };
  const cinder = findCinderDirectory(root);
  if (cinderGeneratedStaleness(cinder) === undefined) return false;
  const lease = await acquireOwnedProcessLease(
    join(cinder, '.generate-lock'),
    root,
    'Cinder metadata',
    beforeLeasePublication,
  );
  let safeToRelease = true;
  try {
    // Another process may have generated while this one waited for the lock.
    const reason = cinderGeneratedStaleness(cinder);
    if (reason === undefined) return false;
    const code =
      generate === undefined
        ? await runOwnedProcessGroup({
            command: [process.execPath, 'run', 'metadata'],
            cwd: cinder,
            environment,
            token: lease.token,
            stdout: stdout ?? 'inherit',
            register: async (pid) => {
              await beforeRegistration?.(pid);
              await lease.recordProcessGroup(pid);
            },
          })
        : await generate(cinder);
    if (code !== 0)
      throw new Error(`Cinder's metadata task failed (${reason}); run it and read its output.`);
    return true;
  } catch (error) {
    if (error instanceof OwnedProcessGroupUnverifiedError) safeToRelease = false;
    throw error;
  } finally {
    if (safeToRelease) await lease.release();
  }
}
