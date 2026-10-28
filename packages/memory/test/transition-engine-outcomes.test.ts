import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import {
  EvidenceImmutableError,
  EvidenceProjectionBatchLimitError,
  EvidenceProjectionCapacityError,
  EvidenceProjectionCommitError,
  ProjectionRevisionConflictError,
} from '../src/evidence-projection-storage';
import { MemoryEvidenceValidationError } from '../src/evidence-schema';
import {
  createTransitionEngine,
  TransitionIdentifierConflictError,
} from '../src/transition-engine';
import type {
  TransitionConflictReason,
  TransitionRejectionReason,
} from '../src/transition-outcome';
import { MemoryTransitionProposalError } from '../src/transition-proposal';
import { makeInlineEvidence } from './evidence-projection-fixtures';
import { failFirstBatch, TRANSITION_BACKENDS } from './transition-backends';
import {
  appendProposal,
  correctionProposal,
  createHarness,
  expectCommitted,
  expectRefused,
  makeWriteAuthority,
  NAMESPACE,
  seedCorrectionState,
  storageFailingWith,
  TENANT,
} from './transition-test-support';

/**
 * Every row of the outcome table, produced from its source on both backends,
 * with the event sequence each outcome emits.
 */

const e1 = makeInlineEvidence('e1');

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`outcome table (${label})`, () => {
    describe('committed', () => {
      it('emits requested, validation-started, committed, then one superseded per superseded record', async () => {
        const harness = createHarness(makeBackend);
        await seedCorrectionState(harness.storage);
        expectCommitted(await harness.engine.submit(correctionProposal('operation-1')));
        expect(harness.recorder.kinds()).toEqual([
          'requested',
          'validation-started',
          'committed',
          'superseded',
          'superseded',
        ]);
        const [requested, , committed, evidenceSuperseded, projectionSuperseded] =
          harness.recorder.events;
        expect(requested).toMatchObject({
          kind: 'requested',
          sources: [
            { kind: 'evidence', id: 'e2' },
            { kind: 'evidence', id: 'e1' },
            { kind: 'projection', namespace: NAMESPACE, id: 'p2', revision: 1 },
            { kind: 'projection', namespace: NAMESPACE, id: 'p1', revision: 1 },
          ],
        });
        expect(committed).toMatchObject({
          kind: 'committed',
          evidence: [{ kind: 'evidence', id: 'e2' }],
          projections: [
            { kind: 'projection', id: 'p2', revision: 1 },
            { kind: 'projection', id: 'p1', revision: 2 },
          ],
        });
        expect(evidenceSuperseded).toMatchObject({
          kind: 'superseded',
          subject: { kind: 'evidence', id: 'e1', digest: e1.digest },
          successor: { kind: 'evidence', id: 'e2' },
        });
        expect(projectionSuperseded).toMatchObject({
          kind: 'superseded',
          subject: { kind: 'projection', id: 'p1', revision: 1 },
          successor: { kind: 'projection', id: 'p2', revision: 1 },
        });
      });

      it('carries the operation id as the causal identifier on every event', async () => {
        const harness = createHarness(makeBackend);
        await seedCorrectionState(harness.storage);
        expectCommitted(await harness.engine.submit(correctionProposal('operation-7')));
        expect(harness.recorder.events.length).toBeGreaterThan(0);
        for (const event of harness.recorder.events) {
          expect(event.operationId).toBe('operation-7');
          expect(event.tenantId).toBe(TENANT);
          expect(event.proposalKind).toBe('correct-evidence');
          expect(event.principal).toEqual({ kind: 'user', id: 'user-1' });
        }
      });

      it('reads the clock twice for a commit and once for a replay', async () => {
        const harness = createHarness(makeBackend);
        expectCommitted(await harness.engine.submit(appendProposal('operation-1')));
        expect(harness.clock.reads).toBe(2);
        expectCommitted(await harness.engine.submit(appendProposal('operation-1')));
        expect(harness.clock.reads).toBe(3);
      });

      it('puts no source content in any event', async () => {
        const harness = createHarness(makeBackend);
        await seedCorrectionState(harness.storage);
        expectCommitted(await harness.engine.submit(correctionProposal('operation-1')));
        // The recorder parses every event with the strict schema, so an extra key already failed.
        const serialized = JSON.stringify(harness.recorder.events);
        expect(serialized).not.toContain('Evidence text for');
        expect(serialized).not.toContain('Statement of');
      });
    });

    describe('rejected', () => {
      it('emits requested, validation-started, rejected for a validator refusal', async () => {
        const harness = createHarness(makeBackend);
        const result = await harness.engine.submit(
          appendProposal(
            'operation-1',
            ['e1'],
            makeWriteAuthority({ capabilities: ['memory:search'] }),
          ),
        );
        expect(result.outcome).toBe('rejected');
        expect(harness.recorder.kinds()).toEqual(['requested', 'validation-started', 'rejected']);
        expect(harness.recorder.events[2]).toMatchObject({
          kind: 'rejected',
          reason: 'unauthorized',
        });
      });

      const commitErrors: ReadonlyArray<
        readonly [string, () => unknown, TransitionRejectionReason]
      > = [
        [
          'EvidenceProjectionCommitError invalid-commit',
          () => new EvidenceProjectionCommitError('invalid-commit', 'store says no'),
          'invalid-commit',
        ],
        [
          'EvidenceProjectionCommitError evidence-not-found',
          () => new EvidenceProjectionCommitError('evidence-not-found', 'store says no'),
          'evidence-not-found',
        ],
        [
          'EvidenceProjectionCommitError projection-not-found',
          () => new EvidenceProjectionCommitError('projection-not-found', 'store says no'),
          'projection-not-found',
        ],
        [
          'MemoryEvidenceValidationError',
          () => new MemoryEvidenceValidationError('digest-mismatch', 'evidence', 'bad digest'),
          'digest-mismatch',
        ],
        [
          'EvidenceProjectionBatchLimitError',
          () => new EvidenceProjectionBatchLimitError('operations', 10_001, 10_000),
          'batch-limit',
        ],
        [
          'EvidenceProjectionCapacityError',
          () => new EvidenceProjectionCapacityError('maxEvidence'),
          'capacity',
        ],
      ];
      it.each(commitErrors)(
        'maps %s to rejected with the store code',
        async (_name, makeError, reason) => {
          const harness = createHarness(makeBackend);
          const failing = createHarness(makeBackend, {
            storage: storageFailingWith(harness.storage, makeError()),
            clock: harness.clock,
            recorder: harness.recorder,
          });
          const result = expectRefused(
            await failing.engine.submit(appendProposal('operation-1')),
            'rejected',
          );
          expect(result.reason).toBe(reason);
          expect(harness.recorder.kinds()).toEqual(['requested', 'validation-started', 'rejected']);
          expect(harness.recorder.events[2]).toMatchObject({ kind: 'rejected', reason });
          expect(await harness.engine.getReceipt(TENANT, 'operation-1')).toBeUndefined();
        },
      );

      it('produces batch-limit from a real commit past the batch cap', async () => {
        const harness = createHarness(makeBackend);
        const ids = Array.from({ length: 10_000 }, (_, index) => `bulk-${index}`);
        const result = expectRefused(
          await harness.engine.submit(appendProposal('operation-1', ids)),
          'rejected',
        );
        expect(result.reason).toBe('batch-limit');
        expect(await harness.storage.getEvidence(TENANT, 'bulk-0')).toBeUndefined();
      });
    });

    describe('conflicted', () => {
      it('conflicts, without mutating, on a stale expected revision found before the commit', async () => {
        const harness = createHarness(makeBackend);
        await seedCorrectionState(harness.storage);
        const stale = {
          kind: 'revise-projection' as const,
          operationId: 'operation-1',
          tenantId: TENANT,
          authority: makeWriteAuthority(),
          revisions: [
            {
              namespace: NAMESPACE,
              id: 'p1',
              expectedRevision: 2,
              change: { kind: 'revoked' as const, reasonCode: 'withdrawn' },
            },
          ],
        };
        const before = await harness.storage.getProjection(TENANT, NAMESPACE, 'p1');
        const result = expectRefused(await harness.engine.submit(stale), 'conflicted');
        expect(result.reason).toBe('stale-revision');
        expect(result.detail).toContain('p1');
        expect(harness.recorder.kinds()).toEqual(['requested', 'validation-started', 'conflicted']);
        expect(await harness.storage.getProjection(TENANT, NAMESPACE, 'p1')).toEqual(before);
        expect(await harness.engine.getReceipt(TENANT, 'operation-1')).toBeUndefined();
      });

      it('conflicts on a revision of a projection that does not exist', async () => {
        const harness = createHarness(makeBackend);
        const result = expectRefused(
          await harness.engine.submit({
            kind: 'revise-projection',
            operationId: 'operation-1',
            tenantId: TENANT,
            authority: makeWriteAuthority(),
            revisions: [
              {
                namespace: NAMESPACE,
                id: 'ghost',
                expectedRevision: 1,
                change: { kind: 'revoked', reasonCode: 'withdrawn' },
              },
            ],
          }),
          'conflicted',
        );
        expect(result.reason).toBe('stale-revision');
      });

      const storeConflicts: ReadonlyArray<readonly [string, unknown, TransitionConflictReason]> = [
        [
          'ProjectionRevisionConflictError',
          new ProjectionRevisionConflictError(TENANT, NAMESPACE, ['p1']),
          'revision-conflict',
        ],
        [
          'EvidenceProjectionCommitError evidence-superseded',
          new EvidenceProjectionCommitError('evidence-superseded', 'superseded'),
          'evidence-superseded',
        ],
        [
          'EvidenceProjectionCommitError projection-terminal',
          new EvidenceProjectionCommitError('projection-terminal', 'terminal'),
          'projection-terminal',
        ],
        ['EvidenceImmutableError', new EvidenceImmutableError(TENANT, 'e1'), 'evidence-immutable'],
      ];
      it.each(storeConflicts)(
        'maps %s to conflicted, whatever attempt raised it',
        async (_name, error, reason) => {
          const harness = createHarness(makeBackend);
          const failing = createHarness(makeBackend, {
            storage: storageFailingWith(harness.storage, error),
            clock: harness.clock,
            recorder: harness.recorder,
          });
          const result = expectRefused(
            await failing.engine.submit(appendProposal('operation-1')),
            'conflicted',
          );
          expect(result.reason).toBe(reason);
          expect(harness.recorder.kinds()).toEqual([
            'requested',
            'validation-started',
            'conflicted',
          ]);
        },
      );

      it('produces evidence-immutable from a stored record the proposal would rewrite', async () => {
        const harness = createHarness(makeBackend);
        // The stored e1 was written at a fixture instant; the engine would stamp it with the clock.
        await harness.storage.appendEvidence(e1);
        const result = expectRefused(
          await harness.engine.submit(appendProposal('operation-1')),
          'conflicted',
        );
        expect(result.reason).toBe('evidence-immutable');
      });

      it('produces projection-terminal from a revision of an already superseded projection', async () => {
        const harness = createHarness(makeBackend);
        await seedCorrectionState(harness.storage);
        expectCommitted(await harness.engine.submit(correctionProposal('operation-1')));
        harness.recorder.clear();
        const result = expectRefused(
          await harness.engine.submit({
            kind: 'revise-projection',
            operationId: 'operation-2',
            tenantId: TENANT,
            authority: makeWriteAuthority(),
            revisions: [
              {
                namespace: NAMESPACE,
                id: 'p1',
                expectedRevision: 2,
                change: { kind: 'revoked', reasonCode: 'withdrawn' },
              },
            ],
          }),
          'conflicted',
        );
        expect(result.reason).toBe('projection-terminal');
      });

      it('produces evidence-superseded when the predecessor is superseded after validation', async () => {
        const harness = createHarness(makeBackend, {
          hooks: {
            beforeBatch: async () => {
              await harness.storage.appendEvidence(
                makeInlineEvidence('e9', { supersedes: ['e1'], kind: 'operator' }),
              );
            },
          },
        });
        await seedCorrectionState(harness.storage);
        const result = expectRefused(
          await harness.engine.submit(correctionProposal('operation-1')),
          'conflicted',
        );
        expect(result.reason).toBe('evidence-superseded');
        expect(await harness.storage.getEvidence(TENANT, 'e2')).toBeUndefined();
        expect(await harness.engine.getReceipt(TENANT, 'operation-1')).toBeUndefined();
      });
    });

    describe('canceled', () => {
      it('cancels when aborted before the batch, after requested and validation-started', async () => {
        const controller = new AbortController();
        const harness = createHarness(makeBackend);
        const aborting = createHarness(makeBackend, {
          storage: harness.storage,
          clock: harness.clock,
          recorder: harness.recorder,
          hooks: { beforeBatch: () => controller.abort() },
        });
        const result = await aborting.engine.submit(appendProposal('operation-1'), {
          signal: controller.signal,
        });
        expect(result).toEqual({ outcome: 'canceled' });
        expect(harness.recorder.kinds()).toEqual(['requested', 'validation-started', 'canceled']);
        expect(await harness.storage.getEvidence(TENANT, 'e1')).toBeUndefined();
        expect(await harness.engine.getReceipt(TENANT, 'operation-1')).toBeUndefined();
      });

      it('cancels a submission that was aborted before it began', async () => {
        const controller = new AbortController();
        controller.abort();
        const harness = createHarness(makeBackend);
        const result = await harness.engine.submit(appendProposal('operation-1'), {
          signal: controller.signal,
        });
        expect(result).toEqual({ outcome: 'canceled' });
        expect(harness.recorder.kinds()).toEqual(['requested', 'canceled']);
        expect(harness.clock.reads).toBe(1);
      });

      it('commits when the abort comes after the batch', async () => {
        const controller = new AbortController();
        const harness = createHarness(makeBackend, {
          hooks: { afterBatch: () => controller.abort() },
        });
        const result = await harness.engine.submit(appendProposal('operation-1'), {
          signal: controller.signal,
        });
        expectCommitted(result);
        expect(await harness.storage.getEvidence(TENANT, 'e1')).toBeDefined();
      });
    });

    describe('unknown', () => {
      it('is unknown when the batch throws before applying, and a retry then commits', async () => {
        const fault = failFirstBatch('before');
        const harness = createHarness(makeBackend, { wrapApply: fault.wrapApply });
        const first = await harness.engine.submit(appendProposal('operation-1'));
        expect(first.outcome).toBe('unknown');
        expect((first as { error: Error }).error.message).toContain('before the batch applied');
        expect(harness.recorder.kinds()).toEqual(['requested', 'validation-started', 'failed']);
        expect(harness.recorder.events[2]).toMatchObject({
          kind: 'failed',
          error: { name: 'Error' },
        });
        expect(await harness.storage.getEvidence(TENANT, 'e1')).toBeUndefined();
        expect(await harness.engine.getReceipt(TENANT, 'operation-1')).toBeUndefined();

        harness.recorder.clear();
        const retry = expectCommitted(await harness.engine.submit(appendProposal('operation-1')));
        expect(retry.replayed).toBe(false);
        expect(harness.recorder.kinds()).toEqual(['requested', 'validation-started', 'committed']);
      });

      it('never puts the error message in a failed event', async () => {
        const fault = failFirstBatch('before');
        const harness = createHarness(makeBackend, { wrapApply: fault.wrapApply });
        await harness.engine.submit(appendProposal('operation-1'));
        expect(JSON.stringify(harness.recorder.events)).not.toContain('injected fault');
      });

      it('reconciles, not unknown, when the batch applies and then throws', async () => {
        const fault = failFirstBatch('after');
        const harness = createHarness(makeBackend, { wrapApply: fault.wrapApply });
        const result = expectCommitted(await harness.engine.submit(appendProposal('operation-1')));
        expect(result.replayed).toBe(true);
        expect(harness.recorder.kinds()).toEqual([
          'requested',
          'validation-started',
          'recovery-reconciled',
        ]);
        expect(harness.recorder.events[2]).toMatchObject({
          kind: 'recovery-reconciled',
          digest: result.receipt.digest,
        });
      });
    });

    describe('existing receipts', () => {
      it('replays a receipt found before validation as requested, recovery-reconciled', async () => {
        const harness = createHarness(makeBackend);
        expectCommitted(await harness.engine.submit(appendProposal('operation-1')));
        harness.recorder.clear();
        const replay = expectCommitted(await harness.engine.submit(appendProposal('operation-1')));
        expect(replay.replayed).toBe(true);
        expect(harness.recorder.kinds()).toEqual(['requested', 'recovery-reconciled']);
      });

      it('throws a typed error for a reused id with a different digest, after requested', async () => {
        const harness = createHarness(makeBackend);
        const first = expectCommitted(await harness.engine.submit(appendProposal('operation-1')));
        harness.recorder.clear();
        const different = appendProposal('operation-1', ['e2']);
        const error = await rejectionOf(harness.engine.submit(different));
        expect(error).toBeInstanceOf(TransitionIdentifierConflictError);
        expect((error as TransitionIdentifierConflictError).storedDigest).toBe(
          first.receipt.digest,
        );
        expect((error as TransitionIdentifierConflictError).code).toBe('operation-id-conflict');
        expect(harness.recorder.kinds()).toEqual(['requested']);
        expect(await harness.storage.getEvidence(TENANT, 'e2')).toBeUndefined();
        expect(await harness.engine.getReceipt(TENANT, 'operation-1')).toEqual(first.receipt);
      });

      it('throws MemoryTransitionProposalError for a malformed proposal, emitting nothing', async () => {
        const harness = createHarness(makeBackend);
        const error = await rejectionOf(
          harness.engine.submit({ ...appendProposal('operation-1'), evidence: [] }),
        );
        expect(error).toBeInstanceOf(MemoryTransitionProposalError);
        expect(harness.recorder.events).toEqual([]);
        expect(harness.clock.reads).toBe(0);
      });
    });

    describe('the event sink', () => {
      it('never changes the outcome or the sequence when it throws', async () => {
        const delivered: string[] = [];
        const harness = createHarness(makeBackend);
        const engine = createTransitionEngine({
          storage: harness.storage,
          now: harness.clock.now,
          sink: (event) => {
            delivered.push(event.kind);
            throw new Error('the sink is down');
          },
        });
        const result = await engine.submit(appendProposal('operation-1'));
        expectCommitted(result);
        expect(delivered).toEqual(['requested', 'validation-started', 'committed']);
        const rejected = await engine.submit(
          appendProposal(
            'operation-2',
            ['e2'],
            makeWriteAuthority({ capabilities: ['memory:search'] }),
          ),
        );
        expect(rejected.outcome).toBe('rejected');
      });

      it('awaits an asynchronous sink in order', async () => {
        const order: string[] = [];
        const harness = createHarness(makeBackend);
        const engine = createTransitionEngine({
          storage: harness.storage,
          now: harness.clock.now,
          sink: async (event) => {
            order.push(`start:${event.kind}`);
            await Promise.resolve();
            order.push(`end:${event.kind}`);
          },
        });
        expectCommitted(await engine.submit(appendProposal('operation-1')));
        expect(order).toEqual([
          'start:requested',
          'end:requested',
          'start:validation-started',
          'end:validation-started',
          'start:committed',
          'end:committed',
        ]);
      });
    });
  });
}
