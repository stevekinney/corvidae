<script lang="ts" module>
  export const title = 'Quoting agent messages';
  export const description =
    'Select part of an assistant message, or use its Quote message action, to gather excerpts above the composer; sending puts them at the top of the message as Markdown block quotes.';
</script>

<script lang="ts">
  import {
    Chat,
    appendAssistantMessage,
    appendUserMessage,
    createConversation,
    type ChatAdapter,
  } from '@lostgradient/chat';

  let conversation = $state(
    appendAssistantMessage(
      appendUserMessage(createConversation({ id: 'quoting' }), 'What should I know about alpha?'),
      'alpha is the first item we track.\n\nIt was added before every other item.',
    ),
  );

  // The quotes arrive already composed into message.content, as Markdown block
  // quotes above the typed text. Store it as sent: the transcript renders them.
  const adapter: ChatAdapter = {
    async sendMessage(message) {
      conversation = appendAssistantMessage(
        appendUserMessage(conversation, message.content),
        'Noted. Everything you quoted came through in the message.',
      );
    },
  };
</script>

<div style="height: 30rem;">
  <Chat id="quoting" {conversation} {adapter} capabilities={{ attachments: false }} />
</div>
