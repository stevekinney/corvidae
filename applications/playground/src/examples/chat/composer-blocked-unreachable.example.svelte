<script lang="ts" module>
  export const title = 'Blocked composer, server unreachable';
  export const description =
    'While Interborough is unreachable the composer is one blocked row with only the reason: Retry lives in the banner, so there is no second retry button.';
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
      createConversation({ id: 'composer-blocked-unreachable' }),
      'Please refund order 4471, it arrived damaged.',
    ),
    'Order 4471 is $42.00, delivered Monday. I can refund the full amount to the original card.',
  );
</script>

<div style="block-size: 22rem;">
  <Chat
    id="composer-blocked-unreachable"
    {conversation}
    surfaceMode="transparent"
    composerStatus={{ kind: 'blocked', reason: 'Sending is off until Interborough is reachable' }}
  />
</div>
