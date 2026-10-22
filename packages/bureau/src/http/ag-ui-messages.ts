/**
 * The conversation as a `MESSAGES_SNAPSHOT` carries it, and the rows a start
 * request adds to it.
 *
 * Both go through Conversationalist's AG-UI mapping, which this module only
 * guards: it takes `thinking` and `redacted_thinking` parts out of the
 * conversation before it is exported, because `toAGUIMessages` writes a
 * `thinking` part as a plaintext `reasoning` message (and throws on a
 * `redacted_thinking` one), which would put chain-of-thought on the wire.
 *
 * It also owns how a managed asset crosses the boundary (COR-1547), because Conversationalist
 * names no Bureau provider. A user part that names an asset arrives as a `file` source from the
 * provider `bureau` whose `value` is the asset's id, and becomes a `managed-asset` source; a
 * stored user part leaves as the same `file` source. An assistant message holds text only in
 * AG-UI, so its assets leave in the row's `metadata`, listed under `bureau:assetParts`.
 *
 * @module ag-ui-messages
 */

import type { Message as AgUiMessage } from '@ag-ui/core';
import {
  agUiConversationAdapter,
  type ConversationHistory,
  type Message,
  type MultiModalContent,
  mergeAGUIMessages,
  messageMediaParts,
} from 'conversationalist';

import { MEMORY_EVIDENCE_METADATA_KEY } from '../memory-evidence-metadata.ts';
import { assetPartsOf } from './ag-ui-asset-parts.ts';
import { ASSET_FILE_PROVIDER, ASSET_PARTS_METADATA_KEY } from './ag-ui-vocabulary.ts';

/** A conversation with every reasoning part taken out of every row. */
export function withoutReasoning(history: ConversationHistory): ConversationHistory {
  const messages: Record<string, Message> = {};
  for (const [id, message] of Object.entries(history.messages)) {
    if (typeof message.content === 'string') {
      messages[id] = message;
      continue;
    }
    const kept = message.content.filter(
      (part) => part.type !== 'thinking' && part.type !== 'redacted_thinking',
    );
    messages[id] = kept.length === message.content.length ? message : { ...message, content: kept };
  }
  return { ...history, messages };
}

/**
 * A conversation without the rows a run's memory recall appended (COR-1546). Recalled memory is
 * evidence for the model, labelled as such and wrapped in an envelope, and it is not part of the
 * thread: a person who reads the transcript is not shown the envelope, and the Memory page is
 * where what an agent remembers is read. The row stays in the stored conversation, so the next
 * run's model still sees what the last one recalled.
 */
export function withoutMemoryEvidence(history: ConversationHistory): ConversationHistory {
  const recalled = new Set(
    history.ids.filter(
      (id) => history.messages[id]?.metadata?.[MEMORY_EVIDENCE_METADATA_KEY] !== undefined,
    ),
  );
  if (recalled.size === 0) return history;
  const messages: Record<string, Message> = {};
  for (const [id, message] of Object.entries(history.messages)) {
    if (!recalled.has(id)) messages[id] = message;
  }
  return { ...history, ids: history.ids.filter((id) => !recalled.has(id)), messages };
}

/**
 * A conversation whose rows hold only text parts, for the roles `roles` names (every role when
 * omitted). An AG-UI assistant message carries text only, so `toAGUIMessages` throws on a
 * server-tool, `container_upload` or generated-image part. A snapshot is a view of the thread, so
 * those parts are left out of it rather than failing it; the row itself stays, with its text.
 */
function textOnly(
  history: ConversationHistory,
  roles?: ReadonlySet<Message['role']>,
): ConversationHistory {
  const messages: Record<string, Message> = {};
  for (const [id, message] of Object.entries(history.messages)) {
    if (typeof message.content === 'string' || (roles && !roles.has(message.role))) {
      messages[id] = message;
      continue;
    }
    const kept = message.content.filter((part) => part.type === 'text');
    messages[id] = kept.length === message.content.length ? message : { ...message, content: kept };
  }
  return { ...history, messages };
}

/**
 * A conversation whose assistant rows carry their managed assets in `metadata`, listed under
 * {@link ASSET_PARTS_METADATA_KEY} with each asset's position among the row's parts. Read before
 * any part is taken out of the row, so the positions are the ones the run counted.
 */
function withAssetPartsInMetadata(history: ConversationHistory): ConversationHistory {
  const messages: Record<string, Message> = {};
  for (const [id, message] of Object.entries(history.messages)) {
    const assets =
      message.role === 'assistant' && typeof message.content !== 'string'
        ? assetPartsOf(message.content)
        : [];
    messages[id] =
      assets.length === 0
        ? message
        : { ...message, metadata: { ...message.metadata, [ASSET_PARTS_METADATA_KEY]: assets } };
  }
  return { ...history, messages };
}

/**
 * A conversation whose user rows name each managed asset the way an inbound message does, as a
 * `provider-file` source from the provider `bureau`, which Conversationalist exports as an AG-UI
 * `file` source. Applied to user rows only: no other role carries media in AG-UI.
 */
function withAssetFileSources(history: ConversationHistory): ConversationHistory {
  const messages: Record<string, Message> = {};
  for (const [id, message] of Object.entries(history.messages)) {
    if (message.role !== 'user' || typeof message.content === 'string') {
      messages[id] = message;
      continue;
    }
    let changed = false;
    const content = message.content.map((part): MultiModalContent => {
      if (!('source' in part) || part.source.kind !== 'managed-asset') return part;
      changed = true;
      return {
        ...part,
        source: {
          kind: 'provider-file',
          provider: ASSET_FILE_PROVIDER,
          providerFileId: part.source.assetId,
        },
      };
    });
    messages[id] = changed ? { ...message, content } : message;
  }
  return { ...history, messages };
}

/**
 * The `messages` of a `MESSAGES_SNAPSHOT` for `history`, with no reasoning in it and none of the
 * rows a run's memory recall appended. It never throws
 * for a part the AG-UI mapping cannot carry (COR-713): an assistant row keeps its text, and should
 * any other row still be refused, every row is reduced to its text.
 */
export function snapshotMessages(history: ConversationHistory): AgUiMessage[] {
  const visible = withAssetFileSources(
    withoutReasoning(withAssetPartsInMetadata(withoutMemoryEvidence(history))),
  );
  try {
    return agUiConversationAdapter.export(textOnly(visible, new Set(['assistant'])));
  } catch {
    return agUiConversationAdapter.export(textOnly(visible));
  }
}

/** The row a human's answer appends to a run's conversation: its id, and the text the run renders. */
export type AnswerRow = { readonly id: string; readonly content: string };

/**
 * The `messages` of a `MESSAGES_SNAPSHOT` that also carries the answers a resume just delivered,
 * for the ones `history` does not hold yet (the run appends its own row when it wakes, which a
 * stream that opens first has not seen). An answer travels as a row of this snapshot and never as
 * a user-role `TEXT_MESSAGE_*` run: a client reads a snapshot's rows as the thread, and may
 * discard text of a role it did not stream. A row `history` already holds is the snapshot's own
 * and is not added again.
 */
export function snapshotMessagesWithAnswers(
  history: ConversationHistory | undefined,
  answerRows: ReadonlyArray<AnswerRow>,
): AgUiMessage[] {
  const messages = history === undefined ? [] : snapshotMessages(history);
  const held = new Set(history?.ids ?? []);
  for (const row of answerRows) {
    if (held.has(row.id)) continue;
    held.add(row.id);
    messages.push({ id: row.id, role: 'user', content: row.content });
  }
  return messages;
}

/**
 * The row with each `file` source from the provider `bureau` turned into the `managed-asset`
 * source it names. The part keeps its `mimeType` when it carried one; the asset's own detected
 * media type is the one a model is given.
 */
function withManagedAssetSources(row: Message): Message {
  if (typeof row.content === 'string') return row;
  let changed = false;
  const content = row.content.map((part): MultiModalContent => {
    if (
      !('source' in part) ||
      part.source.kind !== 'provider-file' ||
      part.source.provider !== ASSET_FILE_PROVIDER
    ) {
      return part;
    }
    changed = true;
    return { ...part, source: { kind: 'managed-asset', assetId: part.source.providerFileId } };
  });
  return changed ? { ...row, content } : row;
}

/**
 * The rows `messages` adds to `history`: every message whose id `history` lacks.
 * A client sends its whole thread with each start, so the rows it already holds
 * are skipped, not refused. A part that names a managed asset arrives as one
 * (`managed-asset` source), so the run resolves it as the thread's owner.
 */
export function rowsAddedBy(history: ConversationHistory, messages: ReadonlyArray<AgUiMessage>) {
  const merged = mergeAGUIMessages(history, messages);
  const known = new Set(history.ids);
  return merged.ids
    .filter((id) => !known.has(id))
    .map((id) => withoutReservedMetadata(withManagedAssetSources(merged.messages[id]!)));
}

/**
 * The row without the metadata only the server may set. A client's message carries whatever
 * `metadata` it sends, and `memoryEvidence` marks the row a run's memory recall appended: left on
 * a client's row, it would hide that row from the thread's snapshot while the model still read it
 * (COR-1546). Every row that enters from a client comes through here, so only the recall hook sets it.
 */
function withoutReservedMetadata(row: Message): Message {
  if (row.metadata?.[MEMORY_EVIDENCE_METADATA_KEY] === undefined) return row;
  const { [MEMORY_EVIDENCE_METADATA_KEY]: _reserved, ...metadata } = row.metadata;
  return { ...row, metadata };
}

/** The ids of the managed assets `rows` name, in order, each once. */
export function managedAssetIdsOf(rows: ReadonlyArray<Message>): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const { part } of messageMediaParts(row)) {
      if (part.source.kind === 'managed-asset') ids.add(part.source.assetId);
    }
  }
  return [...ids];
}
