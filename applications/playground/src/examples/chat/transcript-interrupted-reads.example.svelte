<script lang="ts" module>
  export const title = 'Transcript: interrupted while a reading tool ran';
  export const description =
    'The run ended while Lookup order, a tool that only reads, was running. Its row shows "Interrupted · didn’t finish" in danger text with an error glyph, never a dot, and the status line says the call didn’t finish and nothing was changed, with a secondary Retry that sends the turn again.';
</script>

<script lang="ts">
  import {
    appendUserMessage,
    Chat,
    CINDER_NOTES_METADATA_KEY,
    createConversation,
    type ChatAdapter,
  } from '@lostgradient/chat';
  import { Button, ToolCallRail } from '@lostgradient/cinder';

  const adapter: ChatAdapter = { sendMessage: async () => undefined };
  const base = appendUserMessage(
    createConversation({ id: 'transcript-interrupted-reads' }),
    'Please refund order 4471, it arrived damaged.',
  );
  const userId = base.ids[base.ids.length - 1]!;
  const conversation = {
    ...base,
    messages: {
      ...base.messages,
      [userId]: {
        ...base.messages[userId]!,
        metadata: {
          [CINDER_NOTES_METADATA_KEY]: [
            {
              kind: 'stopped',
              id: 'stopped',
              failed: true,
              reason:
                'The reply stopped while Lookup order was running: the model provider dropped the connection. Lookup order didn’t finish and nothing was changed.',
            },
          ],
        },
      },
    },
  };
</script>

<div
  style="display: grid; gap: 0.5rem; block-size: 30rem; grid-template-rows: auto minmax(0, 1fr);"
>
  <ToolCallRail
    calls={[
      {
        id: 'call-1',
        name: 'Lookup order',
        input: '4471',
        result: 'Interrupted · didn’t finish',
        duration: '1.2s',
        status: 'interrupted',
      },
    ]}
  />
  <Chat
    id="transcript-interrupted-reads"
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
