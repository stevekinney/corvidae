<script lang="ts">
  /**
   * The composer's one Settings control, drawn when the composer is too narrow for Model, Effort and
   * Permissions side by side (a docked side panel, a phone): a ghost button that opens a panel
   * holding the same three selects, so the row never wraps. The selects are the page's own and are
   * rendered once, here or in the row, never both.
   */
  import type { Snippet } from 'svelte';

  import { Button, Popover } from '@lostgradient/cinder';
  import { ChevronDown, SlidersHorizontal } from '@lucide/svelte';

  import { CHAT_COPY } from '../../app/copy/chat.ts';

  interface ComposerSettingsProps {
    /** The selects the control folds. */
    children: Snippet;
  }

  let { children }: ComposerSettingsProps = $props();

  const COPY = CHAT_COPY.composer.settings;

  let open = $state(false);
</script>

<Popover
  bind:open
  placement="top-start"
  label={COPY.label}
  focusManagement="panel"
  class="ib-composer-settings__panel"
>
  {#snippet trigger()}
    <Button
      type="button"
      variant="ghost"
      size="sm"
      class="ib-composer-settings"
      data-testid="composer-settings"
      aria-label={COPY.label}
      aria-haspopup="dialog"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      {#snippet leadingIcon()}<SlidersHorizontal
          class="cinder-icon-sm"
          aria-hidden="true"
        />{/snippet}
      <span class="ib-composer-settings__word">{COPY.word}</span>
      {#snippet trailingIcon()}<ChevronDown class="cinder-icon-sm" aria-hidden="true" />{/snippet}
    </Button>
  {/snippet}
  <div class="ib-composer-settings__fields" data-testid="composer-settings-panel">
    {@render children()}
  </div>
</Popover>
