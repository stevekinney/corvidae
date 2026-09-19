/**
 * COR-581 — the effective-context epoch.
 *
 * Pure and synchronous: no sleeps, no timers, no provider call. Epoch ids
 * are injected so every assertion names the exact chain it is about.
 */
import { Conversation } from '@corvidae/conversationalist';
import { describe, expect, it } from 'bun:test';

import {
  createContextEpochSealer,
  digestText,
  epochSourcesUnchanged,
  sealContextEpoch,
} from './context-epoch.ts';
import type { SteeringDesiredState } from './durable/types.ts';

function conversationWith(messages: ReadonlyArray<[role: 'user' | 'assistant', text: string]>) {
  const conversation = new Conversation();
  for (const [role, text] of messages) {
    if (role === 'user') conversation.appendUserMessage(text);
    else conversation.appendAssistantMessage(text);
  }
  return conversation;
}

function sequentialEpochIds(): () => string {
  let counter = 0;
  return () => `epoch-${++counter}`;
}

const CONSUMER = { runId: 'run-1', step: 0, attempt: 0 } as const;

describe('digestText', () => {
  it('is stable for identical input and differs for different input', () => {
    expect(digestText('hello')).toBe(digestText('hello'));
    expect(digestText('hello')).not.toBe(digestText('hellp'));
  });

  it('renders a fixed-width hex string', () => {
    expect(digestText('')).toMatch(/^[0-9a-f]{16}$/);
    expect(digestText('a much longer input string')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('sealContextEpoch', () => {
  it('records an unconfigured source as absent-by-composition, not excluded', () => {
    // The distinction is load-bearing: without it, a `required` source
    // would fail every step of every plain `createAgent` agent, which has
    // no Bureau, no policy configuration and no catalog.
    const epoch = sealContextEpoch({
      epochId: 'epoch-1',
      conversation: conversationWith([['user', 'hi']]),
      consumer: CONSUMER,
    });

    const plan = epoch.sources.find((source) => source.sourceId === 'selection-plan');
    expect(plan?.disposition.kind).toBe('absent-by-composition');
    const hooks = epoch.sources.find((source) => source.sourceId === 'hook-plan');
    expect(hooks?.disposition.kind).toBe('absent-by-composition');
  });

  it('declares the conversation as per-message trust, not one scalar tier', () => {
    // A transcript carries operator messages, agent turns and tool results
    // with different provenance; one tier for all three would erase the
    // distinction the epoch exists to preserve.
    const epoch = sealContextEpoch({
      epochId: 'epoch-1',
      conversation: conversationWith([
        ['user', 'hi'],
        ['assistant', 'hello'],
      ]),
      consumer: CONSUMER,
    });

    const conversation = epoch.sources.find((source) => source.sourceId === 'conversation');
    expect(conversation?.trust).toBe('per-message');
    expect(conversation?.redaction).toBe('reference-only');
    // The vector separates operator-authored from agent-authored turns.
    expect(conversation?.digest).toBe('operator=1,agent=1,retrieved=0');
  });

  it('records the steering configVersion without redacting it', () => {
    const steering: SteeringDesiredState = { paused: false, configVersion: 7, model: 'm' };
    const epoch = sealContextEpoch({
      epochId: 'epoch-1',
      conversation: conversationWith([['user', 'hi']]),
      steering,
      consumer: CONSUMER,
    });

    expect(epoch.configVersion).toBe(7);
    const source = epoch.sources.find((entry) => entry.sourceId === 'steering-desired');
    expect(source?.redaction).toBe('none');
    expect(source?.revision).toBe(7);
  });

  it('digests the toolbox as a set, so reordering the same tools is not a change', () => {
    const base = {
      conversation: conversationWith([['user', 'hi']] as const),
      consumer: CONSUMER,
    };
    const forward = sealContextEpoch({ ...base, epochId: 'a', toolNames: ['alpha', 'beta'] });
    const reversed = sealContextEpoch({ ...base, epochId: 'b', toolNames: ['beta', 'alpha'] });

    const digestOf = (epoch: typeof forward) =>
      epoch.sources.find((source) => source.sourceId === 'toolbox')?.digest;
    expect(digestOf(forward)).toBe(digestOf(reversed));
  });

  it('carries the consumer triple including the attempt index', () => {
    const epoch = sealContextEpoch({
      epochId: 'epoch-1',
      conversation: conversationWith([['user', 'hi']]),
      consumer: { runId: 'run-9', step: 3, attempt: 2 },
    });

    expect(epoch.firstConsumedBy).toEqual({ runId: 'run-9', step: 3, attempt: 2 });
  });
});

describe('createContextEpochSealer', () => {
  it('mints a fresh epoch when the conversation moved, chaining supersedes', () => {
    const sealer = createContextEpochSealer({ newEpochId: sequentialEpochIds() });
    const conversation = conversationWith([['user', 'hi']]);

    const first = sealer.seal({ conversation, consumer: { runId: 'r', step: 0, attempt: 0 } });
    conversation.appendAssistantMessage('hello');
    const second = sealer.seal({ conversation, consumer: { runId: 'r', step: 1, attempt: 0 } });

    expect(first.epochId).toBe('epoch-1');
    expect(first.supersedes).toBeUndefined();
    expect(second.epochId).toBe('epoch-2');
    expect(second.supersedes).toBe('epoch-1');
  });

  it('reuses the epoch across a retry attempt where nothing changed', () => {
    // Reuse is the permitted optimization the contract describes: a retry
    // attempt whose sources are all unchanged consumes the same epoch.
    const sealer = createContextEpochSealer({ newEpochId: sequentialEpochIds() });
    const conversation = conversationWith([['user', 'hi']]);

    const attemptZero = sealer.seal({
      conversation,
      consumer: { runId: 'r', step: 0, attempt: 0 },
    });
    const attemptOne = sealer.seal({ conversation, consumer: { runId: 'r', step: 0, attempt: 1 } });

    expect(attemptOne.epochId).toBe(attemptZero.epochId);
    // `firstConsumedBy` names the FIRST turn that consumed it, and the
    // retry is not that turn — the field is write-once.
    expect(attemptOne.firstConsumedBy.attempt).toBe(0);
  });

  it('mints a successor when a guardrail rewrites the transcript between attempts', () => {
    // The case sealing per attempt exists for: an input guardrail's
    // `sanitize` action rewrites the last user message in place, so
    // attempt 1 genuinely sees different context than attempt 0.
    const sealer = createContextEpochSealer({ newEpochId: sequentialEpochIds() });
    const conversation = conversationWith([['user', 'my secret is hunter2']]);

    const before = sealer.seal({ conversation, consumer: { runId: 'r', step: 0, attempt: 0 } });
    conversation.redactMessageAtPosition(0, 'my secret is [redacted]');
    const after = sealer.seal({ conversation, consumer: { runId: 'r', step: 0, attempt: 1 } });

    expect(after.epochId).not.toBe(before.epochId);
    expect(after.supersedes).toBe(before.epochId);
    expect(after.firstConsumedBy.attempt).toBe(1);
  });

  it('mints a successor when the hook plan revision moves', () => {
    let revision = 1;
    const sealer = createContextEpochSealer({
      newEpochId: sequentialEpochIds(),
      hookPlanRevision: () => revision,
    });
    const conversation = conversationWith([['user', 'hi']]);

    const before = sealer.seal({ conversation, consumer: { runId: 'r', step: 0, attempt: 0 } });
    revision = 2;
    const after = sealer.seal({ conversation, consumer: { runId: 'r', step: 0, attempt: 1 } });

    expect(after.epochId).not.toBe(before.epochId);
    expect(after.supersedes).toBe(before.epochId);
  });

  it('exposes the most recently sealed epoch through current()', () => {
    const sealer = createContextEpochSealer({ newEpochId: sequentialEpochIds() });
    expect(sealer.current()).toBeUndefined();

    const sealed = sealer.seal({
      conversation: conversationWith([['user', 'hi']]),
      consumer: CONSUMER,
    });
    expect(sealer.current()?.epochId).toBe(sealed.epochId);
  });
});

describe('epochSourcesUnchanged', () => {
  it('ignores epochId and firstConsumedBy when comparing', () => {
    const conversation = conversationWith([['user', 'hi']]);
    const a = sealContextEpoch({
      epochId: 'a',
      conversation,
      consumer: { runId: 'r', step: 0, attempt: 0 },
    });
    const b = sealContextEpoch({
      epochId: 'b',
      conversation,
      consumer: { runId: 'other', step: 9, attempt: 4 },
    });

    expect(epochSourcesUnchanged(a, b)).toBe(true);
  });

  it('reports a change when the rendered baseline moved', () => {
    const a = sealContextEpoch({
      epochId: 'a',
      conversation: conversationWith([['user', 'hi']]),
      consumer: CONSUMER,
    });
    const b = sealContextEpoch({
      epochId: 'b',
      conversation: conversationWith([['user', 'different']]),
      consumer: CONSUMER,
    });

    expect(epochSourcesUnchanged(a, b)).toBe(false);
  });
});

describe('provider-retry mutation (COR-581 gap closure)', () => {
  it('seals a successor epoch when a retry mutator changes the request', async () => {
    // The gap this closes: `callGenerateWithRetry` can issue several real
    // generate() calls under one seal, and a RetryMutator can change the
    // request between them. Those mutations used to be invisible to the
    // epoch, so the recorded context described something the model was
    // never sent on the retried attempt.
    const { callGenerateWithRetry } = await import('./run-step-utilities.ts');
    const { createDefaultRuntimeServices } = await import('@corvidae/lifecycle');

    const conversation = conversationWith([['user', 'original']]);
    const sealer = createContextEpochSealer({ newEpochId: sequentialEpochIds() });
    const sealed: string[] = [];

    let calls = 0;
    const generate = async (context: { conversation: Conversation }) => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return { content: context.conversation.getMessages().length.toString(), toolCalls: [] };
    };

    await callGenerateWithRetry(
      generate as never,
      { conversation, step: 0, toolbox: { tools: () => [] } } as never,
      {
        attempts: 2,
        delay: 0,
        mutate: (context: { conversation: Conversation }) => {
          context.conversation.appendUserMessage('mutated in');
          return context as never;
        },
      } as never,
      undefined,
      createDefaultRuntimeServices(),
      (mutatedContext, attempt) => {
        const epoch = sealer.seal({
          conversation: mutatedContext.conversation,
          consumer: { runId: 'r', step: 0, attempt },
        });
        sealed.push(epoch.epochId);
        return epoch.epochId;
      },
    );

    // The mutator ran once, so exactly one successor epoch was sealed.
    expect(sealed).toEqual(['epoch-1']);
    expect(calls).toBe(2);
  });

  it('seals nothing when a retry is not mutated', async () => {
    // An unmutated retry re-issues the identical request and correctly
    // consumes the epoch sealed before `generate.started`. Minting a
    // successor would claim a context change that did not happen.
    const { callGenerateWithRetry } = await import('./run-step-utilities.ts');
    const { createDefaultRuntimeServices } = await import('@corvidae/lifecycle');

    const conversation = conversationWith([['user', 'original']]);
    const sealed: string[] = [];
    let calls = 0;
    const generate = async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return { content: 'ok', toolCalls: [] };
    };

    await callGenerateWithRetry(
      generate as never,
      { conversation, step: 0, toolbox: { tools: () => [] } } as never,
      { attempts: 2, delay: 0 } as never,
      undefined,
      createDefaultRuntimeServices(),
      () => {
        sealed.push('should-not-happen');
        return 'x';
      },
    );

    expect(sealed).toEqual([]);
    expect(calls).toBe(2);
  });
});
