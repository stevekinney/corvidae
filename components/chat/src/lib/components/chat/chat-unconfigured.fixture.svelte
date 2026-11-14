<script lang="ts" module>
  export const title = 'Chat with no model provider';
  export const description =
    'Chat with its unconfigured availability state, twice: with no message it stands in place of the transcript and the composer, and with messages the transcript stays and only the composer becomes the blocked Connect provider row.';
</script>

<script lang="ts">
  import {
    Chat,
    appendAssistantMessage,
    appendUserMessage,
    createConversation,
  } from '@lostgradient/chat';

  const empty = createConversation({ id: 'unconfigured-fixture' });
  const withHistory = appendAssistantMessage(
    appendUserMessage(
      createConversation({ id: 'unconfigured-history-fixture' }),
      'Refund order 4471.',
    ),
    'I found order 4471. I need your approval to refund it.',
  );
</script>

<div class="chat-unconfigured-fixture" data-testid="unconfigured-empty">
  <Chat
    id="fixture-unconfigured-empty-chat"
    conversation={empty}
    capabilities={{ attachments: false }}
    availability={{ kind: 'unconfigured', onConnect: () => undefined }}
  />
</div>
<div class="chat-unconfigured-fixture" data-testid="unconfigured-with-history">
  <Chat
    id="fixture-unconfigured-history-chat"
    conversation={withHistory}
    capabilities={{ attachments: false }}
    availability={{ kind: 'unconfigured', onConnect: () => undefined }}
  />
</div>

<style>
  .chat-unconfigured-fixture {
    block-size: 22rem;
  }
</style>
