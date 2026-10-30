/**
 * COR-1946 — a stalled owner's real result replaces `owner-lost`, and the process dies before it
 * dismisses the failure notification the inference wrote.
 *
 * The child (`test/owner-lost-replaced-crash-child.ts`) settles its own task `owner-lost` as a peer
 * would, waits for that notification, holds the next notification write for ever, ends the run for
 * real and SIGKILLs itself at the held write. The replacing settlement and its outbox entry are on
 * disk; the dismissal is not. A fresh Bureau over the file must close the debt at boot:
 *
 * | the owner's real result | notification before the boot | after the boot (open / ever) | outbox |
 * | ----------------------- | ---------------------------- | ----------------------------- | ------ |
 * | completed               | one, open                    | 0 / 1 (dismissed)             | empty  |
 * | canceled                | one, open                    | 0 / 1 (dismissed)             | empty  |
 *
 * It spawns a process, so it lives in the `test:slow` lane, each scenario once at module scope.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgent, stopWhen } from '@lostgradient/operative';
import { textValueStore } from '@lostgradient/storage';
import { HANG_GUARD_MILLISECONDS, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { readChildJson } from './test/child-output-file';
import { unexpectedChildStderr } from './test/child-stderr';
import { expectScenarioPassed, type ScenarioScope, settleScenario } from './test/hoisted-scenario';
import { createSqliteStorageFixture } from './test/storage-fixtures';

const CHILD = join(import.meta.dir, 'test', 'owner-lost-replaced-crash-child.ts');
const OWNER = 'api-key:alice';
const OUTBOX_PREFIX = 'bureau-notification:v1:o:';
const MODES = ['completed', 'canceled'] as const;

async function scenario(mode: (typeof MODES)[number], scope: ScenarioScope): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `corvidae-owner-lost-replaced-${mode}-`));
  const storagePath = join(directory, 'bureau.sqlite');
  const markerPath = join(directory, 'marker.json');
  const store = createSqliteStorageFixture({ path: storagePath });
  scope.onHang(async () => {
    await store.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  try {
    const child = spawnWithHangGuard(['bun', CHILD, mode, storagePath, markerPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    scope.onHang(() => child.kill());
    await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(child.signalCode ?? stderr).toBe('SIGKILL');
    expect(unexpectedChildStderr(stderr)).toBe('');
    const { runId } = readChildJson<{ runId: string }>(markerPath);

    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => ({ content: 'done', toolCalls: [] }),
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: store.storage,
      durable: false,
      maintenance: 'manual',
      onDiagnostic: () => undefined,
    });
    scope.onHang(() => bureau.shutdown());
    try {
      // The false failure is still open before the boot's repair has run.
      const record = await bureau.internals.taskRegistry.record(runId);
      expect(record?.settled?.status).toBe(mode);
      await bureau.recovery();
      await waitUntil(
        async () => {
          const open = await bureau.notifications.list({ owner: OWNER });
          const owed = await textValueStore(store.storage).list(OUTBOX_PREFIX);
          return open.notifications.length === 0 && owed.length === 0;
        },
        { message: 'the boot dismissed the false failure and cleared the debt' },
      );
      const everWritten = await bureau.notifications.list({ owner: OWNER, includeDismissed: true });
      expect(everWritten.notifications).toHaveLength(1);
      expect(everWritten.notifications[0]?.dismissedAt).not.toBeNull();
    } finally {
      await bureau.shutdown();
    }
  } finally {
    await store.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

const outcomes = new Map<string, Awaited<ReturnType<typeof settleScenario>>>();
for (const mode of MODES) {
  outcomes.set(
    mode,
    await settleScenario((scope) => scenario(mode, scope), HANG_GUARD_MILLISECONDS),
  );
}

describe('a false owner-lost failure survives a SIGKILL before its dismissal', () => {
  it.each(MODES.map((mode) => [mode] as const))(
    'is dismissed at the next boot when the owner really %s',
    (mode) => {
      expectScenarioPassed(outcomes.get(mode));
    },
  );
});
