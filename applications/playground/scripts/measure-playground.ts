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
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { PLAYGROUND_ROOT, REPOSITORY_ROOT } from '../src/playground-paths.ts';
import {
  captureHostLoad,
  capturePinnedEnvironment,
  captureSourceState,
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
  observationsFromResults,
  RESULT_SCHEMA,
  runFailures,
  summarizePlaywrightReport,
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
/** The Playwright configuration's existing web-server readiness limit, reused unchanged. */
const SERVER_READY_DEADLINE_MILLISECONDS = 300_000;
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
  maximumLoadFactor: number;
};

export type CompareOptions = {
  command: 'compare';
  baseline: string;
  candidate: string;
  output: string | undefined;
};

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
      'maximum-load-factor': { type: 'string', default: '3' },
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
    maximumLoadFactor: positiveNumber('maximum-load-factor', values['maximum-load-factor']),
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
    env: { ...process.env, ...options.environment },
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
    source: captureSourceState(REPOSITORY_ROOT),
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
    else if (performance.now() - startedAt > SERVER_READY_DEADLINE_MILLISECONDS) break;
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

function assertPlaywrightPortFree(): void {
  const result = Bun.spawnSync(['lsof', '-nP', `-iTCP:${PLAYWRIGHT_PORT}`, '-sTCP:LISTEN'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode === 0) {
    throw new Error(`Port ${PLAYWRIGHT_PORT} is already listening:\n${result.stdout.toString()}`);
  }
}

async function measurePlaywright(context: SampleContext): Promise<PlaywrightSample> {
  await prepareTemperature(context);
  assertPlaywrightPortFree();
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
    'Spawn of bun src/playground-server.ts to the first GET /ready answering 200 "ready", polled every 100 ms.',
  jsHeap:
    'Chromium JS heap through CDP Runtime.getHeapUsage after HeapProfiler.collectGarbage; never summed with RSS.',
  hostLoad:
    'uptime load averages and os.availableParallelism() captured before and after every sample.',
};

async function run(options: RunOptions): Promise<MeasurementResults> {
  await mkdir(options.workDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const has = (phase: Phase): boolean => options.phases.includes(phase);
  const results: MeasurementResults = {
    schema: RESULT_SCHEMA,
    label: options.label,
    startedAt,
    finishedAt: startedAt,
    environment: capturePinnedEnvironment(REPOSITORY_ROOT, PLAYGROUND_ROOT),
    routeInventory: [],
    definitions: DEFINITIONS,
    prerequisites: [],
    staticExport: [],
    serverReady: [],
    playwright: [],
    probes: {},
  };
  const checkpoint = async (): Promise<void> => {
    results.finishedAt = new Date().toISOString();
    await writeJson(options.output, results);
  };
  if (has('prerequisites')) {
    const loadWait = await settledLoad(options, 'prerequisites');
    process.stdout.write('[measure-playground] prerequisites\n');
    const hostLoadBefore = captureHostLoad();
    const source = captureSourceState(REPOSITORY_ROOT);
    const child = await spawnOwnedChild(['bun', 'install', '--frozen-lockfile'], {
      cwd: REPOSITORY_ROOT,
      logPath: join(options.workDirectory, 'prerequisites.log'),
    }).finish();
    results.prerequisites.push({
      pair: 1,
      loadWait,
      hostLoadBefore,
      hostLoadAfter: captureHostLoad(),
      source,
      child,
    });
    await checkpoint();
  }
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
  const survivors = [
    ...results.prerequisites,
    ...results.staticExport,
    ...results.serverReady,
    ...results.playwright,
  ].flatMap((sample) => sample.child.survivingPids);
  const failures = runFailures(results);
  if (survivors.length > 0)
    failures.push(`Processes outlived their measured child: ${survivors.join(', ')}`);
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
