import type { RunOptions } from '@lostgradient/operative';
import { Conversation, getFirstSystemMessage } from 'conversationalist';

/** The text of the first system message `options.conversation` carries, or `undefined`. */
export function agentInstructionsFromRunOptions(options: RunOptions): string | undefined {
  const history =
    options.conversation instanceof Conversation
      ? options.conversation.current
      : options.conversation;
  const content = getFirstSystemMessage(history)?.content;
  if (typeof content === 'string') return content;
  if (content === undefined) return undefined;
  const text = content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
  return text.length === 0 ? undefined : text;
}
/** The input a session run resolves its agent with; the run's own conversation replaces it. */
export const SESSION_AGENT_PLACEHOLDER_INPUT = 'session run';
/** The default agent a run with no `agentName` belongs to; it has no catalog entry. */
export const BUREAU_AGENT_NAME = 'bureau';
/** Session metadata: the definition revision of the named agent the latest run started under. */
export const SESSION_AGENT_REVISION_METADATA_KEY = 'lastAgentRevision';
/**
 * COR-1524 — where a session run records the SHA-256 of the agent file it started with (`null`
 * for a code-defined agent), so a recovered run builds from its snapshot.
 */
export const SESSION_AGENT_DEFINITION_HASH_METADATA_KEY = 'lastAgentDefinitionHash';
/**
 * COR-1584 — the definition revision a session's metadata recorded for the definition at `hash`.
 * A session's metadata names its latest run's definition only, so the revision is the run's own
 * only when the hash is the one the metadata names; any other run's revision is not recorded
 * there, and the caller gets `undefined`.
 */
export function sessionRecordedRevision(
  metadata: Readonly<Record<string, unknown>>,
  hash: unknown,
): number | undefined {
  const revision = metadata[SESSION_AGENT_REVISION_METADATA_KEY];
  return typeof hash === 'string' &&
    metadata[SESSION_AGENT_DEFINITION_HASH_METADATA_KEY] === hash &&
    typeof revision === 'number'
    ? revision
    : undefined;
}
