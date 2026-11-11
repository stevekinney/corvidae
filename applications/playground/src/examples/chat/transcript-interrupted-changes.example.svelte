<script lang="ts" module>
  export const title = 'Transcript: interrupted while a changing tool ran';
  export const description =
    'The run ended while Issue refund, a tool that changes things, was running. Its row shows "Interrupted, may have run" in danger text, and the status line says the call may have run and Retry goes back through the approval. It never says nothing was changed, so a refund cannot be issued twice.';
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
    createConversation({ id: 'transcript-interrupted-changes' }),
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
                'The reply stopped while Issue refund was running: the model provider dropped the connection. Issue refund may have run. Check the order before retrying. Retry goes back through the approval.',
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
        name: 'Issue refund',
        input: '4471',
        result: 'Interrupted, may have run',
        duration: '1.2s',
        status: 'interrupted',
      },
    ]}
  />
  <Chat
    id="transcript-interrupted-changes"
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
