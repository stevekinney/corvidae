/**
 * COR-1439 — signal-driven shutdown and restart recovery for a long-lived
 * process hosting Weft, Operative, or Bureau.
 *
 * Each case spawns a real host process (`test/signal-shutdown/*-host.ts`),
 * waits for its `ready` handshake on stdout, sends SIGTERM or SIGINT to that
 * child's pid alone, and asserts on its exit code and the marker files it
 * wrote synchronously before exiting. Where the criterion is recovery, a
 * second host is launched over the same store, the way a supervisor relaunches
 * a service. Every host installs the same reference handler,
 * `test/signal-shutdown/shutdown-handler.ts`, which
 * `documentation/runtime-contracts.md` carries verbatim.
 *
 * The Weft and Operative hosts run under Bun and under native Node; the Node
 * runs are plain `node --import <hooks> <host>.ts` (not `node --test`, so the
 * signal reaches the host) over `NodeSQLiteStorage`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  type HostProcess,
  type HostRuntime,
  HOST_DEADLINE_MS,
  hostCommand,
  startHost,
} from './test/signal-shutdown/host-process';

const HOSTS = join(import.meta.dir, 'test', 'signal-shutdown');
const HOOKS = join(HOSTS, 'native-node-hooks.ts');
const HANDLER = join(HOSTS, 'shutdown-handler.ts');
const RUNTIME_CONTRACTS = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'documentation',
  'runtime-contracts.md',
);
/** Each case runs at most two hosts one after the other, so either can reach its deadline first. */
const TEST_TIMEOUT_MS = 2 * HOST_DEADLINE_MS + 60_000;

const STORAGE_BY_RUNTIME: Record<HostRuntime, string> = {
  bun: 'BunSQLiteStorage',
  node: 'NodeSQLiteStorage',
};

const hosts: HostProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    host.stop();
    await host.finished;
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function scratchDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `corvidae-signal-shutdown-${label}-`));
  directories.push(directory);
  return directory;
}

function launch(command: readonly string[], env?: Record<string, string | undefined>) {
  const host = startHost(command, env);
  hosts.push(host);
  return host;
}

function readMarker(directory: string, name: string): unknown {
  return JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));
}

/** A host that exited the way the case expects: by its own `process.exit`, cleanly, in time. */
function expectExit(exit: Awaited<HostProcess['finished']>, exitCode: number): void {
  expect({ killedAtDeadline: exit.killedAtDeadline, signalCode: exit.signalCode }).toEqual({
    killedAtDeadline: false,
    signalCode: null,
  });
  expect(exit.stderr).toBe('');
  expect(exit.exitCode).toBe(exitCode);
}

describe.each(['bun', 'node'] as const)('a Weft host under %s', (hostRuntime) => {
  it(
    'awaits engine.shutdown() on SIGTERM and exits 0, and a relaunched host recovers the workflow to its terminal result',
    async () => {
      const directory = scratchDirectory(`weft-${hostRuntime}`);
      const { command, env } = hostCommand(hostRuntime, HOOKS);
      const host = launch(command(join(HOSTS, 'weft-host.ts'), 'start', directory), env);

      const ready = await host.waitFor('ready');
      expect(ready['storage']).toBe(STORAGE_BY_RUNTIME[hostRuntime]);
      host.signal('SIGTERM');
      expectExit(await host.finished, 0);
      expect(readMarker(directory, 'weft-shutdown')).toEqual({ released: true });

      const relaunched = launch(command(join(HOSTS, 'weft-host.ts'), 'recover', directory), env);
      expectExit(await relaunched.finished, 0);
      expect(readMarker(directory, 'weft-recovered')).toEqual({
        result: { prepared: 21, finished: 42 },
        status: 'completed',
        // Recovery resumed the workflow after its committed first step.
        prepareCalls: 0,
      });
    },
    TEST_TIMEOUT_MS,
  );
});

describe.each(['bun', 'node'] as const)('an Operative host under %s', (hostRuntime) => {
  it(
    'calls run.abort() on SIGTERM, awaits run.closed(), and exits 0 with the run aborted',
    async () => {
      const directory = scratchDirectory(`operative-${hostRuntime}`);
      const { command, env } = hostCommand(hostRuntime, HOOKS);
      const host = launch(command(join(HOSTS, 'operative-host.ts'), 'start', directory), env);

      const ready = await host.waitFor('ready');
      expect(ready['storage']).toBe(STORAGE_BY_RUNTIME[hostRuntime]);
      host.signal('SIGTERM');
      expectExit(await host.finished, 0);
      expect(readMarker(directory, 'operative-shutdown')).toEqual({
        cleanup: 'completed',
        finishReason: 'aborted',
      });

      // The next process reads the same store: the durable run's terminal status is aborted.
      const inspector = launch(
        command(join(HOSTS, 'operative-host.ts'), 'inspect', directory),
        env,
      );
      expectExit(await inspector.finished, 0);
      expect(readMarker(directory, 'operative-inspected')).toEqual({
        workflowStatus: 'cancelled',
        finishReason: 'aborted',
        completedSteps: 1,
      });
    },
    TEST_TIMEOUT_MS,
  );
});

interface BureauShutdownMarker {
  readonly report: {
    readonly policy: 'abort' | 'drain';
    readonly unresolved: number;
    readonly owners: readonly { readonly kind: string; readonly outcome: string }[];
  };
  readonly refusal?: string;
  readonly runStatus?: string;
}

interface BureauRecoveredMarker {
  readonly recovery?: string;
  readonly durableStatus?: string;
  readonly stepZeroCalls: number;
  readonly laterStepCalls: number;
}

describe('a Bureau host', () => {
  const bureauHost = join(HOSTS, 'bureau-host.ts');

  async function startBureau(mode: string): Promise<{ host: HostProcess; directory: string }> {
    const directory = scratchDirectory(`bureau-${mode}`);
    const host = launch(['bun', bureauHost, mode, directory]);
    await host.waitFor('ready');
    return { host, directory };
  }

  async function relaunchBureau(directory: string): Promise<BureauRecoveredMarker> {
    const relaunched = launch(['bun', bureauHost, 'recover', directory]);
    expectExit(await relaunched.finished, 0);
    return readMarker(directory, 'bureau-recovered') as BureauRecoveredMarker;
  }

  it(
    "drains on SIGTERM under policy: 'drain': refuses new runs, settles the in-flight run, reports unresolved === 0, and exits 0",
    async () => {
      const { host, directory } = await startBureau('drain');
      host.signal('SIGTERM');
      expectExit(await host.finished, 0);

      const marker = readMarker(directory, 'bureau-shutdown') as BureauShutdownMarker;
      expect(marker.refusal).toBe('Cannot create run: Bureau is shutting down.');
      expect(marker.runStatus).toBe('completed');
      expect(marker.report.policy).toBe('drain');
      expect(marker.report.unresolved).toBe(0);
      expect(marker.report.owners.map((owner) => owner.outcome)).not.toContain('unresolved');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "aborts on SIGTERM under policy: 'abort': the in-flight run ends aborted, the report has unresolved === 0, and the process exits 0",
    async () => {
      const { host, directory } = await startBureau('abort');
      host.signal('SIGTERM');
      expectExit(await host.finished, 0);

      const marker = readMarker(directory, 'bureau-shutdown') as BureauShutdownMarker;
      expect(marker.runStatus).toBe('aborted');
      expect(marker.report.policy).toBe('abort');
      expect(marker.report.unresolved).toBe(0);

      // The abort is durable: the next process finds the run cancelled and never resumes it.
      expect(await relaunchBureau(directory)).toEqual({
        recovery: 'clean',
        durableStatus: 'cancelled',
        stepZeroCalls: 0,
        laterStepCalls: 0,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exits 1 when shutdown exceeds timeoutMilliseconds, and the report names each unresolved owner',
    async () => {
      const { host, directory } = await startBureau('timeout');
      host.signal('SIGTERM');
      expectExit(await host.finished, 1);

      const { report } = readMarker(directory, 'bureau-shutdown') as BureauShutdownMarker;
      const unresolved = report.owners.filter((owner) => owner.outcome === 'unresolved');
      expect(report.unresolved).toBeGreaterThan(0);
      expect(unresolved).toHaveLength(report.unresolved);
      // The stuck run holds every owner the drain waits on.
      expect(unresolved.map((owner) => owner.kind)).toEqual([
        'audit-trail',
        'event-history',
        'durable-engine',
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'forces exit 130 on a second SIGINT during a drain, and the next process recovers the run to its terminal result',
    async () => {
      const { host, directory } = await startBureau('interrupt');
      host.signal('SIGINT');
      await host.waitFor('draining');
      host.signal('SIGINT');
      expectExit(await host.finished, 130);

      expect(await relaunchBureau(directory)).toEqual({
        recovery: 'clean',
        durableStatus: 'completed',
        stepZeroCalls: 0,
        laterStepCalls: 1,
      });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the long-lived process reference handler', () => {
  it('appears verbatim in documentation/runtime-contracts.md', () => {
    const handler = readFileSync(HANDLER, 'utf8');
    const documentation = readFileSync(RUNTIME_CONTRACTS, 'utf8');
    const section = documentation.split('\n## Hosting in a long-lived process\n')[1];
    expect(section).toBeDefined();
    const block = /```ts\n([\s\S]*?)```/.exec(section ?? '')?.[1];
    expect(block).toBe(handler);
  });
});
