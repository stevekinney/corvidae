/**
 * Measure Playground build and runtime costs (CIN-585).
 *
 *   bun scripts/measure-playground.ts run --label baseline --output <file> [options]
 *   bun scripts/measure-playground.ts compare --baseline <file> --candidate <file> [--output <file>]
 *
 * `run` records the pinned environment, then each requested phase in fresh child processes:
 *
 *   prerequisites  `bun install --frozen-lockfile` at the repository root, the only prerequisite
 *                  every turbo task runs; workspace libraries have no build step.
 *   static-export  `bun run scripts/static-export.ts` with `PLAYGROUND_BASE_URL=https://cinder.website`,
 *                  spawn to successful exit, in cold/warm pairs.
 *   server-ready   `bun src/playground-server.ts`, spawn to the first positive `/ready`, in cold/warm pairs.
 *   playwright     The package's `test:browser` on `tests/playground-shell-layout.playwright.ts`
 *                  (Chromium, JSON reporter), in cold/warm pairs.
 *   navigation     `measure-playground-probe.ts navigation`: warmed navigation cycles in Chromium.
 *   rebuild        `measure-playground-probe.ts rebuild`: edit/rebuild cycles on a disposable example.
 *
 * A cold sample deletes this checkout's own `applications/playground/.tmp` and points
 * `BUN_RUNTIME_TRANSPILER_CACHE_PATH` at a new, empty, run-owned directory. The warm sample that
 * follows reuses that directory in a new process against the same disk inputs. The exporter always
 * clears this checkout's `build/` itself. No OS cache is flushed, and nothing outside this run's
 * checkout and work directory is deleted. Every child's own `resourceUsage().maxRSS` (bytes) is
 * reported apart from the owned-tree peak sampled every 100 ms.
 *
 * `compare` applies the selection rule in `measure-playground-statistics.ts` and refuses results
 * that ran on different sources, lockfiles, or routes.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { PLAYGROUND_ROOT, REPOSITORY_ROOT } from '../src/playground-paths.ts';
import {
  captureHostLoad,
  capturePinnedEnvironment,
  captureSourceState,
  NORMALIZED_CHILD_ENVIRONMENT,
  waitForSettledLoad,
  type HostLoad,
  type LoadWait,
  type SourceState,
} from './measure-playground-environment.ts';
import {
  parseServerPrebuildSummary,
  parseStaticExportSummary,
  readArtifactFiles,
  readRouteInventory,
  summarizeArtifacts,
} from './measure-playground-inventory.ts';
import { startTreeSampler, type TreeSampleSeries } from './measure-playground-process-tree.ts';
import {
  comparabilityProblems,
  memoryPressureFlags,
  observationsFromResults,
  RESULT_SCHEMA,
  runFailures,
  summarizePlaywrightReport,
  survivingPidFailures,
  treeReadWarnings,
  type ChildMeasurement,
  type MeasurementResults,
  type PlaywrightSample,
  type ProbeMeasurement,
  type ServerReadySample,
  type StaticExportSample,
} from './measure-playground-results.ts';
import { selectCandidate, type Temperature } from './measure-playground-statistics.ts';

export const PHASES = [
  'prerequisites',
  'static-export',
  'server-ready',
  'playwright',
  'navigation',
  'rebuild',
] as const;
export type Phase = (typeof PHASES)[number];

const PRODUCTION_BASE_URL = 'https://cinder.website';
/** The Playwright configuration's fixed port; `test:browser` refuses to run if it is taken. */
const PLAYWRIGHT_PORT = 5597;
/**
 * How long a server-readiness sample may take before it is censored as a miss. It is a measurement
 * censor, not a test gate: on a contended host readiness exceeded the old 300 s cutoff at a load
 * near 60, against 102-124 s on a quiet host (CIN-585). Owner-approved on 2026-10-15 (CIN-588);
 * the production gate and test timeouts are unchanged.
 */
export const SERVER_READY_DEADLINE_MILLISECONDS = 900_000;

/** Whether a readiness wait has run past the cutoff, so the sample is recorded as a miss. */
export function readinessWaitExceeded(elapsedMilliseconds: number): boolean {
  return elapsedMilliseconds > SERVER_READY_DEADLINE_MILLISECONDS;
}
const READY_POLL_INTERVAL_MILLISECONDS = 100;

export type RunOptions = {
  command: 'run';
  label: string;
  output: string;
  workDirectory: string;
  phases: Phase[];
  pairs: number;
  playwrightPairs: number;
  cycles: number;
  serverPort: number;
  /** Opt-in only: hold each sample while the one-minute load exceeds this times the processors. */
  maximumLoadFactor?: number;
};

export type CompareOptions = {
  command: 'compare';
  baseline: string;
  candidate: string;
  output: string | undefined;
};

/**
 * Repository-relative paths a run writes: the directory holding its `--output` file and its work
 * directory. Both are left out of the source fingerprint, so results can live in the repository.
 */
export function outputExclusions(
  output: string,
  workDirectory: string,
  repositoryRoot: string = REPOSITORY_ROOT,
): string[] {
  return [dirname(output), workDirectory]
    .map((path) => relative(repositoryRoot, path))
    .filter((path) => path !== '' && !path.startsWith('..') && !isAbsolute(path));
}

function positiveNumber(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`--${name} must be a positive number.`);
  return parsed;
}

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`--${name} must be a positive integer.`);
  return parsed;
}

/** Parse the command line. Every input arrives as a flag; the script reads no environment. */
export function parseCommandLine(
  argv: readonly string[],
  now = new Date(),
): RunOptions | CompareOptions {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      label: { type: 'string' },
      output: { type: 'string' },
      'work-directory': { type: 'string' },
      phases: { type: 'string', default: PHASES.join(',') },
      pairs: { type: 'string', default: '3' },
      'playwright-pairs': { type: 'string', default: '1' },
      cycles: { type: 'string', default: '5' },
      'server-port': { type: 'string', default: '5610' },
      'maximum-load-factor': { type: 'string' },
      baseline: { type: 'string' },
      candidate: { type: 'string' },
    },
  });
  const [command] = positionals;
  if (command === 'compare') {
    if (values.baseline === undefined || values.candidate === undefined) {
      throw new Error('compare needs --baseline and --candidate.');
    }
    return {
      command,
      baseline: resolve(values.baseline),
      candidate: resolve(values.candidate),
      output: values.output === undefined ? undefined : resolve(values.output),
    };
  }
  if (command !== 'run')
    throw new Error(`Unknown command ${JSON.stringify(command)}; expected run or compare.`);
  if (values.label === undefined || !/^[a-z0-9-]+$/u.test(values.label)) {
    throw new Error('run needs --label made of lowercase letters, digits, and hyphens.');
  }
  if (values.output === undefined) throw new Error('run needs --output.');
  const phases = values.phases
    .split(',')
    .map((phase) => phase.trim())
    .filter(Boolean);
  const unknown = phases.filter((phase) => !(PHASES as readonly string[]).includes(phase));
  if (unknown.length > 0 || phases.length === 0) {
    throw new Error(`--phases must name some of ${PHASES.join(', ')}; got ${values.phases}.`);
  }
  const stamp = now.toISOString().replaceAll(/[:.]/gu, '-');
  return {
    command,
    label: values.label,
    output: resolve(values.output),
    workDirectory: resolve(
      values['work-directory'] ??
        join(REPOSITORY_ROOT, 'tmp', 'playground-measurements', `${values.label}-${stamp}`),
    ),
    phases: phases as Phase[],
    pairs: positiveInteger('pairs', values.pairs),
    playwrightPairs: positiveInteger('playwright-pairs', values['playwright-pairs']),
    cycles: positiveInteger('cycles', values.cycles),
    serverPort: positiveInteger('server-port', values['server-port']),
    ...(values['maximum-load-factor'] === undefined
      ? {}
      : {
          maximumLoadFactor: positiveNumber('maximum-load-factor', values['maximum-load-factor']),
        }),
  };
}

/**
 * `resourceUsage().cpuTime` fields are `bigint` at runtime although Bun's types declare `number`,
 * and `JSON.stringify` cannot serialize a `bigint`. Accept both and return a number.
 */
export function microsecondsFrom(value: number | bigint): number {
  return Number(value);
}

function withoutSamples(series: TreeSampleSeries): Omit<TreeSampleSeries, 'samples'> {
  const { samples: _samples, ...rest } = series;
  return rest;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type OwnedChild = {
  pid: number;
  output: () => string;
  /** Stop observing the tree now (before exit) and keep that series. */
  sampleUntilNow: () => Promise<TreeSampleSeries>;
  finish: () => Promise<ChildMeasurement>;
  kill: (signal: NodeJS.Signals) => void;
};

/** Spawn a child, drain both pipes into its log, and observe its process tree every 100 ms. */
function spawnOwnedChild(
  command: string[],
  options: { cwd: string; environment?: Record<string, string>; logPath: string },
): OwnedChild {
  const startedAt = performance.now();
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...NORMALIZED_CHILD_ENVIRONMENT, ...options.environment },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const sampler = startTreeSampler({ rootPids: () => [child.pid] });
  let captured = '';
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) captured += decoder.decode(chunk, { stream: true });
  };
  const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
  let earlySeries: Promise<TreeSampleSeries> | null = null;
  return {
    pid: child.pid,
    output: () => captured,
    sampleUntilNow: () => (earlySeries ??= sampler.stop()),
    kill: (signal) => child.kill(signal),
    finish: async () => {
      await child.exited;
      const wallMilliseconds = performance.now() - startedAt;
      await drained;
      const series = await (earlySeries ?? sampler.stop());
      await writeFile(options.logPath, captured);
      const usage = child.resourceUsage();
      return {
        command,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        wallMilliseconds,
        childMaxResidentBytes: usage?.maxRSS ?? null,
        userCpuMicroseconds: usage === undefined ? null : microsecondsFrom(usage.cpuTime.user),
        systemCpuMicroseconds: usage === undefined ? null : microsecondsFrom(usage.cpuTime.system),
        tree: withoutSamples(series),
        survivingPids: series.observedPids.filter(isAlive),
        logPath: options.logPath,
      };
    },
  };
}

type SampleContext = {
  options: RunOptions;
  temperature: Temperature;
  pair: number;
  cacheDirectory: string;
  loadWait: LoadWait;
};

/** A cold sample starts from this checkout's own empty scratch root and a new transpiler cache. */
async function prepareTemperature(context: SampleContext): Promise<void> {
  if (context.temperature !== 'cold') return;
  await rm(join(PLAYGROUND_ROOT, '.tmp'), { recursive: true, force: true });
  await rm(context.cacheDirectory, { recursive: true, force: true });
  await mkdir(context.cacheDirectory, { recursive: true });
}

function childEnvironment(
  cacheDirectory: string,
  extra: Record<string, string>,
): Record<string, string> {
  return { BUN_RUNTIME_TRANSPILER_CACHE_PATH: cacheDirectory, ...extra };
}

function sampleHeader(context: SampleContext): {
  pair: number;
  temperature: Temperature;
  loadWait: LoadWait;
  hostLoadBefore: HostLoad;
  source: SourceState;
} {
  return {
    pair: context.pair,
    loadWait: context.loadWait,
    temperature: context.temperature,
    hostLoadBefore: captureHostLoad(),
    source: captureSourceState(
      REPOSITORY_ROOT,
      outputExclusions(context.options.output, context.options.workDirectory),
    ),
  };
}

async function measureStaticExport(context: SampleContext): Promise<StaticExportSample> {
  await prepareTemperature(context);
  const header = sampleHeader(context);
  const child = await spawnOwnedChild(['bun', 'run', 'scripts/static-export.ts'], {
    cwd: PLAYGROUND_ROOT,
    environment: childEnvironment(context.cacheDirectory, {
      PLAYGROUND_BASE_URL: PRODUCTION_BASE_URL,
    }),
    logPath: join(
      context.options.workDirectory,
      `static-export-${context.pair}-${context.temperature}.log`,
    ),
  }).finish();
  const outputDirectory = join(PLAYGROUND_ROOT, 'build');
  const succeeded = child.exitCode === 0;
  const routes = succeeded ? await readRouteInventory(outputDirectory) : [];
  return {
    ...header,
    hostLoadAfter: captureHostLoad(),
    child,
    inventory: summarizeArtifacts(succeeded ? await readArtifactFiles(outputDirectory) : []),
    routeCount: routes.length,
    exporterSummary: parseStaticExportSummary(await readFile(child.logPath, 'utf8')),
  };
}

async function readPort(portFile: string): Promise<number | null> {
  if (!existsSync(portFile)) return null;
  const contents = await readFile(portFile, 'utf8');
  const port = Number(contents.trim());
  return Number.isInteger(port) && port > 0 ? port : null;
}

async function isReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/ready`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.status === 200 && (await response.text()) === 'ready';
  } catch {
    return false;
  }
}

async function measureServerReady(context: SampleContext): Promise<ServerReadySample> {
  await prepareTemperature(context);
  const header = sampleHeader(context);
  const portFile = join(
    context.options.workDirectory,
    `server-${context.pair}-${context.temperature}.port`,
  );
  await rm(portFile, { force: true });
  const startedAt = performance.now();
  const child = spawnOwnedChild(['bun', 'src/playground-server.ts'], {
    cwd: PLAYGROUND_ROOT,
    environment: childEnvironment(context.cacheDirectory, {
      PORT: String(context.options.serverPort),
      PLAYGROUND_PORT_FILE: portFile,
    }),
    logPath: join(
      context.options.workDirectory,
      `server-${context.pair}-${context.temperature}.log`,
    ),
  });
  let spawnToReadyMilliseconds: number | null = null;
  let exitedEarly = false;
  while (spawnToReadyMilliseconds === null && !exitedEarly) {
    const port = await readPort(portFile);
    if (port !== null && (await isReady(port)))
      spawnToReadyMilliseconds = performance.now() - startedAt;
    else if (readinessWaitExceeded(performance.now() - startedAt)) break;
    else if (!isAlive(child.pid)) exitedEarly = true;
    else await Bun.sleep(READY_POLL_INTERVAL_MILLISECONDS);
  }
  const treeUntilReady = await child.sampleUntilNow();
  child.kill('SIGTERM');
  const measurement = await child.finish();
  // A miss is recorded, not thrown: it is evidence about the existing readiness limit, and the
  // samples already taken must survive it. `compare` refuses results that contain a miss.
  const readyOutcome =
    spawnToReadyMilliseconds !== null ? 'ready' : exitedEarly ? 'exited' : 'deadline-exceeded';
  return {
    ...header,
    hostLoadAfter: captureHostLoad(),
    child: measurement,
    spawnToReadyMilliseconds,
    readyOutcome,
    readyDeadlineMilliseconds: SERVER_READY_DEADLINE_MILLISECONDS,
    treeUntilReady: withoutSamples(treeUntilReady),
    prebuildSummary: parseServerPrebuildSummary(child.output()),
  };
}

/** Whether anything accepts TCP connections on the port, over IPv4 or IPv6 loopback. No `lsof`. */
export async function isPortListening(port: number): Promise<boolean> {
  for (const hostname of ['127.0.0.1', '::1']) {
    try {
      const socket = await Bun.connect({ hostname, port, socket: { data() {} } });
      socket.end();
      return true;
    } catch {
      // Refused, or this loopback family is unavailable: try the next one.
    }
  }
  return false;
}

async function assertPlaywrightPortFree(): Promise<void> {
  if (await isPortListening(PLAYWRIGHT_PORT)) {
    throw new Error(`Port ${PLAYWRIGHT_PORT} is already listening; test:browser cannot start.`);
  }
}

async function measurePlaywright(context: SampleContext): Promise<PlaywrightSample> {
  await prepareTemperature(context);
  await assertPlaywrightPortFree();
  const header = sampleHeader(context);
  const reportPath = join(
    context.options.workDirectory,
    `playwright-${context.pair}-${context.temperature}.json`,
  );
  const child = await spawnOwnedChild(
    [
      'bun',
      'run',
      'test:browser',
      '--project=chromium',
      '--reporter=json',
      'tests/playground-shell-layout.playwright.ts',
    ],
    {
      cwd: PLAYGROUND_ROOT,
      environment: childEnvironment(context.cacheDirectory, {
        PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
        PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
      }),
      logPath: join(
        context.options.workDirectory,
        `playwright-${context.pair}-${context.temperature}.log`,
      ),
    },
  ).finish();
  const report = existsSync(reportPath)
    ? summarizePlaywrightReport(JSON.parse(await readFile(reportPath, 'utf8')))
    : null;
  return { ...header, hostLoadAfter: captureHostLoad(), child, report };
}

async function measureProbe(
  options: RunOptions,
  probe: 'navigation' | 'rebuild',
): Promise<ProbeMeasurement> {
  const loadWait = await settledLoad(options, `${probe} probe`);
  const resultPath = join(options.workDirectory, `probe-${probe}.json`);
  const child = await spawnOwnedChild(
    [
      'bun',
      'scripts/measure-playground-probe.ts',
      probe,
      '--cycles',
      String(options.cycles),
      '--output',
      resultPath,
      '--port',
      String(options.serverPort),
    ],
    {
      cwd: PLAYGROUND_ROOT,
      logPath: join(options.workDirectory, `probe-${probe}.log`),
    },
  ).finish();
  if (child.exitCode !== 0)
    return { loadWait, child, result: null, error: `See ${child.logPath}.` };
  return { loadWait, child, result: JSON.parse(await readFile(resultPath, 'utf8')) };
}

/** Wait for the load gate before a sample starts, logging each check that holds it back. */
function settledLoad(options: RunOptions, sample: string): Promise<LoadWait> {
  return waitForSettledLoad(options.maximumLoadFactor, {
    report: (load, threshold) => {
      process.stdout.write(
        `[measure-playground] holding ${sample}: 1-minute load ${load.loadAverages.oneMinute} > ${threshold}\n`,
      );
    },
  });
}

async function measurePairs<T>(
  options: RunOptions,
  pairs: number,
  phase: string,
  measure: (context: SampleContext) => Promise<T>,
  samples: T[],
  checkpoint: () => Promise<void>,
): Promise<T[]> {
  for (let pair = 1; pair <= pairs; pair += 1) {
    const cacheDirectory = join(options.workDirectory, `transpiler-cache-${phase}-${pair}`);
    for (const temperature of ['cold', 'warm'] as const) {
      const loadWait = await settledLoad(options, `${phase} pair ${pair} ${temperature}`);
      process.stdout.write(`[measure-playground] ${phase} pair ${pair}/${pairs} ${temperature}\n`);
      samples.push(await measure({ options, temperature, pair, cacheDirectory, loadWait }));
      await checkpoint();
    }
  }
  return samples;
}

export const DEFINITIONS: Record<string, string> = {
  cold: "This checkout's applications/playground/.tmp removed and BUN_RUNTIME_TRANSPILER_CACHE_PATH set to a new empty run-owned directory; the exporter clears build/ itself; no OS cache flush.",
  warm: 'Immediately after the cold sample, a new process with the same transpiler cache directory and the same disk inputs.',
  childMaxResidentBytes:
    "Bun.Subprocess.resourceUsage().maxRSS, bytes on every platform: one process's own high-water mark.",
  treePeakResidentBytes:
    'Largest sum of ps rss (KiB x 1024) across the child and its descendants, sampled every 100 ms by one observer for baseline and candidate.',
  spawnToReadyMilliseconds:
    'Spawn of bun src/playground-server.ts to the first GET /ready answering 200 "ready", polled every 100 ms. A sample still not ready after 900 s (owner-approved 2026-10-15; 300 s before CIN-588) is recorded as a miss.',
  jsHeap:
    'Chromium JS heap through CDP Runtime.getHeapUsage after HeapProfiler.collectGarbage; never summed with RSS.',
  hostLoad:
    'uptime load averages and os.availableParallelism() captured before and after every sample.',
  loadGate:
    'Record-only by default: every sample records the load averages, logical processors, and memory pressure without waiting. --maximum-load-factor opts into holding each sample while the 1-minute load exceeds that factor times the logical processors.',
  memoryPressure:
    'The process-tree observer reads kern.memorystatus_vm_pressure_level (1 normal, 2 warning, 4 critical) on every 100 ms tick. A sample whose maximum is above normal, or which has no reading, is flagged; a flagged run exits nonzero, and compare refuses a primary memory observation from a flagged sample.',
};

/** Run the install prerequisite, then capture the environment it may have changed. */
export async function prerequisitesThenEnvironment<Environment>(
  runPrerequisites: () => Promise<void>,
  captureEnvironment: () => Environment,
): Promise<Environment> {
  await runPrerequisites();
  return captureEnvironment();
}

async function run(options: RunOptions): Promise<MeasurementResults> {
  await mkdir(options.workDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const has = (phase: Phase): boolean => options.phases.includes(phase);
  const exclusions = outputExclusions(options.output, options.workDirectory);
  const prerequisites: MeasurementResults['prerequisites'] = [];
  // The install can change what is installed, so versions are read after it, not before.
  const environment = await prerequisitesThenEnvironment(
    async () => {
      if (!has('prerequisites')) return;
      const loadWait = await settledLoad(options, 'prerequisites');
      process.stdout.write('[measure-playground] prerequisites\n');
      const hostLoadBefore = captureHostLoad();
      const source = captureSourceState(REPOSITORY_ROOT, exclusions);
      const child = await spawnOwnedChild(['bun', 'install', '--frozen-lockfile'], {
        cwd: REPOSITORY_ROOT,
        logPath: join(options.workDirectory, 'prerequisites.log'),
      }).finish();
      prerequisites.push({
        pair: 1,
        loadWait,
        hostLoadBefore,
        hostLoadAfter: captureHostLoad(),
        source,
        child,
      });
    },
    () => capturePinnedEnvironment(REPOSITORY_ROOT, PLAYGROUND_ROOT, exclusions),
  );
  const results: MeasurementResults = {
    schema: RESULT_SCHEMA,
    label: options.label,
    startedAt,
    finishedAt: startedAt,
    environment,
    routeInventory: [],
    definitions: DEFINITIONS,
    prerequisites,
    staticExport: [],
    serverReady: [],
    playwright: [],
    probes: {},
  };
  const checkpoint = async (): Promise<void> => {
    results.finishedAt = new Date().toISOString();
    await writeJson(options.output, results);
  };
  if (prerequisites.length > 0) await checkpoint();
  if (has('static-export')) {
    await measurePairs(
      options,
      options.pairs,
      'static-export',
      measureStaticExport,
      results.staticExport,
      async () => {
        const latest = results.staticExport.at(-1);
        if (latest?.child.exitCode === 0 && results.routeInventory.length === 0) {
          results.routeInventory = await readRouteInventory(join(PLAYGROUND_ROOT, 'build'));
        }
        await checkpoint();
      },
    );
  }
  if (has('server-ready')) {
    await measurePairs(
      options,
      options.pairs,
      'server-ready',
      measureServerReady,
      results.serverReady,
      checkpoint,
    );
  }
  if (has('playwright')) {
    await measurePairs(
      options,
      options.playwrightPairs,
      'playwright',
      measurePlaywright,
      results.playwright,
      checkpoint,
    );
  }
  if (has('navigation')) {
    process.stdout.write('[measure-playground] navigation probe\n');
    results.probes.navigation = await measureProbe(options, 'navigation');
    await checkpoint();
  }
  if (has('rebuild')) {
    process.stdout.write('[measure-playground] rebuild probe\n');
    results.probes.rebuild = await measureProbe(options, 'rebuild');
    await checkpoint();
  }
  results.finishedAt = new Date().toISOString();
  return results;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function compare(options: CompareOptions): Promise<boolean> {
  const baseline = JSON.parse(await readFile(options.baseline, 'utf8')) as MeasurementResults;
  const candidate = JSON.parse(await readFile(options.candidate, 'utf8')) as MeasurementResults;
  const problems = comparabilityProblems(baseline, candidate);
  if (problems.length > 0) {
    process.stderr.write(
      `Results are not comparable:\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n`,
    );
    return false;
  }
  const decision = selectCandidate(observationsFromResults(baseline, candidate));
  if (options.output !== undefined) await writeJson(options.output, decision);
  process.stdout.write(
    `${decision.selected ? 'SELECT candidate' : 'RETAIN baseline'}\n${decision.reasons.map((reason) => `  - ${reason}`).join('\n')}\n`,
  );
  return true;
}

async function main(): Promise<boolean> {
  const options = parseCommandLine(Bun.argv.slice(2));
  if (options.command === 'compare') return compare(options);
  const results = await run(options);
  await writeJson(options.output, results);
  // Probe children are measured children too, so their survivors count (survivingPidFailures).
  // A flagged memory observation invalidates the run for selection, so it fails like a survivor.
  const failures = [
    ...runFailures(results),
    ...survivingPidFailures(results),
    ...memoryPressureFlags(results),
  ];
  const warnings = treeReadWarnings(results);
  if (warnings.length > 0) {
    process.stderr.write(
      `[measure-playground] process-tree read failures:\n${warnings.map((warning) => `  - ${warning}`).join('\n')}\n`,
    );
  }
  if (failures.length > 0) {
    process.stderr.write(
      `[measure-playground] wrote ${options.output} with failures:\n${failures.map((failure) => `  - ${failure}`).join('\n')}\n`,
    );
    return false;
  }
  process.stdout.write(`[measure-playground] wrote ${options.output}\n`);
  return true;
}

if (import.meta.main) {
  main().then(
    (succeeded) => process.exit(succeeded ? 0 : 1),
    (error: unknown) => {
      // Flush the diagnostic before exiting; a bare exit can truncate piped stderr.
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`${detail}\n`, () => process.exit(1));
    },
  );
}
