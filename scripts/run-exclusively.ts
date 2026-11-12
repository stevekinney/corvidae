/**
 * Runs a heavy root stage under a lock that every checkout of this repository on the host shares.
 *
 * Each `bun run validate` assumes it has the machine to itself: its `tsc`, `svelte-check` and
 * oxlint tasks take about 13 GB at four tasks, so three validates at once would not fit a 32 GB
 * host. The lock serializes the heavy stages (`validate`, `validate:batch`, `lint`, `typecheck`,
 * `build`, `release:check`, the Playwright suites and `harden`). The stages that only run tests
 * (`test`, `test:slow`, `coverage`) run `--shared`, because the test slot pool
 * (`scripts/bun-test-pool.ts`), which every `bun test` passes through, bounds the Bun test workers
 * on the host, inside a locked stage or not. Pool holders never wait on the lock, so the two cannot
 * deadlock.
 *
 * The lock is a directory inside the Git common directory, which every worktree of this
 * repository shares. It is renamed into place with its owner file already inside, and `rename`
 * refuses to replace a non-empty directory, so whoever's rename succeeds holds the lock.
 *
 * The command runs in its own process group, and the lock guards that whole group, not one pid. A
 * chained stage such as `lint` is `sh` running Bun and Turbo, which run more processes; signalling
 * or watching only `sh` would let its descendants outlive it while the lock was released. So
 * signals are forwarded to the group, the lock stays held while the wrapper or any member of the
 * group is alive, and stragglers are terminated before release. Start times recorded beside each
 * pid keep a recycled pid from passing for the holder.
 *
 * Waiters take the lock in the order they arrived. Plain re-polling lets whoever polls first after a
 * release win, which starved a validate for over an hour behind sessions that kept winning. Each
 * waiter first files a ticket in a queue directory beside the lock, named by arrival time, and only
 * the oldest live ticket may attempt the install. Tickets of waiters whose process has exited are
 * pruned, judged by pid plus start time the way the holder is.
 *
 * A holder that runs a chain of stages keeps its place across them. The held lock's token is
 * exported to the command as `CORVIDAE_HOST_LOCK_TOKEN`; a nested `run-exclusively` whose token
 * matches the lock currently held runs its command directly, so `validate` can hold the lock for
 * its whole chain without its own stages queueing behind it.
 *
 * The wrapped command also gets two Turborepo defaults, each only when the caller has not set it.
 * It sets no cache directory: Turborepo itself keeps one local cache in the main checkout for
 * every linked worktree, which the wrapped and the unwrapped runs therefore share.
 * `TURBO_CONCURRENCY` is one task per 8 GiB of memory and per three processors, whichever allows
 * fewer; `turbo.json`'s `concurrency` of 34% is the processor half of that for the runs that do not
 * pass through here, and the variable outranks it. Measured on 2026-10-22 with a forced validate
 * at four tasks on a 12-core, 32 GB host: the largest task
 * (Cinder's coverage run) peaked at 7.8 GB, all tasks together at 13.3 GB, and the load average
 * reached 58. Turborepo's own default of ten tasks at once oversubscribes both. A stage that passes
 * `--concurrency` itself still wins, since the flag overrides the variable.
 *
 * `--shared` before the command skips the lock and keeps the install check and the Turborepo
 * defaults, at half the concurrency, since several shared runs (`bun run check`, the test stages)
 * can run beside each other and beside a locked one. Nothing reads the load average: the test slot
 * pool replaced the load backoff that shared runs once had.
 *
 * Every stage, locked or shared, reads the host's memory before it starts, and waits while the host
 * is short or refuses with the measurement ({@link awaitMemory}). A run whose session is gone ends
 * after the awake-time hang guard ({@link runInProcessGroup}). Both are described in
 * `documentation/repository/host-admission.md`.
 *
 * Usage: `bun scripts/run-exclusively.ts [--shared] '<shell command>' [arguments...]`. Arguments
 * reach the command as `"$@"`, so their boundaries survive, the way `bun run <script> -- …` passes
 * them.
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { constants, cpus, totalmem } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { afterAwakeTime, HANG_GUARD_MILLISECONDS } from '../testing/testing/src/hang-guard.ts';
import { rootScriptEnvironment } from './environment-configuration';

export const ownerFileName = 'owner.json';

/** Names the held lock's token in the environment of the command that runs under it. */
export const heldLockTokenVariable = 'CORVIDAE_HOST_LOCK_TOKEN';

/** Host memory budgeted to each concurrently running Turborepo task. */
const memoryPerTurborepoTask = 8 * 1024 ** 3;

/** Processors budgeted to each concurrently running Turborepo task. */
const processorsPerTurborepoTask = 3;

/**
 * The ref Turborepo's `--affected` compares against. Left unset, Turborepo picks the base itself
 * (its default branch, which can differ from the `origin/main` that `scripts/affected-tests.ts`
 * selects test files against), so the two selections could disagree. Nothing fetches it: a stale
 * local `origin/main` gives a wider or narrower base, and a missing one fails the `--affected` run.
 */
export const turborepoAffectedBase = 'origin/main';

/**
 * `environment` with a memory-scaled task concurrency and the `--affected` base filled in where
 * the caller has not chosen its own. A `shared` run takes no lock, so several can run at once; each
 * gets half the concurrency, since processors are what a full host runs out of. The cache
 * directory is deliberately not set: Turborepo shares its local cache across linked worktrees on
 * its own, and `turbo.json`'s `concurrency` caps the runs that never pass through here.
 */
export function withTurborepoDefaults(
  environment: Readonly<Record<string, string | undefined>>,
  host: { readonly totalMemoryBytes: number; readonly processors: number } = {
    totalMemoryBytes: totalmem(),
    processors: cpus().length,
  },
  shared = false,
): Record<string, string | undefined> {
  const exclusive = Math.min(
    Math.floor(host.processors / processorsPerTurborepoTask),
    Math.floor(host.totalMemoryBytes / memoryPerTurborepoTask),
  );
  const concurrency = Math.max(1, shared ? Math.floor(exclusive / 2) : exclusive);
  return {
    ...environment,
    TURBO_CONCURRENCY: environment['TURBO_CONCURRENCY'] || String(concurrency),
    TURBO_SCM_BASE: environment['TURBO_SCM_BASE'] || turborepoAffectedBase,
  };
}

/**
 * Verifies the install against `bun.lock` before a wrapped command runs. It runs here rather than
 * as a turbo task, because a task every other task depends on folds its own `package.json` into
 * every cache key, so any edit to the root manifest would re-run the whole repository.
 */
export const preflightCommand = 'bun install --frozen-lockfile';

/** `script` preceded by the install check, so a stale `node_modules` fails before turbo runs. */
export function withPreflight(script: string): string {
  return `${preflightCommand} && ${script}`;
}

/** The directory of waiting tickets beside the lock. */
export function queueDirectoryFor(lockDirectory: string): string {
  return `${lockDirectory}.queue`;
}

export type HostLockHolder = {
  readonly pid: number;
  /** `ps -o lstart` for `pid`, so a recycled pid is not mistaken for the holder. */
  readonly pidStartedAt?: string;
  /** The command's process group, recorded once it starts; it can outlive a killed wrapper. */
  readonly processGroup?: number;
  /** `ps -o lstart` for the group's leader when the group started. */
  readonly processGroupStartedAt?: string;
  readonly command: string;
  readonly cwd: string;
  readonly acquiredAt: string;
};

export type OwnerRecord = HostLockHolder & { readonly token: string };

export type AcquireHostLockOptions = {
  readonly lockDirectory: string;
  readonly holder: HostLockHolder;
  /** How often a waiter checks the lock again. */
  readonly pollIntervalMs?: number;
  /**
   * How long a lock directory without a readable owner file may stand before it counts as
   * abandoned. This module never creates one, since it installs the owner and the directory in
   * one rename, so such a directory was left by something else.
   */
  readonly ownerlessGraceMs?: number;
  /**
   * Called whenever what a waiter is queued behind changes, including the first time: the holder
   * of the lock, or with `'queue'` the earlier waiter whose turn comes first.
   */
  readonly onWait?: (holder: HostLockHolder | undefined, behind?: 'lock' | 'queue') => void;
  readonly signal?: AbortSignal;
};

/** Whether `pid` names a live process. Only ESRCH means it is gone; EPERM means it exists. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * The environment `ps` runs under: the host's own time zone and the C locale. `lstart` prints in
 * the caller's zone, and stages run with and without `TZ=UTC`, so without this a holder recorded
 * by one would look recycled to a reader in the other and lose its lock.
 */
export function processTableEnvironment(): Record<string, string | undefined> {
  const environment = Object.fromEntries(
    Object.entries(rootScriptEnvironment()).filter(([name]) => name !== 'TZ'),
  );
  return { ...environment, LC_ALL: 'C' };
}

/** The process's start time as `ps` reports it, or undefined when there is no such process. */
export function processStartTime(pid: number): string | undefined {
  const result = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], {
    env: processTableEnvironment(),
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const startedAt = result.stdout.toString().trim();
  return result.exitCode === 0 && startedAt !== '' ? startedAt : undefined;
}

/** Whether `pid` is alive and, when a start time was recorded, still the same process. */
function isSameProcess(pid: number, startedAt: string | undefined): boolean {
  if (!isProcessAlive(pid)) return false;
  return startedAt === undefined || processStartTime(pid) === startedAt;
}

/**
 * Whether any member of the process group is alive. A process group's id is not reused while the
 * group has members, so a live group under that id is the recorded one, unless a new process now
 * leads a group with the same id, which the leader's start time exposes.
 */
function isProcessGroupAlive(processGroup: number, leaderStartedAt: string | undefined): boolean {
  try {
    process.kill(-processGroup, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
  }
  if (leaderStartedAt === undefined || !isProcessAlive(processGroup)) return true;
  return processStartTime(processGroup) === leaderStartedAt;
}

export async function readOwner(lockDirectory: string): Promise<OwnerRecord | undefined> {
  try {
    return JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8')) as OwnerRecord;
  } catch {
    return undefined;
  }
}

/** Whether the lock is still there and, if so, whether everything it guarded has stopped. */
async function lockState(
  lockDirectory: string,
  owner: OwnerRecord | undefined,
  ownerlessGraceMs: number,
): Promise<'released' | 'abandoned' | 'held'> {
  if (owner) {
    const alive =
      isSameProcess(owner.pid, owner.pidStartedAt) ||
      (owner.processGroup !== undefined &&
        isProcessGroupAlive(owner.processGroup, owner.processGroupStartedAt));
    return alive ? 'held' : 'abandoned';
  }
  try {
    const { mtimeMs } = await stat(lockDirectory);
    // Whole milliseconds on both sides: `mtimeMs` keeps a fraction `Date.now()` drops, so a
    // directory written earlier in this millisecond would otherwise read as written in the future.
    return Date.now() - Math.floor(mtimeMs) >= ownerlessGraceMs ? 'abandoned' : 'held';
  } catch {
    return 'released';
  }
}

/**
 * Removes the lock if it is still the one `expected` describes. `rename` is atomic, so waiters see
 * the lock either whole or gone. If what moved is not the expected lock, it is put back; callers
 * make that case unreachable, a holder by removing only its own lock and a reclaimer by holding
 * the reclaim guard.
 */
export async function removeLock(
  lockDirectory: string,
  expected: OwnerRecord | undefined,
): Promise<void> {
  const aside = `${lockDirectory}.removed-${process.pid}-${crypto.randomUUID()}`;
  try {
    await rename(lockDirectory, aside);
  } catch {
    return;
  }
  const moved = await readOwner(aside);
  if (moved?.token !== expected?.token) {
    await rename(aside, lockDirectory).catch(() => undefined);
    return;
  }
  await rm(aside, { recursive: true, force: true });
}

/**
 * Builds a lock directory beside the real one and renames it into place, so the lock never exists
 * without its owner file. Renaming a directory onto a non-empty one fails, which is how a held
 * lock refuses a second holder. Resolves to whether this call took the lock.
 */
export async function tryInstall(lockDirectory: string, owner: OwnerRecord): Promise<boolean> {
  const pending = `${lockDirectory}.pending-${owner.token}`;
  await mkdir(pending);
  try {
    await writeFile(join(pending, ownerFileName), JSON.stringify(owner));
    await rename(pending, lockDirectory);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
    return false;
  } finally {
    await rm(pending, { recursive: true, force: true });
  }
}

/** How long a reclaim guard may stand before it counts as left by a reclaimer that died. */
const reclaimGuardStaleMs = 30_000;

/**
 * Removes the lock if it is abandoned, judged while holding a reclaim guard. Reclaims are
 * serialized behind the guard directory and the lock is read again under it. No holder can install
 * a lock while an abandoned one stands, and no other reclaimer can move it, so the lock judged
 * under the guard is the lock removed. Judging it before taking the guard would let a waiter acting
 * on a stale reading move aside a live lock another waiter had just installed.
 */
export async function reclaimAbandoned(
  lockDirectory: string,
  ownerlessGraceMs: number,
): Promise<void> {
  const guard = `${lockDirectory}.reclaiming`;
  try {
    await mkdir(guard);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const { mtimeMs } = await stat(guard).catch(() => ({ mtimeMs: Date.now() }));
    if (Date.now() - mtimeMs >= reclaimGuardStaleMs) await rmdir(guard).catch(() => undefined);
    return;
  }
  try {
    const current = await readOwner(lockDirectory);
    if ((await lockState(lockDirectory, current, ownerlessGraceMs)) !== 'abandoned') return;
    await removeLock(lockDirectory, current);
  } finally {
    await rmdir(guard).catch(() => undefined);
  }
}

/** Records the command's process group in the held lock, replacing the owner file in one rename. */
export async function recordProcessGroup(
  lockDirectory: string,
  owner: OwnerRecord,
  processGroup: number,
): Promise<void> {
  const staged = join(lockDirectory, `${ownerFileName}.${owner.token}`);
  const processGroupStartedAt = processStartTime(processGroup);
  await writeFile(
    staged,
    JSON.stringify({
      ...owner,
      processGroup,
      ...(processGroupStartedAt === undefined ? {} : { processGroupStartedAt }),
    }),
  );
  await rename(staged, join(lockDirectory, ownerFileName));
}

function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type HeldHostLock = {
  /** Identifies this lock in its owner file; nested stages present it to reuse the lock. */
  readonly token: string;
  /** Records the command's process group, so the lock outlives a wrapper killed before it. */
  readonly recordProcessGroup: (processGroup: number) => Promise<void>;
  readonly release: () => Promise<void>;
};

const ticketSuffix = '.json';

/** Tickets sort by their zero-padded arrival time, then by token to break an exact tie. */
function ticketName(arrivedAt: number, token: string): string {
  return `${String(arrivedAt).padStart(16, '0')}-${token}${ticketSuffix}`;
}

async function listTickets(queueDirectory: string): Promise<string[]> {
  const names = await readdir(queueDirectory);
  return names.filter((name) => name.endsWith(ticketSuffix)).toSorted();
}

/**
 * Files this waiter's ticket and resolves to its name. The arrival time is never earlier than the
 * newest ticket already filed, so a clock that steps back cannot put a newcomer ahead of it. The
 * ticket is written aside and renamed in, so a reader never sees it half-written.
 */
export async function enqueue(queueDirectory: string, self: OwnerRecord): Promise<string> {
  await mkdir(queueDirectory, { recursive: true });
  const tickets = await listTickets(queueDirectory);
  const newest = tickets.at(-1);
  const newestArrival = newest === undefined ? 0 : Number(newest.slice(0, 16));
  const name = ticketName(Math.max(Date.now(), newestArrival + 1), self.token);
  const staged = join(queueDirectory, `staging-${self.token}`);
  await writeFile(staged, JSON.stringify(self));
  await rename(staged, join(queueDirectory, name));
  return name;
}

/** Whether the waiter that filed this ticket is still running. An unreadable ticket counts as dead. */
async function isTicketLive(queueDirectory: string, name: string): Promise<boolean> {
  try {
    const waiter = JSON.parse(await readFile(join(queueDirectory, name), 'utf8')) as OwnerRecord;
    return isSameProcess(waiter.pid, waiter.pidStartedAt);
  } catch {
    // Gone already (its owner took its turn or gave up) or unreadable: it no longer stands in the way.
    return false;
  }
}

export async function readTicket(
  queueDirectory: string,
  name: string,
): Promise<OwnerRecord | undefined> {
  try {
    return JSON.parse(await readFile(join(queueDirectory, name), 'utf8')) as OwnerRecord;
  } catch {
    return undefined;
  }
}

/**
 * The oldest ticket whose waiter is alive, after pruning the dead ones ahead of it. Resolves to the
 * name of that ticket, which is this waiter's own once nobody live remains ahead.
 */
export async function liveFront(queueDirectory: string, own: string): Promise<string> {
  for (const name of await listTickets(queueDirectory)) {
    if (name === own || (await isTicketLive(queueDirectory, name))) return name;
    await rm(join(queueDirectory, name), { force: true });
  }
  return own;
}

/** Waits until it holds the lock. */
export async function acquireHostLock(options: AcquireHostLockOptions): Promise<HeldHostLock> {
  const { lockDirectory, holder } = options;
  const self: OwnerRecord = { ...holder, token: crypto.randomUUID() };
  const queueDirectory = queueDirectoryFor(lockDirectory);
  options.signal?.throwIfAborted();
  const ticket = await enqueue(queueDirectory, self);
  try {
    return await waitForTurn(options, self, queueDirectory, ticket);
  } finally {
    // After a successful install the lock itself is the claim; on failure or abort the place is
    // given up. Either way the ticket must not outlive the wait.
    await rm(join(queueDirectory, ticket), { force: true });
  }
}

async function waitForTurn(
  options: AcquireHostLockOptions,
  self: OwnerRecord,
  queueDirectory: string,
  ticket: string,
): Promise<HeldHostLock> {
  const { lockDirectory, pollIntervalMs = 1000, ownerlessGraceMs = 10_000 } = options;
  let lastWaitedOn: string | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    const front = await liveFront(queueDirectory, ticket);
    if (front !== ticket) {
      if (front !== lastWaitedOn) {
        lastWaitedOn = front;
        options.onWait?.(await readTicket(queueDirectory, front), 'queue');
      }
      await delay(pollIntervalMs, options.signal);
      continue;
    }
    if (await tryInstall(lockDirectory, self)) {
      return {
        token: self.token,
        recordProcessGroup: (processGroup) => recordProcessGroup(lockDirectory, self, processGroup),
        release: () => removeLock(lockDirectory, self),
      };
    }
    const owner = await readOwner(lockDirectory);
    const state = await lockState(lockDirectory, owner, ownerlessGraceMs);
    if (state === 'released') continue;
    if (state === 'abandoned') {
      await reclaimAbandoned(lockDirectory, ownerlessGraceMs);
      await delay(Math.min(pollIntervalMs, 50), options.signal);
      continue;
    }
    const waitedOn = owner?.token ?? 'ownerless';
    if (waitedOn !== lastWaitedOn) {
      lastWaitedOn = waitedOn;
      options.onWait?.(owner);
    }
    await delay(pollIntervalMs, options.signal);
  }
}

// --- Memory admission ---------------------------------------------------------------------------
//
// The lock and the test slot pool count stages and processes, not memory. On 2026-11-11 the host
// starved on memory instead (swap 14.2 of 15.4 GB, `fseventsd` holding 7.5 GB), and suites that
// pass alone failed for load (COR-2404). So a heavy stage reads the host's memory before it starts
// and waits while the host is short, or refuses with the measurement, rather than starting and
// reporting red for starvation (`documentation/repository/host-admission.md`).

/** Set in a stage's environment once it is admitted, so the stages it starts are not checked again. */
export const memoryAdmittedVariable = 'CORVIDAE_MEMORY_ADMITTED';

/** The exit code of a stage refused for memory: `EX_TEMPFAIL`, a condition that may clear. */
export const memoryRefusalExitCode = 75;

/**
 * The memory a heavy stage needs free before it starts: a little more than one Bun test worker's
 * budget (`memoryPerTestWorker` in `scripts/bun-test-pool.ts`). A first estimate, to be tuned by the
 * load sample COR-2404 asks for.
 */
export const minimumAvailableMemory = 4 * 1024 ** 3;

/** How long a stage waits for memory before it refuses, counted in awake polls, not on the clock. */
const memoryWaitMs = 10 * 60_000;
const memoryPollMs = 5_000;

export type MemoryReading = {
  readonly totalBytes: number;
  /** What the kernel counts free: `kern.memorystatus_level` on macOS, `MemAvailable` on Linux. */
  readonly availableBytes: number;
  /** The kernel's own pressure level, where it reports one (macOS). */
  readonly pressure?: 'normal' | 'warning' | 'critical';
  readonly swapUsedBytes?: number;
  readonly swapTotalBytes?: number;
};

// `kern.memorystatus_vm_pressure_level` reports the dispatch levels of <dispatch/source.h>:
// DISPATCH_MEMORYPRESSURE_NORMAL 0x01, _WARN 0x02 and _CRITICAL 0x04.
const darwinPressureLevels: Readonly<Record<string, MemoryReading['pressure']>> = {
  '1': 'normal',
  '2': 'warning',
  '4': 'critical',
};

const megabytesPattern = /(total|used)\s*=\s*([\d.]+)M/g;

/**
 * A reading from `sysctl kern.memorystatus_level kern.memorystatus_vm_pressure_level vm.swapusage
 * hw.memsize`, one `name: value` line each. Swap is reported, never judged: macOS keeps swap in use
 * long after pressure ends, so the share of swap used says nothing about whether the host is short.
 */
export function parseDarwinMemory(text: string): MemoryReading | undefined {
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    const separator = line.indexOf(':');
    if (separator > 0)
      values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const totalBytes = Number(values.get('hw.memsize'));
  const freePercent = Number(values.get('kern.memorystatus_level'));
  if (
    !(totalBytes > 0) ||
    !Number.isFinite(freePercent) ||
    values.get('kern.memorystatus_level') === undefined
  ) {
    return undefined;
  }
  const pressure = darwinPressureLevels[values.get('kern.memorystatus_vm_pressure_level') ?? ''];
  const swap = new Map<string, number>();
  for (const match of (values.get('vm.swapusage') ?? '').matchAll(megabytesPattern)) {
    swap.set(match[1] ?? '', Number(match[2]) * 1024 ** 2);
  }
  const swapUsedBytes = swap.get('used');
  const swapTotalBytes = swap.get('total');
  return {
    totalBytes,
    availableBytes: Math.round((totalBytes * Math.min(100, Math.max(0, freePercent))) / 100),
    ...(pressure === undefined ? {} : { pressure }),
    ...(swapUsedBytes === undefined || swapTotalBytes === undefined
      ? {}
      : { swapUsedBytes, swapTotalBytes }),
  };
}

/** A reading from `/proc/meminfo`. */
export function parseLinuxMemory(text: string): MemoryReading | undefined {
  const kilobytes = new Map<string, number>();
  for (const match of text.matchAll(/^(\w+):\s+(\d+)\s+kB$/gm)) {
    kilobytes.set(match[1] ?? '', Number(match[2]) * 1024);
  }
  const totalBytes = kilobytes.get('MemTotal');
  const availableBytes = kilobytes.get('MemAvailable');
  if (totalBytes === undefined || availableBytes === undefined) return undefined;
  const swapTotal = kilobytes.get('SwapTotal');
  const swapFree = kilobytes.get('SwapFree');
  return {
    totalBytes,
    availableBytes,
    ...(swapTotal === undefined || swapFree === undefined
      ? {}
      : { swapUsedBytes: swapTotal - swapFree, swapTotalBytes: swapTotal }),
  };
}

/** This host's memory, or undefined where it cannot be read: such a host admits every stage. */
export function readMemory(): MemoryReading | undefined {
  try {
    if (process.platform === 'linux') {
      const file = Bun.spawnSync(['cat', '/proc/meminfo'], { stdout: 'pipe', stderr: 'ignore' });
      return file.exitCode === 0 ? parseLinuxMemory(file.stdout.toString()) : undefined;
    }
    const result = Bun.spawnSync(
      [
        'sysctl',
        'kern.memorystatus_level',
        'kern.memorystatus_vm_pressure_level',
        'vm.swapusage',
        'hw.memsize',
      ],
      { env: processTableEnvironment(), stdout: 'pipe', stderr: 'ignore' },
    );
    return result.exitCode === 0 ? parseDarwinMemory(result.stdout.toString()) : undefined;
  } catch {
    return undefined;
  }
}

function gibibytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** The reading as one line: free memory, the kernel's pressure level, and swap. */
export function describeMemory(reading: MemoryReading): string {
  const parts = [`${gibibytes(reading.availableBytes)} of ${gibibytes(reading.totalBytes)} free`];
  if (reading.pressure !== undefined) parts.push(`pressure ${reading.pressure}`);
  if (reading.swapUsedBytes !== undefined && reading.swapTotalBytes !== undefined) {
    parts.push(
      `swap ${gibibytes(reading.swapUsedBytes)} of ${gibibytes(reading.swapTotalBytes)} used`,
    );
  }
  return parts.join(', ');
}

/**
 * Why the host is too short of memory to start a heavy stage, naming the measurement, or undefined
 * when it may start: the kernel reports warning or critical pressure, or less than `needed` is free.
 */
export function memoryShortfall(
  reading: MemoryReading,
  needed: number = minimumAvailableMemory,
): string | undefined {
  if (reading.pressure === 'warning' || reading.pressure === 'critical') {
    return `the kernel reports ${reading.pressure} memory pressure (kern.memorystatus_vm_pressure_level)`;
  }
  if (reading.availableBytes < needed) {
    return `${gibibytes(reading.availableBytes)} of memory is free, below the ${gibibytes(needed)} a heavy stage needs`;
  }
  return undefined;
}

export type MemoryAdmissionOptions = {
  /** Names the stage in every line. */
  readonly label: string;
  /** A stage whose environment carries {@link memoryAdmittedVariable} was admitted by its parent. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly needed?: number;
  readonly readMemory?: () => MemoryReading | undefined;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  /** How long to wait for memory before refusing, counted as polls times the interval. */
  readonly maximumWaitMs?: number;
  readonly report: (line: string) => void;
};

export type MemoryAdmission =
  | { readonly admitted: true; readonly reason: 'nested' | 'unread' | 'measured' }
  | { readonly admitted: false; readonly message: string };

/**
 * Waits until the host has memory for a heavy stage, or refuses once it has waited
 * `maximumWaitMs` of polls. Waiting is on state: each poll reads the memory again, and a line is
 * printed when the stage starts waiting and once a minute after. A nested stage and a host whose
 * memory cannot be read are admitted at once.
 */
export async function awaitMemory(options: MemoryAdmissionOptions): Promise<MemoryAdmission> {
  if ((options.environment[memoryAdmittedVariable] ?? '') !== '') {
    return { admitted: true, reason: 'nested' };
  }
  const read = options.readMemory ?? readMemory;
  const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const interval = options.pollIntervalMs ?? memoryPollMs;
  const maximum = options.maximumWaitMs ?? memoryWaitMs;
  const reportEvery = Math.max(1, Math.round(60_000 / interval));
  for (let polls = 0; ; polls += 1) {
    const reading = read();
    if (reading === undefined)
      return { admitted: true, reason: polls === 0 ? 'unread' : 'measured' };
    const shortfall = memoryShortfall(reading, options.needed);
    if (shortfall === undefined) return { admitted: true, reason: 'measured' };
    if (polls * interval >= maximum) {
      return {
        admitted: false,
        message: `${options.label}: refused to start after waiting ${Math.round(maximum / 60_000)} minutes for memory: ${shortfall} (${describeMemory(reading)}). Run it again once the host is quieter; ${memoryAdmittedVariable}=1 skips this check.`,
      };
    }
    if (polls % reportEvery === 0) {
      options.report(
        `${options.label}: waiting for memory before starting: ${shortfall} (${describeMemory(reading)})`,
      );
    }
    await sleep(interval);
  }
}

// --- Orphaned runs -------------------------------------------------------------------------------
//
// A run whose agent is gone has no one to read its result, yet a `bun test` from a finished
// worktree lived for over ten hours (COR-2404). A wrapper notes its ancestors when it starts its
// command; once one of them is gone, the run is orphaned, and after the awake-time hang guard it
// terminates its command's process group.

/** The parents of every process, from one `ps` snapshot; undefined when `ps` fails. */
export function readParents(): Map<number, number> | undefined {
  const result = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid='], {
    env: processTableEnvironment(),
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (result.exitCode !== 0) return undefined;
  const parents = new Map<number, number>();
  for (const line of result.stdout.toString().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match !== null) parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

/** The ancestors of `pid`, nearest first, up to but not including pid 1, which never exits. */
export function ancestorsOf(pid: number, parents: ReadonlyMap<number, number>): number[] {
  const ancestors: number[] = [];
  const seen = new Set([pid]);
  for (let parent = parents.get(pid); parent !== undefined && parent > 1;) {
    if (seen.has(parent)) break;
    seen.add(parent);
    ancestors.push(parent);
    parent = parents.get(parent);
  }
  return ancestors;
}

export type OrphanWatchOptions = {
  readonly ancestors: readonly number[];
  readonly onOrphaned: (gone: number) => void;
  /** Called once the hang guard's awake time has passed since the run was orphaned. */
  readonly onExpired: () => void;
  readonly isAlive?: (pid: number) => boolean;
  /** Calls `check` every `milliseconds` until the returned function is called. */
  readonly every?: (check: () => void, milliseconds: number) => () => void;
  readonly afterAwake?: (milliseconds: number, onElapsed: () => void) => () => void;
  readonly graceMs?: number;
  readonly pollIntervalMs?: number;
};

function everyInterval(check: () => void, milliseconds: number): () => void {
  const timer = setInterval(check, milliseconds);
  timer.unref();
  return () => clearInterval(timer);
}

/** Watches `ancestors`; resolves to a function that stops watching. */
export function watchForOrphaning(options: OrphanWatchOptions): () => void {
  const isAlive = options.isAlive ?? isProcessAlive;
  const afterAwake = options.afterAwake ?? afterAwakeTime;
  let cancelGrace: (() => void) | undefined;
  let stopChecking: () => void = () => {};
  stopChecking = (options.every ?? everyInterval)(() => {
    const gone = options.ancestors.find((pid) => !isAlive(pid));
    if (gone === undefined || cancelGrace !== undefined) return;
    stopChecking();
    options.onOrphaned(gone);
    cancelGrace = afterAwake(options.graceMs ?? HANG_GUARD_MILLISECONDS, options.onExpired);
  }, options.pollIntervalMs ?? memoryPollMs);
  return () => {
    stopChecking();
    cancelGrace?.();
  };
}

export type RunExclusivelyOptions = {
  /** Resolving it may fail; the command then runs without the lock rather than not at all. */
  readonly lockDirectory: string | Promise<string>;
  readonly script: string;
  /** Passed to the command as `"$@"`. */
  readonly args?: readonly string[];
  readonly pollIntervalMs?: number;
  readonly report?: (line: string) => void;
  /** The environment the command inherits; defaults to this process's. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /**
   * Runs without taking the host lock: `bun run check` and the stages that only run tests, whose
   * Bun test workers the test slot pool bounds instead. It still gets the install check and the
   * Turborepo defaults, at half the concurrency.
   */
  readonly shared?: boolean;
  /** Reads the host's memory before the stage starts; tests substitute a reading. */
  readonly readMemory?: () => MemoryReading | undefined;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

function describeHolder(holder: HostLockHolder | undefined): string {
  if (!holder) return 'a holder that has not recorded itself yet';
  return `pid ${holder.pid} running \`${holder.command}\` in ${holder.cwd} since ${holder.acquiredAt}`;
}

/** How long stragglers get to exit after SIGTERM before they are killed outright. */
const stragglerGraceMs = 2000;

/**
 * Terminates whatever is left in the command's process group once `sh` has exited, so a leaked
 * background process neither keeps loading the machine nor holds the lock after release.
 */
export async function terminateProcessGroup(processGroup: number): Promise<void> {
  const signalGroup = (signal: NodeJS.Signals): boolean => {
    try {
      process.kill(-processGroup, signal);
      return true;
    } catch {
      return false;
    }
  };
  if (!signalGroup('SIGTERM')) return;
  for (let waited = 0; waited < stragglerGraceMs; waited += 50) {
    if (!isProcessGroupAlive(processGroup, undefined)) return;
    await delay(50, undefined);
  }
  signalGroup('SIGKILL');
}

/** Runs `script` through `sh -c` while holding the host lock and resolves to its exit code. */
export async function runExclusively(input: RunExclusivelyOptions): Promise<number> {
  // Snapshotted, so a caller that changes its options while the run waits cannot change the run.
  const options = { ...input, ...(input.args === undefined ? {} : { args: [...input.args] }) };
  const report = options.report ?? ((line: string) => process.stderr.write(`${line}\n`));
  let lock: HeldHostLock | undefined;
  // Copied too: the command inherits the environment as it was when the run was asked for.
  const environment = { ...(options.environment ?? rootScriptEnvironment()) };
  try {
    const lockDirectory = options.shared ? undefined : await options.lockDirectory;
    // A parent run that already holds the lock exported its token; a stage it started reuses the
    // lock rather than queueing behind its own parent.
    const reserved = environment[heldLockTokenVariable];
    const current =
      reserved === undefined || lockDirectory === undefined
        ? undefined
        : await readOwner(lockDirectory);
    const reusesParentLock = reserved !== undefined && current?.token === reserved;
    if (lockDirectory !== undefined && !reusesParentLock) {
      lock = await acquireHostLock({
        lockDirectory,
        holder: {
          pid: process.pid,
          ...pidStartedAtField(),
          command: options.script,
          cwd: process.cwd(),
          acquiredAt: new Date().toISOString(),
        },
        ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
        onWait: (holder, behind) =>
          report(
            behind === 'queue'
              ? `run-exclusively: queued behind the earlier waiter ${describeHolder(holder)}`
              : `run-exclusively: waiting for the host lock held by ${describeHolder(holder)}`,
          ),
      });
    }
  } catch (error) {
    report(`run-exclusively: running without the host lock: ${(error as Error).message}`);
  }
  try {
    // After the lock, so the reading is taken just before the stage starts, not before a long wait.
    const memory = await admitMemory(options, environment, report);
    if (memory !== undefined) return memory;
    return await runScript(options, environment, lock, report);
  } finally {
    await lock?.release();
  }
}

/** Undefined when the stage may start; otherwise the refusal is reported and its exit code returned. */
async function admitMemory(
  options: RunExclusivelyOptions,
  environment: Readonly<Record<string, string | undefined>>,
  report: (line: string) => void,
): Promise<number | undefined> {
  const admission = await awaitMemory({
    label: 'run-exclusively',
    environment,
    report,
    ...(options.readMemory === undefined ? {} : { readMemory: options.readMemory }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  if (admission.admitted) return undefined;
  report(admission.message);
  return memoryRefusalExitCode;
}

/** Runs the wrapped script through `sh -c`, exporting the held lock's token to it. */
function runScript(
  options: RunExclusivelyOptions,
  snapshot: Readonly<Record<string, string | undefined>>,
  lock: HeldHostLock | undefined,
  report: (line: string) => void,
): Promise<number> {
  const args = options.args ?? [];
  const command = args.length === 0 ? options.script : `${options.script} "$@"`;
  const environment = { ...snapshot, [memoryAdmittedVariable]: '1' };
  return runInProcessGroup(['sh', '-c', command, 'sh', ...args], {
    environment:
      lock === undefined ? environment : { ...environment, [heldLockTokenVariable]: lock.token },
    ...(lock === undefined ? {} : { recordProcessGroup: lock.recordProcessGroup }),
    report,
  });
}

/** This process's start time, as the field an owner record carries, when `ps` can tell it. */
export function pidStartedAtField(): { pidStartedAt?: string } {
  const pidStartedAt = processStartTime(process.pid);
  return pidStartedAt === undefined ? {} : { pidStartedAt };
}

export type ProcessGroupRun = {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  /** Records the group in whatever guards it, before the command is awaited. */
  readonly recordProcessGroup?: (processGroup: number) => Promise<void>;
  readonly report: (line: string) => void;
  /**
   * How the run notices that the session that started it is gone; `false` turns that off. Defaults
   * to this process's ancestors from one `ps` snapshot, checked every five seconds.
   */
  readonly orphanWatch?: false | Partial<OrphanWatchOptions>;
};

/**
 * Runs `argv` as the leader of a new process group and resolves to its exit code. `detached` makes
 * it a new session, so the terminal no longer delivers Ctrl-C to it directly; the wrapper forwards
 * SIGINT, SIGTERM, and SIGHUP to the whole group instead, and terminates what is left of the group
 * once the leader exits. Stdin is closed because a process outside the terminal's foreground group
 * cannot read it, and none of the wrapped commands needs input.
 *
 * Once an ancestor of this wrapper exits (the agent or shell that started it is gone), the group
 * gets the awake-time hang guard to finish, and is then sent SIGTERM like a forwarded signal.
 */
export async function runInProcessGroup(
  argv: readonly string[],
  run: ProcessGroupRun,
): Promise<number> {
  const watchOptions = run.orphanWatch;
  let ancestors: readonly number[] | undefined;
  if (watchOptions !== false) {
    const parents = watchOptions?.ancestors === undefined ? readParents() : undefined;
    ancestors = watchOptions?.ancestors ?? (parents && ancestorsOf(process.pid, parents));
  }
  const [program = 'sh', ...rest] = argv;
  const child = spawn(program, rest, {
    detached: true,
    env: run.environment,
    ...(run.cwd === undefined ? {} : { cwd: run.cwd }),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once('exit', (code, signal) => resolve([code, signal]));
    child.once('error', reject);
  });
  const processGroup = child.pid;
  if (processGroup === undefined) {
    await exited;
    return 127;
  }
  const forward = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-processGroup, signal);
    } catch {
      // The group is already gone.
    }
  };
  const forwarded = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  // Registered before the group is recorded: a caller that reads the recorded group and signals
  // the wrapper must find the forwarders in place, or the default action ends the wrapper and
  // orphans the group.
  for (const signal of forwarded) process.on(signal, forward);
  const stopWatching =
    ancestors === undefined
      ? () => {}
      : watchForOrphaning({
          ...watchOptions,
          ancestors,
          onOrphaned: (gone) => {
            // The session's end may have closed the pipes this process writes to; a failed write
            // must not end the wrapper and leave its group running unwatched.
            for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
            run.report(
              `the session that started this run is gone (pid ${gone} exited); the run ends after ${HANG_GUARD_MILLISECONDS / 1000} s of awake time unless it finishes first`,
            );
          },
          onExpired: () => {
            // The bounded termination, not a bare SIGTERM: a leader that handles SIGTERM and keeps
            // running would leave `exited` pending and the lock or slots held for ever.
            void terminateProcessGroup(processGroup);
            run.report('ended the orphaned run: its session is gone and the hang guard has passed');
          },
        });
  try {
    await run.recordProcessGroup?.(processGroup).catch((error: unknown) => {
      run.report(`could not record the command's process group: ${String(error)}`);
    });
    const [code, signal] = await exited;
    if (signal) return 128 + (constants.signals[signal] ?? 0);
    return code ?? 1;
  } finally {
    stopWatching();
    for (const signal of forwarded) process.off(signal, forward);
    await terminateProcessGroup(processGroup);
  }
}

/** This repository's Git common directory, which every worktree shares. */
export async function gitCommonDirectory(): Promise<string> {
  const git = Bun.spawn(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const text = await new Response(git.stdout).text();
  const output = text.trim();
  if ((await git.exited) !== 0 || output === '') {
    throw new Error('run-exclusively must run inside a Git checkout of this repository');
  }
  if (!isAbsolute(output)) throw new Error(`git returned a relative common directory: ${output}`);
  return output;
}

if (import.meta.main) {
  const sharedFlag = '--shared';
  const shared = process.argv[2] === sharedFlag;
  const [script = '', ...args] = process.argv.slice(shared ? 3 : 2);
  if (script === '') {
    process.stderr.write(
      "usage: bun scripts/run-exclusively.ts [--shared] '<shell command>' [arguments...]\n",
    );
    process.exitCode = 64;
  } else {
    const commonDirectoryLookup = gitCommonDirectory();
    process.exitCode = await runExclusively({
      // A failed lookup still reaches `runExclusively`, which reports it and runs unlocked.
      lockDirectory: commonDirectoryLookup.then((directory) =>
        join(directory, 'corvidae-host-lock'),
      ),
      script: withPreflight(script),
      args,
      shared,
      environment: withTurborepoDefaults(rootScriptEnvironment(), undefined, shared),
    });
  }
}
