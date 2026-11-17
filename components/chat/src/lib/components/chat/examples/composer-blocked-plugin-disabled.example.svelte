<script lang="ts" module>
  export const title = 'Blocked composer, agent plugin disabled';
  export const description =
    'The agent’s plugin is disabled: the row names the agent and the plugin once, and Enable and restart opens a confirm dialog that says what happens to running work. The composer stays read-only until it is confirmed.';
</script>

<script lang="ts">
  import {
    Chat,
    appendAssistantMessage,
    appendUserMessage,
    createConversation,
  } from '@lostgradient/chat';
  import { ConfirmDialog } from '@lostgradient/cinder';

  let confirming = $state(false);

  const conversation = appendAssistantMessage(
    appendUserMessage(
      createConversation({ id: 'composer-blocked-plugin-disabled' }),
      'Please refund order 4471, it arrived damaged.',
    ),
    'Order 4471 is $42.00, delivered Monday. I can refund the full amount to the original card.',
  );
</script>

<div style="block-size: 22rem;">
  <Chat
    id="composer-blocked-plugin-disabled"
    {conversation}
    surfaceMode="transparent"
    composerStatus={{
      kind: 'blocked',
      reason: 'Release helper isn’t available. Enable the Demo plugin to continue.',
      action: { label: 'Enable and restart', onclick: () => (confirming = true) },
    }}
  />
</div>

<ConfirmDialog
  bind:open={confirming}
  title="Enable the Demo plugin and restart?"
  description="Running work picks up where it stopped; reviews stay waiting."
  confirmLabel="Enable and restart"
  onConfirm={() => (confirming = false)}
/>
