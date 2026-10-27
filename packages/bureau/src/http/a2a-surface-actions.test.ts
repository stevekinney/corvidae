/**
 * COR-837 — how an admitted A2UI action becomes the answer to a wait: a review's value rides as
 * `data`, and an approval's round must still be the one the surface was declared for.
 */
import { Message } from '@a2a-js/sdk';
import { describe, expect, it } from 'bun:test';

import { A2UI_EXTENSION_URI } from '../a2ui/catalogs.ts';
import type { TaskView } from '../task-registry.ts';
import { surfaceActionOf } from './a2a-surface-actions.ts';

function harness(options: {
  continuation: Record<string, unknown>;
  intent: string;
  value: unknown;
  waits: unknown[];
  reviewRound?: number;
}) {
  const declared = { name: 'go', intent: options.intent, continuation: options.continuation };
  const bureau = {
    surfaces: {
      snapshot: async () => ({
        outcome: 'found',
        surface: { kind: 'a2ui', revision: 1, actions: [declared] },
      }),
      act: async () => ({
        outcome: 'accepted',
        continuation: options.continuation,
        intent: options.intent,
        value: options.value,
      }),
    },
    reviews: { get: async () => ({ kind: 'tool-approval', round: options.reviewRound ?? 0 }) },
  };
  const message = Message.fromJSON({
    messageId: 'm1',
    taskId: 't1',
    role: 'ROLE_USER',
    parts: [
      {
        data: [
          {
            version: 'v0.9.1',
            action: {
              name: 'go',
              surfaceId: 's',
              sourceComponentId: 'b',
              timestamp: '2026-10-23T12:00:00.000Z',
              context: {},
            },
          },
        ],
      },
    ],
  });
  const view = { id: 't1', owner: 'o', status: 'input-required', openWaits: options.waits };
  return surfaceActionOf({
    bureau: bureau as never,
    message,
    view: view as unknown as TaskView,
    activated: new Set([A2UI_EXTENSION_URI]),
  });
}

describe('a surface action continuing a review', () => {
  it('delivers the admitted structured value as data to a human wait', async () => {
    const result = await harness({
      continuation: { type: 'review', reviewId: 'r1' },
      intent: 'submit',
      value: { choice: 'a' },
      waits: [{ kind: 'human-wait', reviewId: 'r1', signalName: 'go' }],
    });
    expect(result).toMatchObject({ ok: true, input: { signalName: 'go', data: { choice: 'a' } } });
    expect((result as { input: object }).input).not.toHaveProperty('answer');
  });

  it('falls back to the action name for a valueless action', async () => {
    const result = await harness({
      continuation: { type: 'review', reviewId: 'r1' },
      intent: 'submit',
      value: {},
      waits: [{ kind: 'human-wait', reviewId: 'r1', signalName: 'go' }],
    });
    expect(result).toMatchObject({ ok: true, input: { signalName: 'go', answer: 'go' } });
  });

  it('refuses an approval surface declared for a round the review has moved past', async () => {
    const result = await harness({
      continuation: { type: 'review', reviewId: 'r1', round: 0 },
      intent: 'approve',
      value: {},
      waits: [{ kind: 'tool-approval', reviewId: 'r1', callId: 'c1' }],
      reviewRound: 1,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain('stale-round');
  });

  it('decides an approval whose round is still current', async () => {
    const result = await harness({
      continuation: { type: 'review', reviewId: 'r1', round: 1 },
      intent: 'approve',
      value: {},
      waits: [{ kind: 'tool-approval', reviewId: 'r1', callId: 'c1' }],
      reviewRound: 1,
    });
    expect(result).toMatchObject({ ok: true, input: { callId: 'c1', decision: 'approve' } });
  });
});
