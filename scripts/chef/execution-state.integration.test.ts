import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import { waitUntil } from '../../testing/testing/src/wait-until.ts';
import {
  acquireDispatch,
  cancelDispatch,
  createExecutionStateStore,
  requireAuthority,
  withProviderTransitionLock,
} from './execution-state.ts';

const directories: string[] = [];

function directory() {
  const value = mkdtempSync(join(tmpdir(), 'execution-state-integration-'));
  directories.push(value);
  return value;
}

afterEach(() => {
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

async function runClaim(stateDirectory: string, resource: string, runId: string, ownerId: string) {
  const modulePath = join(import.meta.dir, 'execution-state.ts');
  const program = `
    import { acquireDispatch, createExecutionStateStore } from ${JSON.stringify(modulePath)};
    const state = createExecutionStateStore({ stateDirectory: ${JSON.stringify(stateDirectory)}, hostId: 'host-a' });
    console.log(JSON.stringify(await acquireDispatch(state, { resource: ${JSON.stringify(resource)}, runId: ${JSON.stringify(runId)}, ownerId: ${JSON.stringify(ownerId)} })));
  `;
  const child = spawnWithHangGuard(['bun', '--eval', program], { stdout: 'pipe', stderr: 'pipe' });
  const exitCode = await child.exited;
  const stdout = await new Response(child.stdout).text();
  return { exitCode, output: stdout.trim() };
}

// This runs at module scope because the host lock consults the process table. The test below only
// asserts the completed coordinator transition, keeping process work out of Bun's per-test clock.
const barrierState = createExecutionStateStore({ stateDirectory: directory(), hostId: 'host-a' });
const barrierResult = await (async () => {
  const first = await acquireDispatch(barrierState, {
    resource: 'issue:COR-barrier',
    runId: 'run-a',
    ownerId: 'owner-a',
  });
  if (!first.granted) throw new Error(first.reason);
  let releaseProvider!: () => void;
  const providerReleased = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  let validated = false;
  const transition = withProviderTransitionLock(
    barrierState,
    first.authority.resource,
    async () => {
      requireAuthority(barrierState, first.authority);
      validated = true;
      await providerReleased;
      return requireAuthority(barrierState, first.authority);
    },
  );
  await waitUntil(() => validated, { message: 'generation one provider transition validation' });
  let cancelled = false;
  const cancellation = cancelDispatch(barrierState, first.authority).then((result) => {
    cancelled = result;
    return result;
  });
  await Promise.resolve();
  const blockedBeforeProviderCloseout = !cancelled;
  releaseProvider();
  await transition;
  const cancelledAfterProviderCloseout = await cancellation;
  const second = await acquireDispatch(barrierState, {
    resource: first.authority.resource,
    runId: 'run-b',
    ownerId: 'owner-b',
  });
  if (!second.granted) throw new Error(second.reason);
  return {
    blockedBeforeProviderCloseout,
    cancelledAfterProviderCloseout,
    first: first.authority,
    second: second.authority,
  };
})();

describe('execution state across coordinator processes', () => {
  test('holds cancellation and regrant behind an in-flight provider transition', () => {
    expect(barrierResult.blockedBeforeProviderCloseout).toBe(true);
    expect(barrierResult.cancelledAfterProviderCloseout).toBe(true);
    expect(barrierResult.second.generation).toBe(barrierResult.first.generation + 1);
    expect(() => requireAuthority(barrierState, barrierResult.first)).toThrow('generation');
    expect(requireAuthority(barrierState, barrierResult.second)).toEqual(barrierResult.second);
  });

  // spawn-free: this isolated test starts two hang-guarded Bun coordinators at module behavior boundary.
  test('two subprocess coordinators race for one resource and one receives authority', async () => {
    const stateDirectory = directory();
    const [first, second] = await Promise.all([
      runClaim(stateDirectory, 'issue:COR-1', 'run-a', 'owner-a'),
      runClaim(stateDirectory, 'issue:COR-1', 'run-b', 'owner-b'),
    ]);
    expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
    const outcomes = [first, second].map(
      ({ output }) => JSON.parse(output) as { granted: boolean },
    );
    expect(outcomes.filter((outcome) => outcome.granted)).toHaveLength(1);
  });

  // spawn-free: this isolated test starts hang-guarded coordinators on distinct resources.
  test('distinct resources preserve every granted ownership record in one shared snapshot', async () => {
    const stateDirectory = directory();
    const claims = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        runClaim(
          stateDirectory,
          `issue:COR-${index + 1}`,
          `run-${index + 1}`,
          `owner-${index + 1}`,
        ),
      ),
    );
    expect(claims.every((claim) => claim.exitCode === 0)).toBe(true);
    const snapshot = JSON.parse(
      await Bun.file(join(stateDirectory, 'execution-state.json')).text(),
    ) as { ownership: Record<string, unknown> };
    expect(Object.keys(snapshot.ownership)).toHaveLength(32);
  });
});
