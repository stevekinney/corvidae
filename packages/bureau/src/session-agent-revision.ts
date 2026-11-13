import type { RunOptions } from '@lostgradient/operative';
import { Conversation, getFirstSystemMessage } from 'conversationalist';

import { type AgentDefinitionPin, pinOf } from './agent-definition-pin';

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
/**
 * COR-2230 — the pin the run `runId` recorded in a session's metadata. The metadata holds one pin,
 * the latest pinning run's, and names that run beside it: a session holds runs that never write one
 * (a schedule fire's approvals are restored under the same session keys as a chat's), and a run is
 * compared only with a pin it wrote itself. A run that is not the pin's, a session written before
 * the pin, and a recovery with no run id get an empty pin, which never drifts.
 */
export function sessionRecordedPin(
  metadata: Readonly<Record<string, unknown>>,
  runId: string | undefined,
): AgentDefinitionPin {
  if (runId === undefined || metadata[SESSION_AGENT_PIN_RUN_METADATA_KEY] !== runId) return {};
  return pinOf(
    metadata[SESSION_AGENT_PLUGIN_VERSION_METADATA_KEY],
    metadata[SESSION_AGENT_OVERRIDE_HASH_METADATA_KEY],
  );
}
/**
 * The metadata entries the run `runId` writes as it starts with `pin`: the pin's two fields (`null`
 * for a field the agent has none of) and the run that holds them.
 */
export function sessionPinMetadata(
  pin: AgentDefinitionPin | undefined,
  runId: string,
): {
  readonly [SESSION_AGENT_PIN_RUN_METADATA_KEY]: string;
  readonly [SESSION_AGENT_PLUGIN_VERSION_METADATA_KEY]: string | null;
  readonly [SESSION_AGENT_OVERRIDE_HASH_METADATA_KEY]: string | null;
} {
  return {
    [SESSION_AGENT_PIN_RUN_METADATA_KEY]: runId,
    [SESSION_AGENT_PLUGIN_VERSION_METADATA_KEY]: pin?.agentPluginVersion ?? null,
    [SESSION_AGENT_OVERRIDE_HASH_METADATA_KEY]: pin?.agentOverrideHash ?? null,
  };
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
 * COR-2230 — session metadata: the plugin version (a plugin agent's own `version`, else its
 * plugin's; `null` for a built-in agent) and the override hash the latest run's code agent started
 * with. A session written before these existed holds neither, and its run recovers as it did.
 */
export const SESSION_AGENT_PLUGIN_VERSION_METADATA_KEY = 'lastAgentPluginVersion';
export const SESSION_AGENT_OVERRIDE_HASH_METADATA_KEY = 'lastAgentOverrideHash';
/** The run that wrote the two entries above (a chat run, or a schedule fire). */
export const SESSION_AGENT_PIN_RUN_METADATA_KEY = 'lastAgentPinRunId';
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
