<script lang="ts">
  import {
    ChatNavigationRail,
    appendAssistantMessage,
    appendUserMessage,
    createConversation,
    getMessages,
  } from '@lostgradient/chat';

  const conversation = appendAssistantMessage(
    appendUserMessage(
      createConversation({ id: 'navigation-rail' }),
      'Review the release checklist',
    ),
    'The release checklist is ready for review.',
  );
  const messages = getMessages(conversation);
</script>

<ChatNavigationRail {messages} label="Release messages" />
