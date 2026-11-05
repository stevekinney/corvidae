<script lang="ts" module>
  export const title = 'Composer while the stream reconnects';
  export const description =
    'The stream dropped: the reply so far stays at full contrast, Stop stays, and the line under the composer counts the attempts. The run keeps going on the server.';
</script>

<script lang="ts">
  import {
    appendAssistantMessage,
    appendUserMessage,
    Chat,
    ChatComposerSettings,
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
      createConversation({ id: 'composer-reconnecting' }),
      'Please refund order 4471, it arrived damaged.',
    ),
    'Order 4471 is $42.00, delivered Monday. I can refund the full amount to the original card.',
  );
</script>

<div style="block-size: 26rem;">
  <Chat
    id="composer-reconnecting"
    {conversation}
    surfaceMode="transparent"
    composerPlaceholder="Message Tool runner…"
    {adapter}
    composerStatus={{ kind: 'reconnecting', attempt: 3 }}
  >
    {#snippet composerControls({ folded })}
      <ChatComposerSettings {folded}>
        <Select
          id="composer-reconnecting-model"
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
          id="composer-reconnecting-effort"
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
          id="composer-reconnecting-permissions"
          variant="ghost"
          presentation="listbox"
          size="sm"
          label="Permissions"
          labelVisible={false}
          valuePrefix="Permissions"
          options={PERMISSIONS}
          bind:value={permissions}
        />
      </ChatComposerSettings>
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

  /* A phone-width composer keeps the figure and drops the bar, so the row never overlaps. */
  @container (max-inline-size: 24rem) {
    .context-meter :global(.cinder-meter) {
      display: none;
    }
  }
</style>
