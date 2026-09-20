# Chat-room interface surfaces

The chat-room application is the integration test for Corvidae's browser surfaces. The component packages render conversation state, approvals, artifacts, and review UI; this application owns the route, credentials, durable session, and recovery decisions. The [reference architecture](./reference-architecture.md) describes the wire contract, while this page shows how the pieces fit together at the interface boundary.

## Conversation layout

`@corvidae/chat` owns the transcript and composer. Give `Chat` an ancestor with a resolved height because its root fills `height: 100%`.

```svelte
<script lang="ts">
  import { Chat, createConversation } from '@corvidae/chat';

  let conversation = $state(createConversation({ id: 'demo' }));
</script>

<div class="chat-shell">
  <Chat id="conversation" {conversation} />
</div>

<style>
  .chat-shell {
    block-size: 100dvh;
  }
</style>
```

Keep the conversation snapshot authoritative in the host. The component owns transient streaming presentation, typing presence, read receipts, and the message affordances; the adapter owns transport and persists accepted mutations. When `ChatAdapter.subscribe` replays state synchronously, defer the callback with `queueMicrotask` or `tick()` so the subscription does not update Chat during its mount effect.

## Streaming and failed delivery

Create the assistant placeholder before calling `beginStreaming`, update that same message for every token, and finalize it before `endStreaming`. If the backend rejects the request, cancel the placeholder, mark the optimistic user message as failed, and rethrow so `onadaptererror` can expose Retry.

```svelte
<script lang="ts">
  import {
    Chat,
    appendStreamingMessage,
    appendUserMessage,
    cancelStreamingMessage,
    createConversation,
    finalizeStreamingMessage,
    updateStreamingMessage,
    type ChatAdapter,
    type ConversationHistory,
  } from '@corvidae/chat';

  let chat: ReturnType<typeof Chat> | undefined;
  let conversation = $state<ConversationHistory>(createConversation({ id: 'streaming' }));
  let streaming = $state(false);
  const responseChunks = ['This reply ', 'comes ', 'from ', 'a finite stream.'];

  const adapter: ChatAdapter = {
    async sendMessage(message) {
      conversation = appendUserMessage(conversation, message.content);
      const started = appendStreamingMessage(conversation, 'assistant');
      conversation = started.conversation;
      streaming = true;
      chat?.beginStreaming(started.messageId);

      let content = '';
      try {
        for (const chunk of responseChunks) {
          content += chunk;
          conversation = updateStreamingMessage(conversation, started.messageId, content);
          chat?.pushToken(chunk);
        }
        conversation = finalizeStreamingMessage(conversation, started.messageId);
      } catch (error) {
        conversation = cancelStreamingMessage(conversation, started.messageId);
        throw error;
      } finally {
        chat?.endStreaming();
        streaming = false;
      }
    },
  };
</script>

<div style="height: 34rem;">
  <Chat bind:this={chat} id="streaming-chat" {conversation} {adapter} {streaming} />
</div>
```

This ordering keeps stable geometry for the partial message and prevents a failed request from looking like a successful empty response. `retryMessage` and `editMessage` use the same delivery-status helpers; the successful attempt clears the transient failure marker.

## Approvals and artifacts

Tool results with `outcome: 'action_required'` are the transcript-level source of truth for pending approvals. Render them with Cinder's [`ApprovalCard`](../../../components/cinder/src/components/approval-card/README.md), record the resolution in the server-owned route, and replace the parked tool result with `replaceToolResult`. The card never executes a command or reads an environment value.

Artifacts stay attached to their message through `message.metadata['cinder:artifact']`. Chat resolves paired tool-result metadata even when the result row is folded into its tool-call row. Use `messageActions` to open application-owned panel state and compose [`ArtifactViewer`](../../../components/chat/README.md#rendering-mermaid-artifacts); Mermaid rendering remains application-owned so the host can choose its version and content-safety policy.

## Server-owned sessions

The `/server-owned` route moves execution ownership to the server while the browser remains a projection of the authoritative snapshot. A browser refresh should rehydrate the conversation, preserve unresolved approvals, and distinguish a cancelled run from a failed run. The route's recovery endpoint classifies an interrupted run as orphaned before allowing a new attempt; it does not silently create a second worker.

When a stream ends, reconcile the final snapshot once, then finalize the partial message. On a protocol error, abort the fetch and reader before marking the message failed so the server can finish its cleanup path. The [durability exercise](./durability-exercise.md) records the kill and restart sequence and the expected observations.

## Accessibility and sizing

Keep the transcript reading measure and message affordances stable while streaming. Timestamps and read receipts belong in the message flow, tool activity uses prose plus an icon, and color never carries approval, failure, or presence state by itself. Give custom artifact renderers an accessible name and preserve keyboard access to image maximize controls and message actions.

The application checks these contracts with the browser suites for hydration, streaming, error live regions, approvals, recovery, and synchronization. Run the focused checks from `applications/chat-room` while changing a surface, then run the workspace validation before delivery.
