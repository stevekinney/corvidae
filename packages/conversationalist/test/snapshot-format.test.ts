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

// Produced by the published v2 encoder before flat node storage was introduced.
const nestedV2Fixture: any = await Bun.file(
  new URL('./fixtures/conversation-snapshot-v2-nested.json', import.meta.url),
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
  it('restores the published nested v2 shape and writes the current flat shape', () => {
    const restored = Conversation.from(nestedV2Fixture);
    expect(restored.current).toMatchObject({
      id: 'conversation-id',
      ids: ['message-1', 'message-2'],
    });
    expect(currentConversationFromSnapshot(nestedV2Fixture)).toEqual(restored.current);

    const snapshot = restored.snapshot();
    expect(snapshot.nodes).toHaveLength(3);
    expect(Conversation.from(snapshot).current).toEqual(restored.current);
  });

  it('reads only the selected nested v2 path when requesting the current conversation', () => {
    const offPath = structuredClone(nestedV2Fixture);
    offPath.root.children.push({});
    resign(offPath);

    expect(currentConversationFromSnapshot(offPath)).toEqual(
      currentConversationFromSnapshot(nestedV2Fixture),
    );
    expect(() => Conversation.from(offPath)).toThrow('invalid node');
  });

  it('rejects tampered nested v2 snapshots after integrity is re-signed', () => {
    const cases: Array<[string, (value: any) => void, string]> = [
      [
        'a missing child message',
        (value) => Reflect.set(value.root.children[0], 'appendedMessageIds', ['missing']),
        'missing message missing',
      ],
      [
        'an invalid current path',
        (value) => Reflect.set(value, 'currentPath', [0, 1]),
        'current path index 1 is out of range',
      ],
      [
        'a mismatched child parent',
        (value) => Reflect.set(value.root.children[0], 'parentId', 'wrong-parent'),
        'inconsistent parent',
      ],
    ];

    for (const [, mutate, message] of cases) {
      const tampered = structuredClone(nestedV2Fixture);
      mutate(tampered);
      const resigned = resign(tampered);
      expect(() => decodeSnapshot(resigned)).toThrow(message);
      expect(() => currentConversationFromSnapshot(resigned)).toThrow(message);
    }
  });

  it('rejects mixed and shape-inconsistent v2 snapshots after re-signing', () => {
    const mixed = structuredClone(nestedV2Fixture);
    Reflect.set(mixed, 'nodes', []);
    const flatNodeWithChildren = structuredClone(editedConversation().snapshot());
    Reflect.set(flatNodeWithChildren.nodes[0]!, 'children', []);

    for (const snapshot of [resign(mixed), resign(flatNodeWithChildren)]) {
      expect(() => decodeSnapshot(snapshot)).toThrow(
        snapshot === mixed ? 'ambiguous version 2 snapshot shape' : 'invalid node',
      );
      expect(() => currentConversationFromSnapshot(snapshot)).toThrow(
        snapshot === mixed ? 'ambiguous version 2 snapshot shape' : 'invalid node',
      );
    }
  });

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
    for (const node of snapshot.nodes) {
      storedEntries += node.appendedMessageIds.length + Object.keys(node.messageReferences).length;
    }

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
    tampered.nodes[0]!.conversation.title = 'tampered';
    expect(() => currentConversationFromSnapshot(tampered)).toThrow('integrity digest mismatch');
  });

  it('rejects malformed message deltas even when re-signed', () => {
    const snapshot = editedConversation().snapshot();
    const child = (value: ConversationSnapshot) => value.nodes[1]!;
    const cases: Array<[string, (value: ConversationSnapshot) => void, string]> = [
      [
        'a table that is not an array',
        (value) => Reflect.set(value, 'messages', {}),
        'invalid message table',
      ],
      [
        'an out-of-range reference',
        (value) => {
          const [id] = Object.keys(value.nodes[0]!.messageReferences);
          Reflect.set(value.nodes[0]!.messageReferences, id!, value.messages.length);
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

  it('keeps a long history shallow enough for depth-limited codecs', () => {
    const conversation = new Conversation(createConversationHistory());
    for (let step = 0; step < 250; step += 1) {
      conversation.appendUserMessage(`question ${step}`);
      conversation.appendAssistantMessage(`answer ${step}`);
    }
    const snapshot = conversation.snapshot();

    const depth = (value: unknown): number =>
      value !== null && typeof value === 'object'
        ? 1 + Math.max(0, ...Object.values(value).map(depth))
        : 0;
    // One node per commit: nesting children put this 500 levels deep, past
    // msgpack's 100-level limit that Weft checkpoints enforce.
    expect(snapshot.nodes).toHaveLength(501);
    expect(depth(snapshot)).toBeLessThan(12);
    expect(Conversation.from(snapshot).current).toEqual(conversation.current);
  });

  it('rejects a malformed message table entry, even when re-signed', () => {
    const snapshot = editedConversation().snapshot();
    const cases: Array<[string, (entry: Record<string, unknown>) => void]> = [
      ['an unknown role', (entry) => Reflect.set(entry, 'role', 'narrator')],
      ['a non-integer position', (entry) => Reflect.set(entry, 'position', 'first')],
      ['an unknown field', (entry) => Reflect.set(entry, 'surprise', true)],
      ['a legacy shape', (entry) => Reflect.set(entry, 'role', 'tool-use')],
    ];

    for (const [, mutate] of cases) {
      const mutated = structuredClone(snapshot);
      mutate(mutated.messages[0] as unknown as Record<string, unknown>);
      resign(mutated);
      expect(() => decodeSnapshot(mutated)).toThrow('invalid message table entry 0');
      expect(() => Conversation.from(mutated)).toThrow('invalid message table entry 0');
    }
  });

  it('rejects a malformed node header, even when re-signed', () => {
    const snapshot = editedConversation().snapshot();
    const cases: Array<[string, (header: Record<string, unknown>) => void]> = [
      ['an unknown status', (header) => Reflect.set(header, 'status', 'paused')],
      ['a null title', (header) => Reflect.set(header, 'title', null)],
      ['a zero schema version', (header) => Reflect.set(header, 'schemaVersion', 0)],
      ['an unknown field', (header) => Reflect.set(header, 'surprise', true)],
      ['a non-object metadata', (header) => Reflect.set(header, 'metadata', [])],
      [
        'a non-JSON metadata value',
        (header) => Reflect.set(header, 'metadata', { at: new Date() }),
      ],
      ['a numeric timestamp', (header) => Reflect.set(header, 'updatedAt', 0)],
    ];

    for (const [, mutate] of cases) {
      for (const position of [0, 1]) {
        const mutated = structuredClone(snapshot);
        mutate(mutated.nodes[position]!.conversation);
        resign(mutated);
        const id = mutated.nodes[position]!.id;
        expect(() => decodeSnapshot(mutated)).toThrow(`invalid conversation for ${id}`);
      }
    }
  });

  it('copies node header metadata rather than freezing the snapshot it restores from', () => {
    const conversation = new Conversation(
      createConversationHistory({ metadata: { tags: ['a'], nested: { depth: 1 } } }),
    );
    conversation.appendUserMessage('Hello.');
    const snapshot = structuredClone(conversation.snapshot());

    const restored = Conversation.from(snapshot);

    expect(restored.current.metadata).toEqual({ tags: ['a'], nested: { depth: 1 } });
    expect(Object.isFrozen(snapshot.nodes[0]!.conversation.metadata)).toBe(false);
    expect(Object.isFrozen(snapshot.nodes[0]!.conversation.metadata['tags'])).toBe(false);
  });

  it('rejects a tool result without its call, even when re-signed', () => {
    const conversation = new Conversation(createConversationHistory());
    conversation.appendUserMessage('Look it up.');
    conversation.appendToolCall({ id: 'lookup', name: 'lookup', arguments: {} });
    conversation.appendToolResult({ callId: 'lookup', outcome: 'success', content: 'found' });
    const snapshot = structuredClone(conversation.snapshot());
    const result = snapshot.messages.find((message) => message.role === 'tool-result')!;
    // On its own the entry is still a well-formed message: only the
    // conversation around it shows that no call has this id.
    Reflect.set(result.toolResult!, 'callId', 'missing-call');
    resign(snapshot);

    expect(() => decodeSnapshot(snapshot)).toThrow('non-existent tool-call: missing-call');
    expect(() => Conversation.from(snapshot)).toThrow('non-existent tool-call: missing-call');
    expect(() => currentConversationFromSnapshot(snapshot)).toThrow(
      'non-existent tool-call: missing-call',
    );
  });

  it('rejects a second result for one tool call, even when re-signed', () => {
    const conversation = new Conversation(createConversationHistory());
    conversation.appendToolCall({ id: 'lookup', name: 'lookup', arguments: {} });
    conversation.appendToolResult({ callId: 'lookup', outcome: 'success', content: 'found' });
    const snapshot = structuredClone(conversation.snapshot());
    const result = snapshot.messages.find((message) => message.role === 'tool-result')!;
    const last = snapshot.nodes.at(-1)!;
    // Every entry parses and every result follows its call, so only the
    // per-node integrity check sees the duplicate answer.
    Reflect.set(snapshot, 'messages', [
      ...snapshot.messages,
      {
        ...result,
        id: 'duplicate-result',
        position: last.retainedMessageCount + last.appendedMessageIds.length,
      },
    ]);
    Reflect.set(last, 'appendedMessageIds', [...last.appendedMessageIds, 'duplicate-result']);
    Reflect.set(last.messageReferences, 'duplicate-result', snapshot.messages.length - 1);
    resign(snapshot);

    expect(() => decodeSnapshot(snapshot)).toThrow('conversation integrity check failed');
  });

  it('rejects a node listed before its parent, even when re-signed', () => {
    const snapshot = structuredClone(editedConversation().snapshot());
    const nodes = [...snapshot.nodes];
    [nodes[1], nodes[2]] = [nodes[2]!, nodes[1]!];
    Reflect.set(snapshot, 'nodes', nodes);

    expect(() => decodeSnapshot(resign(snapshot))).toThrow('inconsistent parent');
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
