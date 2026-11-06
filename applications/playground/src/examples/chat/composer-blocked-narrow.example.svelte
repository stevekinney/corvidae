<script lang="ts" module>
  export const title = 'Blocked composer on a narrow card';
  export const description =
    'On a narrow card the actions drop to a second line instead of overlapping the reason.';
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
      createConversation({ id: 'composer-blocked-narrow' }),
      'Please refund order 4471, it arrived damaged.',
    ),
    'Order 4471 is $42.00, delivered Monday. I can refund the full amount to the original card.',
  );
</script>

<div style="max-inline-size: 22rem; block-size: 22rem;">
  <Chat
    id="composer-blocked-narrow"
    {conversation}
    surfaceMode="transparent"
    composerStatus={{
      kind: 'blocked',
      reason: 'Connect a model provider to chat',
      action: { label: 'Connect a provider', href: '#connect' },
      link: { label: 'Use Assistant', onclick: () => undefined },
    }}
  />
</div>
