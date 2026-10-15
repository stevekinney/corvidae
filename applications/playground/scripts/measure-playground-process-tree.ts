/**
 * Owned process-tree resident memory for `measure-playground.ts` (CIN-585).
 *
 * One observer samples `ps` every 100 ms and sums the resident size of a root process and every
 * descendant. The same observer runs for the baseline and the candidate, so its own cost (one `ps`
 * spawn per sample) is identical on both sides. `ps` reports `rss` in kibibytes on macOS and Linux;
 * every value this module returns is converted to bytes and named accordingly.
 *
 * The sampled tree peak is a different number from a child's `resourceUsage().maxRSS`: that is one
 * process's own high-water mark, while this is the largest instantaneous sum across the tree that
 * a 100 ms observer saw. The decision document reports them separately.
 */

export type ProcessRow = { pid: number; parentPid: number; residentKibibytes: number };

/** Parse `ps -axo pid=,ppid=,rss=` output. Lines that are not three integers are ignored. */
export function parseProcessTable(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(line);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      residentKibibytes: Number(match[3]),
    });
  }
  return rows;
}

/** The root and every process descended from it, as present in `rows`. */
export function descendantsOf(rootPid: number, rows: readonly ProcessRow[]): Set<number> {
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    const siblings = childrenByParent.get(row.parentPid) ?? [];
    siblings.push(row.pid);
    childrenByParent.set(row.parentPid, siblings);
  }
  const owned = new Set<number>();
  if (!rows.some((row) => row.pid === rootPid)) return owned;
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (owned.has(pid)) continue;
    owned.add(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return owned;
}

export type TreeReading = { residentBytes: number; processCount: number; pids: number[] };

/** Sum the resident bytes of every process owned by the given roots, counting each process once. */
export function treeResidentBytes(
  rootPids: readonly number[],
  rows: readonly ProcessRow[],
): TreeReading {
  const owned = new Set<number>();
  for (const rootPid of rootPids) {
    for (const pid of descendantsOf(rootPid, rows)) owned.add(pid);
  }
  let residentKibibytes = 0;
  for (const row of rows) {
    if (owned.has(row.pid)) residentKibibytes += row.residentKibibytes;
  }
  return {
    residentBytes: residentKibibytes * 1024,
    processCount: owned.size,
    pids: [...owned].toSorted((left, right) => left - right),
  };
}

export type TreeSample = {
  elapsedMilliseconds: number;
  residentBytes: number;
  processCount: number;
};

export type TreeSampleSeries = {
  intervalMilliseconds: number;
  sampleCount: number;
  /** Ticks skipped because the previous `ps` read had not finished. */
  skippedTicks: number;
  /** Reads of the process table that failed; a sample with none successful has no peak at all. */
  failedReads: number;
  /** The first few failure messages, kept so a failed observer is diagnosable. */
  failureMessages: string[];
  /** Successful reads of `kern.memorystatus_vm_pressure_level`, one per tick. */
  pressureReadings: number;
  /** The highest pressure level read (1 normal, 2 warning, 4 critical), or null when none was read. */
  maximumPressureLevel: number | null;
  peakResidentBytes: number;
  peakProcessCount: number;
  /** Every pid the observer attributed to the tree at any sample. */
  observedPids: number[];
  samples: TreeSample[];
};

export type TreeSamplerOptions = {
  rootPids: () => readonly number[];
  readProcessTable?: () => Promise<string>;
  /** Reads the host's memory-pressure level once per tick; null when it cannot be read. */
  readPressureLevel?: () => Promise<number | null>;
  intervalMilliseconds?: number;
  now?: () => number;
};

const MAXIMUM_RETAINED_FAILURE_MESSAGES = 5;

/**
 * Read macOS's memory-pressure level (1 normal, 2 warning, 4 critical). Null elsewhere, or when the
 * value cannot be read, so a missing reading is visible rather than mistaken for normal.
 */
export async function readSystemPressureLevel(): Promise<number | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const child = Bun.spawn(['sysctl', '-n', 'kern.memorystatus_vm_pressure_level'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const level = Number(output.trim());
    return exitCode === 0 && Number.isInteger(level) ? level : null;
  } catch {
    return null;
  }
}

export async function readSystemProcessTable(): Promise<string> {
  const child = Bun.spawn(['ps', '-axo', 'pid=,ppid=,rss='], { stdout: 'pipe', stderr: 'ignore' });
  const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`ps exited ${exitCode}`);
  return output;
}

/**
 * Sample the owned tree on a fixed cadence until `stop()` resolves the series.
 *
 * A tick that arrives while the previous read is still running is skipped and counted, rather
 * than queued, so a slow `ps` on a loaded host lowers the sample count instead of stacking reads.
 */
export function startTreeSampler(options: TreeSamplerOptions): {
  stop: () => Promise<TreeSampleSeries>;
} {
  const intervalMilliseconds = options.intervalMilliseconds ?? 100;
  const readProcessTable = options.readProcessTable ?? readSystemProcessTable;
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const samples: TreeSample[] = [];
  const observedPids = new Set<number>();
  let skippedTicks = 0;
  let failedReads = 0;
  let pressureReadings = 0;
  let maximumPressureLevel: number | null = null;
  const readPressureLevel = options.readPressureLevel ?? readSystemPressureLevel;
  const failureMessages: string[] = [];
  let inFlight: Promise<void> | null = null;

  const samplePressure = async (): Promise<void> => {
    const level = await readPressureLevel().catch(() => null);
    if (level === null) return;
    pressureReadings += 1;
    maximumPressureLevel = Math.max(maximumPressureLevel ?? level, level);
  };

  const sampleOnce = async (): Promise<void> => {
    // Pressure is read on every tick, alongside the process table.
    const pressure = samplePressure();
    const rootPids = options.rootPids();
    if (rootPids.length === 0) {
      await pressure;
      return;
    }
    const [table] = await Promise.all([readProcessTable(), pressure]);
    const reading = treeResidentBytes(rootPids, parseProcessTable(table));
    if (reading.processCount === 0) return;
    for (const pid of reading.pids) observedPids.add(pid);
    samples.push({
      elapsedMilliseconds: now() - startedAt,
      residentBytes: reading.residentBytes,
      processCount: reading.processCount,
    });
  };

  const tick = (): void => {
    if (inFlight !== null) {
      skippedTicks += 1;
      return;
    }
    inFlight = sampleOnce()
      .catch((error: unknown) => {
        failedReads += 1;
        if (failureMessages.length < MAXIMUM_RETAINED_FAILURE_MESSAGES) {
          failureMessages.push(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        inFlight = null;
      });
  };

  tick();
  const timer = setInterval(tick, intervalMilliseconds);

  return {
    stop: async () => {
      clearInterval(timer);
      await inFlight;
      return {
        intervalMilliseconds,
        sampleCount: samples.length,
        skippedTicks,
        failedReads,
        failureMessages,
        pressureReadings,
        maximumPressureLevel,
        peakResidentBytes: Math.max(0, ...samples.map((sample) => sample.residentBytes)),
        peakProcessCount: Math.max(0, ...samples.map((sample) => sample.processCount)),
        observedPids: [...observedPids].toSorted((left, right) => left - right),
        samples,
      };
    },
  };
}
