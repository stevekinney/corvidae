<script lang="ts" module>
  export const title = 'Compact composer: a tool call under way';
  export const description =
    'Try it while an answer streams: the tool call shows as the line “Using Lookup order…” under the person’s message, above the partial reply “Category: damaged item, urgency” and its caret, with no line of time or Copy under the reply yet, and the field is disabled with Stop in the place of Send.';
</script>

<script lang="ts">
  import {
    appendStreamingMessage,
    appendToolCall,
    appendUserMessage,
    Chat,
    createConversation,
    updateStreamingMessage,
    type ChatAdapter,
  } from '@lostgradient/chat';

  const adapter: ChatAdapter = {
    sendMessage: async () => undefined,
    sendRunInput: async () => undefined,
    stopGenerating: async () => undefined,
    describeToolCall: (call, result) =>
      result === undefined
        ? { verb: 'Using', detail: `${call.name}…`, tense: 'present' }
        : { verb: 'Used', detail: call.name, tense: 'past' },
  };
  // The agent looked the order up first, and is now writing its reply: the call has no answer yet,
  // and the reply is the streaming row at the end, so it draws the caret and no line of time.
  const called = appendToolCall(
    appendUserMessage(
      createConversation({ id: 'composer-compact-tool-call' }),
      'My order 4471 arrived broken.',
    ),
    {
      id: 'call-1',
      name: 'Lookup order',
      arguments: { orderId: '4471' },
    },
  );
  const opened = appendStreamingMessage(called, 'assistant');
  const conversation = updateStreamingMessage(
    opened.conversation,
    opened.messageId,
    'Category: damaged item, urgency',
  );
</script>

<div style="block-size: 20rem; max-inline-size: 26rem;">
  <Chat
    id="composer-compact-tool-call"
    {conversation}
    {adapter}
    streaming
    surfaceMode="transparent"
    variant="transcript"
    composerCompact
    composerPlaceholder="Send a test message"
    composerHint="Tools run for real, under this agent’s approval rules. Test chats aren’t saved and leave no memories."
    capabilities={{ attachments: false, editing: false, quote: false }}
  />
</div>
