<script lang="ts" module>
  export const title = 'Follow-ups during a run';
  export const description =
    'Opt in to follow-ups with sendRunInput: the composer stays enabled while a run streams, Send and Stop sit side by side, and a follow-up shows as pending until the transport acknowledges it.';
</script>

<script lang="ts">
  import {
    Chat,
    createChatSessionController,
    createConversation,
    type ChatStreamEvent,
    type ConversationHistory,
  } from '@lostgradient/chat';

  let conversation = $state<ConversationHistory>(
    createConversation({ id: 'follow-up-during-run' }),
  );
  let streaming = $state(false);
  let received = $state<string[]>([]);

  function wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function* slowReply(): AsyncGenerator<ChatStreamEvent> {
    for (const chunk of ['Working ', 'on ', 'it ', 'step ', 'by ', 'step. ', 'Still ', 'going…']) {
      await wait(500);
      yield { type: 'text', text: chunk };
    }
  }

  const session = createChatSessionController({
    // Follow-ups are for server-owned runs.
    executionOwner: 'server',
    getConversation: () => conversation,
    setConversation: (next) => {
      conversation = next;
    },
    transport: async () => slowReply(),
    // Providing sendRunInput is the opt-in. The promise resolving is the
    // acknowledgement; rejecting marks the message failed with a retry.
    sendRunInput: async (_conversationId, message, _attachments, { messageId }) => {
      await wait(300);
      received = [...received, `${String(message.content)} (${messageId})`];
    },
    hooks: { onStreamingChange: (value) => (streaming = value) },
  });
</script>

<div style="display: grid; gap: 0.75rem;">
  <div style="height: 28rem;">
    <Chat
      id="follow-up-during-run"
      {conversation}
      adapter={session.adapter}
      {streaming}
      capabilities={{ attachments: false }}
    />
  </div>
  <p>
    Follow-ups delivered to the run: {received.length === 0 ? 'none yet' : received.join(' | ')}
  </p>
</div>
