/**
 * COR-409 — a recurring schedule's fire survives the real death of the process
 * running it, on both persistent backends.
 *
 * A child process (`test/schedule-fire-crash-child.ts`) registers an interval
 * schedule on a durable Bureau, drives it to its first occurrence by hand, and
 * SIGKILLs itself from inside the fire's agent body. This test then opens a
 * fresh Bureau over the same storage and asserts what the crash left:
 *
 * 1. the schedule definition is intact and still describable;
 * 2. the interrupted fire is recorded, and recovery brings it to a terminal state;
 * 3. no second fire is recorded for the same scheduled instant.
 *
 * Nothing waits on the clock: both Bureaus run `durableBackgroundTasks:
 * 'manual'`, so only `runDurableMaintenance(now)` ever ticks the schedule; the
 * child is awaited by process exit and its marker file; and `ownership: 'none'`
 * leaves no dead holder's claim to wait out.
 *
 * It spawns a process, so it lives in the `test:slow` lane. Each backend runs
 * once at module scope, off Bun's per-test clock (see `test/hoisted-scenario.ts`).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HANG_GUARD_MILLISECONDS, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { ScheduleCompletedEvent, ScheduleFailedEvent, stopWhen } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { unexpectedChildStderr } from './test/child-stderr';
import { expectScenarioPassed, type ScenarioScope, settleScenario } from './test/hoisted-scenario';

const CHILD = join(import.meta.dir, 'test', 'schedule-fire-crash-child.ts');
const INTERVAL_MS = 60_000;

type Backend = 'sqlite' | 'lmdb';

interface Marker {
  readonly scheduleId: string;
  readonly occurrence: number;
  readonly fireId: string;
}

async function scheduleFireCrashScenario(backend: Backend, scope: ScenarioScope): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `corvidae-schedule-fire-crash-${backend}-`));
  const storagePath = join(directory, 'bureau');
  const markerPath = join(directory, 'marker.json');
  scope.onHang(() => rmSync(directory, { recursive: true, force: true }));

  try {
    const child = spawnWithHangGuard(['bun', CHILD, backend, storagePath, markerPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    scope.onHang(() => child.kill());
    await child.exited;
    const stderr = await new Response(child.stderr).text();
    // The child kills itself inside the fire; any other exit voids the premise.
    expect(child.signalCode ?? stderr).toBe('SIGKILL');
    expect(unexpectedChildStderr(stderr)).toBe('');
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Marker;

    const conversations = new Set<string>();
    let generateCalls = 0;
    // Holds the recovered fire inside its body until the listeners below are attached.
    let releaseFire: () => void = () => {};
    const fireReleased = new Promise<void>((resolve) => {
      releaseFire = resolve;
    });
    const bureau = await createBureau({
      agents: {},
      generate: async (context) => {
        generateCalls += 1;
        await fireReleased;
        conversations.add(context.conversation.current.id);
        return { content: 'recovered', toolCalls: [] };
      },
      toolbox: createToolbox([]),
      storage: { type: backend, path: storagePath },
      durableExecution: true,
      durableBackgroundTasks: 'manual',
      durableOwnership: { ownership: 'none' },
      stopWhen: stopWhen.noToolCalls(),
    });
    scope.onHang(() => bureau.shutdown());
    try {
      // The recovered fire settles by event: manual mode has no `waitForDurableRun`.
      const settled = new Promise<string>((resolve) => {
        bureau.addEventListener(ScheduleCompletedEvent.type, (event) => resolve(event.runId));
        bureau.addEventListener(ScheduleFailedEvent.type, (event) =>
          resolve(`failed:${event.runId}`),
        );
      });
      releaseFire();
      const report = await bureau.waitForRecovery?.();
      expect(report?.outcome).toBe('clean');

      // (1) The definition survived intact.
      const survived = await bureau.getSchedule(marker.scheduleId);
      expect(survived?.id).toBe(marker.scheduleId);
      expect(survived?.status).toBe('active');
      expect(survived?.intervalMs).toBe(INTERVAL_MS);
      expect(survived?.lastFireAt).toBe(marker.occurrence);
      expect(survived?.nextFireAt).toBe(marker.occurrence + INTERVAL_MS);
      const listed = await bureau.listSchedules();
      expect(listed?.items.map((item) => item.id)).toEqual([marker.scheduleId]);

      // (2) The interrupted fire is on record, and recovery drove it to a terminal state.
      expect(await settled).toBe(marker.fireId);
      const fire = await bureau.getDurableRun(marker.fireId);
      expect(fire?.status).toBe('completed');
      expect(generateCalls).toBeGreaterThan(0);
      expect(conversations.size).toBe(1);
      const afterRecovery = generateCalls;

      // (3) The recovered process fires nothing more for the instant that was already fired.
      await bureau.runDurableMaintenance(marker.occurrence);
      await bureau.runDurableMaintenance(marker.occurrence + INTERVAL_MS - 1);
      const unchanged = await bureau.getSchedule(marker.scheduleId);
      expect(unchanged?.lastFireAt).toBe(marker.occurrence);
      expect(unchanged?.nextFireAt).toBe(marker.occurrence + INTERVAL_MS);
      expect(unchanged?.currentWorkflowId).toBeUndefined();
      expect(generateCalls).toBe(afterRecovery);
      expect(conversations.size).toBe(1);

      // Control: the same drive does fire the next instant, so the checks above
      // were not passing because the tick was inert.
      await bureau.runDurableMaintenance(marker.occurrence + INTERVAL_MS);
      const next = await bureau.getSchedule(marker.scheduleId);
      expect(next?.lastFireAt).toBe(marker.occurrence + INTERVAL_MS);
    } finally {
      await bureau.shutdown();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const outcomes = {
  sqlite: await settleScenario(
    (scope) => scheduleFireCrashScenario('sqlite', scope),
    HANG_GUARD_MILLISECONDS,
  ),
  lmdb: await settleScenario(
    (scope) => scheduleFireCrashScenario('lmdb', scope),
    HANG_GUARD_MILLISECONDS,
  ),
};

describe('a schedule fire survives SIGKILL', () => {
  it('keeps the definition, records the interrupted fire, and fires nothing twice on SQLite', () => {
    expectScenarioPassed(outcomes.sqlite);
  });

  it('keeps the definition, records the interrupted fire, and fires nothing twice on LMDB', () => {
    expectScenarioPassed(outcomes.lmdb);
  });
});
