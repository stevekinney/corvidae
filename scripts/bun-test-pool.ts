/**
 * The host-wide pool of Bun test worker slots.
 *
 * Sessions, worktrees and turbo tasks multiply: several sessions each run several test tasks, and
 * each task starts up to four Bun workers, which loaded this 12-core host to an average of 60–95.
 * Every `bun test` the gate starts goes through `scripts/bun-test.ts`, `scripts/bun-test-junit.ts`
 * or `scripts/bun-test-selected.ts` (or, for the few runners that start `bun test` themselves,
 * through {@link runPooledBunTest} directly), and each takes one slot per worker before it starts,
 * so the Bun test workers on the host never exceed the pool's size, whoever starts them. `tsc`,
 * `svelte-check` and oxlint start no Bun test worker and stay outside the pool; the host lock,
 * which serializes the heavy stages, and the turbo concurrency cap bound them. Browser suites,
 * captures, the Docker renderer and fan-outs of worker processes take slots from this pool too,
 * one per process they keep busy, through `scripts/host-slots.ts`
 * (`documentation/repository/host-admission.md`).
 *
 * The pool lives in the Git common directory, which every worktree shares, as
 * `corvidae-test-slots/`. Each slot is a directory `slot-<i>`, for `i` below the pool's size,
 * installed the way the host lock is (`scripts/run-exclusively.ts`): renamed into place with its
 * owner file inside, so two acquirers can never both hold one slot, and the cap holds by
 * construction. A run takes all the slots it needs or none: a partial claim is given back, so two
 * runs can never each hold part of what both wait for.
 *
 * Waiters take slots in arrival order through the host lock's ticket queue (`queue/`), so a large
 * request is never overtaken by later small ones, and a small one behind it waits its turn. Only
 * the waiter at the front claims. Waiting is on state, not on time: the front waiter looks again
 * every quarter second and prints a line whenever what it waits for changes. Waiting has no deadline,
 * because running past it would break the cap; it is bounded by the holders, whose tests the hang
 * guard bounds.
 *
 * Bun's `--parallel` workers (`bun test --test-worker`) are children of the `bun test` leader but
 * each leads a process group of its own, and they outlive a leader killed with SIGKILL. So while a
 * pooled run lives, its wrapper records the leader's test-worker descendants (pid and start time)
 * in its slot records: at once, then every quarter second until all its workers are recorded, then
 * every second. The record only grows, less the workers seen to exit. A slot is held while its
 * run's wrapper, any process in its `bun test` process group, or any recorded worker is alive,
 * judged from one `ps` snapshot by pid, process group and the start time recorded beside each, so
 * a recycled pid never passes for a holder. When the wrapper exits, normally or on a forwarded
 * signal, it terminates the recorded workers before it releases; a reclaimer that finds a holder
 * whose wrapper and group are gone but whose recorded workers live terminates them (SIGTERM, then
 * SIGKILL, only a pid whose start time matches and whose command is still a Bun test worker) and
 * reclaims only once none is left. A holder killed with SIGKILL therefore keeps its slots exactly as
 * long as its workers run, with no timeout. The remaining window: a worker started after the last
 * refresh and before the leader is killed is not recorded, so it is neither counted nor terminated.
 * An unreadable slot or ticket is garbage and is reclaimed at once, since this module never leaves
 * one.
 *
 * A wrapper started inside a run that holds slots (a test that itself runs a wrapper) finds its
 * parent's token in `CORVIDAE_TEST_SLOTS_TOKEN` and runs inside the parent's slots, with its
 * `--parallel` clamped to the slots the parent holds, so it neither waits on its own parent nor
 * counts twice. The token is honoured only while a live slot names it.
 *
 * The pool's size is {@link defaultPoolSize}, or `CORVIDAE_TEST_SLOTS` when set. A request above it
 * is clamped: the run holds every slot and its `--parallel` is rewritten to the pool's size, so the
 * slots held always equal the workers running. A checkout whose wrappers predate the pool simply
 * goes uncounted. When the pool cannot be used at all, the run warns and runs without a slot.
 *
 * Usage: `bun scripts/bun-test-pool.ts status [--pool <directory>] [--size <n>]` prints the holders
 * and the free slots.
 */

import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';

import { rootScriptEnvironment } from './environment-configuration.ts';
import {
  enqueue,
  gitCommonDirectory,
  liveFront,
  ownerFileName,
  pidStartedAtField,
  processStartTime,
  processTableEnvironment,
  readOwner,
  readTicket,
  reclaimAbandoned,
  removeLock,
  runInProcessGroup,
  tryInstall,
  type HostLockHolder,
  type OwnerRecord,
} from './run-exclusively.ts';
import { TEST_TIMEOUT_ARGUMENT } from './test-deadlines.ts';

/** Overrides the pool's size, for CI runners and the dev container. */
export const poolSizeVariable = 'CORVIDAE_TEST_SLOTS';

/** Names the slots a run holds, in the environment of the `bun test` it starts. */
export const heldSlotsTokenVariable = 'CORVIDAE_TEST_SLOTS_TOKEN';

/** The pool's directory inside the Git common directory. */
export const poolDirectoryName = 'corvidae-test-slots';

/** The largest `--parallel` any lane uses, so no lane is clamped on a small host by default. */
export const minimumPoolSize = 4;

/** Processors left to `tsc`, turbo, and the sessions themselves. */
const processorsLeftOver = 2;

/** Memory budgeted to each Bun test worker: Cinder's four-worker run peaked at 7.8 GB. */
export const memoryPerTestWorker = 3 * 1024 ** 3;

/** The default `bun test` command, with the repository's per-test deadline. */
export const bunTestCommand = ['bun', 'test', TEST_TIMEOUT_ARGUMENT] as const;

export type Host = { readonly processors: number; readonly totalMemoryBytes: number };

function currentHost(): Host {
  return { processors: cpus().length, totalMemoryBytes: totalmem() };
}

/**
 * `max(4, min(processors − 2, floor(memory / 3 GiB)))`: one worker per processor, less two for
 * everything else, and no more than memory allows. 10 on a 12-core, 32 GB host; 4 on a 4-vCPU,
 * 16 GB runner, where the floor keeps the `--parallel=4` lanes unclamped.
 */
export function defaultPoolSize(host: Host = currentHost()): number {
  return Math.max(
    minimumPoolSize,
    Math.min(
      host.processors - processorsLeftOver,
      Math.floor(host.totalMemoryBytes / memoryPerTestWorker),
    ),
  );
}

/** The pool's size: `CORVIDAE_TEST_SLOTS` when it is a positive integer, the default otherwise. */
export function poolSize(
  environment: Readonly<Record<string, string | undefined>>,
  host: Host = currentHost(),
): number {
  const override = environment[poolSizeVariable];
  if (override !== undefined && /^[1-9]\d*$/.test(override)) return Number(override);
  return defaultPoolSize(host);
}

const parallelArgument = /^--parallel(?:=(\d+))?$/;

/** The Bun workers a `bun test` argument list starts: `--parallel=k`, the processors for a bare `--parallel`, else one. */
export function requestedWorkers(
  argumentsList: readonly string[],
  processors: number = cpus().length,
): number {
  let workers = 1;
  for (const argument of argumentsList) {
    const match = parallelArgument.exec(argument);
    if (match) workers = Math.max(1, match[1] === undefined ? processors : Number(match[1]));
  }
  return workers;
}

/** `argumentsList` with every `--parallel` set to `workers`. */
export function withWorkerCount(argumentsList: readonly string[], workers: number): string[] {
  return argumentsList.map((argument) =>
    parallelArgument.test(argument) ? `--parallel=${workers}` : argument,
  );
}

export type ProcessEntry = {
  readonly processGroup: number;
  readonly startedAt: string;
  /** The parent's pid. */
  readonly parent?: number;
  /** The command line. */
  readonly command?: string;
};

/** A snapshot of the host's processes by pid. */
export type ProcessTable = ReadonlyMap<number, ProcessEntry>;

/** `lstart` under the C locale, kept byte for byte as `processStartTime` prints it. */
const processLine =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*(.*?)\s*$/;

/**
 * One `ps` snapshot of every process, with the same `lstart` text `processStartTime` records.
 * Undefined when `ps` fails or the snapshot lacks this process: a holder must never be judged
 * dead from a table that cannot be trusted.
 */
export function readProcessTable(): ProcessTable | undefined {
  const result = Bun.spawnSync(['ps', '-A', '-ww', '-o', 'pid=,ppid=,pgid=,lstart=,command='], {
    env: processTableEnvironment(),
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (result.exitCode !== 0) return undefined;
  const table = new Map<number, ProcessEntry>();
  for (const line of result.stdout.toString().split('\n')) {
    const match = processLine.exec(line);
    if (match?.[4] !== undefined) {
      table.set(Number(match[1]), {
        parent: Number(match[2]),
        processGroup: Number(match[3]),
        startedAt: match[4],
        command: match[5] ?? '',
      });
    }
  }
  return table.has(process.pid) ? table : undefined;
}

/** A Bun `--parallel` worker, recorded by pid and start time. */
export type RecordedWorker = { readonly pid: number; readonly startedAt: string };

const testWorkerCommand = /(?:^|\/)bun\s+test\s(?:.*\s)?--test-worker(?:\s|$)/;

/** Whether a command line is a Bun test worker's. */
export function isTestWorkerCommand(command: string | undefined): boolean {
  return command !== undefined && testWorkerCommand.test(command);
}

/** The Bun test workers among the descendants of `leader`. */
export function testWorkersOf(leader: number, table: ProcessTable): RecordedWorker[] {
  const children = new Map<number, number[]>();
  for (const [pid, entry] of table) {
    if (entry.parent === undefined || pid === entry.parent) continue;
    children.set(entry.parent, [...(children.get(entry.parent) ?? []), pid]);
  }
  const workers: RecordedWorker[] = [];
  const seen = new Set([leader]);
  const pending = [...(children.get(leader) ?? [])];
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    const entry = table.get(pid);
    if (isTestWorkerCommand(entry?.command) && entry !== undefined) {
      workers.push({ pid, startedAt: entry.startedAt });
    }
    pending.push(...(children.get(pid) ?? []));
  }
  return workers;
}

/** The recorded workers that are alive, by pid and start time; a malformed record names none. */
export function liveRecordedWorkers(workers: unknown, table: ProcessTable): RecordedWorker[] {
  if (!Array.isArray(workers)) return [];
  return workers.filter(
    (worker: RecordedWorker) =>
      typeof worker?.pid === 'number' && table.get(worker.pid)?.startedAt === worker.startedAt,
  );
}

/**
 * Whether the run that wrote `owner` is alive: its wrapper, by pid and start time, any member of
 * its recorded process group, unless a new process now leads a group with that id, or any of its
 * recorded workers, by pid and start time.
 */
export function isHolderAlive(owner: OwnerRecord, table: ProcessTable): boolean {
  return (
    isRunAlive(owner, table) || liveRecordedWorkers((owner as SlotOwner).workers, table).length > 0
  );
}

/** Whether the wrapper or the `bun test` process group of `owner` is alive. */
function isRunAlive(owner: OwnerRecord, table: ProcessTable): boolean {
  const own = table.get(owner.pid);
  if (own && (owner.pidStartedAt === undefined || own.startedAt === owner.pidStartedAt)) {
    return true;
  }
  const group = owner.processGroup;
  if (group === undefined) return false;
  const leader = table.get(group);
  const recycled =
    leader !== undefined &&
    owner.processGroupStartedAt !== undefined &&
    leader.startedAt !== owner.processGroupStartedAt;
  if (recycled) return false;
  for (const entry of table.values()) if (entry.processGroup === group) return true;
  return false;
}

/**
 * The owner record of one slot: the host lock's, plus the slots its run holds in all and the Bun
 * test workers its wrapper has seen.
 */
export type SlotOwner = OwnerRecord & {
  readonly slots: number;
  readonly workers?: readonly RecordedWorker[];
};

/** Sends a signal to one process; tests of the pool substitute a recorder. */
export type SignalProcess = (pid: number, signal: NodeJS.Signals) => void;

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

export type TerminateWorkersOptions = {
  readonly readProcessTable: () => ProcessTable | undefined;
  readonly signalProcess?: SignalProcess;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

/** How long recorded workers get to exit after SIGTERM, and then after SIGKILL. */
const workerGraceMs = 2000;
const workerExitPollMs = 50;

/**
 * Terminates the recorded workers that are still alive: SIGTERM, then SIGKILL, each sent only to a
 * pid whose start time matches the record and whose command is still a Bun test worker's. Resolves
 * to whether none of them is left.
 */
export async function terminateRecordedWorkers(
  workers: readonly RecordedWorker[],
  options: TerminateWorkersOptions,
): Promise<boolean> {
  const send = options.signalProcess ?? signalProcess;
  const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const signalAll = (signal: NodeJS.Signals): number => {
    const table = options.readProcessTable();
    if (table === undefined) return 0;
    const targets = liveRecordedWorkers(workers, table).filter((worker) =>
      isTestWorkerCommand(table.get(worker.pid)?.command),
    );
    for (const worker of targets) send(worker.pid, signal);
    return targets.length;
  };
  const gone = (): boolean => {
    const table = options.readProcessTable();
    return table !== undefined && liveRecordedWorkers(workers, table).length === 0;
  };
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (gone()) return true;
    if (signalAll(signal) === 0) return false;
    for (let waited = 0; ; waited += workerExitPollMs) {
      if (gone()) return true;
      if (waited >= workerGraceMs) break;
      await sleep(workerExitPollMs);
    }
  }
  return gone();
}

export function slotDirectory(poolDirectory: string, index: number): string {
  return join(poolDirectory, `slot-${index}`);
}

const slotName = /^slot-\d+$/;

function queueDirectory(poolDirectory: string): string {
  return join(poolDirectory, 'queue');
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * The free slots below `size` and the owners of the held ones. A holder whose wrapper and group are
 * gone but whose recorded workers live has them terminated first, and stays a holder if any is
 * left. A slot whose holder is dead, or that holds garbage, is reclaimed; the host lock's reclaim
 * judges it again under its guard, so a slot installed meanwhile is never removed.
 */
async function surveySlots(
  poolDirectory: string,
  size: number,
  options: TerminateWorkersOptions,
): Promise<{ free: number[]; holders: SlotOwner[] }> {
  const free: number[] = [];
  const holders: SlotOwner[] = [];
  let table = options.readProcessTable();
  for (let index = 0; index < size; index++) {
    const directory = slotDirectory(poolDirectory, index);
    const owner = (await readOwner(directory)) as SlotOwner | undefined;
    const orphans =
      owner === undefined || table === undefined || isRunAlive(owner, table)
        ? []
        : liveRecordedWorkers(owner.workers, table);
    if (orphans.length > 0) {
      await terminateRecordedWorkers(orphans, options);
      table = options.readProcessTable();
    }
    if (owner !== undefined && (table === undefined || isHolderAlive(owner, table))) {
      holders.push(owner);
      continue;
    }
    if (owner !== undefined || (await exists(directory))) await reclaimAbandoned(directory, 0);
    if (!(await exists(directory))) free.push(index);
    else if (owner !== undefined) holders.push(owner);
  }
  return { free, holders };
}

/**
 * Takes `count` of the `free` slots by installing each, or none: a partial claim is given back, so
 * two claimants never each keep part of what both need. Resolves to the slots taken.
 */
export async function claimSlots(
  poolDirectory: string,
  free: readonly number[],
  count: number,
  self: SlotOwner,
): Promise<number[] | undefined> {
  const taken: number[] = [];
  for (const index of free) {
    if (taken.length === count) break;
    if (await tryInstall(slotDirectory(poolDirectory, index), self)) taken.push(index);
  }
  if (taken.length === count) return taken;
  await Promise.all(taken.map((index) => removeLock(slotDirectory(poolDirectory, index), self)));
  return undefined;
}

export type HeldTestSlots = {
  /** Names these slots; a wrapper started under them presents it to run inside them. */
  readonly token: string;
  readonly slots: readonly number[];
  /** Records the `bun test` process group, so the slots outlive a wrapper killed before it. */
  readonly recordProcessGroup: (processGroup: number) => Promise<void>;
  /** Records the run's Bun test workers, so the slots outlive a leader killed before them. */
  readonly recordWorkers: (workers: readonly RecordedWorker[]) => Promise<void>;
  readonly release: () => Promise<void>;
};

export type AcquireTestSlotsOptions = {
  readonly poolDirectory: string;
  readonly size: number;
  /** Clamped to `1..size`. */
  readonly slots: number;
  readonly holder: HostLockHolder;
  readonly pollIntervalMs?: number;
  readonly readProcessTable?: () => ProcessTable | undefined;
  /** Waits between looks, and while an orphaned holder's workers exit. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Terminates an orphaned holder's workers; defaults to `process.kill`. */
  readonly signalProcess?: SignalProcess;
  /** Called with a line each time what the waiter waits for changes. */
  readonly onWait?: (line: string) => void;
  readonly signal?: AbortSignal;
};

function describeOwner(owner: SlotOwner | OwnerRecord | undefined): string {
  if (owner === undefined) return 'a waiter that has not recorded itself yet';
  const slots = 'slots' in owner ? `${owner.slots} slot(s), ` : '';
  return `pid ${owner.pid} (${slots}${owner.cwd})`;
}

/** Waits until it holds `slots` slots of the pool. */
export async function acquireTestSlots(options: AcquireTestSlotsOptions): Promise<HeldTestSlots> {
  const count = Math.min(Math.max(1, options.slots), options.size);
  const self: SlotOwner = { ...options.holder, token: crypto.randomUUID(), slots: count };
  const queue = queueDirectory(options.poolDirectory);
  options.signal?.throwIfAborted();
  await mkdir(options.poolDirectory, { recursive: true });
  const ticket = await enqueue(queue, self);
  try {
    return await waitForSlots(options, self, count, ticket);
  } finally {
    await rm(join(queue, ticket), { force: true });
  }
}

async function waitForSlots(
  options: AcquireTestSlotsOptions,
  self: SlotOwner,
  count: number,
  ticket: string,
): Promise<HeldTestSlots> {
  const { poolDirectory, size, pollIntervalMs = 250 } = options;
  const read = options.readProcessTable ?? readProcessTable;
  const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const queue = queueDirectory(poolDirectory);
  let lastLine: string | undefined;
  const waitingOn = (line: string): void => {
    if (line === lastLine) return;
    lastLine = line;
    options.onWait?.(line);
  };
  for (;;) {
    options.signal?.throwIfAborted();
    const front = await liveFront(queue, ticket);
    if (front === ticket) {
      const { free, holders } = await surveySlots(poolDirectory, size, {
        readProcessTable: read,
        sleep,
        ...(options.signalProcess === undefined ? {} : { signalProcess: options.signalProcess }),
      });
      if (free.length >= count) {
        const taken = await claimSlots(poolDirectory, free, count, self);
        if (taken !== undefined) return heldSlots(poolDirectory, self, taken);
      } else {
        const runs = new Map(holders.map((owner) => [owner.token, owner]));
        waitingOn(
          `waiting for ${count} of ${size} test slots; ${holders.length} held by ${[...runs.values()].map(describeOwner).join(', ')}`,
        );
      }
    } else {
      waitingOn(`queued behind ${describeOwner(await readTicket(queue, front))}`);
    }
    await sleep(pollIntervalMs);
  }
}

/** Replaces a slot's owner file in one rename, so a reader never sees it half-written. */
async function writeSlotOwner(directory: string, record: SlotOwner): Promise<void> {
  const staged = join(directory, `${ownerFileName}.${record.token}`);
  await writeFile(staged, JSON.stringify(record));
  await rename(staged, join(directory, ownerFileName));
}

/**
 * The held slots. One record per run is authoritative in memory, and every write of it, the
 * process group's and each set of workers', is chained after the last, so no write drops a field
 * another wrote, and release waits for the last one.
 */
function heldSlots(poolDirectory: string, self: SlotOwner, taken: number[]): HeldTestSlots {
  const directories = taken.map((index) => slotDirectory(poolDirectory, index));
  let record: SlotOwner = self;
  let written: Promise<void> = Promise.resolve();
  const write = (next: SlotOwner): Promise<void> => {
    record = next;
    const writing = (async () => {
      await written.catch(() => undefined);
      await Promise.all(directories.map((directory) => writeSlotOwner(directory, next)));
    })();
    written = writing;
    return writing;
  };
  return {
    token: self.token,
    slots: taken,
    recordProcessGroup: (processGroup) => {
      const processGroupStartedAt = processStartTime(processGroup);
      return write({
        ...record,
        processGroup,
        ...(processGroupStartedAt === undefined ? {} : { processGroupStartedAt }),
      });
    },
    recordWorkers: (workers) => write({ ...record, workers }),
    release: async () => {
      await written.catch(() => undefined);
      await Promise.all(directories.map((directory) => removeLock(directory, self)));
    },
  };
}

/**
 * Follows a running `bun test` leader's worker descendants: refreshes from the process table every
 * quarter second until it has seen `expected` workers, then every second, until the leader exits or
 * `stop` is called. The set only grows, less the workers seen to exit, so a refresh after the leader
 * died cannot erase it. Each change goes to `persist`.
 */
function trackWorkers(
  read: () => ProcessTable | undefined,
  expected: number,
  persist: ((workers: readonly RecordedWorker[]) => Promise<void>) | undefined,
  report: (line: string) => void,
): { start: (leader: number) => void; stop: () => Promise<RecordedWorker[]> } {
  const known = new Map<number, RecordedWorker>();
  const { promise: stopped, resolve: markStopped } = Promise.withResolvers<void>();
  // A property, so the loop sees `stop` set it across its awaits.
  const tracking = { running: true };
  let loop: Promise<void> = Promise.resolve();
  const refresh = async (leader: number, leaderStartedAt: string | undefined) => {
    const table = read();
    if (table === undefined) return true;
    const entry = table.get(leader);
    if (
      entry === undefined ||
      (leaderStartedAt !== undefined && entry.startedAt !== leaderStartedAt)
    )
      return false;
    let changed = false;
    for (const worker of testWorkersOf(leader, table)) {
      if (known.get(worker.pid)?.startedAt === worker.startedAt) continue;
      known.set(worker.pid, worker);
      changed = true;
    }
    for (const [pid, worker] of known) {
      if (table.get(pid)?.startedAt === worker.startedAt) continue;
      known.delete(pid);
      changed = true;
    }
    if (changed) {
      await persist?.([...known.values()]).catch((error: unknown) => {
        report(`could not record the test workers: ${String(error)}`);
      });
    }
    return true;
  };
  return {
    start: (leader) => {
      const leaderStartedAt = processStartTime(leader);
      loop = (async () => {
        while (tracking.running && (await refresh(leader, leaderStartedAt))) {
          const interval = known.size < expected ? 250 : 1000;
          await Promise.race([Bun.sleep(interval), stopped]);
        }
      })();
    },
    stop: async () => {
      tracking.running = false;
      markStopped();
      await loop;
      return [...known.values()];
    },
  };
}

/** Every slot record in the pool, whatever size the run that wrote it used. */
async function slotRecords(poolDirectory: string): Promise<SlotOwner[]> {
  const names = await readdir(poolDirectory).catch(() => [] as string[]);
  const records: SlotOwner[] = [];
  for (const name of names.filter((entry) => slotName.test(entry)).toSorted()) {
    const owner = (await readOwner(join(poolDirectory, name))) as SlotOwner | undefined;
    if (owner !== undefined) records.push(owner);
  }
  return records;
}

/**
 * The slots the live run holding `token` holds, so a run that presents it runs inside them and
 * starts no more workers than they allow; undefined when no live slot names the token.
 */
export async function slotsHeldUnderToken(
  poolDirectory: string,
  token: string | undefined,
  table: ProcessTable | undefined,
): Promise<number | undefined> {
  if (token === undefined || token === '') return undefined;
  const records = await slotRecords(poolDirectory);
  const live = records.filter(
    (owner) => owner.token === token && (table === undefined || isHolderAlive(owner, table)),
  );
  if (live.length === 0) return undefined;
  const recorded = live[0]?.slots;
  return Number.isInteger(recorded) && recorded !== undefined && recorded > 0
    ? recorded
    : live.length;
}

/** The pool's state as lines: a summary, then one line per run that holds slots. */
export async function describePool(
  poolDirectory: string,
  size: number,
  table: ProcessTable | undefined,
  now: number = Date.now(),
): Promise<string[]> {
  const runs = new Map<string, { owner: SlotOwner; slots: number; alive: boolean }>();
  for (const owner of await slotRecords(poolDirectory)) {
    const alive = table === undefined || isHolderAlive(owner, table);
    const run = runs.get(owner.token);
    if (run === undefined) runs.set(owner.token, { owner, slots: 1, alive });
    else run.slots += 1;
  }
  const held = [...runs.values()].reduce((total, run) => total + (run.alive ? run.slots : 0), 0);
  const queued = await readdir(queueDirectory(poolDirectory)).catch(() => [] as string[]);
  const waiting = queued.filter((name) => name.endsWith('.json')).length;
  const lines = [
    `test slot pool ${poolDirectory}: ${held} of ${size} held, ${Math.max(0, size - held)} free, ${waiting} waiting`,
  ];
  for (const { owner, slots, alive } of runs.values()) {
    const age = Math.max(0, Math.round((now - Date.parse(owner.acquiredAt)) / 1000));
    const state = alive ? '' : ' (exited; reclaimable)';
    lines.push(
      `  pid ${owner.pid} holds ${slots} slot(s) for ${age}s in ${owner.cwd}${state}: ${owner.command}`,
    );
  }
  return lines;
}

async function defaultPoolDirectory(): Promise<string> {
  return join(await gitCommonDirectory(), poolDirectoryName);
}

export type RunPooledBunTestOptions = {
  /** The arguments after `bun test` and its deadline. */
  readonly bunTestArguments: readonly string[];
  /** The environment `bun test` inherits; defaults to this process's. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  /** Defaults to `corvidae-test-slots` in the Git common directory; a failed lookup runs unpooled. */
  readonly poolDirectory?: string | Promise<string>;
  /** Defaults to {@link poolSize} of the environment. */
  readonly size?: number;
  /** What a bare `--parallel` means; defaults to the host's processors. */
  readonly processors?: number;
  readonly pollIntervalMs?: number;
  readonly readProcessTable?: () => ProcessTable | undefined;
  readonly report?: (line: string) => void;
  /** The program that runs the tests, before the arguments; tests of the pool substitute a stand-in. */
  readonly command?: readonly string[];
};

/**
 * Runs `bun test` holding one slot per worker, in a process group of its own whose signals the
 * wrapper forwards, and releases the slots once the group and the workers it recorded are gone.
 * Resolves to its exit code.
 */
export async function runPooledBunTest(input: RunPooledBunTestOptions): Promise<number> {
  // Snapshotted, so a caller that reuses its options object cannot change a run after an await.
  const options = { ...input, bunTestArguments: [...input.bunTestArguments] };
  const environment = { ...(options.environment ?? rootScriptEnvironment()) };
  const report = options.report ?? ((line: string) => process.stderr.write(`${line}\n`));
  const size = options.size ?? poolSize(environment);
  const requested = requestedWorkers(options.bunTestArguments, options.processors);
  let workers = requested;
  let argumentsList = [...options.bunTestArguments];
  const clampTo = (limit: number, reason: string): void => {
    if (workers <= limit) return;
    workers = limit;
    argumentsList = withWorkerCount(options.bunTestArguments, workers);
    report(`bun-test-pool: running ${workers} workers, ${reason}, not ${requested}`);
  };
  clampTo(size, 'the size of the pool');
  const read = options.readProcessTable ?? readProcessTable;
  let held: HeldTestSlots | undefined;
  try {
    const poolDirectory = await (options.poolDirectory ?? defaultPoolDirectory());
    const token = environment[heldSlotsTokenVariable];
    const parentSlots = await slotsHeldUnderToken(poolDirectory, token, read());
    if (parentSlots !== undefined) {
      clampTo(parentSlots, 'the slots of the run it is nested in');
    } else {
      held = await acquireTestSlots({
        poolDirectory,
        size,
        slots: workers,
        holder: {
          pid: process.pid,
          ...pidStartedAtField(),
          command: argumentsList.join(' '),
          cwd: options.cwd ?? process.cwd(),
          acquiredAt: new Date().toISOString(),
        },
        readProcessTable: read,
        ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
        onWait: (line) => report(`bun-test-pool: ${line}`),
      });
    }
  } catch (error) {
    report(`bun-test-pool: running without a test slot: ${(error as Error).message}`);
  }
  // Bun starts workers only under `--parallel`; without it the leader runs the tests itself.
  const tracker = argumentsList.some((argument) => parallelArgument.test(argument))
    ? trackWorkers(read, workers, held?.recordWorkers, (line) => report(`bun-test-pool: ${line}`))
    : undefined;
  try {
    return await runInProcessGroup([...(options.command ?? bunTestCommand), ...argumentsList], {
      environment:
        held === undefined ? environment : { ...environment, [heldSlotsTokenVariable]: held.token },
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      recordProcessGroup: async (processGroup) => {
        // Started first, so a failed record write cannot leave the run's workers untracked.
        tracker?.start(processGroup);
        await held?.recordProcessGroup(processGroup);
      },
      report: (line) => report(`bun-test-pool: ${line}`),
    });
  } finally {
    const recorded = (await tracker?.stop()) ?? [];
    if (recorded.length > 0) await terminateRecordedWorkers(recorded, { readProcessTable: read });
    await held?.release();
  }
}

function optionValue(argumentsList: readonly string[], name: string): string | undefined {
  const index = argumentsList.indexOf(name);
  return index === -1 ? undefined : argumentsList[index + 1];
}

if (import.meta.main) {
  const [command, ...rest] = Bun.argv.slice(2);
  if (command === 'status') {
    const poolDirectory = optionValue(rest, '--pool') ?? (await defaultPoolDirectory());
    const sizeOption = optionValue(rest, '--size');
    if (sizeOption !== undefined && !/^[1-9]\d*$/.test(sizeOption)) {
      process.stderr.write(`--size must be a positive integer, not ${sizeOption}\n`);
      process.exitCode = 64;
    } else {
      const size =
        sizeOption === undefined ? poolSize(rootScriptEnvironment()) : Number(sizeOption);
      for (const line of await describePool(poolDirectory, size, readProcessTable())) {
        process.stdout.write(`${line}\n`);
      }
    }
  } else {
    process.stderr.write(
      'usage: bun scripts/bun-test-pool.ts status [--pool <directory>] [--size <n>]\n',
    );
    process.exitCode = 64;
  }
}
