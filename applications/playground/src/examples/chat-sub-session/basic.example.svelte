<script lang="ts" module>
  export const title = 'Nested session transcript';
  export const description = 'A reduced child conversation rendered inside its parent workflow.';
</script>

<script lang="ts">
  import {
    appendAssistantMessage,
    appendUserMessage,
    ChatSubSession,
    createConversation,
  } from '@lostgradient/chat';

  // Number messages in order and give the transcript a fixed time, rather than random ids and
  // the clock, so every render of this example, including the static export's, is identical.
  let messageCount = 0;
  const environment = {
    randomId: () => `message-${(messageCount += 1)}`,
    now: () => '2026-01-15T09:30:00.000Z',
  };

  let conversation = createConversation({ id: 'nested-example' });
  conversation = appendUserMessage(
    conversation,
    'Inspect the deployment logs.',
    undefined,
    environment,
  );
  conversation = appendAssistantMessage(
    conversation,
    'The deployment completed without errors.',
    undefined,
    environment,
  );
</script>

<ChatSubSession {conversation} />
