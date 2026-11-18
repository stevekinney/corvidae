/**
 * Durable, single-host authority for Chef coordinators.
 *
 * This is deliberately local fencing, not a distributed lock. A provider marker is inspected
 * before a grant, while the per-resource host lock serializes only local state replacement.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { acquireHostLock, processStartTime } from '../run-exclusively.ts';

// P04 binds persisted operations to provider identities; prior snapshots cannot prove that tuple.
export const executionStateVersion = 2 as const;

export class ExecutionStateError extends Error {}

export interface Authority {
  runId: string;
  ownerId: string;
  resource: string;
  generation: number;
}

type OwnershipStatus = 'held' | 'cancelled' | 'released';

interface OwnershipRecord extends Authority {
  status: OwnershipStatus;
}

export interface RemoteOperation {
  operationId: string;
  action: string;
  authority: Authority;
  intentFingerprint: string;
  outcome: 'intent' | 'observed' | 'unknown' | 'unresolved';
  observed?: unknown;
  nextAction: 'perform' | 'inspect-provider' | 'closeout';
}

export interface ExecutionSnapshot {
  version: typeof executionStateVersion;
  hostId: string;
  ownership: Record<string, OwnershipRecord>;
  operations: Record<string, RemoteOperation>;
  pendingCloseout: string[];
  nextAction: string | null;
}

export interface ExecutionStateStore {
  stateDirectory: string;
  statePath: string;
  lockDirectory: string;
  hostId: string;
}

export interface ProviderClaimReader {
  inspectClaim(resource: string): Promise<{ holder: string; live: boolean } | undefined>;
}

export interface ProviderOperationReader {
  inspect(
    operationId: string,
  ): Promise<{ operationId: string; outcome: 'observed' | 'unresolved'; observed?: unknown }>;
}

export function createExecutionStateStore(options: {
  stateDirectory: string;
  hostId: string;
}): ExecutionStateStore {
  return {
    stateDirectory: options.stateDirectory,
    statePath: join(options.stateDirectory, 'execution-state.json'),
    lockDirectory: join(options.stateDirectory, 'locks'),
    hostId: options.hostId,
  };
}

function emptySnapshot(hostId: string): ExecutionSnapshot {
  return {
    version: executionStateVersion,
    hostId,
    ownership: Object.create(null) as Record<string, OwnershipRecord>,
    operations: Object.create(null) as Record<string, RemoteOperation>,
    pendingCloseout: [],
    nextAction: null,
  };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertAuthorityRecord(value: unknown, resource: string, statePath: string): void {
  if (!plainRecord(value))
    throw new ExecutionStateError(`${statePath} has malformed ownership for ${resource}.`);
  if (
    value['resource'] !== resource ||
    typeof value['runId'] !== 'string' ||
    value['runId'] === '' ||
    typeof value['ownerId'] !== 'string' ||
    value['ownerId'] === ''
  )
    throw new ExecutionStateError(`${statePath} has malformed ownership identity for ${resource}.`);
  if (!Number.isSafeInteger(value['generation']) || (value['generation'] as number) < 1)
    throw new ExecutionStateError(
      `${statePath} has malformed ownership generation for ${resource}.`,
    );
  if (
    value['status'] !== 'held' &&
    value['status'] !== 'cancelled' &&
    value['status'] !== 'released'
  )
    throw new ExecutionStateError(`${statePath} has malformed ownership status for ${resource}.`);
}

function assertAuthority(value: unknown, statePath: string): void {
  if (!plainRecord(value) || typeof value['resource'] !== 'string' || value['resource'] === '')
    throw new ExecutionStateError(`${statePath} has malformed operation authority.`);
  if (
    typeof value['runId'] !== 'string' ||
    value['runId'] === '' ||
    typeof value['ownerId'] !== 'string' ||
    value['ownerId'] === '' ||
    !Number.isSafeInteger(value['generation']) ||
    (value['generation'] as number) < 1
  )
    throw new ExecutionStateError(`${statePath} has malformed operation authority.`);
}

function assertOperation(value: unknown, operationId: string, statePath: string): void {
  if (
    !plainRecord(value) ||
    value['operationId'] !== operationId ||
    typeof value['action'] !== 'string' ||
    value['action'] === '' ||
    typeof value['intentFingerprint'] !== 'string' ||
    value['intentFingerprint'] === ''
  )
    throw new ExecutionStateError(`${statePath} has malformed operation ${operationId}.`);
  if (
    !['intent', 'observed', 'unknown', 'unresolved'].includes(String(value['outcome'])) ||
    !['perform', 'inspect-provider', 'closeout'].includes(String(value['nextAction']))
  )
    throw new ExecutionStateError(`${statePath} has malformed operation state for ${operationId}.`);
  assertAuthority(value['authority'], statePath);
}

function assertSnapshot(value: unknown, statePath: string): asserts value is ExecutionSnapshot {
  if (typeof value !== 'object' || value === null)
    throw new ExecutionStateError(`${statePath} is not an execution-state object.`);
  const snapshot = value as Partial<ExecutionSnapshot>;
  if (snapshot.version !== executionStateVersion)
    throw new ExecutionStateError(
      `${statePath} has unsupported execution-state version ${String(snapshot.version)}.`,
    );
  if (typeof snapshot.hostId !== 'string' || snapshot.hostId === '')
    throw new ExecutionStateError(`${statePath} has no host identity.`);
  if (
    !plainRecord(snapshot.ownership) ||
    !plainRecord(snapshot.operations) ||
    !Array.isArray(snapshot.pendingCloseout)
  )
    throw new ExecutionStateError(`${statePath} has malformed execution-state fields.`);
  for (const [resource, record] of Object.entries(snapshot.ownership))
    assertAuthorityRecord(record, resource, statePath);
  for (const [operationId, operation] of Object.entries(snapshot.operations))
    assertOperation(operation, operationId, statePath);
  const operations = snapshot.operations as Record<string, unknown>;
  if (
    !snapshot.pendingCloseout.every(
      (operationId) => typeof operationId === 'string' && operations[operationId] !== undefined,
    )
  )
    throw new ExecutionStateError(`${statePath} has malformed pending closeout.`);
  if (snapshot.nextAction !== null && typeof snapshot.nextAction !== 'string')
    throw new ExecutionStateError(`${statePath} has malformed next action.`);
}

export function readExecutionSnapshot(store: ExecutionStateStore): ExecutionSnapshot {
  let content: string;
  try {
    content = readFileSync(store.statePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySnapshot(store.hostId);
    throw error;
  }
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(content);
  } catch {
    throw new ExecutionStateError(
      `${store.statePath} is malformed; preserving its bytes for recovery.`,
    );
  }
  assertSnapshot(snapshot, store.statePath);
  if (snapshot.hostId !== store.hostId)
    throw new ExecutionStateError(
      `${store.statePath} belongs to host ${snapshot.hostId}; local authority is not multi-host fencing.`,
    );
  return snapshot;
}

function writeSnapshot(store: ExecutionStateStore, snapshot: ExecutionSnapshot): void {
  mkdirSync(store.stateDirectory, { recursive: true });
  const temporary = `${store.statePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`);
    renameSync(temporary, store.statePath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function lockPath(store: ExecutionStateStore): string {
  return join(store.lockDirectory, 'execution-state.lock');
}

function providerTransitionLockPath(store: ExecutionStateStore, resource: string): string {
  return join(store.lockDirectory, `${encodeURIComponent(resource)}.provider-transition.lock`);
}

/**
 * Serializes one resource's provider read/mutate/read-back transition. This is separate from the
 * short snapshot lock: provider I/O must never block unrelated state replacements.
 */
export async function withProviderTransitionLock<T>(
  store: ExecutionStateStore,
  resource: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  mkdirSync(store.lockDirectory, { recursive: true });
  const pidStartedAt = processStartTime(process.pid);
  const lock = await acquireHostLock({
    lockDirectory: providerTransitionLockPath(store, resource),
    holder: {
      pid: process.pid,
      ...(pidStartedAt === undefined ? {} : { pidStartedAt }),
      command: 'chef provider transition',
      cwd: process.cwd(),
      acquiredAt: new Date().toISOString(),
    },
    pollIntervalMs: 5,
  });
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

async function underResourceLock<T>(
  store: ExecutionStateStore,
  _resource: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  mkdirSync(store.lockDirectory, { recursive: true });
  const pidStartedAt = processStartTime(process.pid);
  const lock = await acquireHostLock({
    lockDirectory: lockPath(store),
    holder: {
      pid: process.pid,
      ...(pidStartedAt === undefined ? {} : { pidStartedAt }),
      command: 'chef execution-state',
      cwd: process.cwd(),
      acquiredAt: new Date().toISOString(),
    },
    pollIntervalMs: 5,
  });
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

function sameAuthority(record: OwnershipRecord | undefined, authority: Authority): boolean {
  return (
    record?.resource === authority.resource &&
    record.runId === authority.runId &&
    record.ownerId === authority.ownerId &&
    record.generation === authority.generation
  );
}

export function requireAuthority(store: ExecutionStateStore, authority: Authority): Authority {
  const current = readExecutionSnapshot(store).ownership[authority.resource];
  if (current === undefined || !sameAuthority(current, authority))
    throw new ExecutionStateError(`Authority for ${authority.resource} has a newer generation.`);
  if (current.status !== 'held')
    throw new ExecutionStateError(
      `Authority for ${authority.resource} is ${current.status}; transitions are revoked.`,
    );
  return authority;
}

/** Finds this coordinator's current authority without reviving an expired or cancelled generation. */
export function currentAuthority(
  store: ExecutionStateStore,
  request: Omit<Authority, 'generation'>,
): Authority {
  const current = readExecutionSnapshot(store).ownership[request.resource];
  if (
    current === undefined ||
    current.status !== 'held' ||
    current.runId !== request.runId ||
    current.ownerId !== request.ownerId
  )
    throw new ExecutionStateError(`No current authority for ${request.resource}.`);
  return {
    resource: current.resource,
    runId: current.runId,
    ownerId: current.ownerId,
    generation: current.generation,
  };
}

export async function acquireDispatch(
  store: ExecutionStateStore,
  request: Omit<Authority, 'generation'>,
  provider?: ProviderClaimReader,
): Promise<{ granted: true; authority: Authority } | { granted: false; reason: string }> {
  // Provider I/O deliberately occurs before the local lock: a slow provider cannot hold the host lock.
  const remote = await provider?.inspectClaim(request.resource);
  if (remote?.live === true) return { granted: false, reason: `held remotely by ${remote.holder}` };
  return underResourceLock(store, request.resource, () => {
    const snapshot = readExecutionSnapshot(store);
    const current = snapshot.ownership[request.resource];
    if (remote !== undefined && !remote.live && current?.status === 'held') {
      current.status = 'cancelled';
      snapshot.nextAction = `resume:${request.resource}`;
      writeSnapshot(store, snapshot);
    }
    const effectiveCurrent = snapshot.ownership[request.resource];
    if (effectiveCurrent?.status === 'held') {
      if (effectiveCurrent.runId === request.runId && effectiveCurrent.ownerId === request.ownerId)
        return {
          granted: true as const,
          authority: {
            resource: effectiveCurrent.resource,
            runId: effectiveCurrent.runId,
            ownerId: effectiveCurrent.ownerId,
            generation: effectiveCurrent.generation,
          },
        };
      return { granted: false as const, reason: `held locally by ${effectiveCurrent.ownerId}` };
    }
    const authority: Authority = {
      ...request,
      generation: (effectiveCurrent?.generation ?? 0) + 1,
    };
    snapshot.ownership[request.resource] = { ...authority, status: 'held' };
    snapshot.nextAction = `dispatch:${request.resource}`;
    writeSnapshot(store, snapshot);
    return { granted: true as const, authority };
  });
}

async function changeAuthority(
  store: ExecutionStateStore,
  authority: Authority,
  status: Exclude<OwnershipStatus, 'held'>,
): Promise<boolean> {
  return underResourceLock(store, authority.resource, () => {
    const snapshot = readExecutionSnapshot(store);
    const current = snapshot.ownership[authority.resource];
    if (current === undefined || !sameAuthority(current, authority) || current.status !== 'held')
      return false;
    current.status = status;
    snapshot.nextAction = status === 'cancelled' ? `resume:${authority.resource}` : null;
    writeSnapshot(store, snapshot);
    return true;
  });
}

/** Cancellation revokes future transition permission; it does not signal or stop a process. */
export async function cancelDispatch(
  store: ExecutionStateStore,
  authority: Authority,
): Promise<boolean> {
  return changeAuthority(store, authority, 'cancelled');
}

export async function releaseDispatch(
  store: ExecutionStateStore,
  authority: Authority,
): Promise<boolean> {
  return changeAuthority(store, authority, 'released');
}

async function mutateOwnedSnapshot(
  store: ExecutionStateStore,
  authority: Authority,
  mutate: (snapshot: ExecutionSnapshot) => void,
): Promise<void> {
  await underResourceLock(store, authority.resource, () => {
    requireAuthority(store, authority);
    const snapshot = readExecutionSnapshot(store);
    mutate(snapshot);
    writeSnapshot(store, snapshot);
  });
}

export async function recordMutationIntent(
  store: ExecutionStateStore,
  authority: Authority,
  input: { operationId: string; action: string; intentFingerprint: string },
): Promise<void> {
  await mutateOwnedSnapshot(store, authority, (snapshot) => {
    const existing = snapshot.operations[input.operationId];
    if (
      existing !== undefined &&
      (existing.action !== input.action ||
        existing.intentFingerprint !== input.intentFingerprint ||
        !sameAuthority(existing.authority as OwnershipRecord, authority))
    )
      throw new ExecutionStateError(
        `Operation ${input.operationId} already names ${existing.action}.`,
      );
    snapshot.operations[input.operationId] = existing ?? {
      operationId: input.operationId,
      action: input.action,
      authority,
      intentFingerprint: input.intentFingerprint,
      outcome: 'intent',
      nextAction: 'perform',
    };
    snapshot.nextAction = `perform:${input.operationId}`;
  });
}

export async function recordMutationResult(
  store: ExecutionStateStore,
  authority: Authority,
  operationId: string,
  input: { outcome: 'observed' | 'unknown' | 'unresolved'; observed?: unknown },
): Promise<void> {
  await mutateOwnedSnapshot(store, authority, (snapshot) => {
    const operation = snapshot.operations[operationId];
    if (operation === undefined)
      throw new ExecutionStateError(`Operation ${operationId} has no recorded intent.`);
    operation.outcome = input.outcome;
    operation.observed = input.observed;
    operation.nextAction = input.outcome === 'observed' ? 'closeout' : 'inspect-provider';
    snapshot.nextAction = `${operation.nextAction}:${operationId}`;
    if (operation.nextAction === 'closeout' && !snapshot.pendingCloseout.includes(operationId))
      snapshot.pendingCloseout.push(operationId);
  });
}

export async function reconcileOperation(
  store: ExecutionStateStore,
  authority: Authority,
  operationId: string,
  provider: ProviderOperationReader,
): Promise<{
  operationId: string;
  outcome: 'observed' | 'unresolved';
  nextAction: 'closeout' | 'inspect-provider';
}> {
  requireAuthority(store, authority);
  const operation = readExecutionSnapshot(store).operations[operationId];
  if (operation === undefined)
    throw new ExecutionStateError(`Operation ${operationId} has no recorded intent.`);
  // Read provider state before deciding whether a lost response should be retried.
  const observed = await provider.inspect(operationId);
  await mutateOwnedSnapshot(store, authority, (snapshot) => {
    const current = snapshot.operations[operationId];
    if (current === undefined)
      throw new ExecutionStateError(`Operation ${operationId} disappeared during reconciliation.`);
    current.outcome = observed.outcome;
    current.observed = observed.observed;
    current.nextAction = observed.outcome === 'observed' ? 'closeout' : 'inspect-provider';
    snapshot.nextAction = `${current.nextAction}:${operationId}`;
    if (current.nextAction === 'closeout' && !snapshot.pendingCloseout.includes(operationId))
      snapshot.pendingCloseout.push(operationId);
  });
  return {
    operationId,
    outcome: observed.outcome,
    nextAction: observed.outcome === 'observed' ? 'closeout' : 'inspect-provider',
  };
}
