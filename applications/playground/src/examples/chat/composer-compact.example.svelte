<script lang="ts" module>
  export const title = 'Compact composer: a test chat';
  export const description =
    'A one-line composer for a small surface such as Try it: the field "Send a test message" and Send share one row, with the line about real tools under it. While an answer streams Send becomes Stop and the field is disabled; with no model provider the shared blocked row stands in its place.';
</script>

<script lang="ts">
  import {
    appendAssistantMessage,
    appendUserMessage,
    Chat,
    createConversation,
    type ChatAdapter,
  } from '@lostgradient/chat';

  const adapter: ChatAdapter = {
    sendMessage: async () => undefined,
    stopGenerating: async () => undefined,
  };
  const HINT =
    'Tools run for real, under this agent’s approval rules. Test chats aren’t saved and leave no memories.';
  const empty = createConversation({ id: 'composer-compact-empty' });
  const streamed = appendAssistantMessage(
    appendUserMessage(
      createConversation({ id: 'composer-compact-streaming' }),
      'My order 4471 arrived broken.',
    ),
    'Category: damaged item, urgency',
  );
</script>

<div style="display: grid; gap: 1.5rem; max-inline-size: 26rem;">
  <div style="block-size: 14rem;">
    <Chat
      id="composer-compact-idle"
      conversation={empty}
      {adapter}
      surfaceMode="transparent"
      variant="transcript"
      composerCompact
      composerPlaceholder="Send a test message"
      composerHint={HINT}
      capabilities={{ attachments: false, editing: false, quote: false }}
    />
  </div>
  <div style="block-size: 16rem;">
    <Chat
      id="composer-compact-streaming"
      conversation={streamed}
      {adapter}
      streaming
      surfaceMode="transparent"
      variant="transcript"
      composerCompact
      composerPlaceholder="Send a test message"
      composerHint={HINT}
      capabilities={{ attachments: false, editing: false, quote: false }}
    />
  </div>
  <div style="block-size: 12rem;">
    <Chat
      id="composer-compact-blocked"
      conversation={empty}
      {adapter}
      surfaceMode="transparent"
      variant="transcript"
      composerCompact
      composerStatus={{
        kind: 'blocked',
        reason: 'Connect a model provider to chat',
        action: { label: 'Connect a provider', href: '/settings/models' },
      }}
      capabilities={{ attachments: false, editing: false, quote: false }}
    />
  </div>
</div>
