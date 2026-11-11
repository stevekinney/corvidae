<script lang="ts">
  /**
   * The "⋯" menu at the right of a workflow's header (board PageWorkflow, "More menu, and Delete"
   * and "More menu on an active workflow"). It holds Send a signal, which opens the signal dialog
   * (the form no longer sits on the Overview, where people read); Duplicate; Pause, with what
   * pausing does under it, on a workflow that is running; and Delete…, in red, which opens the
   * delete dialog. A paused workflow's Resume is the header's primary action, so the menu never
   * repeats it. The page owns what each item does and passes it in; the menu draws only the items
   * it is given, and draws nothing when it is given none. While a write is in flight the items that
   * write are off, so a second press cannot send a second write.
   */
  import { Dropdown, VisuallyHidden } from '@lostgradient/cinder';
  import { Copy, Ellipsis, Pause, Send, Trash2 } from '@lucide/svelte';

  import { WORKFLOW_COPY } from '../../app/copy.ts';

  interface Props {
    /** Whether the workflow accepts a signal, which only a ready file does. */
    canSignal: boolean;
    /** Opens the signal dialog. */
    onSendSignal: () => void;
    /** Duplicates the workflow, when it is a file the Bureau can read; absent, the item is not drawn. */
    onDuplicate?: (() => void) | undefined;
    /** Pauses the workflow, when it is a running file; absent, the item is not drawn. */
    onPause?: (() => void) | undefined;
    /** Opens the delete dialog, when the file can be deleted; absent, the item is not drawn. */
    onDelete?: (() => void) | undefined;
    /** Whether a write to the file is in flight, which turns the items that write off. */
    busy?: boolean;
  }

  let {
    canSignal,
    onSendSignal,
    onDuplicate = undefined,
    onPause = undefined,
    onDelete = undefined,
    busy = false,
  }: Props = $props();

  const copy = WORKFLOW_COPY.page.menu;
  const any = $derived(
    canSignal || onDuplicate !== undefined || onPause !== undefined || onDelete !== undefined,
  );
</script>

{#if any}
  <Dropdown id="ib-workflow-actions" placement="bottom-end">
    <Dropdown.Trigger caretVisible={false}>
      <Ellipsis aria-hidden="true" size={16} />
      <VisuallyHidden>{copy.label}</VisuallyHidden>
    </Dropdown.Trigger>
    <Dropdown.Menu>
      {#if canSignal}
        <Dropdown.Item data-changes onclick={onSendSignal}>
          <Send aria-hidden="true" size={14} />
          {copy.sendSignal}
        </Dropdown.Item>
      {/if}
      {#if onDuplicate !== undefined}
        <Dropdown.Item data-changes disabled={busy} onclick={onDuplicate}>
          <Copy aria-hidden="true" size={14} />
          {copy.duplicate}
        </Dropdown.Item>
      {/if}
      {#if onPause !== undefined}
        <Dropdown.Item
          data-changes
          disabled={busy}
          aria-label={copy.pause}
          aria-describedby="ib-workflow-actions-pause-description"
          onclick={onPause}
        >
          <Pause aria-hidden="true" size={14} />
          <span class="ib-workflow-menu__item">
            <span>{copy.pause}</span>
            <span
              class="ib-workflow-menu__description"
              id="ib-workflow-actions-pause-description"
              data-testid="workflow-menu-pause-description">{copy.pauseDescription}</span
            >
          </span>
        </Dropdown.Item>
      {/if}
      {#if onDelete !== undefined}
        <Dropdown.Item data-changes variant="danger" disabled={busy} onclick={onDelete}>
          <Trash2 aria-hidden="true" size={14} />
          {copy.delete}
        </Dropdown.Item>
      {/if}
    </Dropdown.Menu>
  </Dropdown>
{/if}
