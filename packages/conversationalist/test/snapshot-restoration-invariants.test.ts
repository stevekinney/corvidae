import { describe, expect, it } from 'bun:test';

import { decodeSnapshot } from '../src/conversation/snapshot-format';
import { snapshotDigest } from '../src/conversation/snapshot-integrity';
import { Conversation } from '../src/history';
import type { ConversationSnapshot } from '../src/index';
import { createConversationHistory } from '../src/index';

function resign<T extends { integrity: { algorithm: 'fnv1a-64'; digest: string } }>(
  snapshot: T,
): T {
  const { integrity: _integrity, ...unsigned } = snapshot;
  snapshot.integrity = { algorithm: 'fnv1a-64', digest: snapshotDigest(unsigned) };
  return snapshot;
}

function mutable(snapshot: ConversationSnapshot): any {
  return structuredClone(snapshot);
}

function branchedConversation(): Conversation {
  const conversation = new Conversation(createConversationHistory({ id: 'invariants' }));
  conversation.appendUserMessage('one');
  conversation.appendAssistantMessage('two');
  conversation.undo();
  conversation.appendAssistantMessage('other');
  return conversation;
}

function toolConversation(): Conversation {
  const conversation = new Conversation(createConversationHistory({ id: 'legacy' }));
  conversation.appendMessages(
    { role: 'tool-call', content: 'call', toolCall: { id: 'c1', name: 't', arguments: {} } },
    {
      role: 'tool-result',
      content: 'ok',
      toolResult: { callId: 'c1', outcome: 'success', content: {} },
    },
  );
  return conversation;
}

function rootNode(conversation: Conversation): any {
  let node = (conversation as any).currentNode;
  while (node.parent) node = node.parent;
  return node;
}

describe('snapshot restoration invariants', () => {
  it('deep-freezes every restored node, not only the root', () => {
    const restored = Conversation.from(branchedConversation().snapshot());
    const nodes: any[] = [rootNode(restored)];
    for (let index = 0; index < nodes.length; index += 1) nodes.push(...nodes[index].children);
    expect(nodes.length).toBeGreaterThan(3);
    for (const node of nodes) {
      expect(Object.isFrozen(node.conversation)).toBe(true);
      expect(Object.isFrozen(node.conversation.ids)).toBe(true);
      expect(() => {
        node.conversation.title = 'mutated';
      }).toThrow();
    }
  });

  it('rejects a node payload that only loads through legacy normalization', () => {
    const snapshot = mutable(toolConversation().snapshot());
    snapshot.messages.find((message: any) => message.toolCall).role = 'tool-use';
    resign(snapshot);
    expect(() => Conversation.from(snapshot)).toThrow(/legacy/);
    expect(() => decodeSnapshot(snapshot)).toThrow(/legacy/);
  });

  it('rejects legacy tool call and result field names', () => {
    const args = mutable(toolConversation().snapshot());
    const call = args.messages.find((message: any) => message.toolCall);
    call.toolCall.args = call.toolCall.arguments;
    delete call.toolCall.arguments;
    resign(args);
    expect(() => decodeSnapshot(args)).toThrow(/legacy/);

    const result = mutable(toolConversation().snapshot());
    const output = result.messages.find((message: any) => message.toolResult);
    output.toolResult.result = output.toolResult.content;
    delete output.toolResult.content;
    resign(result);
    expect(() => decodeSnapshot(result)).toThrow(/legacy/);
  });

  it('rejects a child whose revision is lower than its parent', () => {
    const snapshot = mutable(branchedConversation().snapshot());
    const [root, first] = snapshot.nodes;
    expect(first.parentId).toBe(root.id);
    root.revision = 2;
    first.revision = 1;
    resign(snapshot);
    expect(() => Conversation.from(snapshot)).toThrow(/precedes its parent/);
  });

  it('applies the revision chronology check to published nested snapshots', async () => {
    const fixture: any = await Bun.file(
      new URL('./fixtures/conversation-snapshot-v2-nested.json', import.meta.url),
    ).json();
    expect(() => decodeSnapshot(fixture)).not.toThrow();
    fixture.root.revision = fixture.controllerRevision;
    fixture.root.children[0].revision = 0;
    resign(fixture);
    expect(() => decodeSnapshot(fixture)).toThrow(/precedes its parent/);
  });

  it('persists stream sequences and continues them after restore', () => {
    const source = new Conversation(createConversationHistory({ id: 'sequences' }));
    const messageId = source.appendStreamingMessage('assistant');
    source.updateStreamingMessage(messageId, 'a');
    source.updateStreamingMessage(messageId, 'ab');
    const snapshot = source.snapshot();
    expect(snapshot.streamSequences).toEqual({ [messageId]: 2 });

    const restored = Conversation.from(snapshot);
    const sequences: Array<number | undefined> = [];
    restored.addEventListener('stream.updated', (event) => sequences.push(event.streamSequence));
    restored.updateStreamingMessage(messageId, 'abc');
    expect(sequences).toEqual([3]);
    expect(restored.snapshot().streamSequences).toEqual({ [messageId]: 3 });
  });

  it('covers stream sequences with the digest and validates them', () => {
    const source = new Conversation(createConversationHistory({ id: 'sequence-digest' }));
    const messageId = source.appendStreamingMessage('assistant');
    source.updateStreamingMessage(messageId, 'a');
    const tampered = mutable(source.snapshot());
    tampered.streamSequences[messageId] = 9;
    expect(() => Conversation.from(tampered)).toThrow(/integrity/);
    tampered.streamSequences[messageId] = -1;
    resign(tampered);
    expect(() => Conversation.from(tampered)).toThrow(/stream sequences/);
  });

  it('omits stream sequences when none exist so existing digests stay valid', () => {
    const source = new Conversation(createConversationHistory({ id: 'no-sequences' }));
    source.appendUserMessage('hi');
    expect('streamSequences' in source.snapshot()).toBe(false);
  });

  it('builds snapshot.restored from the restored state, not live state', async () => {
    const source = new Conversation(createConversationHistory({ id: 'restored-detail' }));
    source.appendUserMessage('persisted');
    const snapshot = source.snapshot();
    const restored = Conversation.from(snapshot);
    const expectedIds = [...restored.current.ids];
    const details: Array<{ ids: readonly string[]; revision: number }> = [];
    const sequences: number[] = [];
    restored.addEventListener('snapshot.restored', (event) => {
      details.push({ ids: [...event.conversation.ids], revision: event.revision });
      sequences.push(event.sequence);
    });
    restored.addEventListener('change', (event) => sequences.push(event.sequence));
    restored.appendUserMessage('after restore');

    await Promise.resolve();

    expect(details).toEqual([{ ids: expectedIds, revision: snapshot.controllerRevision }]);
    expect(sequences).toHaveLength(2);
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index]).toBeGreaterThan(sequences[index - 1] as number);
    }
  });
});
