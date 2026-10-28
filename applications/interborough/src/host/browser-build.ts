/**
 * The development host's browser build, run in a child process.
 *
 * `bun --watch` restarts the host when its own modules change, and in that mode `Bun.build` run
 * inside the watched process resolves a dependency the host has already loaded (`@msgpack/msgpack`,
 * through Weft) to the runtime's CommonJS form, whose `.cjs` siblings the package does not ship, so
 * the bundle fails (COR-1642). The same build succeeds in a fresh process, so the host builds
 * through `scripts/build.ts` as a command instead of calling the bundler itself.
 *
 * A child must not outlive the host generation that started it, or a stale build could replace a
 * newer one in `build/`. The child holds a pipe to the host on its standard input and exits, having
 * removed its staging directory, when the pipe closes, which Bun does for every child of a
 * `--watch` generation that is reloaded (the reload keeps the process but not its module scope).
 * Within a generation, {@link stopBrowserBuilds} closes the pipes and waits for the children.
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
  /**
   * Where the build records the files it read (`--inputs-file`), so the host can watch exactly
   * the directories a rebuild depends on.
   */
  readonly inputsFile?: string;
};

/** A browser build running in a child process. */
export type BrowserBuild = {
  /** The child's process id. */
  readonly pid: number;
  /** Settles when the child exits: resolves on success, rejects on a failure or when stopped. */
  readonly done: Promise<void>;
  /** Tell the child to stop and settle once it has exited. */
  stop(): Promise<void>;
};

const running = new Set<BrowserBuild>();

/** Start the browser build in a fresh Bun process, without waiting for it. */
export function startBrowserBuild(options: BrowserBuildOptions = {}): BrowserBuild {
  const argv = [process.execPath, BUILD_SCRIPT, '--exit-with-parent'];
  if (options.development ?? true) argv.push('--development');
  if (options.outdir !== undefined) argv.push('--outdir', options.outdir);
  if (options.inputsFile !== undefined) argv.push('--inputs-file', options.inputsFile);
  const child = Bun.spawn(argv, {
    cwd: PACKAGE_DIRECTORY,
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'inherit',
  });
  let stopped = false;
  const done = child.exited.then((code) => {
    if (code !== 0) {
      throw new Error(
        stopped ? 'The browser build was stopped.' : `The browser build exited with code ${code}.`,
      );
    }
    return undefined;
  });
  const build: BrowserBuild = {
    pid: child.pid,
    done,
    async stop() {
      stopped = true;
      // A child that already exited has closed its end; ending the pipe then is not an error.
      try {
        void child.stdin.end();
      } catch {
        // Nothing to close.
      }
      await child.exited;
    },
  };
  running.add(build);
  // A stopped or failed build is reported to whoever awaits `done`; this only forgets it.
  done.then(
    () => running.delete(build),
    () => running.delete(build),
  );
  return build;
}

/**
 * Build the browser application in a fresh Bun process and settle when it exits. The child's
 * bundler errors go to this process's standard error; a nonzero exit rejects.
 */
export function buildBrowserApplication(options: BrowserBuildOptions = {}): Promise<void> {
  return startBrowserBuild(options).done;
}

/** Stop every build this generation started and wait until each child has exited. */
export async function stopBrowserBuilds(): Promise<void> {
  await Promise.all([...running].map((build) => build.stop()));
}
