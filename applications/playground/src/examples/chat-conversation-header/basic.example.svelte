<script lang="ts" module>
  export const title = 'Basic conversation header';
  export const description = 'A header derived from the active compatible conversation snapshot.';
</script>

<script lang="ts">
  import {
    appendAssistantMessage,
    ChatConversationHeader,
    createConversation,
  } from '@lostgradient/chat';

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
