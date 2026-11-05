<script lang="ts" module>
  export const title = 'Blocked composer, chat ended';
  export const description =
    'A chat the server ended when it restarted: one blocked row with a secondary New chat button, no text box and no controls.';
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
      createConversation({ id: 'composer-blocked-ended' }),
      'Please refund order 4471, it arrived damaged.',
    ),
    'Order 4471 is $42.00, delivered Monday. I can refund the full amount to the original card.',
  );
</script>

<div style="block-size: 22rem;">
  <Chat
    id="composer-blocked-ended"
    {conversation}
    surfaceMode="transparent"
    composerStatus={{
      kind: 'blocked',
      reason: 'This chat has ended. The server stopped it when it restarted.',
      action: { label: 'New chat', onclick: () => undefined },
    }}
  />
</div>
