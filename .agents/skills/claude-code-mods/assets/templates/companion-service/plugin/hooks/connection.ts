import type { AttentionItemState, ConnectionState } from '../types';

import type { PresenceRequest, RuntimeFile } from './protocol';
import {
  PROTOCOL_VERSION,
  compatibilityOf,
  parseHealth,
  parseItems,
  parseRuntimeFile,
} from './protocol';

/**
 * The narrow capabilities the poller needs. The hooks module builds this
 * object in its `session.start` hook, each member spelling one `$` call, so
 * static analysis sees every call and this file stays plain TypeScript.
 */
export type CompanionHost = {
  readRuntimeFile: () => Promise<string>;
  fetch: (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<{ status: number; ok: boolean; text: string }>;
  now: () => Promise<number>;
  after: (milliseconds: number, callback: () => void) => { cancel: () => void };
  sessionId: () => Promise<string>;
  random: () => number;
};

export type Poller = {
  /** Starts the first cycle on the next timer turn, so `session.start` is not held. */
  start: () => void;
  /** Runs a cycle now, or once more after the one in flight. */
  refreshNow: () => Promise<void>;
  /** Acknowledges one item at the service, then refreshes. Resolves `true` once the service accepted it. */
  acknowledge: (id: string) => Promise<boolean>;
  /** Stops scheduling, and drops any result that arrives afterwards. */
  stop: () => void;
};

export const POLL_INTERVAL_MILLISECONDS = 15_000;
export const MAXIMUM_BACKOFF_MILLISECONDS = 5 * 60_000;

/** Exponential backoff with equal jitter: half the ceiling fixed, half random. */
export function backoffDelay(failures: number, random: () => number): number {
  const ceiling = Math.min(
    MAXIMUM_BACKOFF_MILLISECONDS,
    POLL_INTERVAL_MILLISECONDS * 2 ** Math.max(0, failures - 1),
  );
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** The steady polling interval, spread by plus or minus 20 percent so sessions do not poll in step. */
export function steadyDelay(random: () => number): number {
  return Math.round(POLL_INTERVAL_MILLISECONDS * (0.8 + random() * 0.4));
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Only a loopback address may receive the token and this session's presence. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

type CycleOutcome =
  | { kind: 'connected' }
  | { kind: 'not-running' }
  | { kind: 'unreachable' }
  | { kind: 'unauthorized' }
  | { kind: 'incompatible'; detail: string }
  | { kind: 'superseded' };

export function createPoller(options: {
  host: CompanionHost;
  instanceId: string;
  onItems: (items: AttentionItemState[]) => Promise<unknown>;
  onConnection: (connection: ConnectionState) => Promise<unknown>;
}): Poller {
  const { host, instanceId, onItems, onConnection } = options;
  // A cycle compares the generation it started in with the current one before
  // it reports anything; stop() moves the generation, so a late answer is dropped.
  let generation = 0;
  let isStopped = false;
  let timer: { cancel: () => void } | undefined;
  let inFlight: Promise<void> | undefined;
  let isQueued = false;
  let failures = 0;
  let sequence = 0;
  let runtime: RuntimeFile | undefined;

  async function loadRuntime(): Promise<RuntimeFile | undefined> {
    try {
      return parseRuntimeFile(JSON.parse(await host.readRuntimeFile()));
    } catch {
      return undefined;
    }
  }

  function authorized(path: string, init: { method?: string; body?: string } = {}) {
    const current = runtime;
    if (current === undefined) throw new Error('no runtime file is loaded');
    return host.fetch(`${current.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${current.token}`, 'content-type': 'application/json' },
    });
  }

  async function sendPresence(): Promise<void> {
    sequence += 1;
    const sessionId = await host.sessionId();
    const presence: PresenceRequest = { sessionId, instanceId, sequence, sentAt: await host.now() };
    try {
      await authorized(`/v1/presence/${encodeURIComponent(sessionId)}`, {
        method: 'PUT',
        body: JSON.stringify(presence),
      });
    } catch {
      // Presence is best effort: a missed heartbeat expires on the service side.
    }
  }

  async function cycle(started: number): Promise<CycleOutcome> {
    runtime = await loadRuntime();
    if (runtime === undefined) return { kind: 'not-running' };
    if (!isLoopbackUrl(runtime.url)) {
      return {
        kind: 'incompatible',
        detail: 'the runtime file names an address that is not loopback',
      };
    }
    if (runtime.protocolVersion !== PROTOCOL_VERSION) {
      return {
        kind: 'incompatible',
        detail: `the service speaks protocol ${runtime.protocolVersion}`,
      };
    }

    const health = await host.fetch(`${runtime.url}/health`, { method: 'GET' });
    const compatibility = compatibilityOf(health.ok ? parseHealth(jsonOf(health.text)) : undefined);
    if (compatibility === 'not-this-service') {
      return {
        kind: 'incompatible',
        detail: `something other than the attention-queue service answers at ${runtime.url}`,
      };
    }
    if (compatibility === 'other-protocol') {
      return { kind: 'incompatible', detail: 'the service speaks another protocol version' };
    }

    const listed = await authorized('/v1/items');
    if (listed.status === 401 || listed.status === 403) return { kind: 'unauthorized' };
    if (!listed.ok) throw new Error(`the items request failed with status ${listed.status}`);
    const parsed = parseItems(jsonOf(listed.text));
    if (parsed === undefined)
      throw new Error('the service answered the items request in an unknown shape');

    if (started !== generation) return { kind: 'superseded' };
    await onItems(parsed.items);
    await sendPresence();
    return { kind: 'connected' };
  }

  function schedule(delay: number): void {
    timer?.cancel();
    timer = host.after(delay, () => {
      timer = undefined;
      trigger().catch(() => undefined);
    });
  }

  async function runOnce(): Promise<void> {
    const started = generation;
    let outcome: CycleOutcome;
    try {
      outcome = await cycle(started);
    } catch {
      outcome = { kind: 'unreachable' };
    }
    if (started !== generation || outcome.kind === 'superseded') return;

    if (outcome.kind === 'connected') {
      failures = 0;
      const delay = steadyDelay(host.random);
      await onConnection({ kind: 'connected', checkedAt: await host.now() });
      schedule(delay);
      return;
    }

    failures += 1;
    // A problem the person must fix (a stale token, another program on the
    // port) is checked again slowly; one that may pass on its own backs off.
    const isPersonFixable = outcome.kind === 'unauthorized' || outcome.kind === 'incompatible';
    const delay = isPersonFixable
      ? MAXIMUM_BACKOFF_MILLISECONDS
      : backoffDelay(failures, host.random);
    await onConnection(
      outcome.kind === 'incompatible'
        ? { kind: 'incompatible', detail: outcome.detail, retryInMs: delay }
        : { kind: outcome.kind, retryInMs: delay },
    );
    schedule(delay);
  }

  function trigger(): Promise<void> {
    if (isStopped) return Promise.resolve();
    if (inFlight !== undefined) {
      isQueued = true;
      return inFlight;
    }
    timer?.cancel();
    timer = undefined;
    inFlight = (async () => {
      try {
        do {
          isQueued = false;
          await runOnce();
        } while (isQueued && !isStopped);
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  }

  return {
    start: () => schedule(0),
    refreshNow: trigger,
    acknowledge: async (id) => {
      if (runtime === undefined || isStopped) return false;
      const answered = await authorized(`/v1/items/${encodeURIComponent(id)}/acknowledge`, {
        method: 'POST',
      });
      await trigger();
      return answered.ok;
    },
    stop: () => {
      isStopped = true;
      generation += 1;
      timer?.cancel();
      timer = undefined;
    },
  };
}
