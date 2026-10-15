import { describe, expect, it } from 'bun:test';
import {
  Conversation,
  type ConversationSnapshot,
  createConversationHistory,
} from 'conversationalist';

import {
  applyConversationSnapshotDelta,
  type ConversationSnapshotDelta,
  diffConversationSnapshot,
} from './snapshot-delta';

function appendedCounts(delta: ConversationSnapshotDelta): Record<string, number> {
  return Object.fromEntries(
    delta.fields.flatMap(([key, change]) =>
      change.kind === 'append' ? [[key, change.appended.length] as const] : [],
    ),
  );
}

function setKeys(delta: ConversationSnapshotDelta): string[] {
  return delta.fields.flatMap(([key, change]) => (change.kind === 'set' ? [key] : []));
}

function takeStep(conversation: Conversation, step: number): void {
  conversation.appendAssistantMessage(`step ${step}`);
  conversation.appendUserMessage(`continue after ${step}`);
}

describe('conversation snapshot deltas', () => {
  it('records only what a step appended, however long the conversation is', () => {
    const conversation = new Conversation(createConversationHistory());
    conversation.appendUserMessage('Loop');
    let base = conversation.snapshot();
    const sizes: number[] = [];
    for (let step = 0; step < 40; step += 1) {
      takeStep(conversation, step);
      const next = conversation.snapshot();
      const delta = diffConversationSnapshot(base, next);
      sizes.push(JSON.stringify(delta).length);
      expect(applyConversationSnapshotDelta(base, delta)).toEqual(next);
      base = next;
    }
    const last = diffConversationSnapshot(
      base,
      (() => {
        takeStep(conversation, 40);
        return conversation.snapshot();
      })(),
    );
    expect(appendedCounts(last)).toMatchObject({ messages: 2, nodes: 2 });
    expect(setKeys(last)).not.toContain('messages');
    expect(setKeys(last)).not.toContain('nodes');
    // The fortieth step's delta is no larger than an early one: its size is
    // independent of how many messages came before it.
    expect(sizes.at(-1)!).toBeLessThan(sizes[1]! * 1.5);
  });

  it('rebuilds a snapshot that restores with a verified integrity digest', () => {
    const conversation = new Conversation(createConversationHistory());
    conversation.appendUserMessage('Loop');
    const base = conversation.snapshot();
    takeStep(conversation, 0);
    const next = conversation.snapshot();
    // A structured clone stands in for a base decoded from a checkpoint: its
    // elements are equal to, not identical with, the live snapshot's.
    const decodedBase = structuredClone(base);
    const rebuilt = applyConversationSnapshotDelta(
      decodedBase,
      diffConversationSnapshot(decodedBase, next),
    );
    expect(rebuilt.integrity).toEqual(next.integrity);
    // Restoring verifies the digest against the rebuilt content.
    const restored = Conversation.from(structuredClone(rebuilt));
    expect(restored.snapshot().messages).toEqual(next.messages);
  });

  it('stores a rewritten array whole instead of as an append', () => {
    const conversation = new Conversation(createConversationHistory());
    conversation.appendUserMessage('Loop');
    takeStep(conversation, 0);
    const next = conversation.snapshot();
    const [first, ...rest] = next.messages;
    if (first === undefined) throw new Error('expected a message');
    const rewritten: ConversationSnapshot = {
      ...next,
      messages: [{ ...first, content: 'rewritten' }, ...rest],
    };
    const delta = diffConversationSnapshot(rewritten, next);
    expect(setKeys(delta)).toContain('messages');
    expect(applyConversationSnapshotDelta(rewritten, delta)).toEqual(next);
  });

  it('refuses to apply a delta to any snapshot but its base', () => {
    const conversation = new Conversation(createConversationHistory());
    conversation.appendUserMessage('Loop');
    const base = conversation.snapshot();
    takeStep(conversation, 0);
    const next = conversation.snapshot();
    const delta = diffConversationSnapshot(base, next);
    expect(() => applyConversationSnapshotDelta(next, delta)).toThrow(
      /replay diverged from its recorded history/,
    );
  });
});
