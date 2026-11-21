// Cinder's generated files (token artifacts and `.metadata/`) are not in version control, and
// `components/cinder/src/index.ts` imports them. Turborepo orders every task after Cinder's
// `metadata` task (`scripts/cinder-generated-consumers.test.ts` enforces it), but a path that
// bypasses Turbo (a Playwright web server, a design-review capture, a `bun test` run inside a
// Cinder folder) has to make sure the files exist itself. They call `ensureCinderGenerated()`.
//
// It does nothing while every output exists and none is older than an input, and otherwise runs
// Cinder's own `metadata` script (the token seed, the token generator and the component
// artifacts) once, under a lock, so parallel test workers do not each regenerate.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');

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
  generate?: (cinder: string) => number;
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
  const outputs = CINDER_GENERATED_OUTPUTS.map((path) => join(cinder, path));
  const missing = outputs.find((path) => !existsSync(path));
  if (missing !== undefined) return `${relative(cinder, missing)} is missing`;
  const oldest = Math.min(...outputs.map((path) => statSync(path).mtimeMs));
  const absolute = new Set(outputs);
  const input = Math.max(
    newestInput(join(cinder, 'src'), absolute),
    newestInput(join(cinder, 'scripts'), absolute),
  );
  return input > oldest ? 'an input is newer than the oldest output' : undefined;
}

function defaultGenerate(cinder: string): number {
  const result = Bun.spawnSync(['bun', 'run', 'metadata'], {
    cwd: cinder,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return result.exitCode;
}

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Run `action` holding an exclusive directory lock; a lock whose holder died is taken over. */
function locked<T>(lock: string, action: () => T): T {
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), String(process.pid));
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      const holder = readPid(lock);
      if (holder > 0 && !alive(holder)) rmSync(lock, { recursive: true, force: true });
      else pause(100);
    }
  }
  try {
    return action();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function readPid(lock: string): number {
  try {
    return Number(readFileSync(join(lock, 'pid'), 'utf8'));
  } catch {
    return 0;
  }
}

/** Generate Cinder's ignored files when one is missing or stale. Returns whether it generated. */
export function ensureCinderGenerated(options: EnsureOptions = {}): boolean {
  const cinder = join(options.root ?? REPOSITORY_ROOT, 'components/cinder');
  if (cinderGeneratedStaleness(cinder) === undefined) return false;
  return locked(join(cinder, '.generate-lock'), () => {
    // Another process may have generated while this one waited for the lock.
    const reason = cinderGeneratedStaleness(cinder);
    if (reason === undefined) return false;
    const code = (options.generate ?? defaultGenerate)(cinder);
    if (code !== 0)
      throw new Error(`Cinder's metadata task failed (${reason}); run it and read its output.`);
    return true;
  });
}
