/**
 * COR-1439 — the parent test's view of one spawned host process.
 *
 * Stdout is read line by line for the whole life of the child, so the pipe
 * never fills, and each JSON line is a handshake event a test can wait for
 * instead of sleeping. Signals go to the child's own pid, never a process
 * group, so the test runner never receives them. A deadline kills a child
 * that stops making progress and is reported as the reason it exited, rather
 * than being measured.
 */
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';

import { nativeNodeEnvironment } from './environment-configuration';

const runtime = createDefaultRuntimeServices();

/**
 * A child still running this long after it announced `loaded` is killed and
 * reported as stuck. The clock starts at `loaded`, not at spawn: native Node
 * loads the workspace's TypeScript source module by module, which on a
 * contended host has taken over four minutes, while everything after loading
 * is light work. A child that never finishes loading is bounded by its
 * scenario's hang guard instead, which calls `stop()` to kill it.
 */
export const HOST_DEADLINE_MS = 120_000;

export type HostEvent = Readonly<Record<string, unknown>> & { readonly event: string };

export interface HostExit {
  readonly exitCode: number | null;
  readonly signalCode: string | number | null;
  readonly stderr: string;
  readonly events: readonly HostEvent[];
  readonly killedAtDeadline: boolean;
}

export interface HostProcess {
  /** Resolves with the first `event` line, or rejects once the child exits without it. */
  waitFor(event: string): Promise<HostEvent>;
  signal(signal: 'SIGINT' | 'SIGTERM'): void;
  readonly finished: Promise<HostExit>;
  /** SIGKILLs the child if it is still running. Safe to call more than once. */
  stop(): void;
}

export function startHost(
  command: readonly string[],
  env?: Record<string, string | undefined>,
): HostProcess {
  const child = Bun.spawn([...command], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    ...(env === undefined ? {} : { env }),
  });
  const events: HostEvent[] = [];
  const waiters = new Set<() => void>();
  let streamEnded = false;
  let killedAtDeadline = false;
  /** Set once the deadline is armed at `loaded`; clears it. */
  let cancelDeadline: (() => void) | undefined;

  const notify = (): void => {
    if (cancelDeadline === undefined && events.some((candidate) => candidate.event === 'loaded')) {
      const deadline = runtime.timers.setTimeout(() => {
        killedAtDeadline = true;
        child.kill('SIGKILL');
      }, HOST_DEADLINE_MS);
      cancelDeadline = () => runtime.timers.clearTimeout(deadline);
    }
    for (const waiter of waiters) waiter();
  };
  const stdoutDone = (async () => {
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line !== '') events.push(JSON.parse(line) as HostEvent);
        newline = buffered.indexOf('\n');
      }
      notify();
    }
    streamEnded = true;
    notify();
  })();

  const finished = (async (): Promise<HostExit> => {
    const [, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    await stdoutDone;
    cancelDeadline?.();
    return {
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      stderr,
      events,
      killedAtDeadline,
    };
  })();

  return {
    waitFor(event) {
      return new Promise<HostEvent>((resolve, reject) => {
        const check = (): void => {
          const found = events.find((candidate) => candidate.event === event);
          if (found !== undefined) {
            waiters.delete(check);
            resolve(found);
          } else if (streamEnded) {
            waiters.delete(check);
            void finished.then((exit) =>
              reject(new Error(`host exited before "${event}": ${JSON.stringify(exit)}`)),
            );
          }
        };
        waiters.add(check);
        check();
      });
    },
    signal(signal) {
      process.kill(child.pid, signal);
    },
    finished,
    stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}

/** Locates native Node exactly as the Node SQLite adapter's `node-sqlite.test.ts` does, skipping Bun's `node` shims. */
export function resolveNativeNode(searchPath: string): string {
  for (const directory of searchPath.split(delimiter).filter(existsSync)) {
    const candidate = Bun.which('node', { PATH: directory });
    if (candidate === null) continue;
    const identity = Bun.spawnSync([
      candidate,
      '--eval',
      'process.stdout.write(process.versions.bun ? "bun" : process.release.name)',
    ]);
    if (identity.exitCode === 0 && identity.stdout.toString() === 'node') return candidate;
  }
  throw new Error('The native Node signal-shutdown hosts require Node.js.');
}

export type HostRuntime = 'bun' | 'node';

/** How a host file is launched: `bun <host>`, or `node --import <hooks> <host>`. */
export function hostCommand(
  hostRuntime: HostRuntime,
  hooks: string,
): {
  readonly command: (host: string, ...args: string[]) => string[];
  readonly env?: Record<string, string | undefined>;
} {
  if (hostRuntime === 'bun') return { command: (host, ...args) => ['bun', host, ...args] };
  const environment = nativeNodeEnvironment();
  const node = resolveNativeNode(environment.searchPath);
  return {
    command: (host, ...args) => [node, '--import', hooks, host, ...args],
    env: environment.env,
  };
}
