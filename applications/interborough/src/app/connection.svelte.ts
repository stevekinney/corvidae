/**
 * Whether the server answers, as the shell knows it. Three things say it does not: a request that
 * got no answer (`isNetworkFailure`, seen on any query or mutation), the browser reporting that it
 * is offline, and the engine feed giving up (`stale` or `closed`). One thing says it does again: a
 * request that got an answer, or the probe of `/v1/health` that this monitor makes on its own while
 * the server is down, because nothing else asks while the page sits still.
 *
 * Everything that shows the problem reads `unreachable` from here: the shell's banner, the view
 * frame's dimming (`view-frame.svelte`), the full-page state for a view with nothing to show, and
 * the refusal of changes (`guardChanges`). A page never decides for itself whether to disable an
 * action; it asks `refuseChange` or marks the control `data-changes`, and the shell turns it off.
 */
import { getContext, setContext } from 'svelte';

import type { QueryClient } from '@tanstack/svelte-query';

import { isNetworkFailure, ServerUnreachableError } from '../lib/faults.ts';

/** The wait before the probe of attempt `attempt` (counted from 1): one second, doubling to eight. */
export function connectionProbeDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** (attempt - 1), 8_000);
}

export interface ConnectionMonitorOptions {
  /** Resolves when the server answers in any way, and rejects when it does not. */
  readonly probe: () => Promise<unknown>;
  /** Called once the server answers again after being unreachable, to refetch what was kept. */
  readonly onRecovered?: () => void;
  /** Overrides the wait before each probe while unreachable; tests inject a near-zero one. */
  readonly probeDelayMs?: (attempt: number) => number;
  /** Overrides the clock `lastHealthyAt` reads. */
  readonly now?: () => number;
}

export class ConnectionMonitor {
  /** Whether the server is known not to answer. */
  unreachable = $state(false);
  /** When the server last answered, which is the age of the data the page still shows. */
  lastHealthyAt = $state(0);

  readonly #probe: () => Promise<unknown>;
  readonly #onRecovered: (() => void) | undefined;
  readonly #delay: (attempt: number) => number;
  readonly #now: () => number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #attempt = 0;
  #disposed = false;

  constructor(options: ConnectionMonitorOptions) {
    this.#probe = options.probe;
    this.#onRecovered = options.onRecovered;
    this.#delay = options.probeDelayMs ?? connectionProbeDelayMs;
    this.#now = options.now ?? Date.now;
    this.lastHealthyAt = this.#now();
  }

  /** Records that a request got no answer. The probe starts, and runs until the server answers. */
  reportUnreachable(): void {
    if (this.#disposed || this.unreachable) return;
    this.unreachable = true;
    this.#attempt = 0;
    this.#scheduleProbe();
  }

  /** Records that the server answered. */
  reportReachable(): void {
    if (this.#disposed) return;
    this.lastHealthyAt = this.#now();
    if (!this.unreachable) return;
    this.unreachable = false;
    this.#stopProbing();
    this.#onRecovered?.();
  }

  /** Asks the server once, now. Used by the banner's Retry and when the browser comes back online. */
  async check(): Promise<void> {
    if (this.#disposed) return;
    try {
      await this.#probe();
    } catch {
      this.reportUnreachable();
      return;
    }
    this.reportReachable();
  }

  /** Reads one query or mutation cache event: an error with no answer, or a success. */
  observe(queryClient: QueryClient): () => void {
    const onEvent = (event: { type: string; action?: { type: string; error?: unknown } }): void => {
      if (event.type !== 'updated' || event.action === undefined) return;
      if (event.action.type === 'success') this.reportReachable();
      else if (event.action.type === 'error' && isNetworkFailure(event.action.error)) {
        this.reportUnreachable();
      }
    };
    const stopQueries = queryClient.getQueryCache().subscribe(onEvent);
    const stopMutations = queryClient.getMutationCache().subscribe(onEvent);
    return () => {
      stopQueries();
      stopMutations();
    };
  }

  #scheduleProbe(): void {
    if (this.#disposed || this.#timer !== undefined) return;
    this.#attempt += 1;
    // poll-reason: timer
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#probeOnce();
    }, this.#delay(this.#attempt));
  }

  async #probeOnce(): Promise<void> {
    if (this.#disposed || !this.unreachable) return;
    try {
      await this.#probe();
    } catch {
      this.#scheduleProbe();
      return;
    }
    this.reportReachable();
  }

  #stopProbing(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#attempt = 0;
  }

  dispose(): void {
    this.#disposed = true;
    this.#stopProbing();
  }
}

/**
 * Refuses every mutation while the server is unreachable, for the whole application, without a
 * page naming it: a change sent to a server that does not answer would fail after the retries, or
 * worse, be queued by the browser and sent later. The refusal is a `ServerUnreachableError`, which
 * the default mutation handler already tells the person in the words of an unreachable fault.
 * Returns the function that puts the previous handler back.
 */
export function guardChanges(queryClient: QueryClient, monitor: ConnectionMonitor): () => void {
  const config = queryClient.getMutationCache().config;
  const previous = config.onMutate;
  config.onMutate = (...input) => {
    if (monitor.unreachable) throw new ServerUnreachableError();
    return previous?.(...input);
  };
  return () => {
    if (previous === undefined) delete config.onMutate;
    else config.onMutate = previous;
  };
}

const CONNECTION_CONTEXT_KEY = Symbol('interborough-connection');

/** A monitor that never reports a problem, for a view rendered without a shell (a test harness). */
const REACHABLE = {
  unreachable: false,
  lastHealthyAt: 0,
} as const satisfies Pick<ConnectionMonitor, 'unreachable' | 'lastHealthyAt'>;

/** Provides the shell's monitor to everything below it. */
export function provideConnection(monitor: ConnectionMonitor): ConnectionMonitor {
  setContext(CONNECTION_CONTEXT_KEY, monitor);
  return monitor;
}

/** Reads the shell's monitor, or a monitor that reports no problem when there is no shell. */
export function getConnection(): Pick<ConnectionMonitor, 'unreachable' | 'lastHealthyAt'> {
  return getContext<ConnectionMonitor | undefined>(CONNECTION_CONTEXT_KEY) ?? REACHABLE;
}
