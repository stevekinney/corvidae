import { describe, expect, it } from 'bun:test';

import { decodeSnapshot } from '../src/conversation/snapshot-format';
import { validateSnapshotV1 } from '../src/conversation/snapshot-v1';
import type { DecodedSnapshotNode } from '../src/conversation/snapshot-v2';
import { Conversation } from '../src/history';
import {
  type ConversationSnapshot,
  type ConversationSnapshotV1,
  createConversationHistory,
  currentConversationFromSnapshot,
  migrateConversationSnapshotV1,
} from '../src/index';
import { createTestConversation } from '../src/test/index';
import { cloneSharingFrozen, deepFreeze } from '../src/utilities/type-helpers';

// Produced by `Conversation.snapshot()` before format version 2 existed, with a
// deterministic test environment: streaming updates, a tool call and result, a
// redaction, an undo onto a second branch, and a truncation.
const v1Fixture: ConversationSnapshotV1 = await Bun.file(
  new URL('./fixtures/conversation-snapshot-v1.json', import.meta.url),
).json();

/** Independent of the implementation: its own canonical JSON and BigInt FNV-1a. */
function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, nested]) => nested !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`)
    .join(',')}}`;
}

function resign<T extends { integrity: { algorithm: 'fnv1a-64'; digest: string } }>(
  snapshot: T,
): T {
  const { integrity: _integrity, ...unsigned } = snapshot;
  let hash = 0xcbf29ce484222325n;
  for (const character of stable(unsigned)) {
    hash ^= BigInt(character.charCodeAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  snapshot.integrity = { algorithm: 'fnv1a-64', digest: hash.toString(16).padStart(16, '0') };
  return snapshot;
}

function nodeStates(node: DecodedSnapshotNode): unknown {
  return {
    id: node.id,
    revision: node.revision,
    conversation: stable(node.conversation),
    children: node.children.map(nodeStates),
  };
}

function editedConversation(): Conversation {
  const conversation = createTestConversation(undefined, { now: '2024-01-01T00:00:00.000Z' });
  conversation.appendUserMessage('What is the weather?');
  const streamed = conversation.appendStreamingMessage('assistant');
  conversation.updateStreamingMessage(streamed, 'Let me');
  conversation.updateStreamingMessage(streamed, 'Let me check.');
  conversation.finalizeStreamingMessage(streamed);
  conversation.appendUserMessage('Please hurry.');
  conversation.redactMessageAtPosition(0);
  conversation.truncateFromPosition(2);
  conversation.appendAssistantMessage('Sunny.');
  return conversation;
}

describe('snapshot format version 1', () => {
  it('still verifies the checked-in fixture under the original v1 validator', () => {
    expect(v1Fixture.snapshotFormatVersion).toBe(1);
    expect(() => validateSnapshotV1(v1Fixture)).not.toThrow();
  });

  it('migrates to version 2 without changing any node, revision, lineage, or creation time', () => {
    const migrated = migrateConversationSnapshotV1(v1Fixture);

    expect(migrated.snapshotFormatVersion).toBe(2);
    expect(migrated.controllerRevision).toBe(v1Fixture.controllerRevision);
    expect(migrated.createdAt).toBe(v1Fixture.createdAt);
    expect(migrated.lineage).toEqual(v1Fixture.lineage);
    expect(migrated.currentPath).toEqual(v1Fixture.currentPath);
    expect(nodeStates(decodeSnapshot(migrated).root)).toEqual(
      nodeStates(decodeSnapshot(v1Fixture).root),
    );
    // Each distinct message version is stored once instead of once per node.
    expect(JSON.stringify(migrated).length).toBeLessThan(JSON.stringify(v1Fixture).length);
  });

  it('restores through Conversation.from() and snapshots back as version 2', () => {
    const restored = Conversation.from(v1Fixture);
    const snapshot = restored.snapshot();

    expect(snapshot.snapshotFormatVersion).toBe(2);
    expect(Conversation.from(snapshot).current).toEqual(restored.current);
    expect(currentConversationFromSnapshot(v1Fixture)).toEqual(restored.current);
  });

  it('rejects a tampered version 1 snapshot before migrating it', () => {
    const tampered = structuredClone(v1Fixture);
    tampered.root.conversation.title = 'tampered';

    expect(() => migrateConversationSnapshotV1(tampered)).toThrow('integrity digest mismatch');
    expect(() => Conversation.from(tampered)).toThrow('integrity digest mismatch');
  });
});

describe('snapshot format version 2', () => {
  it('keeps the message table and size unchanged across restore round trips', () => {
    const conversation = editedConversation();
    const forked = conversation.fork(conversation.current.ids[0]);
    forked.appendUserMessage('Forked follow-up.');

    for (const source of [conversation, forked]) {
      const snapshot = source.snapshot();
      const restored = Conversation.from(snapshot).snapshot();
      const throughJson = Conversation.from(JSON.parse(JSON.stringify(restored))).snapshot();

      expect(restored.messages.length).toBe(snapshot.messages.length);
      expect(JSON.stringify(restored).length).toBe(JSON.stringify(snapshot).length);
      expect(throughJson.messages.length).toBe(snapshot.messages.length);
      expect(JSON.stringify(throughJson).length).toBe(JSON.stringify(snapshot).length);
    }
  });

  it('restores every ancestor state when a message is edited in place along the history', () => {
    const conversation = editedConversation();
    const restored = Conversation.from(conversation.snapshot());

    let states = 0;
    for (;;) {
      expect(restored.current).toEqual(conversation.current);
      states += 1;
      if (!conversation.canUndo) break;
      conversation.undo();
      restored.undo();
    }
    expect(restored.canUndo).toBe(false);
    expect(states).toBeGreaterThan(5);
  });

  it('grows with distinct messages rather than with every node transcript', () => {
    const conversation = new Conversation(createConversationHistory());
    for (let step = 0; step < 50; step += 1) {
      conversation.appendUserMessage(`question ${step}`);
      conversation.appendAssistantMessage(`answer ${step}`);
    }
    const snapshot = conversation.snapshot();

    let storedEntries = 0;
    const count = (node: ConversationSnapshot['root']): void => {
      storedEntries += node.appendedMessageIds.length + Object.keys(node.messageReferences).length;
      node.children.forEach(count);
    };
    count(snapshot.root);

    expect(snapshot.messages).toHaveLength(100);
    // Each append stores its new id and message once; version 1 stored every
    // earlier message again at every one of the 100 nodes.
    expect(storedEntries).toBe(200);
  });

  it('shares carried-over messages between commits instead of copying them', () => {
    const conversation = new Conversation(createConversationHistory());
    conversation.appendUserMessage('first');
    const first = conversation.current.messages[conversation.current.ids[0]!];
    conversation.appendAssistantMessage('second');

    expect(conversation.current.messages[conversation.current.ids[0]!]).toBe(first);
  });

  it('reads the current branch without restoring the conversation', () => {
    const conversation = editedConversation();
    conversation.undo();
    conversation.appendUserMessage('A new branch.');
    const snapshot = conversation.snapshot();

    expect(currentConversationFromSnapshot(snapshot)).toEqual(conversation.current);
    const tampered = structuredClone(snapshot);
    tampered.root.conversation.title = 'tampered';
    expect(() => currentConversationFromSnapshot(tampered)).toThrow('integrity digest mismatch');
  });

  it('rejects malformed message deltas even when re-signed', () => {
    const snapshot = editedConversation().snapshot();
    const child = (value: ConversationSnapshot) => value.root.children[0]!;
    const cases: Array<[string, (value: ConversationSnapshot) => void, string]> = [
      [
        'a table that is not an array',
        (value) => Reflect.set(value, 'messages', {}),
        'invalid message table',
      ],
      [
        'an out-of-range reference',
        (value) => {
          const [id] = Object.keys(value.root.messageReferences);
          Reflect.set(value.root.messageReferences, id!, value.messages.length);
        },
        'invalid message reference',
      ],
      [
        'a reference to an id the node does not list',
        (value) => Reflect.set(child(value).messageReferences, 'not-listed', 0),
        'is not listed',
      ],
      [
        'an appended id with no message',
        (value) => Reflect.set(child(value), 'appendedMessageIds', ['missing']),
        'missing message missing',
      ],
      [
        'a retained prefix longer than the parent',
        (value) => Reflect.set(child(value), 'retainedMessageCount', 999),
        'invalid message delta',
      ],
      [
        'an unreferenced table entry',
        (value) => Reflect.set(value, 'messages', [...value.messages, value.messages[0]]),
        'unreferenced message table entry',
      ],
    ];

    for (const [, mutate, message] of cases) {
      const mutated = structuredClone(snapshot);
      mutate(mutated);
      expect(() => decodeSnapshot(resign(mutated))).toThrow(message);
    }
  });

  it('rejects a future format version', () => {
    const future = {
      ...structuredClone(editedConversation().snapshot()),
      snapshotFormatVersion: 3,
    };

    expect(() => decodeSnapshot(future)).toThrow('unsupported snapshot format version 3');
    expect(() => currentConversationFromSnapshot(future)).toThrow(
      'unsupported snapshot format version 3',
    );
  });
});

describe('cloneSharingFrozen', () => {
  it('shares deeply frozen values and copies everything else', () => {
    const frozen = deepFreeze({ nested: { value: 1 } });
    const mutable = { value: 2 };
    const clone = cloneSharingFrozen({ frozen, mutable, list: [mutable] });

    expect(clone.frozen).toBe(frozen);
    expect(cloneSharingFrozen(frozen)).not.toBe(frozen);
    expect(cloneSharingFrozen(frozen).nested).toBe(frozen.nested);
    expect(clone.mutable).not.toBe(mutable);
    expect(clone.mutable).toEqual(mutable);
    expect(clone.list[0]).not.toBe(mutable);
  });

  it('does not treat a shallow-frozen value with mutable children as shareable', () => {
    const inner = { value: 1 };
    const shallow = Object.freeze({ inner });
    const clone = cloneSharingFrozen({ shallow });

    expect(clone.shallow).not.toBe(shallow);
    expect(clone.shallow.inner).not.toBe(inner);
  });

  it('falls back to structuredClone for non-plain values and cycles', () => {
    const date = new Date('2024-01-01T00:00:00.000Z');
    const withDate = cloneSharingFrozen({ date });
    expect(withDate.date).not.toBe(date);
    expect(withDate.date.toISOString()).toBe(date.toISOString());

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const cyclicClone = cloneSharingFrozen(cyclic);
    expect(cyclicClone).not.toBe(cyclic);
    expect(cyclicClone.self).toBe(cyclicClone);
  });
});
