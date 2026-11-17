<script lang="ts" module>
  export const title = 'Composer docked on a phone';
  export const description =
    'At 375px the composer is docked to the bottom of the screen: the agent select on its first row, the placeholder, then attach, one ghost Settings control holding Model, Effort and Permissions, and a 44px secondary Send, disabled until there is text.';
</script>

<script lang="ts">
  import { Chat, createConversation } from '@lostgradient/chat';
  import { Avatar, Button, Popover, Select } from '@lostgradient/cinder';
  import { ChevronDown, SlidersHorizontal } from '@lucide/svelte';

  const AGENTS = [
    {
      value: 'tool-runner',
      label: 'Tool runner',
      description: 'Looks an order up, then asks for approval to refund it.',
    },
  ];
  let agent = $state('tool-runner');
  let open = $state(false);
  const conversation = createConversation({ id: 'composer-phone-dock' });
</script>

<div class="phone">
  <div class="phone__page">
    <h3>What should Tool runner do?</h3>
    <p>Looks an order up, then asks for approval to refund it.</p>
  </div>
  <Chat
    id="composer-phone-dock"
    {conversation}
    surfaceMode="transparent"
    composerPlaceholder="Message Tool runner…"
  >
    {#snippet composerHeader()}
      <Select
        id="composer-phone-dock-agent"
        variant="ghost"
        presentation="listbox"
        size="sm"
        label="Agent"
        labelVisible={false}
        options={AGENTS}
        bind:value={agent}
      >
        {#snippet leading(option)}
          <Avatar size="xs" name={option.label} alt="" />
        {/snippet}
      </Select>
    {/snippet}
    {#snippet composerControls()}
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
        <p>Model, Effort and Permissions.</p>
      </Popover>
    {/snippet}
  </Chat>
</div>

<style>
  .phone {
    display: flex;
    flex-direction: column;
    inline-size: 375px;
    max-inline-size: 100%;
    block-size: 32rem;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-lg);
    overflow: hidden;
  }

  .phone__page {
    flex: 1;
    min-block-size: 0;
    padding: 2rem 1rem;
    overflow: auto;
    text-align: center;
  }

  .phone__page h3,
  .phone__page p {
    margin: 0 0 0.5rem;
  }

  .phone :global(.chat-container) {
    flex: none;
  }
</style>
