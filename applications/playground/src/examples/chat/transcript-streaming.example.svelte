<script lang="ts" module>
  export const title = 'Transcript: a reply that is streaming';
  export const description =
    'While a reply streams, its tool call shows as a rail row with a spinner, “Running…” and the elapsed time, and the reply ends in a caret, with no line of time, Copy or Quote under it yet and no typing dots. Stop replaces Send in the composer.';
</script>

<script lang="ts">
  import {
    appendStreamingMessage,
    appendUserMessage,
    Chat,
    createConversation,
    updateStreamingMessage,
    type ChatAdapter,
  } from '@lostgradient/chat';
  import { ToolCallRail, type ToolCallRailCall } from '@lostgradient/cinder';

  const CALLS: ToolCallRailCall[] = [
    { id: 'call-1', name: 'Lookup order', input: '4398', duration: '1.2s', status: 'running' },
  ];

  const adapter: ChatAdapter = {
    sendMessage: async () => undefined,
    stopGenerating: async () => undefined,
  };
  // The reply is a streaming row, so it draws a caret and no line of actions.
  const opened = appendStreamingMessage(
    appendUserMessage(
      createConversation({ id: 'transcript-streaming' }),
      'Also look up order 4398, the same carrier.',
    ),
    'assistant',
  );
  const conversation = updateStreamingMessage(
    opened.conversation,
    opened.messageId,
    'Looking up order 4398…',
  );
</script>

<div style="block-size: 24rem;">
  <Chat
    id="transcript-streaming"
    {conversation}
    surfaceMode="transparent"
    variant="transcript"
    streaming
    capabilities={{ editing: false }}
    composerPlaceholder="Message Tool runner…"
    {adapter}
  >
    <!-- The call sits under the message that asked for it and above the reply, as the board draws it. -->
    {#snippet row(context, renderDefault)}
      {@render renderDefault()}
      {#if context.message.role === 'user'}
        <ToolCallRail calls={CALLS} />
      {/if}
    {/snippet}
  </Chat>
</div>
