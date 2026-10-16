import type { SessionClock } from '../session/session-clock.ts';
import type { OutputSource, ProcessBackend, TerminalDimensions } from '../session/session-types.ts';
import type { HostPlatform } from './host-platform.ts';
import type { DescriptorWrite } from './input-writer.ts';
import type { PipeDevice } from './pipe-device.ts';
import type { ProcessStartFailure } from './process-start-failure.ts';
import type { PtyDevice } from './pty-device.ts';
import type { MasterWorker, MasterWrite } from './pty-master.ts';

/**
 * The server-owned shapes a Bun host uses to describe a process before it spawns one. A profile is
 * chosen by the host, never by a client: the executable, arguments, working directory, and
 * environment are all explicit, and nothing is resolved from a shell string.
 */
export type ProcessProfile = {
  /** Absolute path or bare name of the executable; never a shell command line. */
  executable: string;
  /** Arguments passed after the executable, without shell interpretation. */
  argumentList: readonly string[];
  /** Absolute working directory the process starts in. */
  workingDirectory: string;
  /** The complete environment; nothing is inherited from the host process. */
  environment: Readonly<Record<string, string>>;
};

/** How a process ended, reported separately from output end-of-file. */
export type ProcessExit = {
  /** The exit code, or `null` when a signal ended the process. */
  exitCode: number | null;
  /** The terminating signal name, or `null` when the process exited on its own. */
  signal: string | null;
};

/** The slice of `Bun.Subprocess` the helpers use, so a test can describe a process that cannot be spawned for real. */
export type SpawnedProcess = {
  readonly pid: number;
  readonly exited: Promise<number>;
  /** A signal's name, or its number when the host has no name for it. */
  readonly signalCode: string | number | null;
  readonly stdin?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
  /** The descriptors Bun opened for extra stdio entries, by position; only a gated PTY child uses them. */
  readonly stdio?: readonly unknown[] | undefined;
  kill(signal?: number | string): void;
};

/** `Bun.spawn`, narrowed to what the helpers call. */
export type SpawnProcess = (command: string[], options: Record<string, unknown>) => SpawnedProcess;

/**
 * What every helper accepts besides the process itself. All of it defaults to the running host, so
 * a production caller passes none of it; each exists so a test can reach a branch the host cannot
 * produce, such as an unsupported platform.
 */
export type ProcessHostOptions = {
  /** The platform and architecture checked against the supported matrix. Defaults to the running host. */
  host?: HostPlatform;
  /** Defaults to `Bun.spawn`. */
  spawn?: SpawnProcess;
  /** Times the termination grace and observation window. Defaults to the system clock. */
  clock?: SessionClock;
  /**
   * How long a TERM-signaled process group may take to empty before it is KILL-signaled.
   * Whole milliseconds within `PROCESS_BUDGETS`; defaults to 1,000.
   */
  terminationGraceMilliseconds?: number;
  /**
   * How long a KILL-signaled process group may take to empty before cleanup reports it
   * `incomplete`. The descendant observation window from the security budgets; defaults to 2,000.
   */
  observationWindowMilliseconds?: number;
};

/** A pipe process: stdout and stderr keep their identity, and stdin is optional. */
export type PipeProcessOptions = ProcessHostOptions & {
  profile: ProcessProfile;
  /** Whether the host opens stdin for input; omitted means the process has no input channel. */
  acceptsInput?: boolean;
  /**
   * Binds the operating-system calls that open the input pipe; throwing means this host cannot.
   * Defaults to libc through `bun:ffi`.
   */
  loadDevice?: () => PipeDevice;
  /** Writes input to the pipe without blocking. Defaults to `fs.writeSync`. */
  writeInput?: DescriptorWrite;
};

/** A PTY process: one combined terminal stream, started at validated dimensions. */
export type PtyProcessOptions = ProcessHostOptions & {
  profile: ProcessProfile;
  dimensions: TerminalDimensions;
  /**
   * Binds the operating-system calls that open and size the terminal; throwing means this host
   * cannot. Defaults to libc through `bun:ffi`.
   */
  loadDevice?: () => PtyDevice;
  /** Starts the thread that reads the terminal's master. Defaults to the `Worker` in `pty-master-worker.ts`. */
  createMasterWorker?: () => MasterWorker;
  /** Writes input to the master without blocking. Defaults to `fs.writeSync`. */
  writeMaster?: MasterWrite;
  /** How long cleanup waits for the reader thread to confirm it stopped. Defaults to two seconds. */
  masterStopTimeoutMilliseconds?: number;
};

/**
 * How long cleanup waits, each with its permitted range. The observation window is the descendant observation window from the security budgets;
 * a TERM grace and an observation window together stay inside the session's cleanup deadline at
 * their defaults. Values outside a range are refused, never clamped.
 */
export const PROCESS_BUDGETS = {
  terminationGraceMilliseconds: { default: 1_000, minimum: 1, maximum: 30_000 },
  observationWindowMilliseconds: { default: 2_000, minimum: 250, maximum: 30_000 },
} as const;

/** The part of a `Session` a hosted process needs in order to report its exit. */
export type ProcessExitReceiver = {
  start(): Promise<void>;
  reportProcessExit(exitCode: number | null, signal: string | null): boolean;
};

/**
 * A process the helpers own, described the way a `Session` consumes it. The host passes `backend`
 * and `sources` to the session, then calls `reportExitTo` so the exit reaches it after output.
 */
export type HostedProcess = {
  readonly mode: 'pipe' | 'pty';
  readonly backend: ProcessBackend;
  readonly sources: readonly OutputSource[];
  /** Why the process did not start, once `backend.start()` has rejected; otherwise `undefined`. */
  readonly startFailure: ProcessStartFailure | undefined;
  /**
   * Start the session if it has not started, wait for the process to end, and report the exit.
   * The exit is reported only once the session is running, so it can never overtake the output it
   * follows. Resolves without reporting when the process never started.
   */
  reportExitTo(receiver: ProcessExitReceiver): Promise<void>;
};
