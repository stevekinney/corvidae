/**
 * Snapshot format version 2: every distinct message is stored once in the
 * envelope's `messages` table, and each history node stores its conversation
 * as a delta from its parent (see `ConversationNodeSnapshot`).
 *
 * Version 1 stored every node's complete conversation. History keeps a node
 * per commit, so a snapshot grew with the square of the conversation's length,
 * and the operative store snapshots on every step. Here a node costs its
 * appended ids and changed messages, so an append-only history snapshots in
 * space linear in its messages.
 *
 * Nodes are a flat, pre-ordered list that names each node's parent, not a
 * nested tree. History is a chain of one node per commit, so nesting put a
 * long conversation's snapshot hundreds of levels deep, past what codecs such
 * as msgpack accept (Weft's checkpoint encoder stops at 100) and deep enough to
 * recurse through. Encoding and decoding here walk the list without recursion.
 */
import type {
  ConversationHistory,
  ConversationHistoryHeader,
  ConversationNodeSnapshot,
  ConversationSnapshot,
  ConversationSnapshotLineage,
  Message,
} from '../types';
import { deepFreeze } from '../utilities/type-helpers';
import {
  assembleConversationHistory,
  parseConversationFrame,
  parseConversationMessage,
} from './serialization';
import {
  asRecord,
  assertLineageMatchesTree,
  assertSnapshotDigest,
  CURRENT_SNAPSHOT_FORMAT_VERSION,
  finalizeSnapshot,
  isRecord,
  readRevision,
  readSnapshotEnvelope,
  readString,
  type SnapshotEnvelope,
  snapshotError,
  unsupportedSnapshotFormatVersion,
} from './snapshot-integrity';

/** A history node as restore consumes it: validated, frozen, and sharing message instances with its relatives. */
export interface DecodedSnapshotNode {
  readonly id: string;
  readonly revision: number;
  readonly conversation: ConversationHistory;
  readonly children: readonly DecodedSnapshotNode[];
}

/** A validated snapshot of any supported format version, decoded to full per-node conversations. */
export interface DecodedSnapshot {
  readonly conversationSchemaVersion: number;
  readonly controllerRevision: number;
  readonly conversationId: string;
  readonly currentBranchId: string;
  readonly createdAt: string;
  readonly currentPath: readonly number[];
  readonly lineage: ConversationSnapshotLineage;
  readonly streamSequences: Readonly<Record<string, number>>;
  readonly root: DecodedSnapshotNode;
}

/** Any tree whose nodes carry a committed conversation: live history nodes or a decoded snapshot. */
export interface EncodableSnapshotNode {
  readonly id: string;
  readonly revision: number;
  readonly conversation: ConversationHistory;
  readonly children: readonly EncodableSnapshotNode[];
}

export type EncodableSnapshot = Omit<DecodedSnapshot, 'root'> & {
  readonly root: EncodableSnapshotNode;
};

interface NodeDelta {
  readonly parent: ConversationHistory | null;
  readonly retainedMessageCount: number;
  readonly appendedMessageIds: readonly string[];
  readonly changedMessages: readonly Message[];
}

/**
 * Committed conversations are immutable and outlive many snapshots, so each
 * node's delta is computed once. Recomputing it would compare the node's ids
 * with its parent's on every snapshot, which is linear per node and makes
 * each snapshot quadratic again.
 */
const nodeDeltas = new WeakMap<ConversationHistory, NodeDelta>();

function nodeDelta(
  parent: ConversationHistory | null,
  conversation: ConversationHistory,
): NodeDelta {
  const cached = nodeDeltas.get(conversation);
  if (cached !== undefined && cached.parent === parent) return cached;
  const parentIds = parent?.ids ?? [];
  let retainedMessageCount = 0;
  while (
    retainedMessageCount < parentIds.length &&
    retainedMessageCount < conversation.ids.length &&
    parentIds[retainedMessageCount] === conversation.ids[retainedMessageCount]
  ) {
    retainedMessageCount += 1;
  }
  // Identity, not id: a streamed, redacted, or repositioned message keeps its
  // id but is a different frozen object, and must be stored again.
  const changedMessages: Message[] = [];
  for (const id of conversation.ids) {
    const message = conversation.messages[id];
    if (message !== undefined && message !== parent?.messages[id]) changedMessages.push(message);
  }
  const delta: NodeDelta = {
    parent,
    retainedMessageCount,
    appendedMessageIds: conversation.ids.slice(retainedMessageCount),
    changedMessages,
  };
  nodeDeltas.set(conversation, delta);
  return delta;
}

function historyHeader(conversation: ConversationHistory): ConversationHistoryHeader {
  const { ids: _ids, messages: _messages, ...header } = conversation;
  return header;
}

export function encodeSnapshot(state: EncodableSnapshot): ConversationSnapshot {
  const messages: Message[] = [];
  const messageIndexes = new Map<Message, number>();
  const referenceMessage = (message: Message): number => {
    let index = messageIndexes.get(message);
    if (index === undefined) {
      index = messages.length;
      messages.push(message);
      messageIndexes.set(message, index);
    }
    return index;
  };
  const nodes: ConversationNodeSnapshot[] = [];
  // Pre-order with an explicit stack: children are pushed in reverse so they
  // are emitted in order, which is what `currentPath` indexes.
  const pending: Array<[EncodableSnapshotNode, EncodableSnapshotNode | null]> = [
    [state.root, null],
  ];
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    const [node, parent] = entry;
    const delta = nodeDelta(parent?.conversation ?? null, node.conversation);
    nodes.push({
      id: node.id,
      revision: node.revision,
      parentId: parent?.id ?? null,
      conversation: historyHeader(node.conversation),
      retainedMessageCount: delta.retainedMessageCount,
      appendedMessageIds: delta.appendedMessageIds,
      messageReferences: Object.fromEntries(
        delta.changedMessages.map((message) => [message.id, referenceMessage(message)]),
      ),
    });
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      pending.push([node.children[index]!, node]);
    }
  }
  return finalizeSnapshot({
    snapshotFormatVersion: CURRENT_SNAPSHOT_FORMAT_VERSION,
    conversationSchemaVersion: state.conversationSchemaVersion,
    controllerRevision: state.controllerRevision,
    conversationId: state.conversationId,
    currentBranchId: state.currentBranchId,
    messages,
    nodes,
    currentPath: state.currentPath,
    createdAt: state.createdAt,
    lineage: state.lineage,
    // Only when present: a snapshot without counters keeps the digest it always had.
    ...(Object.keys(state.streamSequences).length > 0
      ? { streamSequences: state.streamSequences }
      : {}),
  });
}

export interface NodeFields {
  readonly id: string;
  readonly revision: number;
  readonly header: Record<string, unknown>;
  readonly messageReferences: ReadonlyMap<string, number>;
  readonly children: readonly unknown[];
}

/** The message ids a node resolves to, each mapped to its index in the envelope's table. */
export interface NodeMessages {
  readonly ids: readonly string[];
  readonly sources: ReadonlyMap<string, number>;
}

export interface ParentContext extends NodeMessages {
  readonly id: string;
  readonly revision: number;
}

export function readNodeFields(
  value: unknown,
  envelope: SnapshotEnvelope,
  tableLength: number,
  parent: ParentContext | null,
  shape: 'flat' | 'nested' = 'flat',
): NodeFields & NodeMessages {
  const node = asRecord(value, 'node');
  const id = readString(node, 'id', 'node');
  const revision = readRevision(node, 'revision', 'node');
  if (revision > envelope.controllerRevision) throw snapshotError(`invalid node revision ${id}`);
  if (parent !== null && revision < parent.revision) {
    throw snapshotError(`node revision ${id} precedes its parent's revision`);
  }
  const parentId = node['parentId'];
  if (parentId !== null && typeof parentId !== 'string') throw snapshotError('invalid node');
  if (parentId !== (parent?.id ?? null)) throw snapshotError(`inconsistent parent for ${id}`);
  const header = asRecord(node['conversation'], 'node');
  const children = node['children'];
  if (shape === 'nested' && !Array.isArray(children)) throw snapshotError('invalid node');
  if (shape === 'flat' && children !== undefined) throw snapshotError('invalid node');

  const parentIds = parent?.ids ?? [];
  const retainedMessageCount = node['retainedMessageCount'];
  if (
    typeof retainedMessageCount !== 'number' ||
    !Number.isSafeInteger(retainedMessageCount) ||
    retainedMessageCount < 0 ||
    retainedMessageCount > parentIds.length
  ) {
    throw snapshotError(`invalid message delta for ${id}`);
  }
  const appendedMessageIds = node['appendedMessageIds'];
  if (
    !Array.isArray(appendedMessageIds) ||
    appendedMessageIds.some((messageId) => typeof messageId !== 'string')
  ) {
    throw snapshotError(`invalid message delta for ${id}`);
  }
  const rawReferences = node['messageReferences'];
  if (!isRecord(rawReferences)) throw snapshotError(`invalid message delta for ${id}`);
  const messageReferences = new Map<string, number>();
  for (const [messageId, index] of Object.entries(rawReferences)) {
    if (
      typeof index !== 'number' ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= tableLength
    ) {
      throw snapshotError(`invalid message reference ${messageId} for ${id}`);
    }
    messageReferences.set(messageId, index);
  }

  const ids: string[] = [...parentIds.slice(0, retainedMessageCount), ...appendedMessageIds];
  const sources = new Map<string, number>();
  for (const messageId of ids) {
    const source = messageReferences.get(messageId) ?? parent?.sources.get(messageId);
    if (source === undefined) throw snapshotError(`missing message ${messageId} for ${id}`);
    sources.set(messageId, source);
  }
  for (const messageId of messageReferences.keys()) {
    if (!sources.has(messageId)) {
      throw snapshotError(`message reference ${messageId} is not listed for ${id}`);
    }
  }
  return {
    id,
    revision,
    header,
    messageReferences,
    children: Array.isArray(children) ? children : [],
    ids,
    sources,
  };
}

/** Resolves an index in the envelope's message table to its parsed, frozen message. */
export type TableMessageReader = (index: number) => Message;

/**
 * Parses table entries on first use and returns the same frozen instance for
 * every later reference. A table entry is shared by every node that carries
 * its message, so a restore schema-validates each entry once rather than once
 * per node, and restored nodes share message instances exactly as committed
 * history does, which keeps the next snapshot compact.
 */
export function createTableMessageReader(table: readonly unknown[]): TableMessageReader {
  const parsed = new Map<number, Message>();
  return (index) => {
    let message = parsed.get(index);
    if (message === undefined) {
      try {
        message = deepFreeze(parseConversationMessage(table[index], 'current'));
      } catch (error) {
        throw snapshotError(
          `invalid message table entry ${index}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      parsed.set(index, message);
    }
    return message;
  };
}

/**
 * A node's conversation, assembled from already-parsed table entries. Its
 * messages get only the checks that depend on their neighbours, which a table
 * entry cannot carry on its own: positions, tool pairing, and conversation
 * integrity.
 *
 * The node's header (id, title, status, metadata, timestamps) is still
 * schema-validated here, once per node. It is the node's own data rather than
 * a shared table entry, nothing else validates it, and it is a fixed set of
 * fields, so its cost does not grow with the conversation the way per-node
 * message parsing did.
 */
export function deserializeNodeConversation(
  fields: NodeFields & NodeMessages,
  readMessage: TableMessageReader,
  schemaVersion: number,
): ConversationHistory {
  const messages: Record<string, Message> = {};
  for (const messageId of fields.ids) {
    messages[messageId] = readMessage(fields.sources.get(messageId)!);
  }
  let conversation: ConversationHistory;
  try {
    // `readNodeFields` has already checked the ids; the frame validates the header.
    const { header } = parseConversationFrame({ ...fields.header, ids: [], messages: {} });
    conversation = assembleConversationHistory(header, fields.ids, messages);
  } catch (error) {
    throw snapshotError(
      `invalid conversation for ${fields.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (conversation.schemaVersion !== schemaVersion) {
    throw snapshotError('node conversation schema version mismatch');
  }
  return conversation;
}

interface EnvelopeV2 {
  readonly envelope: SnapshotEnvelope;
  readonly table: readonly unknown[];
  readonly nodes: readonly unknown[];
}

function readEnvelopeV2(value: unknown): EnvelopeV2 {
  const envelope = readSnapshotEnvelope(value);
  if (envelope.snapshotFormatVersion !== 2) {
    throw unsupportedSnapshotFormatVersion(envelope.snapshotFormatVersion);
  }
  const table = envelope.record['messages'];
  if (!Array.isArray(table)) throw snapshotError('invalid message table');
  const nodes = envelope.record['nodes'];
  if (!Array.isArray(nodes) || nodes.length === 0) throw snapshotError('invalid node list');
  assertSnapshotDigest(envelope);
  return { envelope, table, nodes };
}

/** A node's parent id as written, before its other fields are validated. */
function declaredParentId(value: unknown): string | null {
  const parentId = asRecord(value, 'node')['parentId'];
  if (parentId !== null && typeof parentId !== 'string') throw snapshotError('invalid node');
  return parentId;
}

interface MutableDecodedNode extends DecodedSnapshotNode {
  readonly children: DecodedSnapshotNode[];
}

export function decodeSnapshotV2(value: unknown): DecodedSnapshot {
  const { envelope, table, nodes } = readEnvelopeV2(value);
  const referencedIndexes = new Set<number>();
  const readMessage = createTableMessageReader(table);
  const decodedById = new Map<string, { node: MutableDecodedNode; context: ParentContext }>();
  let root: MutableDecodedNode | undefined;

  for (const [position, nodeValue] of nodes.entries()) {
    const parentId = declaredParentId(nodeValue);
    const parent = parentId === null ? undefined : decodedById.get(parentId);
    if ((position === 0) !== (parentId === null) || (parentId !== null && parent === undefined)) {
      // The root comes first, and every other node follows its parent.
      throw snapshotError(`inconsistent parent at node ${position}`);
    }
    const fields = readNodeFields(nodeValue, envelope, table.length, parent?.context ?? null);
    if (decodedById.has(fields.id)) throw snapshotError(`duplicate node id ${fields.id}`);
    for (const index of fields.messageReferences.values()) referencedIndexes.add(index);

    const node: MutableDecodedNode = {
      id: fields.id,
      revision: fields.revision,
      conversation: deepFreeze(
        deserializeNodeConversation(fields, readMessage, envelope.conversationSchemaVersion),
      ),
      children: [],
    };
    decodedById.set(fields.id, {
      node,
      context: {
        id: fields.id,
        revision: fields.revision,
        ids: fields.ids,
        sources: fields.sources,
      },
    });
    if (parent === undefined) root = node;
    else parent.node.children.push(node);
  }

  if (referencedIndexes.size !== table.length) {
    throw snapshotError('unreferenced message table entry');
  }
  assertLineageMatchesTree(envelope.lineage, root!.id, new Set(decodedById.keys()));
  let current: DecodedSnapshotNode = root!;
  for (const index of envelope.currentPath) {
    const child = current.children[index];
    if (!child) throw snapshotError(`current path index ${index} is out of range`);
    current = child;
  }
  if (
    current.id !== envelope.currentBranchId ||
    current.conversation.id !== envelope.conversationId
  ) {
    throw snapshotError('current identity mismatch');
  }
  return {
    conversationSchemaVersion: envelope.conversationSchemaVersion,
    controllerRevision: envelope.controllerRevision,
    conversationId: envelope.conversationId,
    currentBranchId: envelope.currentBranchId,
    createdAt: envelope.createdAt,
    currentPath: envelope.currentPath,
    lineage: envelope.lineage,
    streamSequences: envelope.streamSequences,
    root: root!,
  };
}

/**
 * The current branch's conversation from a version 2 snapshot, validated.
 *
 * Verifies the digest and reads only the nodes on `currentPath`, deserializing
 * just the final one, so it costs one conversation rather than a full restore.
 */
export function currentConversationFromSnapshotV2(value: unknown): ConversationHistory {
  const { envelope, table, nodes } = readEnvelopeV2(value);
  const childrenById = new Map<string, unknown[]>();
  for (const nodeValue of nodes.slice(1)) {
    const parentId = declaredParentId(nodeValue);
    if (parentId === null) throw snapshotError('inconsistent parent for a non-root node');
    const siblings = childrenById.get(parentId) ?? [];
    siblings.push(nodeValue);
    childrenById.set(parentId, siblings);
  }
  let fields = readNodeFields(nodes[0], envelope, table.length, null);
  for (const index of envelope.currentPath) {
    const child = childrenById.get(fields.id)?.[index];
    if (child === undefined) throw snapshotError(`current path index ${index} is out of range`);
    fields = readNodeFields(child, envelope, table.length, {
      id: fields.id,
      revision: fields.revision,
      ids: fields.ids,
      sources: fields.sources,
    });
  }
  const conversation = deserializeNodeConversation(
    fields,
    createTableMessageReader(table),
    envelope.conversationSchemaVersion,
  );
  if (fields.id !== envelope.currentBranchId || conversation.id !== envelope.conversationId) {
    throw snapshotError('current identity mismatch');
  }
  return deepFreeze(conversation);
}
