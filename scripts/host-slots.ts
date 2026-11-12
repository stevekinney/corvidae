/**
 * Host slots for the heavy work that is not `bun test`: headless browsers, browser suites, the
 * Docker renderer, and fan-outs of worker processes (`documentation/repository/host-admission.md`).
 *
 * Such work takes slots from the same host-wide pool every `bun test` worker does
 * (`scripts/bun-test-pool.ts`), one per process it keeps busy at once, so the pool bounds both
 * together. Nothing about the pool changes: the slots, the arrival-order queue, the owner record and
 * its reclaim are the pool's own, and so is the nested-run rule.
 *
 * - {@link withHostSlots} holds `count` slots while an in-process `run` resolves, with this process
 *   as the holder: a holder killed outright leaves slots that the next waiter reclaims, judged by
 *   pid and start time, and, when the holder leads its own process group, by that group too, so the
 *   slots stay held while the children it started in it live.
 * - {@link runWithHostSlots}, and the command line below, runs a command in a process group of its
 *   own while holding the slots, and records the group in them, as a pooled `bun test` does: a
 *   wrapper killed outright keeps its slots exactly as long as anything in the group lives.
 *
 * Nesting: a run started inside a run that holds slots finds the holder's token in
 * `CORVIDAE_TEST_SLOTS_TOKEN` and runs inside the holder's slots instead of acquiring more, so it
 * neither waits on its own parent nor counts twice. A command run under these slots gets the token,
 * so a `bun test` or another wrapper it starts runs inside them too. The token is honoured only
 * while a live slot names it.
 *
 * Memory: a script admits the host's memory once, however many phases it has
 * ({@link withMemoryAdmission}): it reads before any work starts, waits while the host is short,
 * and exits 75, never 1, once the host stays short (`awaitMemory` in `scripts/run-exclusively.ts`),
 * then marks its environment admitted so its phases and children never read again. A
 * {@link withHostSlots} run outside such a script reads once its slots are held, and throws
 * {@link MemoryRefusal} naming the measurement. A nested run was admitted with its holder, CI
 * reads once, reports and admits, and a test that passes no reader never reads real memory.
 *
 * A request above the pool's size is clamped to it, and the run learns how many slots it holds, so
 * it can bound its own fan-out to them. When the pool cannot be used at all (no Git checkout, as in
 * the renderer's container), the run warns and runs without a slot.
 *
 * Usage: `bun scripts/host-slots.ts --slots=<n> -- <command> [arguments...]`, exiting with the
 * command's exit code, or 64 on a usage error.
 */

import { join } from 'node:path';

import {
  acquireTestSlots,
  heldSlotsTokenVariable,
  poolDirectoryName,
  poolSize,
  readProcessTable,
  slotsHeldUnderToken,
  type HeldTestSlots,
  type ProcessTable,
} from './bun-test-pool.ts';
import { rootScriptEnvironment } from './environment-configuration.ts';
import {
  awaitMemory,
  gitCommonDirectory,
  memoryAdmittedVariable,
  memoryRefusalExitCode,
  pidStartedAtField,
  runInProcessGroup,
  snapshotParents,
  type MemoryReading,
} from './run-exclusively.ts';

/**
 * Thrown by {@link withHostSlots} when the host stayed too short of memory to start the run. Its
 * message names the measurement; a command line exits with {@link memoryRefusalExitCode}.
 */
export class MemoryRefusal extends Error {
  readonly exitCode = memoryRefusalExitCode;
}

export type HostSlotsOptions = {
  /** Where the holder's token is read from, and what a child inherits; defaults to this process's. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Defaults to `corvidae-test-slots` in the Git common directory; a failed lookup runs unpooled. */
  readonly poolDirectory?: string | Promise<string>;
  /** Defaults to the pool's size for the environment. */
  readonly size?: number;
  /** What the owner record says is running; defaults to this process's command line. */
  readonly command?: string;
  readonly cwd?: string;
  readonly pollIntervalMs?: number;
  readonly readProcessTable?: () => ProcessTable | undefined;
  /** Waits between looks while the slots are held by others. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly report?: (line: string) => void;
  /** Reads the host's memory before the run starts; tests substitute a reading. */
  readonly readMemory?: () => MemoryReading | undefined;
};

/** What a run under host slots knows about them. */
export type HostSlots = {
  /**
   * The slots the run may keep busy: those it holds, those of the run it is nested in when fewer
   * than it asked for, or the count it asked for when it runs without the pool.
   */
  readonly count: number;
  /** How the run is admitted. */
  readonly admission: 'held' | 'nested' | 'unpooled';
  /** The environment for a child process: the caller's, plus the token naming these slots. */
  readonly environment: Record<string, string | undefined>;
  /**
   * Records a child's process group in the slots, so they outlive this process while the group
   * lives. Does nothing when the run is nested or unpooled: the slots are not this run's to record.
   */
  readonly recordProcessGroup: (processGroup: number) => Promise<void>;
};

/** Holds `count` host slots while `run` resolves, and releases them however it settles. */
export async function withHostSlots<T>(
  count: number,
  run: (slots: HostSlots) => Promise<T>,
  input: HostSlotsOptions = {},
): Promise<T> {
  snapshotParents();
  // Snapshotted, so a caller that changes its options after an await cannot change this run.
  const options = { ...input };
  const environment = { ...(options.environment ?? rootScriptEnvironment()) };
  const report = options.report ?? ((line: string) => process.stderr.write(`${line}\n`));
  const size = options.size ?? poolSize(environment);
  const wanted = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
  const read = options.readProcessTable ?? readProcessTable;
  let held: HeldTestSlots | undefined;
  let slots: HostSlots = {
    count: wanted,
    admission: 'unpooled',
    environment,
    recordProcessGroup: async () => {},
  };
  try {
    const poolDirectory = await (options.poolDirectory ??
      gitCommonDirectory().then((directory) => join(directory, poolDirectoryName)));
    const parentSlots = await slotsHeldUnderToken(
      poolDirectory,
      environment[heldSlotsTokenVariable],
      read(),
    );
    if (parentSlots === undefined) {
      held = await acquireTestSlots({
        poolDirectory,
        size,
        slots: wanted,
        holder: {
          pid: process.pid,
          ...pidStartedAtField(),
          command: options.command ?? process.argv.slice(1).join(' '),
          cwd: options.cwd ?? process.cwd(),
          acquiredAt: new Date().toISOString(),
        },
        readProcessTable: read,
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
        onWait: (line) => report(`host-slots: ${line}`),
      });
      slots = {
        count: held.slots.length,
        admission: 'held',
        environment: { ...environment, [heldSlotsTokenVariable]: held.token },
        recordProcessGroup: held.recordProcessGroup,
      };
      // A holder that leads a process group records it, as a wrapper records its command's: killed
      // outright, it leaves its slots held while its browsers and shards, in that group, live. A
      // holder that only belongs to a group (a shell's, a parent's) records nothing, since the
      // group may outlive its work for ever, and its slots are reclaimed with the holder's pid.
      if (read()?.get(process.pid)?.processGroup === process.pid) {
        await held.recordProcessGroup(process.pid).catch((error: unknown) => {
          report(`host-slots: could not record the holder's process group: ${String(error)}`);
        });
      }
    } else {
      slots = { ...slots, count: Math.min(wanted, parentSlots), admission: 'nested' };
    }
  } catch (error) {
    report(`host-slots: running without a host slot: ${(error as Error).message}`);
  }
  try {
    // Once the slots are held, so the reading is the one the run starts under. A nested run was
    // admitted with its holder.
    if (slots.admission !== 'nested') {
      const memory = await awaitMemory({
        label: 'host-slots',
        environment,
        report,
        ...(options.readMemory === undefined ? {} : { readMemory: options.readMemory }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      });
      if (!memory.admitted) throw new MemoryRefusal(memory.message);
    }
    slots = { ...slots, environment: { ...slots.environment, [memoryAdmittedVariable]: '1' } };
    return await run(slots);
  } finally {
    await held?.release();
  }
}

/**
 * Runs `argv` in a process group of its own while holding `count` host slots, records the group in
 * them, forwards SIGINT, SIGTERM and SIGHUP to it, and resolves to its exit code.
 */
export function runWithHostSlots(
  count: number,
  argv: readonly string[],
  options: HostSlotsOptions = {},
): Promise<number> {
  const command = [...argv];
  const report = options.report ?? ((line: string) => process.stderr.write(`${line}\n`));
  return withMemoryAdmission(
    (environment) =>
      withHostSlots(
        count,
        (slots) =>
          runInProcessGroup(command, {
            environment: slots.environment,
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            recordProcessGroup: slots.recordProcessGroup,
            report: (line) => report(`host-slots: ${line}`),
          }),
        { command: command.join(' '), ...options, environment },
      ),
    { ...options, report },
  );
}

export type MemoryAdmissionRun = {
  /** The script's environment; defaults to `process.env`, which is then marked admitted. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly report?: (line: string) => void;
  readonly readMemory?: () => MemoryReading | undefined;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly maximumWaitMs?: number;
};

/**
 * The one memory admission of a script that takes host slots, however many phases it has: checks
 * the host's memory before any work starts, then runs `main` with the environment marked admitted
 * ({@link memoryAdmittedVariable}), so every `withHostSlots` phase inside it, and every child, runs
 * without reading again. By default the mark goes on `process.env`; a caller that passes an
 * environment gets a marked copy, handed to `main`, and its own is left as it was. When the host
 * stays too short of memory, the refusal is reported and the exit code is
 * {@link memoryRefusalExitCode} (75), never 1, and `main` never starts.
 */
export async function withMemoryAdmission(
  main: (environment: Record<string, string | undefined>) => Promise<number>,
  options: MemoryAdmissionRun = {},
): Promise<number> {
  const report = options.report ?? ((line: string) => process.stderr.write(`${line}\n`));
  const source = options.environment ?? rootScriptEnvironment();
  try {
    const memory = await awaitMemory({
      label: 'host-slots',
      environment: source,
      report,
      ...(options.readMemory === undefined ? {} : { readMemory: options.readMemory }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      ...(options.maximumWaitMs === undefined ? {} : { maximumWaitMs: options.maximumWaitMs }),
    });
    if (!memory.admitted) throw new MemoryRefusal(memory.message);
    let environment: Record<string, string | undefined>;
    if (options.environment === undefined) {
      environment = rootScriptEnvironment();
      environment[memoryAdmittedVariable] = '1';
    } else {
      environment = { ...options.environment, [memoryAdmittedVariable]: '1' };
    }
    return await main(environment);
  } catch (error) {
    if (!(error instanceof MemoryRefusal)) throw error;
    report(error.message);
    return error.exitCode;
  }
}

/** The slot count and the command from `--slots=<n> -- <command...>`, or the usage error. */
export function parseHostSlotsArguments(
  argumentsList: readonly string[],
): { slots: number; command: string[] } | { error: string } {
  const separator = argumentsList.indexOf('--');
  const flags = separator === -1 ? argumentsList : argumentsList.slice(0, separator);
  const command = separator === -1 ? [] : argumentsList.slice(separator + 1);
  const match = flags.length === 1 ? /^--slots=([1-9]\d*)$/.exec(flags[0] ?? '') : null;
  if (match?.[1] === undefined || command.length === 0) {
    return { error: 'usage: bun scripts/host-slots.ts --slots=<n> -- <command> [arguments...]' };
  }
  return { slots: Number(match[1]), command };
}

if (import.meta.main) {
  const parsed = parseHostSlotsArguments(Bun.argv.slice(2));
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 64;
  } else {
    process.exitCode = await runWithHostSlots(parsed.slots, parsed.command);
  }
}
