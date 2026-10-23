/**
 * The development host's browser build, run in a child process.
 *
 * `bun --watch` restarts the host when its own modules change, and in that mode `Bun.build` run
 * inside the watched process resolves a dependency the host has already loaded (`@msgpack/msgpack`,
 * through Weft) to the runtime's CommonJS form, whose `.cjs` siblings the package does not ship, so
 * the bundle fails (COR-1642). The same build succeeds in a fresh process, so the host builds
 * through `scripts/build.ts` as a command instead of calling the bundler itself.
 *
 * @module browser-build
 */

import { join } from 'node:path';

/** The `@lostgradient/interborough` package root. */
const PACKAGE_DIRECTORY = join(import.meta.dir, '..', '..');

const BUILD_SCRIPT = join(PACKAGE_DIRECTORY, 'scripts', 'build.ts');

/** Where the build goes and in which mode; the defaults are the host's own `build/` and development. */
export type BrowserBuildOptions = {
  readonly outdir?: string;
  readonly development?: boolean;
};

/**
 * Build the browser application in a fresh Bun process and settle when it exits. The child's
 * bundler errors go to this process's standard error; a nonzero exit rejects.
 */
export async function buildBrowserApplication(options: BrowserBuildOptions = {}): Promise<void> {
  const argv = [process.execPath, BUILD_SCRIPT];
  if (options.development ?? true) argv.push('--development');
  if (options.outdir !== undefined) argv.push('--outdir', options.outdir);
  const child = Bun.spawn(argv, {
    cwd: PACKAGE_DIRECTORY,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`The browser build exited with code ${code}.`);
}
