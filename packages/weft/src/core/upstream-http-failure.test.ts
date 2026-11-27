import { describe, expect, it } from 'bun:test';
import { createCheckpoint, deserializeCheckpoint, serializeCheckpoint } from './checkpoint.ts';
import { failedMessageForError } from './failed-message.ts';
import { errorFromFailedOperationOutcome } from './failure-categories.ts';
import {
  UpstreamHttpError,
  attachUpstreamFailure,
  isUpstreamHttpFailure,
  upstreamFailureOf,
} from './upstream-http-failure.ts';

describe('upstream HTTP failure facts', () => {
  it('accepts only bounded structured values and never infers a fact from a message', () => {
    expect(upstreamFailureOf(new Error('GitHub HTTP 503'))).toBeUndefined();
    expect(isUpstreamHttpFailure({ source: 'github', status: 503, body: 'secret' })).toBe(false);
    expect(isUpstreamHttpFailure({ source: 'github', status: 600 })).toBe(false);
    expect(
      upstreamFailureOf(
        new Error('outer', {
          cause: new UpstreamHttpError({ source: 'github', status: 503 }, 'unavailable'),
        }),
      ),
    ).toEqual({ source: 'github', status: 503 });
    const restored = new Error('reconstructed');
    attachUpstreamFailure(restored, { source: 'github', status: 503 });
    expect(upstreamFailureOf(restored)).toEqual({ source: 'github', status: 503 });
  });

  it('carries the bounded fact through a reconstructed failed operation and worker failure', () => {
    const upstreamFailure = { source: 'github', status: 503 } as const;
    const reconstructed = errorFromFailedOperationOutcome({
      status: 'failed',
      error: 'unavailable',
      upstreamFailure,
    });
    const message = failedMessageForError('run', reconstructed, undefined);
    expect(message.type).toBe('failed');
    if (message.type !== 'failed') throw new Error('expected failure');
    expect(message.upstreamFailure).toEqual(upstreamFailure);
    const checkpoint = {
      ...createCheckpoint('run', '1'),
      workerReplayFailures: [
        [0, { status: 'failed' as const, error: 'unavailable', upstreamFailure }] as [
          number,
          { status: 'failed'; error: string; upstreamFailure: typeof upstreamFailure },
        ],
      ],
    };
    const restored = deserializeCheckpoint(serializeCheckpoint(checkpoint));
    expect(restored.workerReplayFailures?.[0]?.[1].upstreamFailure).toEqual(upstreamFailure);
    expect(
      upstreamFailureOf(errorFromFailedOperationOutcome(restored.workerReplayFailures![0]![1])),
    ).toEqual(upstreamFailure);
  });
});
