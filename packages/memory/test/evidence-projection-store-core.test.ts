import { describe, expect, it } from 'bun:test';

import { createEvidenceProjectionKeys } from '../src/evidence-projection-keys';
import {
  EvidenceProjectionCommitError,
  ProjectionRevisionConflictError,
} from '../src/evidence-projection-storage';
import {
  createEvidenceProjectionStoreCore,
  type PlannedBatch,
} from '../src/evidence-projection-store-core';
import { MemoryEvidenceValidationError } from '../src/evidence-schema';
import { rejectionOf } from '../src/testing/promise-outcome.test-support.ts';
import {
  FIXED_AT,
  makeFact,
  makeInlineEvidence,
  NAMESPACE,
  nextRevision,
  TENANT,
} from './evidence-projection-fixtures';

/**
 * Tests of the shared core with a hand-driven `apply`, so a competing write can
 * land at the one moment between a commit's reads and its batch. The backends
 * cannot be made to interleave that precisely; the core can.
 */

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** A core over a Map whose `apply` runs `interpose` once, before it checks its conditions. */
function interposedCore(interpose: (store: Map<string, Uint8Array>) => void) {
  const store = new Map<string, Uint8Array>();
  const keys = createEvidenceProjectionKeys();
  let armed = false;
  const apply = (batch: PlannedBatch): Promise<boolean> => {
    if (armed) {
      armed = false;
      interpose(store);
    }
    for (const condition of batch.conditions) {
      const current = store.get(condition.key) ?? null;
      const holds =
        condition.expectedValue === null
          ? current === null
          : current !== null && bytesEqual(current, condition.expectedValue);
      if (!holds) return Promise.resolve(false);
    }
    for (const operation of batch.operations) store.set(operation.key, operation.value);
    return Promise.resolve(true);
  };
  const core = createEvidenceProjectionStoreCore({
    keys,
    apply,
    reader: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      async *keys(prefix) {
        for (const key of store.keys()) if (key.startsWith(prefix)) yield key;
      },
    },
  });
  return {
    core,
    store,
    keys,
    arm: () => {
      armed = true;
    },
  };
}

describe('conditions that guard a commit against a write between its reads and its batch', () => {
  it('[item 12] does not mark a predecessor that vanished between plan and apply', async () => {
    const { core, keys, arm } = interposedCore((store) =>
      store.delete(keys.evidence(TENANT, 'e1')),
    );
    await core.appendEvidence(makeInlineEvidence('e1'));
    arm();
    const error = await rejectionOf(
      core.appendEvidence(makeInlineEvidence('e2', { supersedes: ['e1'] })),
    );
    expect((error as EvidenceProjectionCommitError).code).toBe('evidence-not-found');
    expect(await core.getEvidenceSupersession(TENANT, 'e1')).toBeUndefined();
  });

  it('[item 12] does not report a projection as a duplicate after it moved under the commit', async () => {
    const e1 = makeInlineEvidence('e1');
    const p1 = makeFact('p1', [e1]);
    const rebuilt = nextRevision(p1, {
      transition: { kind: 'rebuilt', at: FIXED_AT + 1, rebuiltFromRevision: 1 },
      confidence: 0.1,
    });
    // The bytes a concurrent writer would land for revision 2 of p1.
    const scratch = interposedCore(() => undefined);
    await scratch.core.commit({ tenantId: TENANT, evidence: [e1], projections: [p1] });
    await scratch.core.writeProjectionRevision(rebuilt);
    const landed = {
      current: scratch.store.get(scratch.keys.current(TENANT, NAMESPACE, 'p1'))!,
      history: scratch.store.get(scratch.keys.history(TENANT, NAMESPACE, 'p1', 2))!,
    };

    const moving = interposedCore((store) => {
      store.set(moving.keys.current(TENANT, NAMESPACE, 'p1'), landed.current);
      store.set(moving.keys.history(TENANT, NAMESPACE, 'p1', 2), landed.history);
    });
    await moving.core.commit({ tenantId: TENANT, evidence: [e1], projections: [p1] });
    moving.arm();
    // p1 is a duplicate when planned; q1 is new, so the batch has puts and is really applied.
    const error = await rejectionOf(
      moving.core.commit({ tenantId: TENANT, projections: [p1, makeFact('q1', [e1])] }),
    );
    expect(error).toBeInstanceOf(ProjectionRevisionConflictError);
    expect(await moving.core.getProjection(TENANT, NAMESPACE, 'q1')).toBeUndefined();
  });

  it('[item 12] does not supersede a predecessor whose bytes changed under the commit', async () => {
    const { core, keys, store, arm } = interposedCore((map) => {
      // A competing writer replaces the predecessor's bytes (not its presence).
      map.set(keys.evidence(TENANT, 'e1'), new TextEncoder().encode('{}'));
    });
    await core.appendEvidence(makeInlineEvidence('e1'));
    arm();
    const error = await rejectionOf(
      core.appendEvidence(makeInlineEvidence('e2', { supersedes: ['e1'] })),
    );
    // The re-plan reads the replaced bytes and refuses them at the read boundary.
    expect(error).toBeInstanceOf(MemoryEvidenceValidationError);
    expect(store.has(keys.supersession(TENANT, 'e1'))).toBe(false);
  });
});

describe('retry exhaustion', () => {
  function alwaysLosingCore() {
    let attempts = 0;
    const core = createEvidenceProjectionStoreCore({
      keys: createEvidenceProjectionKeys(),
      apply: () => {
        attempts += 1;
        return Promise.resolve(false);
      },
      reader: { get: () => Promise.resolve(null), async *keys() {} },
    });
    return { core, attempts: () => attempts };
  }

  it('[item 17] gives up after exactly three lost batches with the ruled error shape', async () => {
    const { core, attempts } = alwaysLosingCore();
    const e1 = makeInlineEvidence('e1');
    const error = await rejectionOf(
      core.commit({ tenantId: TENANT, evidence: [e1], projections: [makeFact('p1', [e1])] }),
    );
    expect(error).toBeInstanceOf(ProjectionRevisionConflictError);
    expect((error as ProjectionRevisionConflictError).ids).toEqual(['p1']);
    expect((error as ProjectionRevisionConflictError).namespace).toBe(NAMESPACE);
    expect((error as ProjectionRevisionConflictError).tenantId).toBe(TENANT);
    expect(attempts()).toBe(3);
  });

  it('[item 17] reports an evidence-only loss with no namespace and no ids', async () => {
    const { core } = alwaysLosingCore();
    const error = await rejectionOf(core.appendEvidence(makeInlineEvidence('e1')));
    expect((error as ProjectionRevisionConflictError).namespace).toBeUndefined();
    expect((error as ProjectionRevisionConflictError).ids).toEqual([]);
  });

  it('[item 18] reports no namespace when the lost projections span more than one namespace', async () => {
    const { core } = alwaysLosingCore();
    const e1 = makeInlineEvidence('e1');
    const error = await rejectionOf(
      core.commit({
        tenantId: TENANT,
        evidence: [e1],
        projections: [
          makeFact('p1', [e1], { namespace: 'one' }),
          makeFact('p2', [e1], { namespace: 'two' }),
        ],
      }),
    );
    expect((error as ProjectionRevisionConflictError).namespace).toBeUndefined();
    expect((error as ProjectionRevisionConflictError).ids).toEqual(['p1', 'p2']);
  });

  it('[item 18] names the namespace when every lost projection shares one', async () => {
    const { core } = alwaysLosingCore();
    const e1 = makeInlineEvidence('e1');
    const error = await rejectionOf(
      core.commit({
        tenantId: TENANT,
        evidence: [e1],
        projections: [
          makeFact('p1', [e1], { namespace: 'one' }),
          makeFact('p2', [e1], { namespace: 'one' }),
        ],
      }),
    );
    expect((error as ProjectionRevisionConflictError).namespace).toBe('one');
  });
});

describe('a projection stored under a key that disagrees with its body', () => {
  async function seeded() {
    const context = interposedCore(() => undefined);
    const e1 = makeInlineEvidence('e1');
    await context.core.commit({
      tenantId: TENANT,
      evidence: [e1],
      projections: [makeFact('p1', [e1])],
    });
    return context;
  }

  it('[item 20] refuses a current key whose body names another id', async () => {
    const { core, store, keys } = await seeded();
    store.set(
      keys.current(TENANT, NAMESPACE, 'p9'),
      store.get(keys.current(TENANT, NAMESPACE, 'p1'))!,
    );
    const error = await rejectionOf(core.getProjection(TENANT, NAMESPACE, 'p9'));
    expect((error as MemoryEvidenceValidationError).code).toBe('malformed');
  });

  it('[item 20] refuses a current key whose body names another namespace', async () => {
    const { core, store, keys } = await seeded();
    store.set(
      keys.current(TENANT, 'other', 'p1'),
      store.get(keys.current(TENANT, NAMESPACE, 'p1'))!,
    );
    const error = await rejectionOf(core.getProjection(TENANT, 'other', 'p1'));
    expect((error as MemoryEvidenceValidationError).code).toBe('malformed');
  });

  it('[item 20] refuses a history key whose body carries another revision', async () => {
    const { core, store, keys } = await seeded();
    store.set(
      keys.history(TENANT, NAMESPACE, 'p1', 2),
      store.get(keys.history(TENANT, NAMESPACE, 'p1', 1))!,
    );
    const error = await rejectionOf(core.getProjectionRevision(TENANT, NAMESPACE, 'p1', 2));
    expect((error as MemoryEvidenceValidationError).code).toBe('malformed');
  });
});
