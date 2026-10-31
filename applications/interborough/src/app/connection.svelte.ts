/**
 * Whether the server answers, as the shell knows it. Three things say it does not: a request that
 * got no answer (`isNetworkFailure`, seen on any query or mutation), the browser reporting that it
 * is offline, and the engine feed giving up (`stale` or `closed`). Exactly one thing says it does
 * again: the probe of `/v1/health` that this monitor makes on its own while the server is down.
 * No query result clears it, because a query can succeed against a stopped host: a view that
 * swallows its own failures (`view-probes.ts`) or settles them (`allSettled` in
 * `schedule-kinds.ts`) resolves with the host down.
 *
 * Everything that shows the problem reads `unreachable` from here: the shell's banner, the view
 * frame's dimming (`view-frame.svelte`), the full-page state for a view with nothing to show, and
 * the refusal of changes (`../lib/write-guard.ts`, which the shell arms from this monitor). A page
 * never decides for itself whether to disable an action; it marks the control `data-changes`, and
 * the shell turns it off (`shell/changing-actions.ts`).
 */
import { getContext, setContext } from 'svelte';

import type { QueryClient } from '@tanstack/svelte-query';

import { isNetworkFailure } from '../lib/faults.ts';

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

  /** Records that the server answered. Only the probe may say so: see the header. */
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

  /**
   * Reads one query or mutation cache event. An error with no answer makes the server unreachable.
   * A success moves the age of the data forward while the server is reachable, and does nothing
   * while it is not: it cannot lift the state, and it must not make the data on screen look newer.
   */
  observe(queryClient: QueryClient): () => void {
    const onEvent = (event: { type: string; action?: { type: string; error?: unknown } }): void => {
      if (event.type !== 'updated' || event.action === undefined) return;
      if (event.action.type === 'success') {
        if (!this.unreachable && !this.#disposed) this.lastHealthyAt = this.#now();
      } else if (event.action.type === 'error' && isNetworkFailure(event.action.error)) {
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
