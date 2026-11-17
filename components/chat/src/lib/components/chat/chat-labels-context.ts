/**
 * Chat's words for the parts deep inside a message's content (COR-2439): a code block, a wide
 * table's overflow cue, an image that did not load. Each message hands its resolved `labels` down
 * through a Svelte context rather than through every Markdown node, so the content renderers read
 * the same words the rest of Chat does. Outside a message they read the English defaults.
 */
import { getContext, setContext } from 'svelte';

import { DEFAULT_CHAT_LABELS, type ChatLabels } from './chat-labels.ts';

const CHAT_LABELS_CONTEXT = Symbol('chat-labels');

/** Hands the message's words to everything it renders; `read` is called on each use, so they stay current. */
export function setChatLabelsContext(read: () => ChatLabels): void {
  setContext(CHAT_LABELS_CONTEXT, read);
}

/** The words the enclosing message hands down, read when called, or the defaults outside one. */
export function useChatLabels(): () => ChatLabels {
  return (
    getContext<(() => ChatLabels) | undefined>(CHAT_LABELS_CONTEXT) ?? (() => DEFAULT_CHAT_LABELS)
  );
}
