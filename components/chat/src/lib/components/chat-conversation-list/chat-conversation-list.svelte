<script lang="ts" module>
  /**
   * @cinder
   * @category domain
   * @status domain-suite
   * @purpose Conversation navigation list for switching among Chat transcripts without embedding the list inside Chat.
   * @tag chat
   * @tag conversation
   * @tag navigation
   * @useWhen Rendering a multi-conversation chat sidebar beside one active Chat transcript.
   * @useWhen Showing unread counts and last-message previews for compatible conversation snapshots.
   * @avoidWhen Rendering the message transcript itself — use chat for the active conversation surface.
   * @avoidWhen Building app-wide primary navigation — use side-navigation or navigation-bar.
   * @related chat, chat-conversation-header, side-navigation
   */
  export type { ChatConversationListProps } from './chat-conversation-list.types.ts';
  export type {
    ConversationActivity,
    ConversationAgent,
    ConversationSummary,
  } from './conversation-summary.ts';
  export { deriveConversationSummary } from './conversation-summary.ts';
</script>

<script lang="ts">
  import { LoadMore, StatusDot } from '@lostgradient/cinder';
  import { classNames } from '../../utilities/class-names.ts';
  import type { ChatConversationListProps } from './chat-conversation-list.types.ts';
  import { conversationSummaryTimestamp } from './conversation-summary.ts';

  let {
    conversations,
    activeConversationId = null,
    ariaLabel = 'Conversations',
    emptyText = 'No conversations',
    class: className,
    onSelectConversation,
    onLoadMore,
    hasMore = false,
    loading = false,
    buttonLabel,
    onError,
    ...rest
  }: ChatConversationListProps = $props();

  const sortedConversations = $derived.by(() =>
    conversations
      .slice()
      .sort((a, b) => conversationSummaryTimestamp(b) - conversationSummaryTimestamp(a)),
  );

  function preview(summary: (typeof sortedConversations)[number]): string {
    const text = summary.lastMessageText?.trim();
    if (!text) return summary.messageCount === 1 ? '1 message' : `${summary.messageCount} messages`;
    return text.length > 96 ? `${text.slice(0, 93)}...` : text;
  }

  function unreadMessageLabel(unreadCount: number): string {
    return unreadCount === 1 ? '1 unread message' : `${unreadCount} unread messages`;
  }

  const activityLabels = {
    running: 'Running',
    'awaiting-input': 'Awaiting input',
  } as const;
  const activityStatuses = { running: 'accent', 'awaiting-input': 'warning' } as const;

  // The list is the scroll container LoadMore observes, so its sentinel fires as
  // the user scrolls to the end of the list. LoadMore captures its root once, when
  // it is created, so it is only created after the element exists.
  let listElement = $state<HTMLElement | null>(null);
  // Left out rather than passed as `undefined`, so LoadMore keeps its own defaults.
  const loadMoreOptions = $derived({
    ...(buttonLabel === undefined ? {} : { buttonLabel }),
    ...(onError === undefined ? {} : { onError }),
  });

  const resolvedAriaLabel = $derived(
    typeof ariaLabel === 'string' && ariaLabel.trim().length > 0 ? ariaLabel : undefined,
  );
</script>

{#snippet rowContent(conversation: (typeof sortedConversations)[number])}
  <span class="cinder-chat-conversation-list__title">{conversation.title}</span>
  <span class="cinder-chat-conversation-list__preview">{preview(conversation)}</span>
  {#if conversation.unreadCount > 0}
    <span class="cinder-chat-conversation-list__badge" aria-hidden="true">
      {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
    </span>
    <span class="cinder-sr-only">, {unreadMessageLabel(conversation.unreadCount)}</span>
  {/if}
  {#if conversation.agent || (conversation.activity && conversation.activity !== 'idle')}
    <span class="cinder-chat-conversation-list__meta">
      {#if conversation.agent}
        <span class="cinder-chat-conversation-list__agent" data-cinder-conversation-agent>
          <span class="cinder-sr-only">Agent:</span>
          {conversation.agent.name}
        </span>
      {/if}
      {#if conversation.activity && conversation.activity !== 'idle'}
        <StatusDot
          class="cinder-chat-conversation-list__activity"
          size="sm"
          status={activityStatuses[conversation.activity]}
          label={activityLabels[conversation.activity]}
          data-cinder-conversation-activity={conversation.activity}
        />
      {/if}
    </span>
  {/if}
{/snippet}

<nav
  bind:this={listElement}
  {...rest}
  class={classNames('cinder-chat-conversation-list', className)}
  aria-label={resolvedAriaLabel}
  data-cinder-conversation-list-scrolls={onLoadMore === undefined ? undefined : ''}
>
  {#if sortedConversations.length === 0}
    <p class="cinder-chat-conversation-list__empty" role="status">{emptyText}</p>
  {:else}
    <ul class="cinder-chat-conversation-list__items">
      {#each sortedConversations as conversation (conversation.id)}
        {@const isActive = conversation.id === activeConversationId}
        <li class="cinder-chat-conversation-list__item">
          {#if onSelectConversation}
            <button
              type="button"
              class="cinder-chat-conversation-list__button"
              aria-current={isActive ? 'page' : undefined}
              data-cinder-conversation-item
              data-cinder-conversation-interactive
              data-cinder-conversation-selected={isActive ? '' : undefined}
              onclick={() => onSelectConversation(conversation.id)}
            >
              {@render rowContent(conversation)}
            </button>
          {:else}
            <div
              class="cinder-chat-conversation-list__button"
              aria-current={isActive ? 'page' : undefined}
              data-cinder-conversation-item
              data-cinder-conversation-static
              data-cinder-conversation-selected={isActive ? '' : undefined}
            >
              {@render rowContent(conversation)}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if onLoadMore && hasMore && listElement}
    <LoadMore {onLoadMore} {hasMore} {loading} root={listElement} {...loadMoreOptions} />
  {/if}
</nav>
