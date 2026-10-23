/**
 * COR-1487 — each human wait's form is its own A2UI surface, and a repeated wait on a signal closes
 * the surface of the park before it.
 */
import { describe, expect, it } from 'bun:test';

import type { TaskView } from '../task-registry.ts';
import { waitingMessage } from './a2a-task-projection.ts';

const schema = { type: 'object', properties: { a: { type: 'string' } } };
const viewOf = (reviewId: string) =>
  ({
    id: 'run-1',
    contextId: 'context-1',
    status: 'input-required',
    updatedAt: 'now',
    openWaits: [{ kind: 'human-wait', reviewId, signalName: 'deploy' }],
  }) as unknown as TaskView;

function messagesOf(reviewId: string): Record<string, any>[] {
  const message = waitingMessage(viewOf(reviewId), [
    { reviewId, signalName: 'deploy', prompt: 'Where?', inputSchema: schema },
  ]);
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
    const messages = messagesOf('human-wait:run-1:deploy:1');

    expect(messages[0]).toEqual({
      version: 'v0.9',
      deleteSurface: { surfaceId: 'input-form:human-wait:run-1:deploy:0' },
    });
    expect(messages[1]?.['createSurface'].surfaceId).toBe('input-form:human-wait:run-1:deploy:1');
    expect(messages[2]?.['updateComponents'].surfaceId).toBe(
      'input-form:human-wait:run-1:deploy:1',
    );
  });
});
