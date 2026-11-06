<script lang="ts" module>
  export const title = 'Composer with its settings folded';
  export const description =
    'With a panel docked beside the conversation the composer is too narrow for Model, Effort and Permissions, so `composerControls` is told it is `folded` and the host draws one ghost Settings control in their place. The row keeps the attach button, the Settings control, the 38% context meter and Send, and never wraps.';
</script>

<script lang="ts">
  import {
    appendAssistantMessage,
    appendUserMessage,
    Chat,
    ChatComposerSettings,
    createConversation,
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
    { value: 'always', label: 'Always asks', description: 'Every tool call asks first.' },
    {
      value: 'on-changes',
      label: 'On changes asks',
      description: 'Tools set to On changes ask before they run.',
    },
  ];
  let model = $state('sonnet');
  let effort = $state('medium');
  let permissions = $state('on-changes');

  const conversation = appendAssistantMessage(
    appendUserMessage(createConversation({ id: 'composer-settings-folded' }), 'Which step failed?'),
    'Step 3 failed: the lookup timed out.',
  );
</script>

{#snippet settings()}
  <Select
    id="composer-settings-folded-model"
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
    id="composer-settings-folded-effort"
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
    id="composer-settings-folded-permissions"
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

<div style="max-inline-size: 28rem; block-size: 24rem;">
  <Chat
    id="composer-settings-folded"
    {conversation}
    surfaceMode="transparent"
    composerPlaceholder="Message the agent…"
  >
    {#snippet composerControls({ folded })}
      <ChatComposerSettings {folded}>{@render settings()}</ChatComposerSettings>
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
