/**
 * COR-1945 — a failed run produces exactly one failure notification, whichever point the process
 * dies at.
 *
 * A failed run's settlement and its notification are two writes. A child process
 * (`test/notification-crash-child.ts`) interferes with the second one (holds it for ever, or makes
 * it fail), or with the outbox entry the settlement left behind, and SIGKILLs itself once the
 * durable state has gone as far as the window needs. This test then opens a fresh Bureau over the
 * same storage, lets it boot, shuts it down, boots again (the repair replayed), and boots a last
 * time to read the result:
 *
 * | child dies...                                  | notification before | after the boots |
 * | ---------------------------------------------- | ------------------- | --------------- |
 * | settled, notification write held               | none                | exactly one     |
 * | settled, notification write failed (storage)   | none                | exactly one     |
 * | notification written, outbox clear held        | one                 | exactly one     |
 * | notification written, outbox cleared           | one                 | exactly one     |
 * | a run that completed (no failure to notify)    | none                | none            |
 *
 * It spawns a process, so it lives in the `test:slow` lane, each scenario once at module scope off
 * Bun's per-test clock (see `test/hoisted-scenario.ts`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HANG_GUARD_MILLISECONDS, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { stopWhen, createAgent } from '@lostgradient/operative';
import { type Storage, textValueStore } from '@lostgradient/storage';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { unexpectedChildStderr } from './test/child-stderr';
import { readChildJson } from './test/child-output-file';
import { expectScenarioPassed, type ScenarioScope, settleScenario } from './test/hoisted-scenario';
import { failsToGenerate, finishes } from './test/notification-crash-agents';
import { createSqliteStorageFixture } from './test/storage-fixtures';

const CHILD = join(import.meta.dir, 'test', 'notification-crash-child.ts');
const OWNER = 'api-key:alice';
const OUTBOX_PREFIX = 'bureau-notification:v1:o:';

/** Where the child dies, what the first boot after it must write, and what the run was. */
const CELLS = [
  { mode: 'before-notification-write', repairedAtBoot: 1, final: 1 },
  { mode: 'failing-notification-write', repairedAtBoot: 1, final: 1 },
  { mode: 'before-outbox-clear', repairedAtBoot: 0, final: 1 },
  { mode: 'after-both', repairedAtBoot: 0, final: 1 },
  { mode: 'completed-run', repairedAtBoot: 0, final: 0 },
] as const;

type Cell = (typeof CELLS)[number];

/** The Bureau every boot opens over the dead process's storage. */
function openBureau(storage: Storage, onCreated: (kind: string) => void) {
  return createBureau<AgentDefinitions>({
    id: 'notification-crash',
    agents: {
      default: createAgent({
        generate: finishes,
        toolbox: createToolbox([]),
        stopWhen: stopWhen.noToolCalls(),
      }),
      failing: createAgent({
        generate: failsToGenerate,
        toolbox: createToolbox([]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage,
    durable: true,
    durableOwnership: { ownership: 'none' },
    onDiagnostic: () => undefined,
    onEvent: (event) => {
      if (event.type === 'notification.created') onCreated(event.type);
    },
  });
}

async function crashScenario(cell: Cell, scope: ScenarioScope): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `corvidae-notification-crash-${cell.mode}-`));
  const storagePath = join(directory, 'bureau.sqlite');
  const markerPath = join(directory, 'marker.json');
  // The child's store, opened here only once the child is gone.
  const store = createSqliteStorageFixture({ path: storagePath });
  scope.onHang(async () => {
    await store.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  try {
    const child = spawnWithHangGuard(['bun', CHILD, cell.mode, storagePath, markerPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    scope.onHang(() => child.kill());
    await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(child.signalCode ?? stderr).toBe('SIGKILL');
    expect(unexpectedChildStderr(stderr)).toBe('');
    const { runId } = readChildJson<{ runId: string }>(markerPath);

    const created: string[] = [];
    const owedOf = async () => await textValueStore(store.storage).list(OUTBOX_PREFIX);

    // Boot one: the repair writes what the dead process owed.
    const first = await openBureau(store.storage, (kind) => created.push(kind));
    scope.onHang(() => first.shutdown());
    try {
      await first.recovery();
      if (cell.final > 0) {
        await waitUntil(
          async () => {
            const page = await first.notifications.list({ owner: OWNER });
            const owed = await owedOf();
            return page.notifications.length === cell.final && owed.length === 0;
          },
          { message: 'the failed run’s notification is written and its outbox entry cleared' },
        );
      }
    } finally {
      await first.shutdown();
    }
    expect(created).toHaveLength(cell.repairedAtBoot);

    // Boot two replays the repair over what boot one left; it must change nothing.
    const second = await openBureau(await store.reopen(), (kind) => created.push(kind));
    scope.onHang(() => second.shutdown());
    try {
      await second.recovery();
    } finally {
      await second.shutdown();
    }
    expect(created).toHaveLength(cell.repairedAtBoot);

    // Boot three reads the result: exactly one for a failed run, none for a completed one.
    const third = await openBureau(await store.reopen(), (kind) => created.push(kind));
    scope.onHang(() => third.shutdown());
    try {
      await third.recovery();
      const page = await third.notifications.list({ owner: OWNER, includeDismissed: true });
      expect(page.notifications).toHaveLength(cell.final);
      if (cell.final > 0) {
        expect(page.notifications[0]).toMatchObject({
          kind: 'run.failed',
          subject: { runId },
        });
      }
      expect(await owedOf()).toEqual([]);
    } finally {
      await third.shutdown();
    }
    expect(created).toHaveLength(cell.repairedAtBoot);
  } finally {
    await store.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

const outcomes = new Map<string, Awaited<ReturnType<typeof settleScenario>>>();
for (const cell of CELLS) {
  outcomes.set(
    cell.mode,
    await settleScenario((scope) => crashScenario(cell, scope), HANG_GUARD_MILLISECONDS),
  );
}

describe('a failed run’s notification survives SIGKILL', () => {
  it.each(CELLS.map((cell) => [cell.mode, cell] as const))(
    'writes exactly the notifications owed when the child dies at %s',
    (mode) => {
      expectScenarioPassed(outcomes.get(mode));
    },
  );
});
