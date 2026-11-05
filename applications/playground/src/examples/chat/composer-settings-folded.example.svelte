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
    createConversation,
  } from '@lostgradient/chat';
  import { Button, Meter, Popover, Select } from '@lostgradient/cinder';
  import { ChevronDown, SlidersHorizontal } from '@lucide/svelte';

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
  let open = $state(false);

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
      {#if folded}
        <Popover bind:open placement="top-start" label="Settings: Model, Effort and Permissions">
          {#snippet trigger()}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Settings: Model, Effort and Permissions"
              aria-haspopup="dialog"
              aria-expanded={open}
              onclick={() => (open = !open)}
            >
              {#snippet leadingIcon()}<SlidersHorizontal class="cinder-icon-sm" />{/snippet}
              Settings
              {#snippet trailingIcon()}<ChevronDown class="cinder-icon-sm" />{/snippet}
            </Button>
          {/snippet}
          <div class="composer-settings">{@render settings()}</div>
        </Popover>
      {:else}
        {@render settings()}
      {/if}
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
  .composer-settings {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-inline-size: 16rem;
  }

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
