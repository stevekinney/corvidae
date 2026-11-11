<script lang="ts">
  /**
   * The header of a hook that is saved (design rows 84l, 84m, 85x and sweep W42): the hook's name
   * for the page heading (its sentence when it has no name), the real On switch with the word "On"
   * beside it and a "More actions" menu holding Delete hook at the right, the hook as a sentence under
   * the heading, and its latest delivery as a status dot and word with when it happened, what the
   * receiver answered, and a "Jump to log" link to the delivery log. The switch saves the moment it
   * changes (`onToggle`); the page says so in a toast with Undo. At phone width the same header
   * narrows, and the latest delivery stays one line under it.
   */
  import {
    Dropdown,
    Link,
    PageHeader,
    StatusDot,
    Toggle,
    VisuallyHidden,
  } from '@lostgradient/cinder';
  import { Ellipsis, Trash2 } from '@lucide/svelte';

  import type { Hook } from '../../lib/bureau-hooks.ts';
  import { HOOKS_COPY } from './hook-copy.ts';
  import type { LatestDelivery } from './hook-editor-presentation.ts';

  interface Props {
    /** The hook as the Bureau holds it. */
    hook: Hook;
    /** The page heading: the hook's name, or its sentence. */
    title: string;
    /** The hook as a sentence, under the heading. */
    sentence: string;
    /** What the newest delivery came to, or `undefined` while the deliveries are read or cannot be. */
    latest: LatestDelivery | undefined;
    /** Whether the switch is being saved. */
    togglePending: boolean;
    /** Turns the hook on or off; the switch shows the saved value until the hook is read again. */
    onToggle: (next: boolean) => void;
    /** Opens the confirmation that deletes the hook. */
    onDelete: () => void;
    /** Moves to the delivery log. */
    onJumpToLog: (event: MouseEvent) => void;
  }

  let { hook, title, sentence, latest, togglePending, onToggle, onDelete, onJumpToLog }: Props =
    $props();

  const copy = HOOKS_COPY.editor.header;
</script>

<div class="ib-hook-identity" data-testid="hook-header">
  <PageHeader {title} description={sentence} headingLevel={1}>
    {#snippet actions()}
      <div class="ib-hook-identity__actions">
        <Toggle
          {...{ 'data-changes': true }}
          id="ib-hook-on"
          label={hook.enabled ? copy.on : copy.off}
          nameDetail={title}
          mutating
          checked={hook.enabled}
          disabled={togglePending}
          onValueChangeRequest={(next) => {
            onToggle(next);
            // The switch follows the saved hook once it has been read again, not the press. Cinder
            // takes the returned boolean as the value to show, so hand back the saved one.
            return hook.enabled;
          }}
        />
        <Dropdown id="ib-hook-actions" placement="bottom-end">
          <Dropdown.Trigger caretVisible={false}>
            <Ellipsis aria-hidden="true" size={16} />
            <VisuallyHidden>{copy.menuLabel}</VisuallyHidden>
          </Dropdown.Trigger>
          <Dropdown.Menu>
            <Dropdown.Item data-changes variant="danger" onclick={onDelete}>
              <Trash2 aria-hidden="true" size={14} />
              {HOOKS_COPY.editor.check.delete}
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown>
      </div>
    {/snippet}
  </PageHeader>
  {#if latest !== undefined}
    <p class="ib-hook-identity__latest" data-testid="hook-latest-delivery">
      <span class="ib-hook-identity__latest-label">
        <VisuallyHidden>{copy.latestLabel}</VisuallyHidden>
        {#if latest.word !== undefined}
          <StatusDot word={latest.word} size="sm" data-status-word={latest.word} />
        {:else}
          <StatusDot status="pending" label={copy.nothingSent} size="sm" />
        {/if}
      </span>
      {#if latest.when !== undefined}
        <span class="ib-hook-identity__when" data-testid="hook-latest-when"
          >{latest.answer === undefined ? latest.when : `${latest.when}, ${latest.answer}`}</span
        >
      {/if}
      <Link href="#ib-hook-log" onclick={onJumpToLog}>{copy.jumpToLog}</Link>
    </p>
  {/if}
</div>

<style>
  .ib-hook-identity {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-hook-identity__actions {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-3);
  }

  .ib-hook-identity__latest {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-1) var(--cinder-space-3);
    margin: 0;
    min-width: 0;
    font-size: var(--cinder-text-sm);
  }

  .ib-hook-identity__latest-label {
    display: inline-flex;
    align-items: center;
  }

  .ib-hook-identity__when {
    color: var(--cinder-text-muted);
    overflow-wrap: anywhere;
  }
</style>
