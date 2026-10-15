/**
 * The static production gate: verifies the exported Playground exactly as the static host serves
 * it, with no credentials and no development server.
 *
 *   bun run --filter=@lostgradient/playground test:production -- [--shard 1/8] [--workers 4]
 *
 * This runner is the one owner of everything the gate starts. It creates a run-owned temporary
 * directory, starts the static server (`scripts/static-playground-server.ts`) as one child process,
 * runs every HTTP-level check against it (`scripts/static-playground-preflight.ts`), and only when
 * those pass starts Playwright as a second child for the browser cases. Both children lead their
 * own process groups and run with the run directory as `TMPDIR`; `ProcessOwner` terminates
 * everything either of them left behind on every exit path, then the run directory is removed.
 *
 * Exit status: the test runner's exit code; `128 + n` when signal `n` interrupted the runner or
 * killed the test runner; 1 for a preflight failure, a static server that died, incomplete case
 * evidence, or a cleanup that could not prove every owned process gone.
 *
 * `report.json`, the digest manifest, and failure screenshots land in `--output`, which persists.
 */
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

import {
  readScrubbedEnvironment,
  readSecretEnvironmentEntries,
} from '../src/environment-configuration.ts';
import { EXPORT_REPORT_PATH, type ExportReport, parseExportReport } from './export-report.ts';
import {
  createCaseList,
  parseShard,
  selectShard,
  type Shard,
  type StaticCase,
} from './static-playground-cases.ts';
import { serializeDigestManifest } from './static-playground-digest.ts';
import { runPreflight } from './static-playground-preflight.ts';
import {
  exitedWithin,
  type OwnedChild,
  ProcessOwner,
  signalNumber,
} from './static-playground-processes.ts';
import { loadStaticHostConfiguration } from './static-playground-server.ts';

const PLAYGROUND_ROOT = join(import.meta.dirname, '..');
const DEFAULT_DIRECTORY = join(PLAYGROUND_ROOT, 'build');
/**
 * Outside `test-results/`, which Playwright empties before every development `test:browser` run,
 * so a gate report survives until the next gate run replaces it.
 */
const DEFAULT_OUTPUT = join(PLAYGROUND_ROOT, 'production-gate-results');
const DEFAULT_WORKERS = 4;
const SERVER_READY_DEADLINE_MILLISECONDS = 30_000;

export type ServerCommand = (input: { directory: string; portFile: string }) => string[];
export type TestRunnerCommand = (input: { workers: number }) => string[];

export const defaultServerCommand: ServerCommand = ({ directory, portFile }) => [
  process.execPath,
  join(PLAYGROUND_ROOT, 'scripts', 'static-playground-server.ts'),
  '--directory',
  directory,
  '--port-file',
  portFile,
];

export const defaultTestRunnerCommand: TestRunnerCommand = ({ workers }) => [
  process.execPath,
  'x',
  '--no-install',
  'playwright',
  'test',
  '-c',
  'playwright-static.config.ts',
  `--workers=${workers}`,
];

export type GateOptions = {
  directory: string;
  exportReportPath: string;
  output: string;
  shard: Shard;
  workers: number;
  allowSourceMismatch: boolean;
  serverCommand?: ServerCommand;
  testRunnerCommand?: TestRunnerCommand;
};

export type CaseResult = {
  caseId: string;
  status: string;
  errors: string[];
  diagnostics: string[];
  screenshot: string | null;
};

/**
 * Where a static-server death interrupted the run: before it reported its port (`startup`), during
 * the HTTP preflight (`first-request`), after the first browser case started but before any case
 * completed (`hydration`), or after at least one case completed (`mid-run`).
 */
export type FailurePhase = 'startup' | 'first-request' | 'hydration' | 'mid-run';

export type GateReport = {
  version: 1;
  exitCode: number;
  diagnosis: string | null;
  preflightFailures: string[];
  sourceSha: string | null;
  buildDigest: string | null;
  servedDigest: string | null;
  nodeEnv: string | null;
  exportDurationMilliseconds: number | null;
  peakResidentSetBytes: number | null;
  routeCount: number | null;
  caseCount: number | null;
  shard: Shard;
  shardCaseCount: number | null;
  workers: number;
  durationMilliseconds: number;
  passedCount: number;
  failedCases: CaseResult[];
  missingCases: string[];
  /** Set only when the static server died; names where the run was. */
  failurePhase: FailurePhase | null;
  /** Cases that had started but not completed when the static server died. */
  inFlightCases: string[];
  manifestPath: string | null;
};

class GateInterrupted extends Error {
  constructor(readonly signal: NodeJS.Signals) {
    super(`[static-playground] interrupted by ${signal}`);
  }
}

class GateFailure extends Error {}

function exitStatusOf(subprocess: OwnedChild['subprocess']): number {
  if (subprocess.signalCode !== null) return 128 + signalNumber(subprocess.signalCode);
  return subprocess.exitCode ?? 1;
}

function describeExit(subprocess: OwnedChild['subprocess']): string {
  return subprocess.signalCode === null
    ? `exit code ${String(subprocess.exitCode)}`
    : `signal ${subprocess.signalCode}`;
}

/** A case-start line the reporter writes before the case's result line. */
export type CaseBegin = { caseId: string; event: 'begin' };

/**
 * Parse the reporter's JSON lines into the cases that started and the results of those that
 * completed; a missing file is an empty list of each.
 */
export async function readCaseProgress(
  path: string,
): Promise<{ started: string[]; results: CaseResult[] }> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { started: [], results: [] };
  const text = await file.text();
  const lines = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CaseResult | CaseBegin);
  const isBegin = (line: CaseResult | CaseBegin): line is CaseBegin =>
    'event' in line && line.event === 'begin';
  return {
    started: lines.filter(isBegin).map((line) => line.caseId),
    results: lines.filter((line): line is CaseResult => !isBegin(line)),
  };
}

/** The results of the cases that completed. */
export async function readCaseResults(path: string): Promise<CaseResult[]> {
  const progress = await readCaseProgress(path);
  return progress.results;
}

/** Every expected case must have exactly one result, and a passing run must pass all of them. */
export function summarizeCaseResults(
  cases: readonly StaticCase[],
  results: readonly CaseResult[],
): { passed: number; failed: CaseResult[]; missing: string[] } {
  const byId = new Map<string, CaseResult[]>();
  for (const result of results)
    byId.set(result.caseId, [...(byId.get(result.caseId) ?? []), result]);
  const missing = cases.filter((testCase) => byId.get(testCase.id)?.length !== 1).map((c) => c.id);
  const expected = new Set(cases.map((testCase) => testCase.id));
  // A result for a test the case list does not name means the list and the spec have drifted
  // apart; it is a failure, and it never counts toward the passed total.
  const unexpected = results
    .filter((result) => !expected.has(result.caseId))
    .map((result) => ({
      ...result,
      status: 'unexpected',
      errors: ['the case list does not name this test'],
    }));
  // A browser diagnostic that arrives after a case's last assertion (before its fixtures tear
  // down) never fails the case in Playwright, so a passed result that carries one is a failure.
  const listed = results.filter((result) => expected.has(result.caseId));
  const failed = listed.filter(
    (result) => result.status !== 'passed' || result.diagnostics.length > 0,
  );
  return { passed: listed.length - failed.length, failed: [...failed, ...unexpected], missing };
}

async function readExportReport(path: string): Promise<ExportReport> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new GateFailure(`[static-playground] export report ${path} is missing; build first`);
  }
  try {
    return parseExportReport(await file.json());
  } catch (error) {
    throw new GateFailure(error instanceof Error ? error.message : String(error));
  }
}

async function waitForPort(
  portFile: string,
  server: OwnedChild,
  report: GateReport,
): Promise<number> {
  const deadline = performance.now() + SERVER_READY_DEADLINE_MILLISECONDS;
  while (performance.now() < deadline) {
    if (server.subprocess.exitCode !== null || server.subprocess.signalCode !== null) break;
    const file = Bun.file(portFile);
    if (await file.exists()) {
      const port = await file.text();
      return Number(port.trim());
    }
    await Bun.sleep(50);
  }
  if (server.subprocess.exitCode === null && server.subprocess.signalCode === null) {
    throw new GateFailure('[static-playground] static server did not report a port');
  }
  report.failurePhase = 'startup';
  throw new GateFailure(
    `[static-playground] static server exited before it was ready with ${describeExit(server.subprocess)} (phase: startup)`,
  );
}

/** What the runner is doing, which decides the phase a static-server death is reported under. */
type Stage =
  | { name: 'startup' }
  | { name: 'preflight' }
  | { name: 'browser-cases'; cases: readonly StaticCase[]; resultsPath: string };

type RunState = {
  options: GateOptions;
  owner: ProcessOwner;
  runDirectory: string;
  report: GateReport;
  interrupted: Promise<never>;
  stage: Stage;
};

/**
 * How long aborted work may take to settle after a server death before the runner reports anyway.
 * Aborted preflight requests settle at once; this only bounds a step that ignores the signal.
 */
const ABORTED_WORK_MILLISECONDS = 5_000;

/**
 * Record where a static-server death interrupted the run and return its diagnosis. During the
 * browser cases it keeps every completed result, so the report still counts what passed and names
 * what failed, and it names the cases that had started without completing.
 */
async function diagnoseServerDeath(state: RunState, server: OwnedChild): Promise<string> {
  const { report, stage } = state;
  let phase: FailurePhase = stage.name === 'browser-cases' ? 'hydration' : 'first-request';
  if (stage.name === 'browser-cases') {
    const progress = await readCaseProgress(stage.resultsPath);
    const summary = summarizeCaseResults(stage.cases, progress.results);
    const completed = new Set(progress.results.map((result) => result.caseId));
    const inFlight = [...new Set(progress.started)].filter((caseId) => !completed.has(caseId));
    Object.assign(report, {
      passedCount: summary.passed,
      failedCases: summary.failed,
      missingCases: summary.missing,
      inFlightCases: inFlight,
    });
    if (progress.results.length > 0) phase = 'mid-run';
  }
  report.failurePhase = phase;
  const inFlight =
    report.inFlightCases.length === 0 ? '' : `; in flight: ${report.inFlightCases.join(', ')}`;
  return `[static-playground] static server exited unexpectedly with ${describeExit(server.subprocess)} (phase: ${phase}${inFlight})`;
}

/**
 * Await `work`, but give up as soon as the runner is signaled or the static server dies. On a
 * server death, `abort` cancels the work and the runner waits (bounded) for it to settle, so
 * nothing it started outlives the report and the report's duration covers it.
 */
async function serverDeathOf(
  state: RunState,
  server: OwnedChild,
  settled: Promise<number>,
  abort: AbortController | undefined,
): Promise<never> {
  // The watcher retires once the guarded work settles or the runner is interrupted: after either,
  // the server only exits because the runner stops it at teardown, and that is not a death.
  const retired = Promise.race([settled, state.interrupted.catch(() => undefined)]).then(
    () => 'retired' as const,
  );
  const ended = await Promise.race([
    server.subprocess.exited.then(() => 'exited' as const),
    retired,
  ]);
  if (ended === 'retired') return new Promise<never>(() => {});
  if (abort !== undefined) {
    abort.abort(new Error('the static server died'));
    await exitedWithin({ exited: settled }, ABORTED_WORK_MILLISECONDS);
  }
  throw new GateFailure(await diagnoseServerDeath(state, server));
}

async function guarded<T>(
  state: RunState,
  server: OwnedChild | null,
  work: Promise<T>,
  abort?: AbortController,
) {
  const settled = work.then(
    () => 0,
    () => 0,
  );
  const serverDeath =
    server === null ? new Promise<never>(() => {}) : serverDeathOf(state, server, settled, abort);
  // The race observes a later rejection; this keeps one that lands after `work` from going unhandled.
  serverDeath.catch(() => undefined);
  // An aborted `work` rejects first; the server death, not the abort, is what failed the run.
  const outcome = work.catch(async (error: unknown) => {
    if (abort?.signal.aborted === true) return serverDeath;
    throw error;
  });
  return Promise.race([outcome, state.interrupted, serverDeath]);
}

async function startServer(state: RunState): Promise<{ server: OwnedChild; origin: string }> {
  const portFile = join(state.runDirectory, 'static-server.port');
  const command = (state.options.serverCommand ?? defaultServerCommand)({
    directory: state.options.directory,
    portFile,
  });
  const server = state.owner.spawn('static server', command, {
    cwd: PLAYGROUND_ROOT,
    env: childEnvironment(state.runDirectory, {}),
  });
  const port = await guarded(state, null, waitForPort(portFile, server, state.report));
  return { server, origin: `http://127.0.0.1:${port}` };
}

/**
 * A child's environment: the runner's own with every credential-shaped variable removed, plus the
 * run-owned temporary directory and `additions`. Neither the static server nor Playwright and its
 * browsers needs a credential, so none is handed to them; the unscrubbed values are read only by
 * the served-byte leak scan in the runner itself.
 */
export function childEnvironment(
  runDirectory: string,
  additions: Record<string, string>,
): Record<string, string> {
  return {
    ...readScrubbedEnvironment(),
    TMPDIR: runDirectory,
    TMP: runDirectory,
    TEMP: runDirectory,
    ...additions,
  };
}

async function preflight(state: RunState, server: OwnedChild, origin: string) {
  const exportReport = await readExportReport(state.options.exportReportPath);
  Object.assign(state.report, {
    sourceSha: exportReport.sourceSha,
    buildDigest: exportReport.buildDigest,
    nodeEnv: exportReport.nodeEnv,
    exportDurationMilliseconds: exportReport.exportDurationMilliseconds,
    peakResidentSetBytes: exportReport.peakResidentSetBytes,
    routeCount: exportReport.routes.length,
  });
  state.stage = { name: 'preflight' };
  const abort = new AbortController();
  const result = await guarded(
    state,
    server,
    runPreflight({
      directory: state.options.directory,
      origin,
      report: exportReport,
      configuration: await loadStaticHostConfiguration(),
      allowSourceMismatch: state.options.allowSourceMismatch,
      secretEntries: readSecretEnvironmentEntries(),
      signal: abort.signal,
    }),
    abort,
  );
  const manifestPath = join(state.options.output, 'manifest.sha256');
  await Bun.write(manifestPath, serializeDigestManifest(result.manifest));
  Object.assign(state.report, { servedDigest: result.buildDigest, manifestPath });
  state.report.preflightFailures = result.failures;
  if (result.failures.length > 0) {
    throw new GateFailure(
      `[static-playground] preflight failed:\n${result.failures.map((failure) => `  - ${failure}`).join('\n')}`,
    );
  }
  return exportReport;
}

async function runBrowserCases(
  state: RunState,
  server: OwnedChild,
  origin: string,
  exportReport: ExportReport,
): Promise<number> {
  const allCases = createCaseList(exportReport.routes);
  const cases = selectShard(allCases, state.options.shard);
  state.report.caseCount = allCases.length;
  state.report.shardCaseCount = cases.length;
  const casesPath = join(state.runDirectory, 'cases.json');
  const resultsPath = join(state.runDirectory, 'results.jsonl');
  await Bun.write(casesPath, JSON.stringify(cases));
  state.stage = { name: 'browser-cases', cases, resultsPath };
  process.stdout.write(
    `[static-playground] running ${cases.length} of ${allCases.length} cases (shard ${state.options.shard.index}/${state.options.shard.count}, ${state.options.workers} workers)\n`,
  );
  const command = (state.options.testRunnerCommand ?? defaultTestRunnerCommand)({
    workers: state.options.workers,
  });
  const runner = state.owner.spawn('test runner', command, {
    cwd: PLAYGROUND_ROOT,
    env: childEnvironment(state.runDirectory, {
      PLAYGROUND_STATIC_BASE_URL: origin,
      PLAYGROUND_STATIC_CASES: casesPath,
      PLAYGROUND_STATIC_RESULTS: resultsPath,
      PLAYGROUND_STATIC_SCRATCH: join(state.runDirectory, 'playwright-output'),
      PLAYGROUND_STATIC_SCREENSHOTS: join(state.options.output, 'screenshots'),
    }),
  });
  // Bounded like every other wait: no case can outlast Playwright's 30 s default test timeout, so
  // twice that per case per worker, plus startup, is a ceiling a healthy run never reaches.
  const ceiling = Math.ceil(cases.length / state.options.workers) * 60_000 + 120_000;
  const exited = await guarded(state, server, exitedWithin(runner.subprocess, ceiling));
  if (exited === undefined) {
    throw new GateFailure(
      `[static-playground] the test runner did not finish within its ${ceiling} ms ceiling`,
    );
  }
  const status = exitStatusOf(runner.subprocess);
  const summary = summarizeCaseResults(cases, await readCaseResults(resultsPath));
  Object.assign(state.report, {
    passedCount: summary.passed,
    failedCases: summary.failed,
    missingCases: summary.missing,
  });
  if (status === 0 && (summary.failed.length > 0 || summary.missing.length > 0)) {
    state.report.diagnosis = `[static-playground] the test runner exited 0 without passing every case`;
    return 1;
  }
  if (status !== 0)
    state.report.diagnosis = `[static-playground] test runner ${describeExit(runner.subprocess)}`;
  return status;
}

async function runGate(state: RunState): Promise<number> {
  const { server, origin } = await startServer(state);
  process.stdout.write(`[static-playground] serving ${state.options.directory} at ${origin}\n`);
  const exportReport = await preflight(state, server, origin);
  return runBrowserCases(state, server, origin, exportReport);
}

function emptyReport(options: GateOptions): GateReport {
  return {
    version: 1,
    exitCode: 1,
    diagnosis: null,
    preflightFailures: [],
    sourceSha: null,
    buildDigest: null,
    servedDigest: null,
    nodeEnv: null,
    exportDurationMilliseconds: null,
    peakResidentSetBytes: null,
    routeCount: null,
    caseCount: null,
    shard: options.shard,
    shardCaseCount: null,
    workers: options.workers,
    durationMilliseconds: 0,
    passedCount: 0,
    failedCases: [],
    missingCases: [],
    failurePhase: null,
    inFlightCases: [],
    manifestPath: null,
  };
}

function statusForError(error: unknown, report: GateReport): number {
  if (error instanceof GateInterrupted) {
    report.diagnosis = error.message;
    return 128 + signalNumber(error.signal);
  }
  report.diagnosis = error instanceof Error ? error.message : String(error);
  return 1;
}

/** A path with symlinks in its existing ancestors resolved, keeping segments that do not exist yet. */
function canonicalPath(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...missing);
}

/**
 * The report, manifest, and screenshots are written after the digest is computed, so an output
 * directory inside the served one would change the bytes the report vouches for.
 */
export function assertOutputOutsideServedDirectory(output: string, directory: string): void {
  const fromServed = relative(canonicalPath(directory), canonicalPath(output));
  if (fromServed === '' || (!fromServed.startsWith(`..${sep}`) && fromServed !== '..')) {
    throw new Error(
      `[static-playground] --output ${output} must be outside the served directory ${directory}`,
    );
  }
}

/** Run the gate and return its exit status. Every process it starts is gone when it resolves. */
export async function runStaticPlaygroundGate(options: GateOptions): Promise<number> {
  const startedAt = performance.now();
  assertOutputOutsideServedDirectory(options.output, options.directory);
  await mkdir(options.output, { recursive: true });
  await rm(join(options.output, 'screenshots'), { recursive: true, force: true });
  const runDirectory = realpathSync(await mkdtemp(join(tmpdir(), 'static-playground-')));
  process.stdout.write(`[static-playground] run directory ${runDirectory}\n`);
  const owner = new ProcessOwner({ marker: runDirectory });
  const interruption = Promise.withResolvers<never>();
  interruption.promise.catch(() => undefined);
  // Recorded apart from the promise: a signal that lands during cleanup, after the gate itself
  // settled, still has to decide the exit status.
  let receivedSignal: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    receivedSignal ??= signal;
    interruption.reject(new GateInterrupted(signal));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const report = emptyReport(options);
  const state: RunState = {
    options,
    owner,
    runDirectory,
    report,
    interrupted: interruption.promise,
    stage: { name: 'startup' },
  };
  let status: number;
  try {
    status = await runGate(state);
  } catch (error) {
    status = statusForError(error, report);
  }
  process.stdout.write('[static-playground] cleaning up owned processes\n');
  const cleanup = await owner.cleanup();
  await rm(runDirectory, { recursive: true, force: true });
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  if (receivedSignal !== undefined && status !== 128 + signalNumber(receivedSignal)) {
    status = statusForError(new GateInterrupted(receivedSignal), report);
  }
  if (!cleanup.complete) {
    const survivors = cleanup.survivors.map((row) => `${row.pid} ${row.args}`).join('; ');
    report.diagnosis =
      `${report.diagnosis ?? ''}\n[static-playground] cleanup could not prove every owned process gone: ${survivors || 'output still open'}`.trim();
    if (status === 0) status = 1;
  }
  report.exitCode = status;
  report.durationMilliseconds = Math.round(performance.now() - startedAt);
  await Bun.write(join(options.output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (report.diagnosis !== null) process.stderr.write(`${report.diagnosis}\n`);
  for (const failure of report.failedCases) {
    process.stderr.write(
      `[static-playground] FAILED ${failure.caseId}: ${failure.errors.join(' | ')}${failure.screenshot === null ? '' : ` (screenshot ${failure.screenshot})`}\n`,
    );
  }
  process.stdout.write(
    `[static-playground] exit ${status}: ${report.passedCount}/${String(report.shardCaseCount)} cases passed, digest ${String(report.servedDigest)}, report ${join(options.output, 'report.json')}\n`,
  );
  return status;
}

export function parseGateArguments(args: string[]): GateOptions {
  const { values } = parseArgs({
    args,
    options: {
      directory: { type: 'string' },
      'export-report': { type: 'string' },
      output: { type: 'string' },
      shard: { type: 'string' },
      workers: { type: 'string' },
      'allow-source-mismatch': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const shard = parseShard(values.shard ?? '1/1');
  const workers = Number(values.workers ?? DEFAULT_WORKERS);
  if (!Number.isSafeInteger(workers) || workers < 1) {
    throw new Error('[static-playground] --workers must be a positive integer');
  }
  const defaultOutput =
    shard.count === 1
      ? DEFAULT_OUTPUT
      : join(DEFAULT_OUTPUT, `shard-${shard.index}-of-${shard.count}`);
  return {
    directory: resolve(values.directory ?? DEFAULT_DIRECTORY),
    exportReportPath: resolve(values['export-report'] ?? EXPORT_REPORT_PATH),
    output: resolve(values.output ?? defaultOutput),
    shard,
    workers,
    allowSourceMismatch: values['allow-source-mismatch'],
  };
}

if (import.meta.main) {
  try {
    process.exitCode = await runStaticPlaygroundGate(parseGateArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
