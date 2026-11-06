<script lang="ts" module>
  export const title = 'Blocked composer, restarting';
  export const description =
    'After Enable and restart the composer says only what is new, with no action.';
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
      createConversation({ id: 'composer-blocked-restarting' }),
      'Please refund order 4471, it arrived damaged.',
    ),
    'Order 4471 is $42.00, delivered Monday. I can refund the full amount to the original card.',
  );
</script>

<div style="block-size: 22rem;">
  <Chat
    id="composer-blocked-restarting"
    {conversation}
    surfaceMode="transparent"
    composerStatus={{ kind: 'blocked', reason: 'Sending resumes when Interborough is back.' }}
  />
</div>
