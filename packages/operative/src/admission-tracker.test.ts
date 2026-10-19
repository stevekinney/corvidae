/**
 * COR-713 — the tracker folds every admission's `closed()` answer into the run's. A definite
 * failure stays a failure, with its error; only an outcome that did not resolve is `unresolved`.
 */
import { describe, expect, it } from 'bun:test';

import { createAdmissionTracker } from './admission-tracker';
import type { GeneratedMediaAdmission } from './generated-media';
import type { CleanupAcknowledgement } from './types';

function admissionClosing(acknowledgement: CleanupAcknowledgement): GeneratedMediaAdmission {
  return {
    source: { kind: 'managed-asset', assetId: 'asset-1', revision: 1 },
    settled: async () => ({ outcome: 'aborted', reason: 'unused' }),
    abort: () => {},
    closed: async () => acknowledgement,
  };
}

async function foldOf(...answers: CleanupAcknowledgement[]): Promise<CleanupAcknowledgement> {
  const tracker = createAdmissionTracker();
  for (const answer of answers) tracker.track(admissionClosing(answer));
  return tracker.settle();
}

describe('createAdmissionTracker().settle()', () => {
  it('is completed when every admission completed or needed nothing', async () => {
    expect(await foldOf({ status: 'completed' }, { status: 'not-required' })).toEqual({
      status: 'completed',
    });
  });

  it('keeps a failed acknowledgement and its error', async () => {
    const error = new Error('teardown failed');

    const folded = await foldOf({ status: 'completed' }, { status: 'failed', error });

    expect(folded).toEqual({ status: 'failed', error });
  });

  it('prefers a definite failure over an unresolved admission', async () => {
    const error = new Error('teardown failed');

    const folded = await foldOf(
      { status: 'unresolved', reason: 'unknown-effect' },
      { status: 'failed', error },
    );

    expect(folded).toEqual({ status: 'failed', error });
  });

  it('keeps a definite failure when an unresolved admission arrives after it (COR-1581)', async () => {
    const error = new Error('teardown failed');

    const folded = await foldOf(
      { status: 'failed', error },
      { status: 'unresolved', reason: 'unknown-effect' },
    );

    expect(folded).toEqual({ status: 'failed', error });
  });

  it('is unresolved with unknown-effect for an admission that did not resolve', async () => {
    expect(await foldOf({ status: 'unresolved', reason: 'persistence-failed' })).toEqual({
      status: 'unresolved',
      reason: 'unknown-effect',
    });
  });
});
