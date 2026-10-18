import { describe, expect, it } from 'bun:test';

import { decodeSnapshot } from '../src/conversation/snapshot-format';
import { Conversation } from '../src/history';
import { appendUserMessage, createConversationHistory } from '../src/index';
import type { ConversationSnapshot } from '../src/types';
import { deepFreeze } from '../src/utilities/type-helpers';
import { CURRENT_SCHEMA_VERSION } from '../src/versioning';

describe('Conversation state integrity', () => {
  it('deeply freezes public state and preserves cached snapshot identity until a commit', () => {
    const initial = createConversationHistory({ metadata: { nested: { enabled: true } } });
    const conversation = new Conversation(initial);
    const first = conversation.getSnapshot();

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.conversation.metadata)).toBe(true);
    expect(Object.isFrozen(first.conversation.metadata['nested'])).toBe(true);
    const nested = first.conversation.metadata['nested'];
    if (!nested || typeof nested !== 'object' || !('enabled' in nested))
      throw new Error('Expected nested state fixture');
    expect(() => {
      nested['enabled'] = false;
    }).toThrow();
    expect(conversation.getSnapshot()).toBe(first);

    conversation.appendUserMessage([{ type: 'text', text: 'hello' }]);
    const second = conversation.getSnapshot();
    const message = second.conversation.messages[second.conversation.ids[0]!];
    if (message === undefined) throw new Error('expected validated message');
    expect(second).not.toBe(first);
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.content)).toBe(true);
    expect(conversation.revision).toBe(1);
  });

  it('descends into shallow-frozen containers', () => {
    const nested = { enabled: true };
    const shallow = Object.freeze({ nested });

    deepFreeze(shallow);

    expect(Object.isFrozen(nested)).toBe(true);
  });

  it('detaches pure-helper output before enforcing runtime immutability', () => {
    const metadata = { mutable: true };
    const input = structuredClone(createConversationHistory({ metadata }));
    const result = appendUserMessage(input, 'hello');

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.metadata)).toBe(true);
    expect(Object.isFrozen(input.metadata)).toBe(false);
  });

  it('returns a deeply frozen, integrity-protected versioned snapshot', () => {
    const conversation = new Conversation(createConversationHistory());
    conversation.appendUserMessage('hello');
    const snapshot = conversation.snapshot();

    expect(snapshot.snapshotFormatVersion).toBe(2);
    expect(snapshot.conversationSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(snapshot.controllerRevision).toBe(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.nodes[0])).toBe(true);
    expect(Object.isFrozen(snapshot.nodes[0]!.conversation)).toBe(true);
    expect(Conversation.from(snapshot).current).toEqual(conversation.current);

    const corrupted = structuredClone(snapshot);
    corrupted.nodes[0]!.conversation.title = 'tampered';
    expect(() => Conversation.from(corrupted)).toThrow('integrity digest mismatch');
  });

  it('strictly rejects unsupported versions, partial paths, duplicate identities, and invalid revisions', () => {
    const conversation = new Conversation(createConversationHistory());
    conversation.appendUserMessage('first');
    conversation.undo();
    conversation.appendUserMessage('second');
    const snapshot = conversation.snapshot();

    const future: Omit<ConversationSnapshot, 'snapshotFormatVersion'> & {
      snapshotFormatVersion: number;
    } = structuredClone(snapshot);
    future.snapshotFormatVersion = 3;
    expect(() => Reflect.apply(Conversation.from, Conversation, [future])).toThrow(
      'unsupported snapshot format version',
    );

    const partialPath = structuredClone(snapshot);
    partialPath.currentPath = [99];
    expect(() => Conversation.from(resign(partialPath))).toThrow('current path index 99');

    const duplicate = structuredClone(snapshot);
    duplicate.nodes[2]!.id = duplicate.nodes[1]!.id;
    expect(() => Conversation.from(resign(duplicate))).toThrow('duplicate node id');

    const invalidRevision = structuredClone(snapshot);
    invalidRevision.nodes[1]!.revision = snapshot.controllerRevision + 1;
    expect(() => Conversation.from(resign(invalidRevision))).toThrow('invalid node revision');

    const invalidRootRevision = structuredClone(snapshot);
    invalidRootRevision.nodes[0]!.revision = snapshot.controllerRevision + 1;
    expect(() => Conversation.from(resign(invalidRootRevision))).toThrow('invalid node revision');
  });

  it('preserves fork and prune lineage in round trips', () => {
    const source = new Conversation(createConversationHistory(), { maxHistoryDepth: 2 });
    source.appendUserMessage('one');
    const forkPointMessageId = source.current.ids[0]!;
    const forked = source.fork(forkPointMessageId);
    forked.appendAssistantMessage('two');

    const forkSnapshot = forked.snapshot();
    expect(forkSnapshot.lineage).toMatchObject({
      parentConversationId: source.current.id,
      forkPointMessageId,
      sourceRevision: source.revision,
    });
    expect(Conversation.from(forkSnapshot).snapshot().lineage).toEqual(forkSnapshot.lineage);

    source.appendAssistantMessage('two');
    source.appendUserMessage('three');
    const pruned = source.snapshot();
    expect(pruned.lineage.removedNodeIds.length).toBeGreaterThan(0);
    expect(pruned.lineage.retainedFloorNodeId).toBe(pruned.nodes[0]!.id);
    expect(pruned.lineage.removedNodeIds).not.toContain(pruned.currentBranchId);
    expect(Conversation.from(pruned).snapshot().lineage).toEqual(pruned.lineage);

    const branched = new Conversation(createConversationHistory(), { maxHistoryDepth: 3 });
    branched.appendUserMessage('discarded branch');
    const discardedBranchId = branched.snapshot().currentBranchId;
    branched.appendAssistantMessage('discarded descendant');
    const discardedDescendantId = branched.snapshot().currentBranchId;
    branched.undo();
    branched.undo();
    branched.appendUserMessage('retained one');
    branched.appendAssistantMessage('retained two');
    branched.appendUserMessage('retained three');
    const branchedSnapshot = branched.snapshot();

    expect(branchedSnapshot.lineage.removedNodeIds).toContain(discardedBranchId);
    expect(branchedSnapshot.lineage.removedNodeIds).toContain(discardedDescendantId);
    expect(branchedSnapshot.lineage.removedNodeIds).not.toContain(branchedSnapshot.currentBranchId);
  });

  it('rejects every malformed snapshot envelope boundary', () => {
    const snapshot = new Conversation(createConversationHistory()).snapshot();
    const invalidValues: unknown[] = [
      null,
      1,
      { ...structuredClone(snapshot), conversationSchemaVersion: 999 },
      { ...structuredClone(snapshot), controllerRevision: -1 },
      { ...structuredClone(snapshot), currentBranchId: 1 },
      { ...structuredClone(snapshot), createdAt: 'not-a-date' },
      { ...structuredClone(snapshot), currentPath: [-1] },
      { ...structuredClone(snapshot), currentPath: 'root' },
      { ...structuredClone(snapshot), lineage: undefined },
      {
        ...structuredClone(snapshot),
        lineage: { ...structuredClone(snapshot.lineage), parentConversationId: 'parent' },
      },
      {
        ...structuredClone(snapshot),
        lineage: { ...structuredClone(snapshot.lineage), sourceRevision: 'one' },
      },
      {
        ...structuredClone(snapshot),
        lineage: { ...structuredClone(snapshot.lineage), forkPointMessageId: 1 },
      },
      { ...structuredClone(snapshot), lineage: { retainedFloorNodeId: 1, removedNodeIds: [] } },
      {
        ...structuredClone(snapshot),
        lineage: { retainedFloorNodeId: 'root', removedNodeIds: [1] },
      },
      { ...structuredClone(snapshot), integrity: undefined },
      { ...structuredClone(snapshot), integrity: { algorithm: 'fnv1a-64', digest: 1 } },
      { ...structuredClone(snapshot), integrity: { algorithm: 'sha256', digest: 'nope' } },
      { ...structuredClone(snapshot), nodes: null },
      { ...structuredClone(snapshot), nodes: [] },
      { ...structuredClone(snapshot), nodes: [{ id: 1 }] },
      { ...structuredClone(snapshot), nodes: [structuredClone(snapshot.nodes[0]), null] },
      {
        ...structuredClone(snapshot),
        nodes: [
          {
            ...structuredClone(snapshot.nodes[0]),
            conversation: { ...structuredClone(snapshot.nodes[0]!.conversation), schemaVersion: 1 },
          },
        ],
      },
    ];

    for (const invalid of invalidValues) {
      expect(() => decodeSnapshot(invalid)).toThrow('failed to restore snapshot');
    }
  });

  it('round-trips schema-valid empty conversation identities', () => {
    const conversation = new Conversation(createConversationHistory({ id: '' }));

    expect(Conversation.from(conversation.snapshot()).current.id).toBe('');
  });

  it('rejects removed-node evidence that names a retained node', () => {
    const snapshot = structuredClone(new Conversation(createConversationHistory()).snapshot());
    snapshot.lineage.removedNodeIds = [snapshot.nodes[0]!.id];

    expect(() => Conversation.from(resign(snapshot))).toThrow('is still retained');
  });
});

const stable = (value: unknown): string => {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, nested]) => nested !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`)
    .join(',')}}`;
};

function resign(snapshot: ConversationSnapshot): ConversationSnapshot {
  const { integrity: _integrity, ...unsigned } = snapshot;
  let hash = 0xcbf29ce484222325n;
  for (const character of stable(unsigned)) {
    hash ^= BigInt(character.charCodeAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  snapshot.integrity = { algorithm: 'fnv1a-64', digest: hash.toString(16).padStart(16, '0') };
  return snapshot;
}
