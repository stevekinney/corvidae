<script lang="ts">
  import {
    ChatSubSession,
    appendAssistantMessage,
    appendUserMessage,
    createConversation,
  } from '@repo/chat';

  const conversation = appendAssistantMessage(
    appendUserMessage(createConversation({ id: 'sub-session' }), 'Inspect the delegated task'),
    'The delegated task is complete.',
  );
</script>

<ChatSubSession {conversation} live label="Delegated task transcript" />
