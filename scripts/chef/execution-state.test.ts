import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { throwingRejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import {
  ExecutionStateError,
  acquireDispatch,
  cancelDispatch,
  createExecutionStateStore,
  reconcileOperation,
  recordMutationIntent,
  recordMutationResult,
  releaseDispatch,
  requireAuthority,
} from './execution-state.ts';

const directories: string[] = [];

function store(hostId = 'host-a') {
  const directory = mkdtempSync(join(tmpdir(), 'execution-state-'));
  directories.push(directory);
  return createExecutionStateStore({ stateDirectory: directory, hostId });
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('execution state', () => {
  // spawn-free: host-lock behavior is covered by the isolated integration test.
  test('concurrent local claimants grant one owner and refuse the other', async () => {
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
  });

  // spawn-free: the provider is an injected in-memory reader in this unit test.
  test('refuses a live foreign provider claim before granting local authority', async () => {
    const state = store();
    const result = await acquireDispatch(
      state,
      { resource: 'project:p1', runId: 'run-a', ownerId: 'owner-a' },
      { inspectClaim: async () => ({ holder: 'foreign-run', live: true }) },
    );
    expect(result).toEqual({ granted: false, reason: 'held remotely by foreign-run' });
  });

  // spawn-free: the authority transition is exercised with disposable in-process state.
  test('fences stale completions after cancellation and a newer acquisition', async () => {
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
  });

  // spawn-free: atomic persistence is observed through a disposable local directory.
  test('writes complete snapshots atomically and refuses malformed state without replacing it', async () => {
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
  });

  // spawn-free: malformed persisted records are rejected before any ownership mutation.
  test.each([
    [
      'array ownership',
      '{"version":1,"hostId":"host-a","ownership":[],"operations":{},"pendingCloseout":[],"nextAction":null}',
    ],
    [
      'string generation',
      '{"version":1,"hostId":"host-a","ownership":{"issue:COR-1":{"resource":"issue:COR-1","runId":"run-a","ownerId":"owner-a","generation":"corrupt","status":"released"}},"operations":{},"pendingCloseout":[],"nextAction":null}',
    ],
  ])('preserves %s corruption rather than granting a new generation', async (_name, content) => {
    const state = store();
    writeFileSync(state.statePath, content);
    expect(
      await throwingRejectionOf(
        acquireDispatch(state, { resource: 'issue:COR-1', runId: 'run-b', ownerId: 'owner-b' }),
      ),
    ).toThrow(ExecutionStateError);
    expect(readFileSync(state.statePath, 'utf8')).toBe(content);
  });

  // spawn-free: restart recovery uses a deliberately orphaned temporary replacement.
  test('restart ignores a crash-left temporary replacement and reads a complete snapshot', async () => {
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
  });

  // spawn-free: provider reconciliation is injected and does not start an external process.
  test('records an ambiguous provider mutation for inspection, retaining its operation identifier', async () => {
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
  });

  // spawn-free: host identity is an injected string and no foreign host is contacted.
  test('rejects another host from using a local authority directory', async () => {
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
  });
});
