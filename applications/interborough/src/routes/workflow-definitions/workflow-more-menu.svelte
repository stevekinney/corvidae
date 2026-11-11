<script lang="ts">
  /**
   * The "⋯" menu at the right of a workflow's header. Today it holds Send a signal, which opens the
   * signal dialog (the form no longer sits on the Overview, where people read). The page owns the
   * dialog and what each item does, and passes them in; the menu only draws the items it is given.
   */
  import { Dropdown, VisuallyHidden } from '@lostgradient/cinder';
  import { Ellipsis, Send } from '@lucide/svelte';

  import { WORKFLOW_COPY } from '../../app/copy.ts';

  interface Props {
    /** Whether the workflow accepts a signal, which only a ready file does. */
    canSignal: boolean;
    /** Opens the signal dialog. */
    onSendSignal: () => void;
  }

  let { canSignal, onSendSignal }: Props = $props();

  const copy = WORKFLOW_COPY.page.menu;
</script>

{#if canSignal}
  <Dropdown id="ib-workflow-actions" placement="bottom-end">
    <Dropdown.Trigger caretVisible={false}>
      <Ellipsis aria-hidden="true" size={16} />
      <VisuallyHidden>{copy.label}</VisuallyHidden>
    </Dropdown.Trigger>
    <Dropdown.Menu>
      <Dropdown.Item data-changes onclick={onSendSignal}>
        <Send aria-hidden="true" size={14} />
        {copy.sendSignal}
      </Dropdown.Item>
    </Dropdown.Menu>
  </Dropdown>
{/if}
