/**
 * Playground test runner.
 *
 * Runs the playground test suite across deliberately isolated `bun test`
 * processes and fails if any process does. This split is load-bearing — do not
 * collapse it back into a single `bun test` invocation without re-measuring.
 *
 * Two constraints force it (reproducibly verified in CI):
 *
 *   `component-page.test.ts` imperatively `mount()`s Svelte fixtures (it exercises
 *   the example-mount `$effect`). Once those fixtures have been compiled and
 *   mounted in a process, the global Svelte runtime / Bun bundler module state is
 *   left in a shape that makes a LATER `Bun.build` of a real component
 *   (`server.test.ts`'s `/page-bundle/chat.js` route) fail to read Svelte's
 *   internal sources — surfacing as `Unexpected reading file:
 *   svelte/src/internal/client/index.js` and `Unexpected type` on a `.ts`
 *   re-export. Both files pass in isolation; only the same-process combination
 *   breaks. `--parallel=1` does not help (the corruption is shared-process, not a
 *   parallel race), so the only robust fix is to run the mount-heavy test in its
 *   own process, away from the build-driving server tests.
 *
 *   Tests that drive `Bun.build()` must also start in a fresh process. A
 *   previously healthy shared process failed later builds with
 *   `Unexpected reading file` / `Unseekable reading file` errors against
 *   healthy component source files on Linux CI (July 2026). Each build-driving
 *   file passes in isolation.
 *
 * The runner discovers build-driving tests from direct `Bun.build()` calls and
 * imports of the server/export build pipelines, so a new test cannot silently
 * join the shared process and recreate this failure mode.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import ts from 'typescript';

import { repositoryRoot, selectedFilesFor } from '../../../scripts/affected-tests-manifest.ts';
import { finishRun } from '../../../scripts/bun-test-junit.ts';
import { readAllowlist } from '../../../scripts/check-test-durations.ts';
import { rootScriptEnvironment } from '../../../scripts/environment-configuration.ts';
import { TEST_TIMEOUT_ARGUMENT } from '../../../scripts/test-deadlines.ts';

const TEST_ENV = {
  ...process.env,
  TZ: 'UTC',
  LANG: 'en_US.UTF-8',
};

const PLAYGROUND_ROOT = resolve(import.meta.dir, '..');
const TEST_DIRECTORIES = ['scripts', 'src'] as const;

// Four isolated worker processes, matching Cinder, chat, and editor. This was once serial because
// Bun's parallel workers raced to import the Svelte test stack and the iframe-driven preview-frame
// tests hit happy-dom `postMessage` cross-origin errors with several windows open. Re-measured on
// Bun 1.4.2: three consecutive runs at four workers passed every test in about 140 s, against
// 276 s serially. Re-measure before raising the worker count; ten workers on a ten-core host made
// Cinder's scroll-settling tests fail.
const FAST_LANE_FLAGS = ['--conditions', 'browser', '--conditions', 'svelte', '--parallel=4'];

// The slow lane is serial by design (COR-1499): its tests are slow because they do real work, and
// running them four at a time would put their contention back on the host that the lane exists to
// relieve. `--parallel=1` is the serial form this runner used before the fast lane went parallel.
const SLOW_LANE_FLAGS = ['--conditions', 'browser', '--conditions', 'svelte', '--parallel=1'];

const MOUNT_HEAVY_TEST = 'src/component-page.test.ts';

/**
 * Tests that are slow by nature (COR-1499) live in `*.slow.test.ts` files. The default lane skips
 * them and `--slow` runs only them, serially after the fast phase, so their contention stays out
 * of the fast lane. The fast lane writes one JUnit report per process for the root duration ratchet.
 */
export const SLOW_TEST_SUFFIX = '.slow.test.ts';
export type TestLane = 'fast' | 'slow';
const JUNIT_DIRECTORY = join(PLAYGROUND_ROOT, 'test-output', 'junit');

/** Keep the files that belong to a lane. */
export function selectLaneFiles<T extends { path: string }>(files: T[], lane: TestLane): T[] {
  return files.filter((file) => file.path.endsWith(SLOW_TEST_SUFFIX) === (lane === 'slow'));
}

/**
 * Modules that run `Bun.build`, directly or through the build pipeline, so a
 * test that imports one starts in a fresh process. `run-tests.test.ts` checks
 * that every playground module that calls `Bun.build` is listed here.
 */
export const BUILD_PIPELINE_MODULE_NAMES = [
  'build-artifacts-shared.ts',
  'documentation-styles.ts',
  'featured-example-server-renderer.ts',
  'featured-example-server-worker.ts',
  'file-watcher.ts',
  'fixture-bundle.ts',
  'page-bundle.ts',
  'playground-server.ts',
  'scenario-bundle.ts',
  'shell-bundle.ts',
  'ssr-renderer.ts',
  'static-export.ts',
  'theme-builder-bundle.ts',
] as const;

/**
 * Modules that own child processes (spawn, signal, and sweep them) for the static production
 * gate. A test that imports one, or that calls `Bun.spawn`/`Bun.spawnSync` itself, starts in a
 * fresh process: a turbo-launched shared process that had run the gate's lifecycle cases stalled
 * at 100% of its main thread in the next file, for over ten hours, while every direct run passed.
 * `run-tests.test.ts` checks that every test spawning processes is isolated.
 */
export const PROCESS_OWNING_MODULE_NAMES = [
  'check-static-playground.ts',
  'run-linux-lifecycle.ts',
  'static-playground-processes.ts',
] as const;

const PROCESS_SPAWNING_CALLS = new Set(['build', 'spawn', 'spawnSync']);

export type PlaygroundTestFile = {
  path: string;
  source: string;
};

function isBuildPipelineModule(specifier: string): boolean {
  return [...BUILD_PIPELINE_MODULE_NAMES, ...PROCESS_OWNING_MODULE_NAMES].some((moduleName) =>
    specifier.endsWith(moduleName),
  );
}

function syntaxDrivesBuildPipeline(testFile: PlaygroundTestFile): boolean {
  const sourceFile = ts.createSourceFile(
    testFile.path,
    testFile.source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  let drivesBuildPipeline = false;

  function visit(node: ts.Node): void {
    if (drivesBuildPipeline) return;

    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isBuildPipelineModule(node.moduleSpecifier.text)
    ) {
      drivesBuildPipeline = true;
      return;
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [moduleSpecifier] = node.arguments;
      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
        if (isBuildPipelineModule(moduleSpecifier.text)) {
          drivesBuildPipeline = true;
          return;
        }
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Bun' &&
      PROCESS_SPAWNING_CALLS.has(node.expression.name.text)
    ) {
      drivesBuildPipeline = true;
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return drivesBuildPipeline;
}

/** Return whether a test file requires a fresh Bun process. */
export function requiresFreshProcess(testFile: PlaygroundTestFile): boolean {
  return testFile.path === MOUNT_HEAVY_TEST || syntaxDrivesBuildPipeline(testFile);
}

/**
 * Build the process plan: safe tests share one serial process, while every
 * state-sensitive test receives its own process.
 */
export function createTestProcessPlan(testFiles: PlaygroundTestFile[]): string[][] {
  const sortedTestFiles = testFiles.toSorted((left, right) => left.path.localeCompare(right.path));
  const sharedTestPaths = sortedTestFiles
    .filter((testFile) => !requiresFreshProcess(testFile))
    .map((testFile) => testFile.path);
  const isolatedTestPaths = sortedTestFiles
    .filter(requiresFreshProcess)
    .map((testFile) => [testFile.path]);

  return sharedTestPaths.length === 0 ? isolatedTestPaths : [sharedTestPaths, ...isolatedTestPaths];
}

/** Discover every playground test and load enough source to classify it. */
/** Discover the playground's tests: one lane's files, or every file when no lane is named. */
export async function discoverTestFiles(lane?: TestLane): Promise<PlaygroundTestFile[]> {
  const testFiles: PlaygroundTestFile[] = [];

  for (const directory of TEST_DIRECTORIES) {
    const directoryPath = resolve(PLAYGROUND_ROOT, directory);
    const glob = new Bun.Glob('**/*.test.ts');

    for await (const relativePath of glob.scan({ cwd: directoryPath, onlyFiles: true })) {
      const path = `${directory}/${relativePath}`;
      testFiles.push({
        path,
        source: await Bun.file(resolve(PLAYGROUND_ROOT, path)).text(),
      });
    }
  }

  return lane === undefined ? testFiles : selectLaneFiles(testFiles, lane);
}

/** The `bun test` flags for a lane: four workers for the fast lane, one for the slow lane. */
export function bunTestFlags(lane: TestLane): string[] {
  return lane === 'fast' ? [...FAST_LANE_FLAGS] : [...SLOW_LANE_FLAGS];
}

/**
 * Run one `bun test` invocation for a process group. Inherits stdio so the
 * child's reporter streams straight through. Returns its exit code.
 */
async function runBunTest(
  lane: TestLane,
  args: string[],
  reportPath: string | null,
): Promise<number> {
  const reporter =
    reportPath === null ? [] : ['--reporter=junit', `--reporter-outfile=${reportPath}`];
  const child = Bun.spawn(
    ['bun', 'test', TEST_TIMEOUT_ARGUMENT, ...bunTestFlags(lane), ...reporter, ...args],
    {
      cwd: PLAYGROUND_ROOT,
      env: TEST_ENV,
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  return child.exited;
}

/** Run every test process in sequence; exit non-zero if any process fails. */
async function main(): Promise<void> {
  const lane: TestLane = Bun.argv.includes('--slow') ? 'slow' : 'fast';
  const discovered = await discoverTestFiles(lane);
  // `bun scripts/affected-tests.ts run` narrows the lane to the files a change can reach.
  const selected = selectedFilesFor(
    rootScriptEnvironment(),
    relative(repositoryRoot, PLAYGROUND_ROOT),
  );
  const testFiles =
    selected === null || selected === 'all'
      ? discovered
      : discovered.filter((file) => selected.includes(file.path));
  const processPlan = createTestProcessPlan(testFiles);
  if (processPlan.length === 0) {
    if (selected !== null) {
      console.log(
        `run-tests: no playground ${lane} test is reachable from the change; nothing to run.`,
      );
      process.exit(0);
    }
    throw new Error(`No playground ${lane} tests were discovered.`);
  }
  let failed = false;

  if (lane === 'fast') {
    mkdirSync(JUNIT_DIRECTORY, { recursive: true });
    for (const name of readdirSync(JUNIT_DIRECTORY)) {
      if (name.startsWith('fast-') && name.endsWith('.xml')) rmSync(join(JUNIT_DIRECTORY, name));
    }
  }

  for (const [index, testPaths] of processPlan.entries()) {
    const reportPath = lane === 'fast' ? join(JUNIT_DIRECTORY, `fast-${index}.xml`) : null;
    failed = (await runBunTest(lane, testPaths, reportPath)) !== 0 || failed;
  }

  let exitCode = failed ? 1 : 0;
  if (lane === 'fast') {
    // A passing fast lane with an over-budget test fails here, uncached, so a rerun remeasures.
    const reports = readdirSync(JUNIT_DIRECTORY)
      .filter((name) => name.startsWith('fast-') && name.endsWith('.xml'))
      .map((name) => readFileSync(join(JUNIT_DIRECTORY, name), 'utf8'));
    exitCode = finishRun('applications/playground', exitCode, reports, readAllowlist(), (message) =>
      process.stderr.write(message),
    );
  }
  process.exit(exitCode);
}

if (import.meta.main) {
  // Fire-and-forget: `main()` calls `process.exit`, so the process ends inside it.
  // Surface an unexpected rejection as a non-zero exit rather than an unhandled one.
  void main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
