<script lang="ts" module>
  export const title = 'Blocked composer, no provider (fixed agent)';
  export const description =
    'A chat whose agent is fixed does not offer Use Assistant: the row has the reason and Connect a provider only.';
</script>

<script lang="ts">
  import {
    Chat,
    appendAssistantMessage,
    appendUserMessage,
    createConversation,
  } from '@lostgradient/chat';

  const conversation = appendAssistantMessage(
    appendUserMessage(
      createConversation({ id: 'composer-blocked-no-provider-fixed-agent' }),
      'Please refund order 4471, it arrived damaged.',
    ),
    'Order 4471 is $42.00, delivered Monday. I can refund the full amount to the original card.',
  );
</script>

<div style="block-size: 22rem;">
  <Chat
    id="composer-blocked-no-provider-fixed-agent"
    {conversation}
    surfaceMode="transparent"
    composerStatus={{
      kind: 'blocked',
      reason: 'Connect a model provider to chat',
      action: { label: 'Connect a provider', href: '#connect' },
    }}
  />
</div>
