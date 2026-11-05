<script lang="ts" module>
  export const title = 'Composer while the chat is working';
  export const description =
    'Stop replaces Send while the chat is working, and the line under the box says a message now steers the run.';
</script>

<script lang="ts">
  import {
    appendAssistantMessage,
    appendUserMessage,
    Chat,
    createConversation,
    type ChatAdapter,
  } from '@lostgradient/chat';
  import { Meter, Select } from '@lostgradient/cinder';

  const MODELS = [
    { value: 'sonnet', label: 'Claude Sonnet 5.5' },
    { value: 'haiku', label: 'Claude Haiku 5' },
  ];
  const EFFORTS = [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ];
  const PERMISSIONS = [
    {
      value: 'on-changes',
      label: 'On changes asks',
      description: 'Tools set to On changes ask before they run.',
    },
    {
      value: 'allow-all',
      label: 'Allow all',
      description:
        'Skips the On changes asks for this chat. Tools set to Always still ask; Blocked tools stay blocked.',
    },
  ];
  let model = $state('sonnet');
  let effort = $state('medium');
  let permissions = $state('on-changes');

  // An adapter that takes a message while the run is going, so the composer stays live.
  const adapter: ChatAdapter = {
    sendMessage: async () => undefined,
    sendRunInput: async () => undefined,
    stopGenerating: async () => undefined,
  };

  const conversation = appendAssistantMessage(
    appendUserMessage(
      createConversation({ id: 'composer-working' }),
      'Please refund order 4471, it arrived damaged.',
    ),
    'Order 4471 is $42.00, delivered Monday. I can refund the full amount to the original card.',
  );
</script>

<div style="block-size: 26rem;">
  <Chat
    id="composer-working"
    {conversation}
    surfaceMode="transparent"
    composerPlaceholder="Message Tool runner…"
    {adapter}
    streaming
    composerStatus={{ kind: 'steering' }}
  >
    {#snippet composerControls()}
      <Select
        id="composer-working-model"
        variant="ghost"
        presentation="listbox"
        size="sm"
        label="Model"
        labelVisible={false}
        valuePrefix="Model"
        options={MODELS}
        bind:value={model}
      />
      <Select
        id="composer-working-effort"
        variant="ghost"
        presentation="listbox"
        size="sm"
        label="Effort"
        labelVisible={false}
        valuePrefix="Effort"
        options={EFFORTS}
        bind:value={effort}
      />
      <Select
        id="composer-working-permissions"
        variant="ghost"
        presentation="listbox"
        size="sm"
        label="Permissions"
        labelVisible={false}
        valuePrefix="Permissions"
        options={PERMISSIONS}
        bind:value={permissions}
      />
    {/snippet}
    {#snippet composerActions()}
      <span class="context-meter" title="76K of 200K tokens">
        <Meter size="sm" value={38} ariaLabel="Context 38%" />
        <span aria-hidden="true">38%</span>
      </span>
    {/snippet}
  </Chat>
</div>

<style>
  .context-meter {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
  }

  .context-meter :global(.cinder-meter) {
    inline-size: 2.25rem;
  }
</style>
