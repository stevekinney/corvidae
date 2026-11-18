<script lang="ts" module>
  export type {
    ChatConversationHeaderHeadingLevel,
    ChatConversationHeaderProps,
  } from './chat-conversation-header.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';
  import ConversationExportActions from '../chat/export/conversation-export-actions.svelte';
  import { deriveConversationSummary } from '../chat-conversation-list/conversation-summary.ts';
  import type {
    ChatConversationHeaderHeadingLevel,
    ChatConversationHeaderProps,
  } from './chat-conversation-header.types.ts';

  let {
    conversation,
    headingLevel = 2,
    exportActionsVisible = true,
    class: className,
    actions,
    ...rest
  }: ChatConversationHeaderProps = $props();

  const summary = $derived(deriveConversationSummary(conversation));
  const headingTag = $derived(
    `h${headingLevel}` satisfies `h${ChatConversationHeaderHeadingLevel}`,
  );
  const participantLabel = $derived(
    summary.participantNames.length === 0
      ? undefined
      : summary.participantNames.length <= 2
        ? summary.participantNames.join(', ')
        : `${summary.participantNames.slice(0, 2).join(', ')} +${summary.participantNames.length - 2}`,
  );
  const fullParticipantLabel = $derived(summary.participantNames.join(', '));
</script>

<header class={classNames('cinder-chat-conversation-header', className)} {...rest}>
  <div class="cinder-chat-conversation-header__main">
    <svelte:element this={headingTag} class="cinder-chat-conversation-header__title">
      {summary.title}
    </svelte:element>
    <p class="cinder-chat-conversation-header__meta">
      <span>
        {summary.messageCount}
        {summary.messageCount === 1 ? 'message' : 'messages'}
      </span>
      <span class="cinder-chat-conversation-header__status">{summary.status}</span>
      {#if participantLabel}
        <span
          class="cinder-chat-conversation-header__participants"
          title={fullParticipantLabel}
          aria-label={fullParticipantLabel}
        >
          {participantLabel}
        </span>
      {/if}
    </p>
  </div>

  {#if exportActionsVisible || actions}
    <div class="cinder-chat-conversation-header__actions">
      {#if exportActionsVisible}
        <ConversationExportActions id={`${conversation.id}-export-actions`} {conversation} />
      {/if}
      {#if actions}
        {@render actions(summary)}
      {/if}
    </div>
  {/if}
</header>
