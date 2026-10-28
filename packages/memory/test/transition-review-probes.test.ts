import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import type { EvidenceProjectionStorage } from '../src/evidence-projection-storage';
import { createTransitionEngine } from '../src/transition-engine';
import { MemoryTransitionProposalError } from '../src/transition-proposal';
import { makeFact, makeInlineEvidence } from './evidence-projection-fixtures';
import { TRANSITION_BACKENDS } from './transition-backends';
import {
  appendProposal,
  CLOCK_START,
  createHarness,
  createManualClock,
  createOrderedGates,
  createRecordingSink,
  expectCommitted,
  makeWriteAuthority,
  NAMESPACE,
  OWNER,
  proposedEvidence,
  TENANT,
} from './transition-test-support';

/**
 * Probes from the primary review and the conformance review, ported. Each was
 * red against the first candidate and describes behavior the settled decisions
 * require: a revocation needs only `revoke`, a rebuild is authorized against the
 * projection it replaces as well as the sources it brings, an invalid and stale
 * proposal is `rejected`, and a receipt records the outcomes of the batch that
 * carries it.
 */

const e1 = makeInlineEvidence('e1');
const p1 = makeFact('p1', [e1]);

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`review probes (${label})`, () => {
    it("P1: an intruder cannot rebuild another owner's private projection onto evidence of its own", async () => {
      const harness = createHarness(makeBackend);
      await harness.storage.commit({ tenantId: TENANT, evidence: [e1], projections: [p1] });
      const intruder = makeWriteAuthority({ ownerId: 'owner-2', principalId: 'user-2' });
      const own = proposedEvidence('e7', { ownerId: 'owner-2', text: 'Intruder text.' });
      expectCommitted(
        await harness.engine.submit({
          kind: 'append-evidence',
          operationId: 'seed-intruder',
          tenantId: TENANT,
          authority: intruder,
          evidence: [own],
        }),
      );
      const result = await harness.engine.submit({
        kind: 'revise-projection',
        operationId: 'hijack',
        tenantId: TENANT,
        authority: intruder,
        revisions: [
          {
            namespace: NAMESPACE,
            id: 'p1',
            expectedRevision: 1,
            change: {
              kind: 'rebuilt',
              sources: [{ evidenceId: 'e7', digest: own.digest }],
              payload: { statement: 'Overwritten by owner-2.', entities: [] },
            },
          },
        ],
      });
      const after = await harness.storage.getProjection(TENANT, NAMESPACE, 'p1');
      expect({ outcome: result.outcome, revision: after?.revision }).toEqual({
        outcome: 'rejected',
        revision: 1,
      });
    });

    it('P1b: the original owner is not locked out of its own projection', async () => {
      const harness = createHarness(makeBackend);
      await harness.storage.commit({ tenantId: TENANT, evidence: [e1], projections: [p1] });
      const intruder = makeWriteAuthority({ ownerId: 'owner-2', principalId: 'user-2' });
      const own = proposedEvidence('e7', { ownerId: 'owner-2', text: 'Intruder text.' });
      await harness.engine.submit({
        kind: 'append-evidence',
        operationId: 'seed',
        tenantId: TENANT,
        authority: intruder,
        evidence: [own],
      });
      await harness.engine.submit({
        kind: 'revise-projection',
        operationId: 'hijack',
        tenantId: TENANT,
        authority: intruder,
        revisions: [
          {
            namespace: NAMESPACE,
            id: 'p1',
            expectedRevision: 1,
            change: {
              kind: 'rebuilt',
              sources: [{ evidenceId: 'e7', digest: own.digest }],
              payload: { statement: 'x', entities: [] },
            },
          },
        ],
      });
      const current = await harness.storage.getProjection(TENANT, NAMESPACE, 'p1');
      const ownerRevoke = await harness.engine.submit({
        kind: 'revise-projection',
        operationId: 'owner-revoke',
        tenantId: TENANT,
        authority: makeWriteAuthority(),
        revisions: [
          {
            namespace: NAMESPACE,
            id: 'p1',
            expectedRevision: current?.revision ?? 1,
            change: { kind: 'revoked', reasonCode: 'mine' },
          },
        ],
      });
      expect(ownerRevoke.outcome).toBe('committed');
    });

    it('P2: an owner holding only memory:revoke can revoke its own projection', async () => {
      const harness = createHarness(makeBackend);
      await harness.storage.commit({ tenantId: TENANT, evidence: [e1], projections: [p1] });
      const revoker = makeWriteAuthority({ ownerId: OWNER, capabilities: ['memory:revoke'] });
      const result = await harness.engine.submit({
        kind: 'revise-projection',
        operationId: 'revoke-1',
        tenantId: TENANT,
        authority: revoker,
        revisions: [
          {
            namespace: NAMESPACE,
            id: 'p1',
            expectedRevision: 1,
            change: { kind: 'revoked', reasonCode: 'withdrawn' },
          },
        ],
      });
      expect(result.outcome === 'committed' ? 'committed' : JSON.stringify(result)).toBe(
        'committed',
      );
    });

    it('P2b: a proposal that revokes and also writes needs both capabilities', async () => {
      const harness = createHarness(makeBackend);
      await harness.storage.commit({ tenantId: TENANT, evidence: [e1], projections: [p1] });
      const revoker = makeWriteAuthority({ capabilities: ['memory:revoke'] });
      const result = await harness.engine.submit({
        kind: 'correct-evidence',
        operationId: 'mixed',
        tenantId: TENANT,
        authority: revoker,
        successor: proposedEvidence('e9', { supersedes: ['e1'] }),
        revisions: [
          {
            namespace: NAMESPACE,
            id: 'p1',
            expectedRevision: 1,
            change: { kind: 'revoked', reasonCode: 'withdrawn' },
          },
        ],
      });
      expect(result).toMatchObject({ outcome: 'rejected', reason: 'unauthorized' });
    });

    it('P3: a proposal both invalid (prior-state) and stale is rejected, not conflicted', async () => {
      const harness = createHarness(makeBackend);
      await harness.storage.commit({ tenantId: TENANT, evidence: [e1], projections: [p1] });
      const result = await harness.engine.submit({
        kind: 'revise-projection',
        operationId: 'invalid-and-stale',
        tenantId: TENANT,
        authority: makeWriteAuthority(),
        revisions: [
          {
            namespace: NAMESPACE,
            id: 'p1',
            expectedRevision: 7,
            change: { kind: 'superseded', supersededBy: { id: 'ghost', revision: 1 } },
          },
        ],
      });
      expect(result).toMatchObject({ outcome: 'rejected', reason: 'prior-state-not-preserved' });
    });

    it('P4: a receipt never records an outcome the store did not produce, under a concurrent writer', async () => {
      const storage = makeBackend();
      const gates = createOrderedGates(2);
      const a = createTransitionEngine({
        storage,
        sink: createRecordingSink().sink,
        now: createManualClock().now,
        hooks: { beforeBatch: gates.hold(0) },
      });
      const b = createTransitionEngine({
        storage,
        sink: createRecordingSink().sink,
        now: createManualClock().now,
        hooks: { beforeBatch: gates.hold(1) },
      });
      // Two different operations append the same evidence record at the same instant.
      const pendingA = a.submit(appendProposal('operation-a'));
      const pendingB = b.submit(appendProposal('operation-b'));
      await gates.whenAllArrived;
      gates.release(0);
      expectCommitted(await pendingA);
      gates.release(1);
      const resultB = await pendingB;
      const storedB = await b.getReceipt(TENANT, 'operation-b');
      expect({
        outcome: resultB.outcome,
        evidence: storedB?.evidence.map((entry) => entry.outcome),
      }).toEqual({ outcome: 'committed', evidence: ['duplicate'] });
    });

    it('P4b: a retry of that submission replays the true receipt', async () => {
      const storage = makeBackend();
      const gates = createOrderedGates(2);
      const engine = (index: number) =>
        createTransitionEngine({
          storage,
          sink: createRecordingSink().sink,
          now: createManualClock().now,
          hooks: { beforeBatch: gates.hold(index) },
        });
      const a = engine(0);
      const b = engine(1);
      const pendingA = a.submit(appendProposal('operation-a'));
      const pendingB = b.submit(appendProposal('operation-b'));
      await gates.whenAllArrived;
      gates.release(0);
      await pendingA;
      gates.release(1);
      const resultB = await pendingB;
      expect(resultB.outcome).toBe('committed');
      const retry = createTransitionEngine({
        storage,
        sink: createRecordingSink().sink,
        now: createManualClock().now,
      });
      const replay = expectCommitted(await retry.submit(appendProposal('operation-b')));
      expect({
        replayed: replay.replayed,
        evidence: replay.receipt.evidence.map((entry) => entry.outcome),
      }).toEqual({ replayed: true, evidence: ['duplicate'] });
    });

    it('P5: a rebuild of an own projection commits', async () => {
      const harness = createHarness(makeBackend);
      await harness.storage.commit({ tenantId: TENANT, evidence: [e1], projections: [p1] });
      const result = await harness.engine.submit({
        kind: 'revise-projection',
        operationId: 'rebuild-1',
        tenantId: TENANT,
        authority: makeWriteAuthority(),
        revisions: [
          {
            namespace: NAMESPACE,
            id: 'p1',
            expectedRevision: 1,
            change: {
              kind: 'rebuilt',
              sources: [{ evidenceId: 'e1', digest: e1.digest }],
              payload: { statement: 'Rebuilt.', entities: [] },
            },
          },
        ],
      });
      expectCommitted(result);
      const after = await harness.storage.getProjection(TENANT, NAMESPACE, 'p1');
      expect(after?.transition).toMatchObject({ kind: 'rebuilt', rebuiltFromRevision: 1 });
    });

    it('departure 3: a byte-identical concurrent write between validation and the batch commits with a true receipt', async () => {
      let storage: EvidenceProjectionStorage | undefined;
      let interposed = false;
      storage = makeBackend((apply) => async (batch) => {
        if (!interposed) {
          interposed = true;
          // A concurrent, byte-identical append lands first (same clock, so the same writtenAt).
          await storage?.appendEvidence({ ...e1, writtenAt: CLOCK_START });
        }
        return apply(batch);
      });
      const harness = createHarness(makeBackend, { storage });
      const result = await harness.engine.submit(appendProposal('op-1'));
      const receipt = await harness.engine.getReceipt(TENANT, 'op-1');
      expect(receipt?.evidence.map((entry) => entry.outcome)).toEqual(['duplicate']);
      expect(result.outcome).toBe('committed');
      expect(harness.recorder.kinds()).toEqual(['requested', 'validation-started', 'committed']);
    });

    it('rejects a rebuilt payload that is not JSON with a typed error, not a raw TypeError', async () => {
      const harness = createHarness(makeBackend);
      const cyclic: Record<string, unknown> = { statement: 's', entities: [] };
      cyclic['self'] = cyclic;
      for (const payload of [{ statement: 's', entities: [], big: 10n }, cyclic]) {
        const error = await rejectionOf(
          harness.engine.submit({
            kind: 'revise-projection',
            operationId: 'rebuild-1',
            tenantId: TENANT,
            authority: makeWriteAuthority(),
            revisions: [
              {
                namespace: NAMESPACE,
                id: 'p1',
                expectedRevision: 1,
                change: {
                  kind: 'rebuilt',
                  sources: [{ evidenceId: 'e1', digest: e1.digest }],
                  payload,
                },
              },
            ],
          }),
        );
        expect(error).toBeInstanceOf(MemoryTransitionProposalError);
      }
      expect(harness.recorder.events).toEqual([]);
    });
  });
}
