/**
 * The watchdog over a pooled `bun test` run: a ceiling on the memory of its process tree, and a
 * guard for a test process whose event loop is blocked.
 *
 * On 2026-11-12 a `bun test` over an unbounded Svelte render loop grew to 144 GB in 13 minutes and
 * pushed a 64 GB host to 46 GB of swap. Nothing stopped it: the repository's one test deadline
 * (`scripts/test-deadlines.ts`) runs inside the test process, and a synchronous loop never lets it
 * fire. So the wrapper that starts every `bun test` (`runPooledBunTest` in
 * `scripts/bun-test-pool.ts`) watches the run from outside, once a second, and kills it when
 * either guard trips. Neither is a performance bound: a healthy run, however slow the host, trips
 * neither.
 *
 * Memory. Each sample adds up the leader, its descendants and its process group. On macOS a
 * process's memory is its physical footprint (`proc_pid_rusage`, the number Activity Monitor
 * shows), read through `bun:ffi` in about 30 microseconds: resident memory is the wrong number,
 * because the kernel compresses a runaway's pages (the run above showed 3 GB resident and 140 GB
 * compressed; one measured while this was written showed 11.7 GB from `ps -o rss` against a
 * footprint of 86 GB). `top -l 1` reports the same figure but takes four seconds. On Linux it is
 * `VmRSS` plus `VmSwap` from `/proc/<pid>/status`. A process whose footprint cannot be read counts
 * as its resident memory from `ps`. The ceiling is {@link defaultMemoryCeilingBytes}, or
 * `CORVIDAE_TEST_MEMORY_CEILING_MEGABYTES`.
 *
 * Stalls. Output cannot show progress: a lane that writes a JUnit report prints nothing while its
 * tests pass. So `runPooledBunTest` preloads `scripts/test-heartbeat.ts` into every test process,
 * which rewrites one small record, a counter and the current test file, before and after each
 * test. A process is stalled when its record has not changed for {@link stallGuardMilliseconds} of
 * awake time (the per-test deadline plus the hang guard, so Bun's own deadline always fires first
 * where it can) while that one process burned processor time for at least half of it. An idle
 * process is never stalled: its event loop is free, so its own deadline can fire. Awake time is
 * credited as `afterAwakeTime` credits it (`testing/testing/src/hang-guard.ts`): each sample
 * credits at most the interval it waited, so a host that slept credits one interval. The share of
 * processor time is the one heuristic here: a spinning process on a host so loaded that it gets
 * less than half a core is not reported, and the memory ceiling and the orphan watch
 * (`runInProcessGroup`) remain.
 *
 * A tripped guard kills the leader's process group and every process of the tree, by pid and only
 * a pid whose start time matches the sample, and the run exits with {@link runawayExitCode} after
 * one line that names the test files, the measurement and the limit.
 */

import { dlopen, ptr } from 'bun:ffi';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HANG_GUARD_MILLISECONDS } from '../testing/testing/src/hang-guard.ts';
import type { ProcessTable } from './bun-test-pool.ts';
import { TEST_TIMEOUT_MILLISECONDS } from './test-deadlines.ts';

/** Overrides the memory ceiling of a test run, in megabytes. */
export const memoryCeilingVariable = 'CORVIDAE_TEST_MEMORY_CEILING_MEGABYTES';

/** Names the directory a run's test processes write their heartbeat records in. */
export const heartbeatDirectoryVariable = 'CORVIDAE_TEST_HEARTBEATS';

/** When set, a run prints its peak memory and how many test processes reported, for measuring. */
export const watchdogReportVariable = 'CORVIDAE_TEST_WATCHDOG_REPORT';

/** The exit code of a run a guard killed: `EX_SOFTWARE`, an internal error in the program run. */
export const runawayExitCode = 70;

/**
 * The most memory a healthy test run's process tree may hold: 24 GiB, a little over twice the
 * heaviest lane. Measured peaks on 2026-11-12 (`CORVIDAE_TEST_WATCHDOG_REPORT=1`): the UI half of
 * Interborough's coverage run, one instrumented process, 10.4 GiB; Cinder's full suite 9.4 GiB and
 * chat's 6.0 GiB, each on four workers; Interborough's host lane 4.3 GiB and each of its UI shards
 * 2.8 to 3.6 GiB; no slow lane above 4.9 GiB. The runaway that prompted this grew by about 25 GB a
 * minute, so it would have been stopped within a minute.
 */
export const defaultMemoryCeilingBytes = 24 * 1024 ** 3;

/**
 * How long a test process may burn processor time without starting or finishing a test: Bun's
 * per-test deadline, then the hang guard as the margin, so the deadline's own diagnostic comes
 * first whenever the event loop is free to print it.
 */
export const stallGuardMilliseconds = TEST_TIMEOUT_MILLISECONDS + HANG_GUARD_MILLISECONDS;

/** The share of the stall guard a stalled process must have spent on the processor. */
export const stallProcessorShare = 0.5;

const sampleIntervalMilliseconds = 1000;

/** The ceiling: the variable when it is a positive whole number of megabytes, else the default. */
export function memoryCeilingBytes(
  environment: Readonly<Record<string, string | undefined>>,
): number {
  const override = environment[memoryCeilingVariable];
  if (override !== undefined && /^[1-9]\d*$/.test(override)) return Number(override) * 1024 ** 2;
  return defaultMemoryCeilingBytes;
}

const processorTime = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/;

/** The `time` column of `ps` (`[days-][hours:]minutes:seconds[.hundredths]`) in milliseconds. */
export function parseProcessorTime(text: string): number | undefined {
  const match = processorTime.exec(text.trim());
  if (match === null) return undefined;
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match;
  return Math.round(
    ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60_000 + Number(seconds) * 1000,
  );
}

/** `VmRSS` plus `VmSwap` of a `/proc/<pid>/status`, in bytes; undefined for a kernel thread. */
export function parseLinuxProcessMemory(status: string): number | undefined {
  const kilobytes = (name: string): number | undefined => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm').exec(status);
    return match === null ? undefined : Number(match[1]);
  };
  const resident = kilobytes('VmRSS');
  if (resident === undefined) return undefined;
  return (resident + (kilobytes('VmSwap') ?? 0)) * 1024;
}

/** Reads the memory one process holds, compressed and swapped pages included, in bytes. */
export type FootprintReader = (pid: number) => number | undefined;

// <sys/resource.h>: `proc_pid_rusage(pid, RUSAGE_INFO_V2, &info)` fills a `struct rusage_info_v2`,
// a 16-byte UUID followed by 64-bit fields, of which `ri_phys_footprint` is the eighth.
const rusageInfoVersion = 2;
const footprintField = 2 + 7;
const rusageInfoWords = 64;

function darwinFootprintReader(): FootprintReader | undefined {
  try {
    const library = dlopen('libproc.dylib', {
      proc_pid_rusage: { args: ['i32', 'i32', 'ptr'], returns: 'i32' },
    });
    const information = new BigUint64Array(rusageInfoWords);
    return (pid) => {
      // A failed call leaves the last process's numbers in the buffer.
      if (library.symbols.proc_pid_rusage(pid, rusageInfoVersion, ptr(information)) !== 0) {
        return undefined;
      }
      return Number(information[footprintField]);
    };
  } catch {
    return undefined;
  }
}

function linuxFootprint(pid: number): number | undefined {
  try {
    return parseLinuxProcessMemory(readFileSync(`/proc/${pid}/status`, 'utf8'));
  } catch {
    return undefined;
  }
}

/** This platform's reader, or undefined where only `ps` can tell a process's memory. */
export function footprintReader(platform: string = process.platform): FootprintReader | undefined {
  if (platform === 'darwin') return darwinFootprintReader();
  if (platform === 'linux') return linuxFootprint;
  return undefined;
}

/**
 * The leader, its descendants by parent, and every member of its process group, which keeps a
 * child that was reparented but never left the group. A Bun `--parallel` worker leads a group of
 * its own, so the parent links are what reach it.
 */
export function processTreeOf(leader: number, table: ProcessTable): number[] {
  const children = new Map<number, number[]>();
  const tree = new Set<number>();
  for (const [pid, entry] of table) {
    if (entry.processGroup === leader) tree.add(pid);
    if (entry.parent === undefined || entry.parent === pid) continue;
    children.set(entry.parent, [...(children.get(entry.parent) ?? []), pid]);
  }
  if (table.has(leader)) tree.add(leader);
  const pending = [...tree];
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    for (const child of children.get(pid) ?? []) {
      if (tree.has(child)) continue;
      tree.add(child);
      pending.push(child);
    }
  }
  return [...tree];
}

export type SampledProcess = {
  readonly pid: number;
  readonly startedAt: string;
  readonly memoryBytes: number;
  readonly cpuMilliseconds?: number;
};

export type TreeSample = { readonly totalBytes: number; readonly processes: SampledProcess[] };

/**
 * One sample of the run's tree. A process counts as its footprint, and never as less than the
 * resident memory `ps` reported, so an unreadable footprint under-counts rather than hides it.
 */
export function sampleTree(
  leader: number,
  table: ProcessTable,
  readFootprint: FootprintReader | undefined,
): TreeSample {
  const processes: SampledProcess[] = [];
  let totalBytes = 0;
  for (const pid of processTreeOf(leader, table).toSorted((left, right) => left - right)) {
    const entry = table.get(pid);
    if (entry === undefined) continue;
    const memoryBytes = Math.max(entry.residentBytes ?? 0, readFootprint?.(pid) ?? 0);
    totalBytes += memoryBytes;
    processes.push({
      pid,
      startedAt: entry.startedAt,
      memoryBytes,
      ...(entry.cpuMilliseconds === undefined ? {} : { cpuMilliseconds: entry.cpuMilliseconds }),
    });
  }
  return { totalBytes, processes };
}

/** What a test process last recorded: a counter, whether a test is running, and its file. */
export type Heartbeat = {
  readonly sequence: number;
  readonly state: string;
  readonly file: string;
};

/** The first line of a heartbeat record; undefined while it is not whole. */
export function parseHeartbeat(text: string): Heartbeat | undefined {
  const end = text.indexOf('\n');
  if (end === -1) return undefined;
  const [sequence, state, file] = text.slice(0, end).split('\t');
  if (sequence === undefined || !/^\d+$/.test(sequence) || state === undefined) return undefined;
  return { sequence: Number(sequence), state, file: file ?? '' };
}

/** The heartbeat of every test process that recorded one in `directory`, by pid. */
export function readHeartbeats(directory: string): Map<number, Heartbeat> {
  const heartbeats = new Map<number, Heartbeat>();
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return heartbeats;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const heartbeat = parseHeartbeat(readFileSync(join(directory, name), 'utf8'));
      if (heartbeat !== undefined) heartbeats.set(Number(name), heartbeat);
    } catch {
      // Removed between the listing and the read.
    }
  }
  return heartbeats;
}

export type StallObservation = Heartbeat & {
  readonly pid: number;
  readonly startedAt: string;
  readonly cpuMilliseconds: number | undefined;
};

export type StallState = Map<
  number,
  {
    startedAt: string;
    sequence: number;
    awakeMilliseconds: number;
    /** Processor time when the record last changed; undefined when it could not be read. */
    cpuAtProgress: number | undefined;
  }
>;

export type StalledProcess = {
  readonly pid: number;
  readonly startedAt: string;
  readonly file: string;
  readonly state: string;
  readonly awakeMilliseconds: number;
};

export type StallGuard = { readonly milliseconds: number; readonly processorShare: number };

/**
 * Credits `creditMilliseconds` of awake time to every observed process whose record has not
 * changed, and returns those now stalled: unchanged for the guard, with processor time of at least
 * the guard's share of it burned since. A changed record, a new process, or a pid with another
 * start time starts over; a process no longer observed is forgotten.
 */
export function advanceStalls(
  state: StallState,
  observations: readonly StallObservation[],
  creditMilliseconds: number,
  guard: StallGuard,
): StalledProcess[] {
  const stalled: StalledProcess[] = [];
  const observed = new Set<number>();
  for (const observation of observations) {
    observed.add(observation.pid);
    const known = state.get(observation.pid);
    if (
      known === undefined ||
      known.startedAt !== observation.startedAt ||
      known.sequence !== observation.sequence
    ) {
      state.set(observation.pid, {
        startedAt: observation.startedAt,
        sequence: observation.sequence,
        awakeMilliseconds: 0,
        cpuAtProgress: observation.cpuMilliseconds,
      });
      continue;
    }
    known.awakeMilliseconds += creditMilliseconds;
    if (known.awakeMilliseconds < guard.milliseconds) continue;
    if (known.cpuAtProgress === undefined || observation.cpuMilliseconds === undefined) continue;
    const burned = observation.cpuMilliseconds - known.cpuAtProgress;
    if (burned < guard.milliseconds * guard.processorShare) continue;
    stalled.push({
      pid: observation.pid,
      startedAt: observation.startedAt,
      file: observation.file,
      state: observation.state,
      awakeMilliseconds: known.awakeMilliseconds,
    });
  }
  for (const pid of state.keys()) if (!observed.has(pid)) state.delete(pid);
  return stalled;
}

function gibibytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

const notAFlake =
  'This is a runaway, not a flake: do not run it again until the loop or leak is fixed.';

/** The one line a run killed for memory prints. */
export function describeMemoryRunaway(runaway: {
  readonly totalBytes: number;
  readonly ceilingBytes: number;
  readonly files: readonly string[];
  /** The run's arguments, named when no test process had reported a file. */
  readonly run: string;
}): string {
  const running =
    runaway.files.length > 0
      ? `while running ${runaway.files.join(', ')}`
      : `before any test reported its file (bun test ${runaway.run})`;
  return `killed the test run: its processes reached ${gibibytes(runaway.totalBytes)} of memory, compressed and swapped pages included, above the ${gibibytes(runaway.ceilingBytes)} ceiling (${memoryCeilingVariable}), ${running}. Most likely an unbounded loop or a leak. ${notAFlake}`;
}

/** The one line a run killed for a blocked event loop prints. */
export function describeStall(stall: {
  readonly stalled: readonly StalledProcess[];
  readonly guardMilliseconds: number;
}): string {
  const where = stall.stalled
    .map((process) => {
      const doing = process.state === 'running' ? 'inside a test of' : 'between tests of';
      return `pid ${process.pid} ${doing} ${process.file === '' ? 'an unknown file' : process.file}`;
    })
    .join('; ');
  return `killed the test run: ${where} burned processor time for ${Math.round(stall.guardMilliseconds / 1000)} s of awake time without starting or finishing a test, so its event loop is blocked and the per-test deadline could not fire. Most likely a synchronous loop that never ends. ${notAFlake}`;
}

export type WatchdogOutcome = {
  /** The line to print when a guard killed the run. */
  readonly killed?: string;
  readonly peakBytes: number;
  /** The test processes that recorded a heartbeat at any time. */
  readonly heartbeatProcesses: number;
  /** The most processor time one test process burned without starting or finishing a test. */
  readonly longestBurnMilliseconds: number;
};

export type TestWatchdogOptions = {
  /** The `bun test` leader, which leads the run's process group. */
  readonly leader: number;
  readonly readProcessTable: () => ProcessTable | undefined;
  readonly ceilingBytes: number;
  /** Undefined when the run has no heartbeat directory, which leaves the stall guard off. */
  readonly heartbeatDirectory?: string;
  /** The run's arguments, for the line a kill prints. */
  readonly run: string;
  readonly stallGuard?: StallGuard;
  readonly sampleIntervalMilliseconds?: number;
  /** Defaults to this platform's {@link footprintReader}. */
  readonly readFootprint?: FootprintReader;
  /** Sends a signal to a pid, or to a process group when the pid is negative. */
  readonly signal?: (pid: number, signal: NodeJS.Signals) => void;
  readonly now?: () => number;
};

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Watches a running `bun test` until `stop` is called or a guard trips, sampling at once and then
 * every interval. A tripped guard kills the run and ends the watch; `stop` resolves to what it saw.
 */
export function startTestWatchdog(options: TestWatchdogOptions): {
  stop: () => Promise<WatchdogOutcome>;
} {
  const interval = options.sampleIntervalMilliseconds ?? sampleIntervalMilliseconds;
  const guard = options.stallGuard ?? {
    milliseconds: stallGuardMilliseconds,
    processorShare: stallProcessorShare,
  };
  const readFootprint = options.readFootprint ?? footprintReader();
  const signal = options.signal ?? sendSignal;
  const now = options.now ?? (() => performance.now());
  const stalls: StallState = new Map();
  const reported = new Set<number>();
  const { promise: stopped, resolve: markStopped } = Promise.withResolvers<void>();
  // Properties, so the loop sees `stop` and `look` set them across its awaits.
  const watching: { running: boolean; killed?: string } = { running: true };
  let peakBytes = 0;
  let longestBurnMilliseconds = 0;
  let last = now();

  // The leader's start time, from the first sample that shows it. A pid, and so a process group
  // id, is not reused while a member of the group lives, but it can be once the whole run is gone.
  let leaderStartedAt: string | undefined;
  /** Whether the pid of the leader now belongs to another process. */
  const leaderRecycled = (table: ProcessTable): boolean => {
    const startedAt = table.get(options.leader)?.startedAt;
    leaderStartedAt ??= startedAt;
    return startedAt !== undefined && startedAt !== leaderStartedAt;
  };

  const kill = (sample: TreeSample, table: ProcessTable): void => {
    // `look` has just found the leader's pid to be the run's own or gone, never another's.
    signal(-options.leader, 'SIGKILL');
    for (const sampled of sample.processes) {
      if (table.get(sampled.pid)?.startedAt === sampled.startedAt) signal(sampled.pid, 'SIGKILL');
    }
  };

  const look = (): void => {
    const current = now();
    const credit = Math.min(Math.max(0, current - last), interval);
    last = current;
    const table = options.readProcessTable();
    if (table === undefined) return;
    // The run is over and another process has its leader's pid: nothing here is the run's to
    // measure or to kill.
    if (leaderRecycled(table)) return;
    const sample = sampleTree(options.leader, table, readFootprint);
    peakBytes = Math.max(peakBytes, sample.totalBytes);
    const heartbeats =
      options.heartbeatDirectory === undefined
        ? new Map<number, Heartbeat>()
        : readHeartbeats(options.heartbeatDirectory);
    const observations: StallObservation[] = [];
    for (const sampled of sample.processes) {
      const heartbeat = heartbeats.get(sampled.pid);
      if (heartbeat === undefined) continue;
      reported.add(sampled.pid);
      observations.push({
        ...heartbeat,
        pid: sampled.pid,
        startedAt: sampled.startedAt,
        cpuMilliseconds: sampled.cpuMilliseconds,
      });
    }
    if (sample.totalBytes > options.ceilingBytes) {
      const files = new Set(
        observations.map((observation) => observation.file).filter((file) => file !== ''),
      );
      watching.killed = describeMemoryRunaway({
        totalBytes: sample.totalBytes,
        ceilingBytes: options.ceilingBytes,
        files: [...files],
        run: options.run,
      });
    } else {
      const stalled = advanceStalls(stalls, observations, credit, guard);
      for (const observation of observations) {
        const since = stalls.get(observation.pid)?.cpuAtProgress;
        if (since === undefined || observation.cpuMilliseconds === undefined) continue;
        longestBurnMilliseconds = Math.max(
          longestBurnMilliseconds,
          observation.cpuMilliseconds - since,
        );
      }
      if (stalled.length > 0) {
        watching.killed = describeStall({ stalled, guardMilliseconds: guard.milliseconds });
      }
    }
    if (watching.killed !== undefined) kill(sample, table);
  };

  const loop = (async () => {
    while (watching.running) {
      look();
      if (watching.killed !== undefined) break;
      await Promise.race([Bun.sleep(interval), stopped]);
    }
  })();

  return {
    stop: async () => {
      watching.running = false;
      markStopped();
      await loop;
      // A test process that started and finished between two samples left its record behind.
      if (options.heartbeatDirectory !== undefined) {
        for (const pid of readHeartbeats(options.heartbeatDirectory).keys()) reported.add(pid);
      }
      return {
        ...(watching.killed === undefined ? {} : { killed: watching.killed }),
        peakBytes,
        heartbeatProcesses: reported.size,
        longestBurnMilliseconds,
      };
    },
  };
}

/** The line a run prints under {@link watchdogReportVariable}. */
export function describeWatch(
  outcome: WatchdogOutcome,
  ceilingBytes: number,
  guard: StallGuard = { milliseconds: stallGuardMilliseconds, processorShare: stallProcessorShare },
): string {
  const burned = Math.round(outcome.longestBurnMilliseconds / 1000);
  const needed = Math.round((guard.milliseconds * guard.processorShare) / 1000);
  return `peak memory ${gibibytes(outcome.peakBytes)} of the ${gibibytes(ceilingBytes)} ceiling; ${outcome.heartbeatProcesses} test process(es) reported heartbeats; the longest stretch without a test starting or finishing burned ${burned} s of processor time, where a stall needs ${needed} s`;
}
