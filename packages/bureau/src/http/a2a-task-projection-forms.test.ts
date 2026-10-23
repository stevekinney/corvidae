/**
 * COR-1487 — each human wait's form is its own A2UI surface, and a repeated wait on a signal closes
 * the surface of the park before it.
 */
import { describe, expect, it } from 'bun:test';

import type { TaskView } from '../task-registry.ts';
import { withPreviousForms } from './a2a-input-forms.ts';
import { waitingMessage } from './a2a-task-projection.ts';
import { eventsOf } from './a2a-task-stream.ts';

const schema = { type: 'object', properties: { a: { type: 'string' } } };
const viewOf = (reviewId: string) =>
  ({
    id: 'run-1',
    contextId: 'context-1',
    status: 'input-required',
    updatedAt: 'now',
    openWaits: [{ kind: 'human-wait', reviewId, signalName: 'deploy' }],
  }) as unknown as TaskView;

function messagesOf(reviewId: string, previousReviewId?: string): Record<string, any>[] {
  const message = waitingMessage(
    viewOf(reviewId),
    [{ reviewId, signalName: 'deploy', prompt: 'Where?', inputSchema: schema, previousReviewId }],
    true,
  );
  const part = message.parts.find((candidate) => candidate.content?.$case === 'data');
  return part?.content?.$case === 'data' ? (part.content.value as Record<string, any>[]) : [];
}

describe('waitingMessage form surfaces', () => {
  it('opens the first park of a signal without deleting anything', () => {
    const messages = messagesOf('human-wait:run-1:deploy:0');

    expect(messages.map((entry) => Object.keys(entry).find((key) => key !== 'version'))).toEqual([
      'createSurface',
      'updateComponents',
    ]);
    expect(messages[0]?.['createSurface'].surfaceId).toBe('input-form:human-wait:run-1:deploy:0');
  });

  it('gives a second wait on the same signal a new surface and closes the first', () => {
    const messages = messagesOf('human-wait:run-1:deploy:1', 'human-wait:run-1:deploy:0');

    expect(messages[0]).toEqual({
      version: 'v0.9',
      deleteSurface: { surfaceId: 'input-form:human-wait:run-1:deploy:0' },
    });
    expect(messages[1]?.['createSurface'].surfaceId).toBe('input-form:human-wait:run-1:deploy:1');
    expect(messages[2]?.['updateComponents'].surfaceId).toBe(
      'input-form:human-wait:run-1:deploy:1',
    );
  });

  it('closes the previous review’s surface, whatever signal it waited on', () => {
    const messages = messagesOf('human-wait:run-1:region:1', 'human-wait:run-1:deploy:0');

    expect(messages[0]?.['deleteSurface'].surfaceId).toBe('input-form:human-wait:run-1:deploy:0');
  });

  it('sends the prompt without form parts to a request that did not activate A2UI', () => {
    const reviewId = 'human-wait:run-1:deploy:0';
    const message = waitingMessage(viewOf(reviewId), [
      { reviewId, signalName: 'deploy', prompt: 'Where?', inputSchema: schema },
    ]);

    expect(message.parts).toHaveLength(1);
    expect(message.parts[0]?.content?.$case).toBe('text');
  });
});

describe('the previous form of a run (COR-1674)', () => {
  // The audit record of a closed wait, as `buildReviewDecisionAuditRecord` writes it: the review
  // without its schema, and an `inputForm` marker. `getReview` returns a resolved review with no
  // schema too, so only the marker can say the wait showed a form.
  const record = (id: string, inputForm: boolean) => ({
    type: 'review.human-wait.approved',
    detail: { review: { kind: 'human-wait', id }, ...(inputForm ? { inputForm: true } : {}) },
  });
  const bureau = {
    getReview: async () => undefined,
    auditTrail: {
      query: async () => [
        record('human-wait:run-1:deploy:0', true),
        record('human-wait:run-1:note:1', false),
      ],
    },
  } as never;
  const form = {
    reviewId: 'human-wait:run-1:region:2',
    signalName: 'region',
    prompt: undefined,
    inputSchema: schema,
  } as never;

  it('is the closed wait that showed a form, whatever signal it waited on', async () => {
    const [named] = await withPreviousForms(bureau, viewOf('human-wait:run-1:region:2'), [form]);

    expect(named?.previousReviewId).toBe('human-wait:run-1:deploy:0');
  });
});

describe('a stream status that asks for input', () => {
  const element = {
    kind: 'task.status',
    taskId: 'run-1',
    cursor: '',
    emittedAtMs: 0,
    status: 'input-required',
    finishReason: null,
    message: null,
    artifact: null,
  } as never;
  const reviewId = 'human-wait:run-1:deploy:0';
  const forms = [{ reviewId, signalName: 'deploy', prompt: 'Where?', inputSchema: schema }];
  const partsOf = (a2ui: boolean) => {
    const [response] = eventsOf(viewOf(reviewId), element, undefined, forms, a2ui);
    return response?.payload?.$case === 'statusUpdate'
      ? (response.payload.value.status?.message?.parts ?? [])
      : [];
  };

  it('carries the form when the request activated A2UI', () => {
    expect(partsOf(true).map((part) => part.content?.$case)).toEqual(['text', 'data']);
  });

  it('is the prompt text alone when it did not', () => {
    expect(partsOf(false).map((part) => part.content?.$case)).toEqual(['text']);
  });
});
