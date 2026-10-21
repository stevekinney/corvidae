/**
 * COR-1590 — a run Bureau recovers that is abandoned without a terminal event tells whoever waits
 * on its session record that the record will not come (`whenRunRecorded` rejects with
 * `TerminalSessionRecordAbandonedError`), the way a live run that is abandoned does
 * (`http/ag-ui-mount-terminal-snapshot.test.ts`).
 *
 * A child process (`test/session-input-crash-child.ts`) starts a session run, commits its first
 * step, and SIGKILLs itself while the second step hangs. The parent boots a Bureau over the child's
 * store, and the run it recovers loses the compare-and-swap of its next checkpoint, so the engine
 * abandons it for whoever owns it and no terminal event is dispatched. Without the recovered run's
 * own abandon, the record stays pending until the Bureau shuts down: the wait below never ends,
 * and the scenario's hang guard fails it. Real processes are the behavior under test, so the
 * scenario runs once at module scope (see `test/hoisted-scenario.ts`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { stopWhen } from '@lostgradient/operative';
import { resolveStorage, type Storage } from '@lostgradient/weft';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import { expectScenarioPassed, type ScenarioScope, settleScenario } from './test/hoisted-scenario';
import type { Bureau } from './types';

const CHILD = join(import.meta.dir, 'test', 'session-input-crash-child.ts');
/** Matches the child's short workflow claim, so recovery can follow a kill quickly. */
const CLAIM_TTL_MS = 200;
const HANG_GUARD_MILLISECONDS = 60_000;
const RUN_CHECKPOINT = /wf:[^"]*:ckpt/;

const nextTool = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

/**
 * `storage`, except that once armed the next conditional write of a run's checkpoint finds the
 * checkpoint changed under it: the compare-and-swap is lost, as it is to another process.
 */
function losingNextCheckpointSwap(storage: Storage) {
  let armed = false;
  let lost = false;
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== 'function') return member;
      const call = (...args: unknown[]) =>
        (member as (...rest: unknown[]) => unknown).apply(target, args);
      if (String(property) !== 'conditionalBatch') return call.bind(null);
      return async (...args: unknown[]) => {
        const key = RUN_CHECKPOINT.exec(JSON.stringify(args))?.[0];
        if (armed && key !== undefined && !lost) {
          lost = true;
          await target.put(key, new Uint8Array([1, 2, 3]));
        }
        return call(...args);
      };
    },
  });
  return {
    storage: proxy,
    arm: () => {
      armed = true;
    },
    lost: () => lost,
  };
}

async function recoveredAbandonScenario(scope: ScenarioScope): Promise<void> {
  const directory = createTemporaryDirectory('corvidae-recovered-run-abandon');
  const remove = (): void => removeTemporaryPath(directory);
  scope.onHang(remove);
  // Weft reports a lost compare-and-swap to operators as a process warning. It is part of the
  // scenario, so it is captured rather than let reach stderr, and checked.
  const warnings: Error[] = [];
  const emitWarning = spyOn(process, 'emitWarning').mockImplementation((warning) => {
    if (warning instanceof Error) warnings.push(warning);
  });
  let recovering: Bureau | undefined;
  scope.onHang(() => recovering?.dispose());
  try {
    const storagePath = join(directory, 'bureau.sqlite');
    const markerPath = join(directory, 'marker.json');
    const child = spawnWithHangGuard(['bun', CHILD, 'sqlite', storagePath, markerPath, 'running'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    scope.onHang(() => child.kill());
    await scope.phase('child exit', () => child.exited);
    const stderr = await new Response(child.stderr).text();
    expect(child.signalCode ?? stderr).toBe('SIGKILL');
    expect(existsSync(markerPath)).toBe(true);
    const { runId } = JSON.parse(readFileSync(markerPath, 'utf8')) as { runId: string };
    // The killed child's workflow claim must lapse before this process may recover its run; there
    // is no event for that, only its TTL.
    await scope.phase('claim lapse', () => Bun.sleep(CLAIM_TTL_MS * 10));

    // The recovered step is held while it generates, so the wait below is made while the run is
    // still going: a wait made after the run ended reads a record that is already gone.
    const generating = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const seam = losingNextCheckpointSwap(
      await resolveStorage({ type: 'sqlite', path: storagePath }),
    );
    recovering = await scope.phase('boot', () =>
      createBureau({
        agents: {},
        generate: async () => {
          // The checkpoint the recovered step commits next is the one lost.
          seam.arm();
          generating.resolve();
          await released.promise;
          return { content: 'done', toolCalls: [] };
        },
        toolbox: createToolbox([nextTool]),
        storage: seam.storage,
        durableExecution: true,
        durableOwnership: {
          ownership: 'workflow-lease',
          workflowClaimTtlMs: CLAIM_TTL_MS,
          workflowClaimRenewIntervalMs: 50,
        },
        stopWhen: stopWhen.noToolCalls(),
        onDiagnostic: () => undefined,
      }),
    );
    const bureau = recovering;
    await scope.phase('recovery', async () => bureau.waitForRecovery?.());

    // No save of the run's end happens here, so nothing will ever record it: the wait says so,
    // while the Bureau is still open and not because it was shut down.
    await scope.phase('recovered step', () => generating.promise);
    const recorded = bureau.whenRunRecorded(runId).then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.name : 'rejected'),
    );
    released.resolve();
    const outcome = await scope.phase('record', () => recorded);
    expect(outcome).toBe('TerminalSessionRecordAbandonedError');
    expect(seam.lost()).toBe(true);
    expect(warnings.map((warning) => warning.name)).toEqual([
      'WeftWorkflowCheckpointConflictWarning',
    ]);
  } finally {
    emitWarning.mockRestore();
    await recovering?.dispose();
    remove();
  }
}

const outcome = await settleScenario(recoveredAbandonScenario, HANG_GUARD_MILLISECONDS);

describe('a run Bureau recovers that is abandoned without a terminal event (COR-1590)', () => {
  it('tells whoever waits on its session record that the record will not come', () => {
    expectScenarioPassed(outcome);
  });
});
