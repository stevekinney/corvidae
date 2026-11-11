/**
 * The host-wide pool of Bun test worker slots.
 *
 * Sessions, worktrees and turbo tasks multiply: several sessions each run several test tasks, and
 * each task starts up to four Bun workers, which loaded this 12-core host to an average of 60–95.
 * Every `bun test` the gate starts goes through `scripts/bun-test.ts`, `scripts/bun-test-junit.ts`
 * or `scripts/bun-test-selected.ts` (or, for the few runners that start `bun test` themselves,
 * through {@link runPooledBunTest} directly), and each takes one slot per worker before it starts,
 * so the Bun test workers on the host never exceed the pool's size, whoever starts them. `tsc`,
 * `svelte-check`, oxlint and Playwright start no Bun test worker and stay outside the pool; the
 * turbo concurrency cap bounds them, and the host lock serializes the Playwright suites.
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
 * A slot is held while its run's wrapper or any process in its `bun test` process group is alive,
 * judged from one `ps` snapshot of the process table by pid, process group, and the start time
 * recorded beside each, so a recycled pid never passes for a holder. A holder killed with SIGKILL
 * therefore keeps its slots exactly as long as its workers run and frees them the moment they are
 * gone, with no timeout. An unreadable slot or ticket is garbage and is reclaimed at once, since
 * this module never leaves one.
 *
 * A wrapper started inside a run that holds slots (a test that itself runs a wrapper) finds its
 * parent's token in `CORVIDAE_TEST_SLOTS_TOKEN` and runs inside the parent's slots, so it neither
 * waits on its own parent nor counts twice. The token is honoured only while a live slot names it.
 *
 * The pool's size is {@link defaultPoolSize}, or `CORVIDAE_TEST_SLOTS` when set. A request above it
 * is clamped: the run holds every slot and its `--parallel` is rewritten to the pool's size, so the
 * slots held always equal the workers running. A checkout whose wrappers predate the pool simply
 * goes uncounted. When the pool cannot be used at all, the run warns and runs without a slot.
 *
 * Usage: `bun scripts/bun-test-pool.ts status [--pool <directory>] [--size <n>]` prints the holders
 * and the free slots.
 */

import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';

import {
  enqueue,
  gitCommonDirectory,
  liveFront,
  pidStartedAtField,
  processTableEnvironment,
  readOwner,
  readTicket,
  reclaimAbandoned,
  recordProcessGroup,
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

export type ProcessEntry = { readonly processGroup: number; readonly startedAt: string };

/** A snapshot of the host's processes by pid. */
export type ProcessTable = ReadonlyMap<number, ProcessEntry>;

/**
 * One `ps` snapshot of every process, with the same `lstart` text `processStartTime` records.
 * Undefined when `ps` fails or the snapshot lacks this process: a holder must never be judged
 * dead from a table that cannot be trusted.
 */
export function readProcessTable(): ProcessTable | undefined {
  const result = Bun.spawnSync(['ps', '-A', '-o', 'pid=,pgid=,lstart='], {
    env: processTableEnvironment(),
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (result.exitCode !== 0) return undefined;
  const table = new Map<number, ProcessEntry>();
  for (const line of result.stdout.toString().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match?.[3] !== undefined) {
      table.set(Number(match[1]), { processGroup: Number(match[2]), startedAt: match[3] });
    }
  }
  return table.has(process.pid) ? table : undefined;
}

/**
 * Whether the run that wrote `owner` is alive: its wrapper, by pid and start time, or any member
 * of its recorded process group, unless a new process now leads a group with that id.
 */
export function isHolderAlive(owner: OwnerRecord, table: ProcessTable): boolean {
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

/** The owner record of one slot: the host lock's, plus the slots its run holds in all. */
export type SlotOwner = OwnerRecord & { readonly slots: number };

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
 * The free slots below `size` and the owners of the held ones. A slot whose holder is dead, or
 * that holds garbage, is reclaimed first; the host lock's reclaim judges it again under its guard,
 * so a slot installed meanwhile is never removed.
 */
async function surveySlots(
  poolDirectory: string,
  size: number,
  table: ProcessTable | undefined,
): Promise<{ free: number[]; holders: SlotOwner[] }> {
  const free: number[] = [];
  const holders: SlotOwner[] = [];
  for (let index = 0; index < size; index++) {
    const directory = slotDirectory(poolDirectory, index);
    const owner = (await readOwner(directory)) as SlotOwner | undefined;
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
  readonly sleep?: (milliseconds: number) => Promise<void>;
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
      const { free, holders } = await surveySlots(poolDirectory, size, read());
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

function heldSlots(poolDirectory: string, self: SlotOwner, taken: number[]): HeldTestSlots {
  const directories = taken.map((index) => slotDirectory(poolDirectory, index));
  return {
    token: self.token,
    slots: taken,
    recordProcessGroup: async (processGroup) => {
      await Promise.all(
        directories.map((directory) => recordProcessGroup(directory, self, processGroup)),
      );
    },
    release: async () => {
      await Promise.all(directories.map((directory) => removeLock(directory, self)));
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

/** Whether a live slot is held under `token`, so a run that presents it runs inside them. */
export async function heldUnderToken(
  poolDirectory: string,
  token: string | undefined,
  table: ProcessTable | undefined,
): Promise<boolean> {
  if (token === undefined || token === '') return false;
  const records = await slotRecords(poolDirectory);
  return records.some(
    (owner) => owner.token === token && (table === undefined || isHolderAlive(owner, table)),
  );
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
 * wrapper forwards, and releases the slots once the group is gone. Resolves to its exit code.
 */
export async function runPooledBunTest(input: RunPooledBunTestOptions): Promise<number> {
  // Snapshotted, so a caller that reuses its options object cannot change a run after an await.
  const options = { ...input, bunTestArguments: [...input.bunTestArguments] };
  const environment = { ...(options.environment ?? process.env) };
  const report = options.report ?? ((line: string) => process.stderr.write(`${line}\n`));
  const size = options.size ?? poolSize(environment);
  const requested = requestedWorkers(options.bunTestArguments, options.processors);
  const workers = Math.min(requested, size);
  const argumentsList =
    workers < requested
      ? withWorkerCount(options.bunTestArguments, workers)
      : [...options.bunTestArguments];
  if (workers < requested) {
    report(`bun-test-pool: running ${workers} workers, the size of the pool, not ${requested}`);
  }
  const read = options.readProcessTable ?? readProcessTable;
  let held: HeldTestSlots | undefined;
  try {
    const poolDirectory = await (options.poolDirectory ?? defaultPoolDirectory());
    if (!(await heldUnderToken(poolDirectory, environment[heldSlotsTokenVariable], read()))) {
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
  try {
    return await runInProcessGroup([...(options.command ?? bunTestCommand), ...argumentsList], {
      environment:
        held === undefined ? environment : { ...environment, [heldSlotsTokenVariable]: held.token },
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(held === undefined ? {} : { recordProcessGroup: held.recordProcessGroup }),
      report: (line) => report(`bun-test-pool: ${line}`),
    });
  } finally {
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
      const size = sizeOption === undefined ? poolSize(process.env) : Number(sizeOption);
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
