<script lang="ts">
  import {
    appendAssistantMessage,
    createConversation,
    ChatConversationHeader,
  } from '@corvidae/chat';

  let conversation = createConversation({
    id: 'launch-support',
    title: 'Launch support',
  });

  conversation = {
    ...appendAssistantMessage(conversation, 'I drafted the launch checklist.'),
    metadata: { _participantNames: ['Ada', 'Grace', 'Lin'] },
  };
</script>

<ChatConversationHeader {conversation} />
