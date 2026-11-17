<script lang="ts" module>
  export const title = 'Transcript: a reply that stopped partway';
  export const description =
    'The failure is a status line below the partial reply, not agent speech: danger text with an error glyph, "The reply stopped partway: the model provider dropped the connection.", and a secondary Retry beside it. Retry replaces the partial reply with a fresh one.';
</script>

<script lang="ts">
  import {
    appendAssistantMessage,
    appendUserMessage,
    Chat,
    CINDER_NOTES_METADATA_KEY,
    createConversation,
    type ChatAdapter,
  } from '@lostgradient/chat';
  import { Button } from '@lostgradient/cinder';

  const adapter: ChatAdapter = { sendMessage: async () => undefined };
  const base = appendAssistantMessage(
    appendUserMessage(
      createConversation({ id: 'transcript-stopped-partway' }),
      'Please refund order 4471, it arrived damaged.',
    ),
    'Order 4471 is $42.00, delivered Monday, and the carrier flagged it as',
  );
  const replyId = base.ids[base.ids.length - 1]!;
  const conversation = {
    ...base,
    messages: {
      ...base.messages,
      [replyId]: {
        ...base.messages[replyId]!,
        metadata: {
          [CINDER_NOTES_METADATA_KEY]: [
            {
              kind: 'stopped',
              id: 'stopped',
              failed: true,
              reason: 'The reply stopped partway: the model provider dropped the connection.',
            },
          ],
        },
      },
    },
  };
</script>

<div style="block-size: 26rem;">
  <Chat
    id="transcript-stopped-partway"
    {conversation}
    surfaceMode="transparent"
    variant="transcript"
    capabilities={{ editing: false }}
    composerPlaceholder="Message Tool runner…"
    {adapter}
  >
    {#snippet noteAction()}
      <Button type="button" size="sm" variant="secondary">Retry</Button>
    {/snippet}
  </Chat>
</div>
