import { expect } from 'bun:test';

import type { EvidenceProjectionStorage } from '../src/evidence-projection-storage';
import type { WrapApply } from '../src/evidence-projection-store-core';
import {
  createMemoryAuthority,
  type MemoryAuthority,
  type MemoryCapability,
} from '../src/governance/authority';
import {
  createTransitionEngine,
  type CreateTransitionEngineOptions,
  type TransitionEngine,
} from '../src/transition-engine';
import { type TransitionEvent, transitionEventSchema } from '../src/transition-events';
import type { TransitionProposal } from '../src/transition-proposal';
import { createTransitionKeys } from '../src/transition-receipt';
import {
  FIXED_AT,
  makeFact,
  makeInlineEvidence,
  NAMESPACE,
  OWNER,
  TENANT,
} from './evidence-projection-fixtures';
import type { MakeBackend } from './transition-backends';

export { FIXED_AT, NAMESPACE, OWNER, TENANT };

/** The instant a manual clock starts at: after everything the fixtures stamp. */
export const CLOCK_START = FIXED_AT + 1_000_000;

export function makeWriteAuthority(
  options: {
    ownerId?: string;
    tenantId?: string;
    principalId?: string;
    capabilities?: readonly MemoryCapability[];
    policyRevision?: string;
  } = {},
): MemoryAuthority {
  return createMemoryAuthority({
    principal: { kind: 'user', id: options.principalId ?? 'user-1' },
    tenantId: options.tenantId ?? TENANT,
    ownerId: options.ownerId ?? OWNER,
    purpose: 'test',
    capabilities: options.capabilities ?? ['memory:write', 'memory:revoke'],
    policyRevision: options.policyRevision ?? 'authorization:1',
    projection: 'bureau',
  });
}

/** An evidence record as proposed: the stored fixture without `writtenAt`. */
export function proposedEvidence(
  id: string,
  overrides: Parameters<typeof makeInlineEvidence>[1] = {},
) {
  const { writtenAt: _writtenAt, ...proposed } = makeInlineEvidence(id, overrides);
  return proposed;
}

/** A fact as proposed for creation: the stored fixture without the fields the engine stamps. */
export function proposedFact(
  id: string,
  sources: ReadonlyArray<{ id: string; digest: string }>,
  overrides: Record<string, unknown> = {},
) {
  const stored = makeFact(id, [], { sources: [] });
  const {
    schemaVersion: _schemaVersion,
    revision: _revision,
    status: _status,
    transition: _transition,
    policyRevision: _policyRevision,
    validity: _validity,
    ...rest
  } = stored;
  return {
    ...rest,
    sources: sources.map((source) => ({ evidenceId: source.id, digest: source.digest })),
    ...overrides,
  } as Extract<TransitionProposal, { kind: 'create-projection' }>['projections'][number];
}

/** A clock the test moves by hand, and counts reads of. */
export function createManualClock(start: number = CLOCK_START) {
  let current = start;
  let reads = 0;
  return {
    now: () => {
      reads += 1;
      return current;
    },
    set(value: number) {
      current = value;
    },
    advance(by: number) {
      current += by;
    },
    get reads() {
      return reads;
    },
    get current() {
      return current;
    },
  };
}

/** Collects every event, and parses each with the strict schema so extra keys fail the test. */
export function createRecordingSink() {
  const events: TransitionEvent[] = [];
  return {
    events,
    sink: (event: TransitionEvent): void => {
      events.push(transitionEventSchema.parse(event));
    },
    kinds: (): string[] => events.map((event) => event.kind),
    clear: (): void => {
      events.length = 0;
    },
  };
}

/**
 * A named barrier: the first `parties` arrivals wait until the test calls
 * `release()`. `whenFull` resolves once the last party has arrived, so the test
 * never sleeps to find out whether they did.
 */
export function createBarrier(parties: number) {
  const gate = Promise.withResolvers<void>();
  const full = Promise.withResolvers<void>();
  let arrived = 0;
  return {
    async arrive(): Promise<void> {
      arrived += 1;
      if (arrived >= parties) full.resolve();
      await gate.promise;
    },
    whenFull: full.promise,
    release: (): void => gate.resolve(),
    get arrived() {
      return arrived;
    },
  };
}

export interface TransitionHarness {
  readonly storage: EvidenceProjectionStorage;
  readonly engine: TransitionEngine;
  readonly clock: ReturnType<typeof createManualClock>;
  readonly recorder: ReturnType<typeof createRecordingSink>;
}

/** A fresh backend, a manual clock, a recording sink, and an engine over them. */
export function createHarness(
  makeBackend: MakeBackend,
  options: {
    wrapApply?: WrapApply;
    hooks?: CreateTransitionEngineOptions['hooks'];
    storage?: EvidenceProjectionStorage;
    clock?: ReturnType<typeof createManualClock>;
    recorder?: ReturnType<typeof createRecordingSink>;
  } = {},
): TransitionHarness {
  const storage = options.storage ?? makeBackend(options.wrapApply);
  const clock = options.clock ?? createManualClock();
  const recorder = options.recorder ?? createRecordingSink();
  const engine = createTransitionEngine({
    storage,
    sink: recorder.sink,
    now: clock.now,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return { storage, engine, clock, recorder };
}

export function appendProposal(
  operationId: string,
  ids: readonly string[] = ['e1'],
  authority: MemoryAuthority = makeWriteAuthority(),
): Extract<TransitionProposal, { kind: 'append-evidence' }> {
  return {
    kind: 'append-evidence',
    operationId,
    tenantId: authority.tenantId,
    authority,
    evidence: ids.map((id) => proposedEvidence(id)),
  };
}

/** Narrows a result to a committed one, failing the test otherwise. */
export function expectCommitted<Result extends { outcome: string }>(
  result: Result,
): Extract<Result, { outcome: 'committed' }> {
  expect(result.outcome === 'committed' ? 'committed' : JSON.stringify(result)).toBe('committed');
  return result as Extract<Result, { outcome: 'committed' }>;
}

export function expectRefused<Result extends { outcome: string }>(
  result: Result,
  outcome: 'rejected' | 'conflicted',
): Extract<Result, { outcome: 'rejected' | 'conflicted' }> {
  expect(result.outcome).toBe(outcome);
  return result as Extract<Result, { outcome: 'rejected' | 'conflicted' }>;
}

const e1 = makeInlineEvidence('e1');
const e2 = makeInlineEvidence('e2');

/** The state a correction starts from: evidence `e1` and the fact `p1` resting on it. */
export async function seedCorrectionState(storage: EvidenceProjectionStorage): Promise<void> {
  await storage.commit({ tenantId: TENANT, evidence: [e1], projections: [makeFact('p1', [e1])] });
}

/**
 * COR-1546's one-batch correction: a successor evidence record, a projection
 * created from it, and the revision that supersedes the old projection.
 */
export function correctionProposal(
  operationId: string,
  authority: MemoryAuthority = makeWriteAuthority(),
): Extract<TransitionProposal, { kind: 'correct-evidence' }> {
  return {
    kind: 'correct-evidence',
    operationId,
    tenantId: authority.tenantId,
    authority,
    successor: proposedEvidence('e2', { supersedes: ['e1'] }),
    projections: [
      {
        ...proposedFact('p2', [{ id: 'e2', digest: e2.digest }]),
        supersedes: [{ id: 'p1', revision: 1 }],
      },
    ],
    revisions: [
      {
        namespace: NAMESPACE,
        id: 'p1',
        expectedRevision: 1,
        change: { kind: 'superseded', supersededBy: { id: 'p2', revision: 1 } },
      },
    ],
  };
}

/** What a storage holds of the correction, for asserting it is applied whole or not at all. */
export async function correctionState(storage: EvidenceProjectionStorage, operationId: string) {
  const retired = await storage.getProjection(TENANT, NAMESPACE, 'p1');
  return {
    successor: (await storage.getEvidence(TENANT, 'e2')) !== undefined,
    marker: (await storage.getEvidenceSupersession(TENANT, 'e1')) !== undefined,
    createdProjection: (await storage.getProjection(TENANT, NAMESPACE, 'p2')) !== undefined,
    retiredRevision: retired?.revision,
    receipt: await storage.getReceipt(createTransitionKeys().receipt(TENANT, operationId)),
  };
}

/** A storage whose `commit` fails with `error`, for outcomes the real store only reaches under load. */
export function storageFailingWith(
  storage: EvidenceProjectionStorage,
  error: unknown,
): EvidenceProjectionStorage {
  return { ...storage, commit: () => Promise.reject(error) };
}
