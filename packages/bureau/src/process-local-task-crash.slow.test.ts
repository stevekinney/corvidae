/**
 * COR-1946 — two real processes: one is SIGKILLed with a process-local task in flight, one is still
 * running its own; a third Bureau boots over the same SQLite file.
 *
 * | process                      | its task at the booter's first boot | after it is killed and the booter boots again |
 * | ---------------------------- | ----------------------------------- | --------------------------------------------- |
 * | crashed (SIGKILL)            | failed, `owner-lost`                | (unchanged)                                   |
 * | peer (alive at first boot)   | untouched                           | failed, `owner-lost`                          |
 *
 * The booter's clock is a manual one dated well after the crashed child's real lease and before the
 * peer's, so which lease reads as lapsed is decided by those dates and never by how long the host
 * took. It spawns processes, so it lives in the `test:slow` lane, once at module scope off Bun's
 * per-test clock (see `test/hoisted-scenario.ts`).
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, stopWhen } from '@lostgradient/operative';
import { HANG_GUARD_MILLISECONDS, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { unexpectedChildStderr } from './test/child-stderr';
import { readChildJson } from './test/child-output-file';
import { expectScenarioPassed, type ScenarioScope, settleScenario } from './test/hoisted-scenario';
import { createSqliteStorageFixture } from './test/storage-fixtures';

const CHILD = join(import.meta.dir, 'test', 'process-local-task-crash-child.ts');
const MINUTE = 60_000;

interface Marker {
  readonly runId: string;
  readonly ownerProcess: string | null;
}

async function crashScenario(scope: ScenarioScope): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'corvidae-process-local-task-crash-'));
  const storagePath = join(directory, 'bureau.sqlite');
  const store = createSqliteStorageFixture({ path: storagePath });
  scope.onHang(async () => {
    await store.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  // Ten minutes ahead of now: past the crashed child's lease (its real clock, 30 s after it
  // started), and the peer's lease is dated from here, so it is still current.
  const bootAt = Date.now() + 10 * MINUTE;
  try {
    const crashMarker = join(directory, 'crash.json');
    const crashed = spawnWithHangGuard(
      ['bun', CHILD, 'crash', storagePath, crashMarker, String(bootAt)],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    scope.onHang(() => crashed.kill());
    await crashed.exited;
    const crashedStderr = await new Response(crashed.stderr).text();
    expect(crashed.signalCode ?? crashedStderr).toBe('SIGKILL');
    expect(unexpectedChildStderr(crashedStderr)).toBe('');
    const crash = readChildJson<Marker>(crashMarker);
    expect(crash.ownerProcess).not.toBeNull();

    const peerMarker = join(directory, 'peer.json');
    const peer = spawnWithHangGuard(
      ['bun', CHILD, 'peer', storagePath, peerMarker, String(bootAt)],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    scope.onHang(() => peer.kill());
    await waitUntil(() => existsSync(peerMarker), { message: 'the peer child started its task' });
    const alive = readChildJson<Marker>(peerMarker);
    expect(alive.ownerProcess).not.toBeNull();
    expect(alive.ownerProcess).not.toBe(crash.ownerProcess);

    const open = async (at: number) => {
      const bureau = await createBureau<AgentDefinitions>({
        agents: {
          default: createAgent({
            generate: async () => ({ content: 'done', toolCalls: [] }),
            toolbox: createToolbox([]),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        storage: await store.reopen(),
        durable: false,
        maintenance: 'manual',
        runtime: createManualRuntimeServices({ origin: new Date(at).toISOString() }),
        onDiagnostic: () => undefined,
      });
      scope.onHang(() => bureau.shutdown());
      return bureau;
    };
    const settledOf = async (bureau: Awaited<ReturnType<typeof open>>, runId: string) => {
      const record = await bureau.internals.taskRegistry.record(runId);
      return record?.settled;
    };

    // Boot one: the crashed process's task is settled, the live peer's is not.
    const first = await open(bootAt);
    try {
      await first.recovery();
      expect(await settledOf(first, crash.runId)).toMatchObject({
        status: 'failed',
        finishReason: 'owner-lost',
      });
      expect(await settledOf(first, alive.runId)).toBeUndefined();
    } finally {
      await first.shutdown();
    }

    // The peer dies too; a boot dated after its lease settles its task as well, and the crashed
    // process's settlement is not written again.
    peer.kill('SIGKILL');
    await peer.exited;
    const second = await open(bootAt + 2 * MINUTE);
    try {
      await second.recovery();
      expect(await settledOf(second, alive.runId)).toMatchObject({
        status: 'failed',
        finishReason: 'owner-lost',
      });
      expect(await settledOf(second, crash.runId)).toMatchObject({ finishReason: 'owner-lost' });
    } finally {
      await second.shutdown();
    }
  } finally {
    await store.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

const outcome = await settleScenario(crashScenario, HANG_GUARD_MILLISECONDS);

describe('a SIGKILLed process’s local task', () => {
  it('is settled by the next boot, and a live peer’s task is not, until the peer is gone too', () => {
    expectScenarioPassed(outcome);
  });
});
