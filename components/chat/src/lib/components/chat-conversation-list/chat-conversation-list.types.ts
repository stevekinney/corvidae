import type { HTMLAttributes } from 'svelte/elements';
import type { ConversationSummary } from './conversation-summary.ts';

/** Props for the ChatConversationList component. */
export type ChatConversationListProps = Omit<HTMLAttributes<HTMLElement>, 'class'> & {
  /** Conversation summaries to render. Sorts by latest message/update time descending. */
  conversations: readonly ConversationSummary[];
  /** Currently active conversation id. */
  activeConversationId?: string | null;
  /** Accessible name for the conversations navigation landmark. Default `"Conversations"`. */
  ariaLabel?: string;
  /** Empty state text when no conversations are present. Default `"No conversations"`. */
  emptyText?: string;
  /** Additional class name merged with `.cinder-chat-conversation-list`. */
  class?: string;
  /** Called when a conversation is selected. */
  onSelectConversation?: (conversationId: string) => void;
  /**
   * Called when the next page of conversations should load, which is when the
   * user scrolls to the end of the list or activates the load-more button.
   * Providing it, with `hasMore`, renders Cinder's `LoadMore` after the last
   * row. The host supplies the rows and flips `hasMore` and `loading`.
   */
  onLoadMore?: () => void | Promise<void>;
  /** Whether more conversations are available. The load-more control renders only while this is `true`. Default `false`. */
  hasMore?: boolean;
  /** Whether a page is loading. Disables the load-more button and marks it busy. Default `false`. */
  loading?: boolean;
  /** Visible label for the load-more button. Default `"Load more"`. */
  buttonLabel?: string;
  /** Called when `onLoadMore` throws or rejects. */
  onError?: (error: unknown) => void;
};
