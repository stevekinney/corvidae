import { describe, expect, it } from 'bun:test';

import {
  appendMessages,
  type ConversationEnvironment,
  createConversationHistory,
  getMessages,
} from '../src/conversation/index';
import { createProjection } from '../src/projection';
import type { ConversationHistory } from '../src/types';

const createTestEnvironment = (): Partial<ConversationEnvironment> => {
  let counter = 0;
  return {
    now: () => '2026-01-01T00:00:00.000Z',
    randomId: () => `projection-test-${++counter}`,
  };
};

const createSeed = (): ConversationHistory =>
  createConversationHistory({ id: 'projection-test' }, createTestEnvironment());

const messageContents = (conversation: ConversationHistory): string[] =>
  getMessages(conversation).map((message) => {
    if (typeof message.content !== 'string')
      throw new Error(`Expected text content for ${message.id}`);
    return message.content;
  });

describe('projection refolding and state', () => {
  it('allows undefined initial state to transition and resets it on divergence', () => {
    const observed: Array<number | undefined> = [];
    const projection = createProjection<number, number | undefined>({
      seed: createSeed(),
      initialState: undefined,
      identify: (event) => event,
      reduce({ conversation, state }) {
        observed.push(state);
        return { conversation, state: (state ?? 0) + 1 };
      },
    });
    projection.apply([1]);
    projection.apply([1, 2]);
    projection.apply([3]);
    expect(observed).toEqual([undefined, 1, undefined]);
    expect(projection.processedCount).toBe(1);
  });

  it('creates function-valued state through a factory on construction and reset', () => {
    let creations = 0;
    const observed: number[] = [];
    const projection = createProjection<number, () => number>({
      seed: createSeed(),
      initialState: () => {
        const generation = ++creations;
        return () => generation;
      },
      identify: (event) => event,
      reduce({ conversation, state }) {
        observed.push(state());
        return { conversation, state };
      },
    });
    projection.apply([1]);
    projection.reset();
    projection.apply([1]);
    expect(observed).toEqual([1, 2]);
    expect(creations).toBe(2);
  });

  it('uses log keys to refold independent logs with colliding event identities', () => {
    let reducerCalls = 0;
    const environment = createTestEnvironment();
    const projection = createProjection<{ id: string; content: string }>({
      seed: createSeed(),
      identify: (event) => event.id,
      reduce({ conversation, event }) {
        reducerCalls += 1;
        return appendMessages(conversation, { role: 'user', content: event.content }, environment);
      },
    });

    projection.apply(
      [
        { id: '1', content: 'First session message' },
        { id: '2', content: 'First session tail' },
      ],
      { logKey: 'session-a' },
    );
    projection.apply(
      [
        { id: '1', content: 'Second session message' },
        { id: '2', content: 'Second session tail' },
        { id: '3', content: 'Second session extension' },
      ],
      { logKey: 'session-b' },
    );

    expect(reducerCalls).toBe(5);
    expect(messageContents(projection.snapshot())).toEqual([
      'Second session message',
      'Second session tail',
      'Second session extension',
    ]);
  });

  it('creates fresh object state when divergent logs refold from the seed', () => {
    const environment = createTestEnvironment();
    const projection = createProjection<{ id: string; content: string }, { count: number }>({
      seed: createSeed(),
      initialState: { count: 0 },
      identify: (event) => event.id,
      reduce({ conversation, event, state }) {
        state.count += 1;
        return {
          conversation: appendMessages(
            conversation,
            { role: 'user', content: `${event.content}:${state.count}` },
            environment,
          ),
          state,
        };
      },
    });

    projection.apply([{ id: '1', content: 'Original' }]);
    projection.apply([{ id: '2', content: 'Refolded' }]);

    expect(messageContents(projection.snapshot())).toEqual(['Refolded:1']);
  });

  it('throws when a stateful reducer returns conversation without state', () => {
    const projection = createProjection<{ id: string }, { count: number }>({
      seed: createSeed(),
      initialState: { count: 0 },
      identify: (event) => event.id,
      reduce({ conversation }) {
        return { ...conversation, conversation };
      },
    });

    expect(() => projection.apply([{ id: '1' }])).toThrow(
      'Projection reducer returned a conversation without state.',
    );
  });
});
