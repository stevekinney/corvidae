/**
 * Process ownership for the static production gate's runner.
 *
 * Every child the runner spawns leads its own process group, and every child runs with the
 * runner's run-owned temporary directory as `TMPDIR`, so anything that lands a path inside it on
 * its command line (Chromium's `--user-data-dir`, for one) is attributable to this run even when
 * it moved into a process group of its own. Ownership is therefore recomputed from the live
 * process table at every sweep, never from a list captured once: a member of an owned group, a
 * process whose arguments name the run directory, any group such a process leads, and every
 * descendant of those. A process spawned after an earlier sweep is found by the next one.
 *
 * Process groups are also RETAINED: every group led by an owned process is recorded the moment a
 * sweep observes it, and kept for the rest of the run. A detached grandchild with no run-directory
 * marker is reachable through the tree only while its parent lives; once the parent exits it is
 * reparented and only its retained group still identifies it. The owner therefore samples the
 * table every {@link SAMPLE_INTERVAL_MILLISECONDS} while the run is active, not only at cleanup.
 *
 * Residual window, which closing would need a supervisor or subreaper: a process that is spawned
 * into a new group, carries no run-directory marker, AND whose parent exits within one sample
 * interval of its spawn is never observed, so it is not retained and can outlive the run. Every
 * child the runner spawns, and every descendant that lives through one sample, is covered.
 *
 * Cleanup sends SIGTERM, waits up to {@link TERMINATION_GRACE_MILLISECONDS} for every owned
 * process to go and every child's output to close, then sends SIGKILL and waits the same again.
 * Each target is signaled at most once per phase, and a second cleanup call returns the first.
 */
import { constants } from 'node:os';

/** The cinder-era runner's grace between SIGTERM and SIGKILL. It is not to be increased. */
export const TERMINATION_GRACE_MILLISECONDS = 5_000;

const SWEEP_INTERVAL_MILLISECONDS = 50;

/** How often an active run samples the process table to retain the groups its descendants lead. */
export const SAMPLE_INTERVAL_MILLISECONDS = 200;

export type ProcessRow = { pid: number; ppid: number; pgid: number; state: string; args: string };

/** Read the whole process table. `-ww` keeps long command lines from being truncated. */
export function readProcessTable(): ProcessRow[] {
  const result = Bun.spawnSync(['ps', '-A', '-ww', '-o', 'pid=,ppid=,pgid=,stat=,args='], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`[static-playground] ps failed: ${result.stderr.toString().trim()}`);
  }
  return parseProcessTable(result.stdout.toString());
}

export function parseProcessTable(output: string): ProcessRow[] {
  return output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*?)\s*$/.exec(line);
    if (match === null) return [];
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        state: match[4]!,
        args: match[5] ?? '',
      },
    ];
  });
}

export function isZombie(row: ProcessRow): boolean {
  return row.state.startsWith('Z');
}

/** Every process below `rootPid` in the parent tree of `table`. */
export function descendantProcesses(rootPid: number, table: readonly ProcessRow[]): ProcessRow[] {
  const found: ProcessRow[] = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const parent = pending.pop()!;
    for (const row of table) {
      if (row.ppid !== parent) continue;
      found.push(row);
      pending.push(row.pid);
    }
  }
  return found;
}

export type OwnershipRoots = {
  /** Process groups the runner created: one per spawned child, led by that child. */
  groups: ReadonlySet<number>;
  /** The run-owned directory. A process naming it on its command line belongs to the run. */
  marker: string;
};

/**
 * Every process in `table` that belongs to the run, with the groups it owns. Pure, so tests can
 * feed it a synthetic table.
 */
export function ownedProcesses(
  table: readonly ProcessRow[],
  roots: OwnershipRoots,
  exclude: ReadonlySet<number> = new Set([process.pid]),
): { rows: ProcessRow[]; groups: Set<number> } {
  const groups = new Set(roots.groups);
  for (const row of table) {
    if (!exclude.has(row.pid) && row.pid === row.pgid && row.args.includes(roots.marker)) {
      groups.add(row.pgid);
    }
  }
  const owned = new Map<number, ProcessRow>();
  for (const row of table) {
    if (exclude.has(row.pid)) continue;
    if (groups.has(row.pgid) || row.args.includes(roots.marker)) owned.set(row.pid, row);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of table) {
      if (exclude.has(row.pid) || owned.has(row.pid) || !owned.has(row.ppid)) continue;
      owned.set(row.pid, row);
      grew = true;
    }
  }
  return { rows: [...owned.values()], groups };
}

export type Signaler = (target: number, signal: NodeJS.Signals) => void;

/** `process.kill`, quiet when the target is already gone. A negative target is a group. */
export const signalTarget: Signaler = (target, signal) => {
  try {
    process.kill(target, signal);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ESRCH') throw error;
  }
};

export function signalNumber(signal: NodeJS.Signals): number {
  return constants.signals[signal];
}

export type OwnedChild = {
  name: string;
  subprocess: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  /** Settles when both output pipes close, which needs every holder of them gone. */
  outputClosed: Promise<void>;
};

async function forward(stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream) {
  for await (const chunk of stream) target.write(chunk);
}

export type ProcessOwnerOptions = {
  marker: string;
  readTable?: () => ProcessRow[];
  signal?: Signaler;
};

export type CleanupResult = {
  /** Every signal sent, as `[target, signal]`; a negative target is a process group. */
  signals: [target: number, signal: NodeJS.Signals][];
  /** Owned processes still alive after SIGKILL and its grace. */
  survivors: ProcessRow[];
  /** Every owned process is gone, every child has exited, and every output pipe has closed. */
  complete: boolean;
};

export class ProcessOwner {
  readonly #marker: string;
  readonly #readTable: () => ProcessRow[];
  readonly #signal: Signaler;
  readonly #children: OwnedChild[] = [];
  readonly #groups = new Set<number>();
  #cleanup: Promise<CleanupResult> | undefined;
  #sampler: ReturnType<typeof setInterval> | undefined;

  constructor(options: ProcessOwnerOptions) {
    this.#marker = options.marker;
    this.#readTable = options.readTable ?? readProcessTable;
    this.#signal = options.signal ?? signalTarget;
  }

  /** Spawn `command` as the leader of a new process group, forwarding its output. */
  spawn(name: string, command: string[], options: { cwd: string; env: Record<string, string> }) {
    if (this.#cleanup !== undefined) throw new Error(`[static-playground] cannot spawn ${name}`);
    const subprocess = Bun.spawn(command, {
      cwd: options.cwd,
      env: options.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
    this.#groups.add(subprocess.pid);
    if (this.#sampler === undefined) {
      this.#sampler = setInterval(() => this.owned(), SAMPLE_INTERVAL_MILLISECONDS);
      this.#sampler.unref();
    }
    const outputClosed = Promise.all([
      forward(subprocess.stdout, process.stdout),
      forward(subprocess.stderr, process.stderr),
    ]).then(() => undefined);
    const child: OwnedChild = { name, subprocess, outputClosed };
    this.#children.push(child);
    return child;
  }

  /** The processes that belong to the run right now. Every group one of them leads is retained. */
  owned(): { rows: ProcessRow[]; groups: Set<number> } {
    const owned = ownedProcesses(this.#readTable(), { groups: this.#groups, marker: this.#marker });
    for (const row of owned.rows) {
      if (row.pid === row.pgid && !isZombie(row)) this.#groups.add(row.pgid);
    }
    for (const group of this.#groups) owned.groups.add(group);
    return owned;
  }

  /** The process groups retained so far, for tests and diagnostics. */
  retainedGroups(): ReadonlySet<number> {
    return this.#groups;
  }

  /** Terminate everything the run owns. Calling it again returns the first call's result. */
  cleanup(): Promise<CleanupResult> {
    this.#cleanup ??= this.#terminate();
    return this.#cleanup;
  }

  async #terminate(): Promise<CleanupResult> {
    clearInterval(this.#sampler);
    const signals: CleanupResult['signals'] = [];
    let outputClosed = false;
    void Promise.all(this.#children.map((child) => child.outputClosed)).then(() => {
      outputClosed = true;
      return undefined;
    });
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const signaled = new Set<number>();
      const deadline = performance.now() + TERMINATION_GRACE_MILLISECONDS;
      for (;;) {
        const { rows, groups } = this.owned();
        const living = rows.filter((row) => !isZombie(row));
        if (living.length === 0 && this.#childrenExited() && outputClosed) {
          return { signals, survivors: [], complete: true };
        }
        const targets = [
          ...[...groups].map((group) => -group),
          ...living.filter((row) => !groups.has(row.pgid)).map((row) => row.pid),
        ];
        for (const target of targets) {
          if (signaled.has(target)) continue;
          signaled.add(target);
          signals.push([target, signal]);
          this.#signal(target, signal);
        }
        if (performance.now() >= deadline) break;
        await Bun.sleep(SWEEP_INTERVAL_MILLISECONDS);
      }
    }
    const survivors = this.owned().rows.filter((row) => !isZombie(row));
    return { signals, survivors, complete: false };
  }

  #childrenExited(): boolean {
    return this.#children.every(
      (child) => child.subprocess.exitCode !== null || child.subprocess.signalCode !== null,
    );
  }
}

/**
 * Stop a gate runner that a check or test started, leaving nothing behind: interrupt it the way a
 * reader's Ctrl-C would and give its own cleanup the termination grace, then SIGKILL whatever is
 * still attributable to it. Attribution uses the process groups of everything below the runner,
 * captured BEFORE the interrupt (its children lead their own groups and outlive a killed parent),
 * plus any process naming the run-owned `marker` directory, such as a browser profile.
 *
 * @returns the processes still alive afterwards; empty when the stop succeeded.
 */
export async function interruptRunner(
  runner: Bun.Subprocess,
  marker: string | undefined,
  readTable: () => ProcessRow[] = readProcessTable,
): Promise<ProcessRow[]> {
  const ownGroup = readTable().find((row) => row.pid === process.pid)?.pgid;
  const groups = new Set(
    descendantProcesses(runner.pid, readTable())
      .map((row) => row.pgid)
      .filter((group) => group !== ownGroup),
  );
  if (runner.exitCode === null && runner.signalCode === null) {
    runner.kill('SIGINT');
    await Promise.race([runner.exited, Bun.sleep(TERMINATION_GRACE_MILLISECONDS)]);
  }
  const attributable = (): ProcessRow[] =>
    readTable().filter(
      (row) =>
        !isZombie(row) &&
        row.pid !== process.pid &&
        row.pgid !== ownGroup &&
        (groups.has(row.pgid) || (marker !== undefined && row.args.includes(marker))),
    );
  const survivors = attributable();
  for (const group of new Set([...groups, ...survivors.map((row) => row.pgid)])) {
    signalTarget(-group, 'SIGKILL');
  }
  for (const row of survivors) signalTarget(row.pid, 'SIGKILL');
  if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
  await runner.exited;
  const deadline = performance.now() + TERMINATION_GRACE_MILLISECONDS;
  while (attributable().length > 0 && performance.now() < deadline) {
    await Bun.sleep(SWEEP_INTERVAL_MILLISECONDS);
  }
  return attributable();
}
