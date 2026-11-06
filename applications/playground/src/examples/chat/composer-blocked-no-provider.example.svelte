<script lang="ts" module>
  export const title = 'Blocked composer, no provider (Assistant can be chosen)';
  export const description =
    'With no model provider the composer is one compact blocked row: the warning glyph and the reason on the left, Connect a provider, and a quiet Use Assistant link where Assistant can be chosen. There is no text box.';
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
      createConversation({ id: 'composer-blocked-no-provider' }),
      'Please refund order 4471, it arrived damaged.',
    ),
    'Order 4471 is $42.00, delivered Monday. I can refund the full amount to the original card.',
  );
</script>

<div style="block-size: 22rem;">
  <Chat
    id="composer-blocked-no-provider"
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
