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
 *
 * Booting a host is process start and module load, which no per-test clock
 * fits on a loaded host, so each case runs whole, once, at module scope (see
 * `test/hoisted-scenario.ts`) and its test rethrows any failure it captured.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  expectScenarioPassed,
  type ScenarioOutcome,
  type ScenarioScope,
  settleScenario,
} from './test/hoisted-scenario';
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
/**
 * The only bound on how long a host takes to load. Each case runs at most two
 * hosts one after the other; native Node took 259 s to load the workspace
 * source on a host with a load average near 110, so this covers two such loads
 * plus each host's post-load deadline. A host that hangs before `loaded` fails
 * its scenario at this hang guard rather than as `killedAtDeadline`, and the
 * guard still kills it.
 */
const NATIVE_LOAD_ALLOWANCE_MS = 300_000;
const HANG_GUARD_MILLISECONDS = 2 * (NATIVE_LOAD_ALLOWANCE_MS + HOST_DEADLINE_MS) + 60_000;

const STORAGE_BY_RUNTIME: Record<HostRuntime, string> = {
  bun: 'BunSQLiteStorage',
  node: 'NodeSQLiteStorage',
};

interface HostScope {
  readonly directory: string;
  launch(command: readonly string[], env?: Record<string, string | undefined>): HostProcess;
}

/**
 * Gives a scenario a scratch directory and a launcher, and kills every host it
 * launched and removes the directory however the scenario ends, including at
 * the hang guard, which a hung scenario's own `finally` never reaches.
 */
async function withHosts(
  scope: ScenarioScope,
  label: string,
  body: (hosts: HostScope) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `corvidae-signal-shutdown-${label}-`));
  const hosts: HostProcess[] = [];
  scope.onHang(() => {
    for (const host of hosts) host.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  try {
    await body({
      directory,
      launch(command, env) {
        const host = startHost(command, env);
        hosts.push(host);
        return host;
      },
    });
  } finally {
    for (const host of hosts) {
      host.stop();
      await host.finished;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function settle(run: (scope: ScenarioScope) => Promise<void>): Promise<ScenarioOutcome> {
  return settleScenario(run, HANG_GUARD_MILLISECONDS);
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

async function weftScenario(hostRuntime: HostRuntime, scope: ScenarioScope): Promise<void> {
  await withHosts(scope, `weft-${hostRuntime}`, async ({ directory, launch }) => {
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
  });
}

async function operativeScenario(hostRuntime: HostRuntime, scope: ScenarioScope): Promise<void> {
  await withHosts(scope, `operative-${hostRuntime}`, async ({ directory, launch }) => {
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
    const inspector = launch(command(join(HOSTS, 'operative-host.ts'), 'inspect', directory), env);
    expectExit(await inspector.finished, 0);
    expect(readMarker(directory, 'operative-inspected')).toEqual({
      workflowStatus: 'cancelled',
      finishReason: 'aborted',
      completedSteps: 1,
    });
  });
}

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

const BUREAU_HOST = join(HOSTS, 'bureau-host.ts');

/** Starts a Bureau host in `mode`, waits for its `ready` handshake, and hands it to `body`. */
async function bureauScenario(
  mode: string,
  scope: ScenarioScope,
  body: (host: HostProcess, hosts: HostScope) => Promise<void>,
): Promise<void> {
  await withHosts(scope, `bureau-${mode}`, async (hosts) => {
    const host = hosts.launch(['bun', BUREAU_HOST, mode, hosts.directory]);
    await host.waitFor('ready');
    await body(host, hosts);
  });
}

async function relaunchBureau({ directory, launch }: HostScope): Promise<BureauRecoveredMarker> {
  const relaunched = launch(['bun', BUREAU_HOST, 'recover', directory]);
  expectExit(await relaunched.finished, 0);
  return readMarker(directory, 'bureau-recovered') as BureauRecoveredMarker;
}

const drainScenario = (scope: ScenarioScope) =>
  bureauScenario('drain', scope, async (host, { directory }) => {
    host.signal('SIGTERM');
    expectExit(await host.finished, 0);

    const marker = readMarker(directory, 'bureau-shutdown') as BureauShutdownMarker;
    expect(marker.refusal).toBe('Cannot create run: Bureau is shutting down.');
    expect(marker.runStatus).toBe('completed');
    expect(marker.report.policy).toBe('drain');
    expect(marker.report.unresolved).toBe(0);
    expect(marker.report.owners.map((owner) => owner.outcome)).not.toContain('unresolved');
  });

const abortScenario = (scope: ScenarioScope) =>
  bureauScenario('abort', scope, async (host, hosts) => {
    host.signal('SIGTERM');
    expectExit(await host.finished, 0);

    const marker = readMarker(hosts.directory, 'bureau-shutdown') as BureauShutdownMarker;
    expect(marker.runStatus).toBe('aborted');
    expect(marker.report.policy).toBe('abort');
    expect(marker.report.unresolved).toBe(0);

    // The abort is durable: the next process finds the run cancelled and never resumes it.
    expect(await relaunchBureau(hosts)).toEqual({
      recovery: 'clean',
      durableStatus: 'cancelled',
      stepZeroCalls: 0,
      laterStepCalls: 0,
    });
  });

const timeoutScenario = (scope: ScenarioScope) =>
  bureauScenario('timeout', scope, async (host, { directory }) => {
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
  });

const interruptScenario = (scope: ScenarioScope) =>
  bureauScenario('interrupt', scope, async (host, hosts) => {
    host.signal('SIGINT');
    await host.waitFor('draining');
    host.signal('SIGINT');
    expectExit(await host.finished, 130);

    expect(await relaunchBureau(hosts)).toEqual({
      recovery: 'clean',
      durableStatus: 'completed',
      stepZeroCalls: 0,
      laterStepCalls: 1,
    });
  });

// Scenarios run one after another: each boots real processes on a host they already load.
const weftOutcomes = {
  bun: await settle((scope) => weftScenario('bun', scope)),
  node: await settle((scope) => weftScenario('node', scope)),
};
const operativeOutcomes = {
  bun: await settle((scope) => operativeScenario('bun', scope)),
  node: await settle((scope) => operativeScenario('node', scope)),
};
const bureauOutcomes = {
  drain: await settle(drainScenario),
  abort: await settle(abortScenario),
  timeout: await settle(timeoutScenario),
  interrupt: await settle(interruptScenario),
};

describe.each(['bun', 'node'] as const)('a Weft host under %s', (hostRuntime) => {
  it('awaits engine.shutdown() on SIGTERM and exits 0, and a relaunched host recovers the workflow to its terminal result', () => {
    expectScenarioPassed(weftOutcomes[hostRuntime]);
  });
});

describe.each(['bun', 'node'] as const)('an Operative host under %s', (hostRuntime) => {
  it('calls run.abort() on SIGTERM, awaits run.closed(), and exits 0 with the run aborted', () => {
    expectScenarioPassed(operativeOutcomes[hostRuntime]);
  });
});

describe('a Bureau host', () => {
  it("drains on SIGTERM under policy: 'drain': refuses new runs, settles the in-flight run, reports unresolved === 0, and exits 0", () => {
    expectScenarioPassed(bureauOutcomes.drain);
  });

  it("aborts on SIGTERM under policy: 'abort': the in-flight run ends aborted, the report has unresolved === 0, and the process exits 0", () => {
    expectScenarioPassed(bureauOutcomes.abort);
  });

  it('exits 1 when shutdown exceeds timeoutMilliseconds, and the report names each unresolved owner', () => {
    expectScenarioPassed(bureauOutcomes.timeout);
  });

  it('forces exit 130 on a second SIGINT during a drain, and the next process recovers the run to its terminal result', () => {
    expectScenarioPassed(bureauOutcomes.interrupt);
  });
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
