import { describe, expect, it } from 'bun:test';

import { createTransitionEngine } from '../src/transition-engine';
import type { TransitionProposal } from '../src/transition-proposal';
import { makeFact, makeInlineEvidence } from './evidence-projection-fixtures';
import { TRANSITION_BACKENDS } from './transition-backends';
import {
  correctionProposal,
  createManualClock,
  createOrderedGates,
  createRecordingSink,
  expectCommitted,
  expectRefused,
  makeWriteAuthority,
  NAMESPACE,
  seedCorrectionState,
  TENANT,
} from './transition-test-support';

/**
 * Everything validation read is a condition of the batch. A check that passed
 * against state which then changed must not commit, whichever check it was.
 */

const authority = makeWriteAuthority();
const e1 = makeInlineEvidence('e1');

function engineOver(
  storage: Parameters<typeof createTransitionEngine>[0]['storage'],
  options: Pick<Parameters<typeof createTransitionEngine>[0], 'hooks' | 'sink'> = {
    sink: createRecordingSink().sink,
  },
) {
  return createTransitionEngine({
    storage,
    now: createManualClock().now,
    ...options,
  });
}

/** A sink that parks the submission when it reaches `kind`, until the test releases it. */
function parkAt(kind: string) {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const recorder = createRecordingSink();
  return {
    recorder,
    reached: reached.promise,
    release: () => release.resolve(),
    sink: async (event: Parameters<typeof recorder.sink>[0]) => {
      recorder.sink(event);
      if (event.kind === kind) {
        reached.resolve();
        await release.promise;
      }
    },
  };
}

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`the validation read set binds the batch (${label})`, () => {
    it('conflicts a supersession whose existing successor is revoked between validation and the batch', async () => {
      const storage = makeBackend();
      const p1 = makeFact('p1', [e1]);
      const p3 = makeFact('p3', [e1], { payload: { statement: 'Successor.', entities: [] } });
      await storage.commit({ tenantId: TENANT, evidence: [e1], projections: [p1, p3] });
      const gates = createOrderedGates(1);
      const superseder = engineOver(storage, {
        sink: createRecordingSink().sink,
        hooks: { beforeBatch: gates.hold(0) },
      });
      const revoker = engineOver(storage);

      const supersede: TransitionProposal = {
        kind: 'revise-projection',
        operationId: 'supersede-p1',
        tenantId: TENANT,
        authority,
        revisions: [
          {
            namespace: NAMESPACE,
            id: 'p1',
            expectedRevision: 1,
            change: { kind: 'superseded', supersededBy: { id: 'p3', revision: 1 } },
          },
        ],
      };
      const pending = superseder.submit(supersede);
      await gates.whenAllArrived;
      // The successor validated as active; now it is revoked, and that batch lands first.
      expectCommitted(
        await revoker.submit({
          kind: 'revise-projection',
          operationId: 'revoke-p3',
          tenantId: TENANT,
          authority,
          revisions: [
            {
              namespace: NAMESPACE,
              id: 'p3',
              expectedRevision: 1,
              change: { kind: 'revoked', reasonCode: 'withdrawn' },
            },
          ],
        }),
      );
      gates.release(0);
      const result = expectRefused(await pending, 'conflicted');

      expect(result.reason).toBe('revision-conflict');
      const untouched = await storage.getProjection(TENANT, NAMESPACE, 'p1');
      expect(untouched?.revision).toBe(1);
      expect(await superseder.getReceipt(TENANT, 'supersede-p1')).toBeUndefined();
    });

    it('conflicts a proposal whose absent successor appears between validation and the batch', async () => {
      const storage = makeBackend();
      await seedCorrectionState(storage);
      const gates = createOrderedGates(1);
      const engine = engineOver(storage, {
        sink: createRecordingSink().sink,
        hooks: { beforeBatch: gates.hold(0) },
      });
      const pending = engine.submit(correctionProposal('operation-1'));
      await gates.whenAllArrived;
      // Someone else writes the very projection the correction would create.
      await storage.commit({
        tenantId: TENANT,
        projections: [
          makeFact('p2', [e1], { payload: { statement: 'Someone else.', entities: [] } }),
        ],
      });
      gates.release(0);
      expectRefused(await pending, 'conflicted');
      expect(await storage.getEvidence(TENANT, 'e2')).toBeUndefined();
    });
  });

  describe(`a receipt that appears while a loser validates (${label})`, () => {
    const revise: TransitionProposal = {
      kind: 'revise-projection',
      operationId: 'operation-1',
      tenantId: TENANT,
      authority,
      revisions: [
        {
          namespace: NAMESPACE,
          id: 'p1',
          expectedRevision: 1,
          change: { kind: 'revoked', reasonCode: 'withdrawn' },
        },
      ],
    };

    for (const [name, proposal] of [
      ['revise-projection', revise],
      ['correct-evidence', correctionProposal('operation-1')],
    ] as const) {
      it(`gives both identical ${name} submissions the same receipt when the winner commits first`, async () => {
        const storage = makeBackend();
        await seedCorrectionState(storage);
        const loserSink = parkAt('validation-started');
        const loser = engineOver(storage, { sink: loserSink.sink });
        const winner = engineOver(storage);

        const pendingLoser = loser.submit(proposal);
        await loserSink.reached;
        const won = expectCommitted(await winner.submit(proposal));
        loserSink.release();
        const lost = expectCommitted(await pendingLoser);

        expect(lost.replayed).toBe(true);
        expect(lost.receipt).toEqual(won.receipt);
        expect(loserSink.recorder.kinds()).toEqual([
          'requested',
          'validation-started',
          'recovery-reconciled',
        ]);
      });
    }

    it('throws the identifier error when the receipt that appeared is for a different proposal', async () => {
      const storage = makeBackend();
      await seedCorrectionState(storage);
      const loserSink = parkAt('validation-started');
      const loser = engineOver(storage, { sink: loserSink.sink });
      const winner = engineOver(storage);

      const pendingLoser = loser.submit(revise);
      await loserSink.reached;
      expectCommitted(
        await winner.submit({
          ...revise,
          revisions: [
            {
              namespace: NAMESPACE,
              id: 'p1',
              expectedRevision: 1,
              change: { kind: 'revoked', reasonCode: 'a different reason' },
            },
          ],
        }),
      );
      loserSink.release();
      const settled = await Promise.allSettled([pendingLoser]);
      expect(settled[0]?.status).toBe('rejected');
      expect((settled[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'operation-id-conflict',
      });
    });
  });
}
