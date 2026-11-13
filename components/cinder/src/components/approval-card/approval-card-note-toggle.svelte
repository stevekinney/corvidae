<script lang="ts">
  import NotebookPen from '@lucide/svelte/icons/notebook-pen';

  import Button from '../button/button.svelte';
  import Tooltip from '../tooltip/tooltip.svelte';
  import { focusOpenedNote } from './approval-card-state.ts';

  type ApprovalCardNoteToggleProps = {
    /** Whether Deny and Approve are on their way, which turns the control off. */
    disabled: boolean;
    /** Id of the note field it opens, which takes focus once it is drawn. */
    fieldId: string;
    /** Opens the note field. */
    onOpen: () => void;
  };

  let { disabled, fieldId, onOpen }: ApprovalCardNoteToggleProps = $props();

  function open(): void {
    onOpen();
    // The toggle leaves once the field opens, so focus goes on into the field instead of the page.
    void focusOpenedNote(fieldId);
  }
</script>

<!-- A quiet ghost Button. Under 30rem of card width the stylesheet hides its words and the
     tooltip carries them; the accessible name is the same either way. -->
<Tooltip text="Add a note" describe={false} class="cinder-approval-card__note-toggle-tip">
  <Button
    type="button"
    variant="ghost"
    size="sm"
    class="cinder-approval-card__note-toggle"
    aria-expanded={false}
    label="Add a note"
    {disabled}
    onclick={open}
  >
    {#snippet leadingIcon()}<NotebookPen aria-hidden="true" />{/snippet}
  </Button>
</Tooltip>
