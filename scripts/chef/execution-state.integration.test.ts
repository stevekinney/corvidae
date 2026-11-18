import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import { throwingRejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import { waitUntil } from '../../testing/testing/src/wait-until.ts';
import {
  acquireDispatch,
  cancelDispatch,
  createExecutionStateStore,
  ExecutionStateError,
  reconcileOperation,
  recordMutationIntent,
  recordMutationResult,
  releaseDispatch,
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

// These subprocesses consult the host process table. Run them before Bun installs a per-test
// clock; the tests below only inspect their completed records.
const sameResourceRace = await (async () => {
  const stateDirectory = directory();
  const results = await Promise.all([
    runClaim(stateDirectory, 'issue:COR-1', 'run-a', 'owner-a'),
    runClaim(stateDirectory, 'issue:COR-1', 'run-b', 'owner-b'),
  ]);
  return { results };
})();

const distinctResourceClaims = await (async () => {
  const stateDirectory = directory();
  const claims = await Promise.all(
    Array.from({ length: 32 }, (_, index) =>
      runClaim(stateDirectory, `issue:COR-${index + 1}`, `run-${index + 1}`, `owner-${index + 1}`),
    ),
  );
  const snapshot = JSON.parse(
    await Bun.file(join(stateDirectory, 'execution-state.json')).text(),
  ) as { ownership: Record<string, unknown> };
  return { claims, ownership: snapshot.ownership };
})();

describe('execution state across coordinator processes', () => {
  test('holds cancellation and regrant behind an in-flight provider transition', () => {
    expect(barrierResult.blockedBeforeProviderCloseout).toBe(true);
    expect(barrierResult.cancelledAfterProviderCloseout).toBe(true);
    expect(barrierResult.second.generation).toBe(barrierResult.first.generation + 1);
    expect(() => requireAuthority(barrierState, barrierResult.first)).toThrow('generation');
    expect(requireAuthority(barrierState, barrierResult.second)).toEqual(barrierResult.second);
  });

  test('two subprocess coordinators race for one resource and one receives authority', () => {
    expect(sameResourceRace.results.map((result) => result.exitCode)).toEqual([0, 0]);
    const outcomes = sameResourceRace.results.map(
      ({ output }) => JSON.parse(output) as { granted: boolean },
    );
    expect(outcomes.filter((outcome) => outcome.granted)).toHaveLength(1);
  });

  test('distinct resources preserve every granted ownership record in one shared snapshot', () => {
    expect(distinctResourceClaims.claims.every((claim) => claim.exitCode === 0)).toBe(true);
    expect(Object.keys(distinctResourceClaims.ownership)).toHaveLength(32);
  });
});

const unitDirectories: string[] = [];

function store(hostId = 'host-a') {
  const directory = mkdtempSync(join(tmpdir(), 'execution-state-'));
  unitDirectories.push(directory);
  return createExecutionStateStore({ stateDirectory: directory, hostId });
}

afterEach(() => {
  for (const directory of unitDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const executionStateCorruptionCases = Object.fromEntries(
  await Promise.all(
    (
      [
        [
          'array ownership',
          '{"version":1,"hostId":"host-a","ownership":[],"operations":{},"pendingCloseout":[],"nextAction":null}',
        ],
        [
          'string generation',
          '{"version":1,"hostId":"host-a","ownership":{"issue:COR-1":{"resource":"issue:COR-1","runId":"run-a","ownerId":"owner-a","generation":"corrupt","status":"released"}},"operations":{},"pendingCloseout":[],"nextAction":null}',
        ],
      ] as const
    ).map(async ([name, content]) => {
      const state = store();
      writeFileSync(state.statePath, content);
      expect(
        await throwingRejectionOf(
          acquireDispatch(state, { resource: 'issue:COR-1', runId: 'run-b', ownerId: 'owner-b' }),
        ),
      ).toThrow(ExecutionStateError);
      expect(readFileSync(state.statePath, 'utf8')).toBe(content);
      return [name, true] as const;
    }),
  ),
);

const executionStateCase1 = await (async () => {
  const state = store();
  const [first, second] = await Promise.all([
    acquireDispatch(state, { resource: 'issue:COR-1', runId: 'run-a', ownerId: 'owner-a' }),
    acquireDispatch(state, { resource: 'issue:COR-1', runId: 'run-b', ownerId: 'owner-b' }),
  ]);
  expect([first.granted, second.granted].filter(Boolean)).toHaveLength(1);
  const refusal = [first, second].find(
    (result): result is { granted: false; reason: string } => !result.granted,
  );
  expect(refusal?.reason).toMatch(/^held locally by owner-[ab]$/);

  return true;
})();

const executionStateCase2 = await (async () => {
  const state = store();
  const result = await acquireDispatch(
    state,
    { resource: 'project:p1', runId: 'run-a', ownerId: 'owner-a' },
    { inspectClaim: async () => ({ holder: 'foreign-run', live: true }) },
  );
  expect(result).toEqual({ granted: false, reason: 'held remotely by foreign-run' });

  return true;
})();

const executionStateCase3 = await (async () => {
  const state = store();
  const first = await acquireDispatch(state, {
    resource: 'issue:COR-1',
    runId: 'run-a',
    ownerId: 'owner-a',
  });
  if (!first.granted) throw new Error(first.reason);
  expect(await cancelDispatch(state, first.authority)).toBe(true);
  expect(await cancelDispatch(state, first.authority)).toBe(false);
  const second = await acquireDispatch(state, {
    resource: 'issue:COR-1',
    runId: 'run-b',
    ownerId: 'owner-b',
  });
  if (!second.granted) throw new Error(second.reason);
  expect(() => requireAuthority(state, first.authority)).toThrow('generation');
  expect(await releaseDispatch(state, first.authority)).toBe(false);
  expect(requireAuthority(state, second.authority)).toEqual(second.authority);

  return true;
})();

const executionStateCase4 = await (async () => {
  const state = store();
  const first = await acquireDispatch(state, {
    resource: 'issue:COR-1',
    runId: 'run-a',
    ownerId: 'owner-a',
  });
  if (!first.granted) throw new Error(first.reason);
  expect(existsSync(state.statePath)).toBe(true);
  writeFileSync(state.statePath, '{truncated');
  expect(() => requireAuthority(state, first.authority)).toThrow(ExecutionStateError);
  expect(readFileSync(state.statePath, 'utf8')).toBe('{truncated');

  return true;
})();

const executionStateCase5 = await (async () => {
  const state = store();
  const granted = await acquireDispatch(state, {
    resource: 'issue:COR-1',
    runId: 'run-a',
    ownerId: 'owner-a',
  });
  if (!granted.granted) throw new Error(granted.reason);
  writeFileSync(`${state.statePath}.tmp-crash`, '{half-replacement');
  expect(requireAuthority(state, granted.authority)).toEqual(granted.authority);
  expect(readFileSync(state.statePath, 'utf8')).toContain('issue:COR-1');

  return true;
})();

const executionStateCase6 = await (async () => {
  const state = store();
  const granted = await acquireDispatch(state, {
    resource: 'issue:COR-1',
    runId: 'run-a',
    ownerId: 'owner-a',
  });
  if (!granted.granted) throw new Error(granted.reason);
  await recordMutationIntent(state, granted.authority, {
    operationId: 'op-1',
    action: 'linear-comment',
    intentFingerprint: 'test-intent',
  });
  await recordMutationResult(state, granted.authority, 'op-1', { outcome: 'unknown' });
  const result = await reconcileOperation(state, granted.authority, 'op-1', {
    inspect: async (operationId) => ({ operationId, outcome: 'unresolved' }),
  });
  expect(result).toEqual({
    operationId: 'op-1',
    outcome: 'unresolved',
    nextAction: 'inspect-provider',
  });

  return true;
})();

const executionStateCase7 = await (async () => {
  const first = store('host-a');
  const other = createExecutionStateStore({
    stateDirectory: first.stateDirectory,
    hostId: 'host-b',
  });
  const granted = await acquireDispatch(first, {
    resource: 'issue:COR-1',
    runId: 'run-a',
    ownerId: 'owner-a',
  });
  if (!granted.granted) throw new Error(granted.reason);
  expect(
    await throwingRejectionOf(
      acquireDispatch(other, { resource: 'issue:COR-2', runId: 'run-b', ownerId: 'owner-b' }),
    ),
  ).toThrow('host-a');

  return true;
})();

describe('execution state', () => {
  test('concurrent local claimants grant one owner and refuse the other', () => {
    expect(executionStateCase1).toBe(true);
  });

  test('refuses a live foreign provider claim before granting local authority', () => {
    expect(executionStateCase2).toBe(true);
  });

  test('fences stale completions after cancellation and a newer acquisition', () => {
    expect(executionStateCase3).toBe(true);
  });

  test('writes complete snapshots atomically and refuses malformed state without replacing it', () => {
    expect(executionStateCase4).toBe(true);
  });

  test.each([
    [
      'array ownership',
      '{"version":1,"hostId":"host-a","ownership":[],"operations":{},"pendingCloseout":[],"nextAction":null}',
    ],
    [
      'string generation',
      '{"version":1,"hostId":"host-a","ownership":{"issue:COR-1":{"resource":"issue:COR-1","runId":"run-a","ownerId":"owner-a","generation":"corrupt","status":"released"}},"operations":{},"pendingCloseout":[],"nextAction":null}',
    ],
  ])('preserves %s corruption rather than granting a new generation', (name) => {
    expect(executionStateCorruptionCases[name]).toBe(true);
  });

  test('restart ignores a crash-left temporary replacement and reads a complete snapshot', () => {
    expect(executionStateCase5).toBe(true);
  });

  test('records an ambiguous provider mutation for inspection, retaining its operation identifier', () => {
    expect(executionStateCase6).toBe(true);
  });

  test('rejects another host from using a local authority directory', () => {
    expect(executionStateCase7).toBe(true);
  });
});
