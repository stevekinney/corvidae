import type { SessionStore } from '@lostgradient/operative';
import { createSessionStore } from '@lostgradient/operative';
import type { ConditionalTextValueStore, Storage } from '@lostgradient/weft';
import { textValueStore } from '@lostgradient/weft';
import { writeSync } from 'node:fs';
import { settleRuntimeOwnedPendingApprovals } from './server-owned-elicitation.ts';
import type { Durability } from './server-owned-storage.ts';
import { serverOwnedStorage } from './server-owned-storage.ts';
export type ServerOwnedRuntime = {
  readonly storage: Storage;
  readonly store: ConditionalTextValueStore;
  readonly sessions: SessionStore;
  readonly durability: Durability;
  readonly shutdownSignal: AbortSignal;
  readonly onDispose: (teardown: () => void | Promise<void>) => () => void;
};
// Runtime ownership survives Vite module re-evaluation; disposal clears the slot before callbacks.
const RUNTIME_SLOT = Symbol.for('cinder.chat-room.server-owned.runtime');
const DISPOSAL_SLOT = Symbol.for('cinder.chat-room.server-owned.disposal');
const TERMINATING_SLOT = Symbol.for('cinder.chat-room.server-owned.terminating');
type RuntimeHost = typeof globalThis & {
  [RUNTIME_SLOT]?: HeldRuntime | undefined;
  [DISPOSAL_SLOT]?:
    | Promise<{
        failures: number;
      }>
    | undefined;
  [TERMINATING_SLOT]?: true | undefined;
};
type RuntimeTeardown = () => void | Promise<void>;
type HeldRuntime = {
  runtime: ServerOwnedRuntime;
  shutdownController: AbortController;
  teardowns: RuntimeTeardown[];
};
// Registry symbols identify failures across module generations, where instanceof cannot.
export const SHUTDOWN_FAILURE = Symbol.for('cinder.chat-room.server-owned.shutdown-failure');
export class RuntimeTerminatingError extends Error {
  readonly [SHUTDOWN_FAILURE] = true;
  override readonly name = 'RuntimeTerminatingError';
  constructor() {
    super('The server-owned runtime is shutting down and is not accepting new work.');
  }
}
function createRuntime(): HeldRuntime {
  const { storage, durability, release } = serverOwnedStorage();
  const store = textValueStore(storage);
  const sessions = createSessionStore(store);
  const teardowns: Array<() => void | Promise<void>> = [];
  const shutdownController = new AbortController();
  teardowns.push(release);
  return {
    runtime: {
      storage,
      store,
      sessions,
      durability,
      shutdownSignal: shutdownController.signal,
      onDispose: (teardown) => {
        teardowns.push(teardown);
        return () => {
          const index = teardowns.indexOf(teardown);
          if (index !== -1) teardowns.splice(index, 1);
        };
      },
    },
    teardowns,
    shutdownController,
  };
}
export function serverOwnedRuntime(): ServerOwnedRuntime {
  const host: RuntimeHost = globalThis;
  if (host[TERMINATING_SLOT] === true) throw new RuntimeTerminatingError();
  const held = host[RUNTIME_SLOT];
  if (held === undefined) {
    const created = createRuntime();
    host[RUNTIME_SLOT] = created;
    return created.runtime;
  }
  return held.runtime;
}
// Concurrent disposal joins one promise; draining rejects new work and drains successor generations.
function setDisposalMode(host: RuntimeHost, drain: boolean): void {
  if (drain) host[TERMINATING_SLOT] = true;
  else if (host[DISPOSAL_SLOT] === undefined) host[TERMINATING_SLOT] = undefined;
}

async function replaceDisposalAfterJoin(
  host: RuntimeHost,
  joined: { failures: number },
  remaining: HeldRuntime,
): Promise<{ failures: number }> {
  const drain = drainDisposal(host, remaining);
  host[DISPOSAL_SLOT] = drain;
  try {
    const drained = await drain;
    return { failures: joined.failures + drained.failures };
  } finally {
    if (host[DISPOSAL_SLOT] === drain) host[DISPOSAL_SLOT] = undefined;
  }
}

async function joinDisposal(
  host: RuntimeHost,
  inFlight: Promise<{ failures: number }>,
  drain: boolean,
): Promise<{ failures: number }> {
  const joined = await inFlight;
  if (!drain) return joined;
  const remaining = host[RUNTIME_SLOT];
  if (remaining !== undefined) return replaceDisposalAfterJoin(host, joined, remaining);
  const followOn = host[DISPOSAL_SLOT];
  if (followOn === undefined) return joined;
  const drained = await followOn;
  return { failures: joined.failures + drained.failures };
}

export async function disposeServerOwnedRuntime(
  options: {
    drain?: boolean;
  } = {},
): Promise<{
  failures: number;
}> {
  const host: RuntimeHost = globalThis;
  const drain = options.drain === true;
  setDisposalMode(host, drain);
  const inFlight = host[DISPOSAL_SLOT];
  if (inFlight !== undefined) return joinDisposal(host, inFlight, drain);
  const held = host[RUNTIME_SLOT];
  if (held === undefined) return { failures: 0 };
  const disposal = drain ? drainDisposal(host, held) : runDisposal(host, held);
  host[DISPOSAL_SLOT] = disposal;
  try {
    return await disposal;
  } finally {
    host[DISPOSAL_SLOT] = undefined;
  }
}
async function drainDisposal(
  host: RuntimeHost,
  held: HeldRuntime,
): Promise<{
  failures: number;
}> {
  host[TERMINATING_SLOT] = true;
  let failures = 0;
  let generation: HeldRuntime | undefined = host[RUNTIME_SLOT] ?? held;
  while (generation !== undefined) {
    const disposalResult = await runDisposal(host, generation);
    failures += disposalResult.failures;
    generation = host[RUNTIME_SLOT];
  }
  return { failures };
}
async function runDisposal(
  host: RuntimeHost,
  held: HeldRuntime,
): Promise<{
  failures: number;
}> {
  host[RUNTIME_SLOT] = undefined;
  settleRuntimeOwnedPendingApprovals();
  held.shutdownController.abort();
  let failures = 0;
  // Reverse registration order stops consumers before releasing their storage.
  for (const teardown of held.teardowns.toReversed()) {
    try {
      await teardown();
    } catch (cause) {
      failures += 1;
      reportBeforeExit(
        `[server-owned] A teardown rejected during disposal: ${describeCause(cause)}`,
      );
    }
  }
  return { failures };
}
// Install listeners once; each reload replaces their dispatch target without duplicating listeners.
const SIGNALS_SLOT = Symbol.for('cinder.chat-room.server-owned.signals');
const HANDLER_SLOT = Symbol.for('cinder.chat-room.server-owned.signal-handler');
const LISTENERS_SLOT = Symbol.for('cinder.chat-room.server-owned.signal-listeners');
const LISTENER_PROTOCOL = 2;
type TerminationHandler = (signal: 'SIGTERM' | 'SIGINT', forced: boolean) => void;
type InstalledListeners = {
  protocol: number;
  entries: ReadonlyArray<readonly ['SIGTERM' | 'SIGINT', NodeJS.SignalsListener]>;
};
type SignalHost = typeof globalThis & {
  [SIGNALS_SLOT]?: true | undefined;
  [HANDLER_SLOT]?: TerminationHandler;
  [LISTENERS_SLOT]?: InstalledListeners | undefined;
};
const TERMINATION_STATUS = { SIGTERM: 143, SIGINT: 130 } as const;
function reportBeforeExit(message: string): void {
  try {
    writeSync(2, `${message}\n`);
  } catch {
    process.stderr.write(`${message}\n`);
  }
}
function describeCause(cause: unknown): string {
  try {
    if (cause instanceof Error) {
      return cause.name === 'Error' ? cause.message : `${cause.name}: ${cause.message}`;
    }
    return typeof cause === 'string' ? cause : String(cause);
  } catch {
    return `a ${typeof cause} that could not be described`;
  }
}
const signalHost = globalThis as SignalHost;
function handleTerminationSignal(signal: 'SIGTERM' | 'SIGINT', forced: boolean): void {
  if (forced) {
    process.exit(TERMINATION_STATUS[signal]);
  }
  void disposeServerOwnedRuntime({ drain: true })
    .then(({ failures }) => {
      if (failures > 0) {
        reportBeforeExit(`server-owned runtime: ${failures} teardown(s) failed during shutdown`);
      }
      return undefined;
    })
    .catch((cause: unknown) => {
      reportBeforeExit(
        `server-owned runtime: disposal failed during shutdown: ${describeCause(cause)}`,
      );
    })
    .finally(() => {
      process.exit(TERMINATION_STATUS[signal]);
    });
}
signalHost[HANDLER_SLOT] = handleTerminationSignal;
const installed = signalHost[LISTENERS_SLOT];
if (
  installed !== undefined &&
  installed.protocol !== LISTENER_PROTOCOL &&
  typeof process !== 'undefined'
) {
  for (const [signal, listener] of installed.entries) process.off(signal, listener);
  signalHost[LISTENERS_SLOT] = undefined;
  signalHost[SIGNALS_SLOT] = undefined;
}
if (signalHost[SIGNALS_SLOT] !== true && typeof process !== 'undefined') {
  signalHost[SIGNALS_SLOT] = true;
  let terminating = false;
  const entries: Array<readonly ['SIGTERM' | 'SIGINT', NodeJS.SignalsListener]> = [];
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const listener: NodeJS.SignalsListener = () => {
      // A second signal forces exit if graceful shutdown is stuck.
      const forced = terminating;
      terminating = true;
      const handle = (globalThis as SignalHost)[HANDLER_SLOT] ?? handleTerminationSignal;
      handle(signal, forced);
    };
    process.on(signal, listener);
    entries.push([signal, listener]);
  }
  signalHost[LISTENERS_SLOT] = { protocol: LISTENER_PROTOCOL, entries };
}
