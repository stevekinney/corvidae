<script lang="ts">
  /**
   * The composer's settings as the host draws them: Model, Effort and Permissions side by side while
   * the composer is wide enough, and one ghost Settings control that opens a panel holding the same
   * controls once it is not (a side panel docked beside the conversation, a phone), so the row never
   * wraps or overlaps. It is for the `composerControls` snippet, which is told `folded`:
   *
   * ```svelte
   * {#snippet composerControls({ folded })}
   *   <ChatComposerSettings {folded}>
   *     <Select … />
   *   </ChatComposerSettings>
   * {/snippet}
   * ```
   *
   * The controls are rendered once, in the row or in the panel, never both.
   */
  import type { Snippet } from 'svelte';

  import { Button, ChevronDown, Popover, SlidersHorizontal } from '@lostgradient/cinder';

  interface ChatComposerSettingsProps {
    /** Whether the composer is too narrow for the controls, which `composerControls` is told. */
    folded: boolean;
    /** The controls: ghost selects for the model, the effort and the permission mode. */
    children: Snippet;
    /** The accessible name of the Settings control and of its panel. Default: `Settings`. */
    label?: string;
    /** The word on the Settings control. Default: `Settings`. */
    word?: string;
  }

  let {
    folded,
    children,
    label = 'Settings: Model, Effort and Permissions',
    word = 'Settings',
  }: ChatComposerSettingsProps = $props();

  let open = $state(false);
</script>

{#if folded}
  <Popover bind:open placement="top-start" {label} focusManagement="panel">
    {#snippet trigger()}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        class="chat-composer-settings"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onclick={() => (open = !open)}
      >
        {#snippet leadingIcon()}<SlidersHorizontal
            class="cinder-icon-sm"
            aria-hidden="true"
          />{/snippet}
        {word}
        {#snippet trailingIcon()}<ChevronDown class="cinder-icon-sm" aria-hidden="true" />{/snippet}
      </Button>
    {/snippet}
    <div class="chat-composer-settings-fields">
      {@render children()}
    </div>
  </Popover>
{:else}
  {@render children()}
{/if}

<style>
  .chat-composer-settings-fields {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    min-inline-size: 16rem;
  }

  /* The word gives way before the glyphs do, so a narrow row clips nothing it needs. */
  :global(.chat-composer-settings) {
    min-inline-size: 0;
    max-inline-size: 100%;
  }
</style>
