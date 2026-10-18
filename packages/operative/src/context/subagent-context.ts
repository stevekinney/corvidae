/**
 * Subagent context isolation.
 *
 * Provides helpers to prepare an isolated conversation for a subagent
 * (inheriting parent system messages and recent context) and to merge
 * the subagent's result back into the parent conversation.
 */

import type { Conversation, JSONValue, Message, MultiModalContent } from 'conversationalist';
import { Conversation as ConversationClass, copyContent, isMediaContent } from 'conversationalist';

/** Options for preparing a subagent's conversation context. */
export interface PrepareSubagentContextOptions {
  /** Instructions injected as a system message in the child conversation. */
  instructions: string;
  /**
   * Number of recent non-system parent messages to include as context.
   * Default: `2`.
   */
  recentParentMessageCount?: number | undefined;
}

/** Options for merging a subagent result back into the parent. */
export interface MergeSubagentResultOptions {
  /** The text content produced by the subagent. */
  content: string;
  /** Name of the subagent, stored in metadata for provenance tracking. */
  agentName?: string | undefined;
}

/**
 * Projects a parent message's content for a child conversation: text and media
 * parts are carried over unchanged and in order, so a document the parent was
 * given is the same document in the child, never an empty string or a line of
 * prose about it. Provider-private blocks (reasoning with its signature, server
 * tool use and results, container uploads) belong to the parent's provider
 * session and are not replayed into a child. A message left with nothing to
 * carry is skipped, not appended empty.
 */
function projectContentForChild(
  content: Message['content'],
): string | MultiModalContent[] | undefined {
  if (typeof content === 'string') return content;
  const carried = content.filter((part) => part.type === 'text' || isMediaContent(part));
  return carried.length === 0 ? undefined : copyContent(carried);
}

/**
 * Creates a new, isolated `Conversation` for a subagent.
 *
 * The child conversation inherits:
 * - All system messages from the parent.
 * - A summary of the most recent parent messages (controlled by
 *   `recentParentMessageCount`).
 * - The subagent's own instructions injected as a system message.
 *
 * Mutations to the child conversation do not affect the parent.
 */
export function prepareSubagentContext(
  parentConversation: Conversation,
  options: PrepareSubagentContextOptions,
): Conversation {
  const { instructions, recentParentMessageCount = 2 } = options;

  const child = new ConversationClass();
  const parentMessages = parentConversation.getMessages();

  // Copy system messages from parent
  const systemMessages = parentMessages.filter((m: Message) => m.role === 'system');
  for (const msg of systemMessages) {
    const content = projectContentForChild(msg.content);
    if (content !== undefined) child.appendMessages({ role: 'system', content });
  }

  // Inject subagent instructions
  child.appendSystemMessage(instructions);

  // Include recent parent context
  const nonSystem = parentMessages.filter((m: Message) => m.role !== 'system');
  const recentMessages = nonSystem.slice(-recentParentMessageCount);

  for (const msg of recentMessages) {
    const content = projectContentForChild(msg.content);
    if (content === undefined) continue;
    if (msg.role === 'user') {
      child.appendUserMessage(content);
    } else if (msg.role === 'assistant') {
      child.appendAssistantMessage(content);
    }
    // Tool calls and results are not copied to subagent context
  }

  return child;
}

/**
 * Merges a subagent's result into the parent conversation as an assistant
 * message with metadata indicating the source agent.
 */
export function mergeSubagentResult(
  parentConversation: Conversation,
  options: MergeSubagentResultOptions,
): void {
  const { content, agentName } = options;

  const metadata: Record<string, JSONValue> = {
    subagentResult: true,
  };

  if (agentName) {
    metadata['subagentName'] = agentName;
  }

  parentConversation.appendAssistantMessage(content, metadata);
}
