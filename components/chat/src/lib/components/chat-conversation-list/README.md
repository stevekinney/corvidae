# ChatConversationList

Conversation navigation list for switching among Chat transcripts without embedding the list inside Chat.

## Usage

```svelte
<script lang="ts">
  import { ChatConversationList } from '@lostgradient/chat';
</script>

<ChatConversationList
  conversations={conversationSummaries}
  activeConversationId={activeConversation.id}
  onSelectConversation={selectConversation}
/>
```

## Agent, activity, and loading more

Each `ConversationSummary` can carry an optional `agent` (`{ id, name }`), shown as a label on its row, and an optional `activity` of `idle`, `running`, or `awaiting-input`. `running` and `awaiting-input` render a status indicator with a visible label and an accessible name; `idle`, or no `activity`, renders nothing. A row with neither field renders exactly as it did before.

```svelte
<ChatConversationList
  conversations={[
    {
      ...summary,
      agent: { id: 'atlas', name: 'Atlas' },
      activity: 'running',
    },
  ]}
  onSelectConversation={selectConversation}
  hasMore={hasMoreConversations}
  loading={loadingConversations}
  onLoadMore={loadNextPage}
  class="session-list"
/>
```

Passing `onLoadMore` while `hasMore` is `true` renders Cinder's `LoadMore` after the last row, with the list itself as its scroll container, so the next page loads when the user scrolls to the end of the list. The button stays available as a fallback, and `buttonLabel` and `onError` are passed through. The list does not fetch or page anything: the host supplies the rows, flips `hasMore` and `loading`, and handles the callback. Give the list a bounded height (for example with `class` or a flex or grid parent) so it scrolls inside that region; the list only becomes a scroll container while the load-more control is showing.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `activeConversationId` | `string` \| `null` | no | — | Currently active conversation id. |
| `ariaLabel` | `string` | no | — | Accessible name for the conversations navigation landmark. Default `"Conversations"`. |
| `buttonLabel` | `string` | no | — | Visible label for the load-more button. Default `"Load more"`. |
| `class` | `string` | no | — | Additional class name merged with `.cinder-chat-conversation-list`. |
| `emptyText` | `string` | no | — | Empty state text when no conversations are present. Default `"No conversations"`. |
| `hasMore` | `boolean` | no | — | Whether more conversations are available. The load-more control renders only while this is `true`. Default `false`. |
| `loading` | `boolean` | no | — | Whether a page is loading. Disables the load-more button and marks it busy. Default `false`. |
| `conversations` | `(opaque)` | yes | — | Conversation summaries to render. Sorts by latest message/update time descending. Not expressible in JSON Schema; see the component types for the signature. |
| `onError` | `(opaque)` | no | — | Called when `onLoadMore` throws or rejects. Not expressible in JSON Schema; see the component types for the signature. |
| `onLoadMore` | `(opaque)` | no | — | Called when the next page of conversations should load, which is when the user scrolls to the end of the list or activates the load-more button. Providing it, with `hasMore`, renders Cinder's `LoadMore` after the last row. The host supplies the rows and flips `hasMore` and `loading`. Not expressible in JSON Schema; see the component types for the signature. |
| `onSelectConversation` | `(opaque)` | no | — | Called when a conversation is selected. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.

<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
