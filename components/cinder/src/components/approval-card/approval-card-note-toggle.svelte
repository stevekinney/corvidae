<script lang="ts">
  import Pencil from '@lucide/svelte/icons/pencil';

  import Button from '../button/button.svelte';
  import Tooltip from '../tooltip/tooltip.svelte';

  type ApprovalCardNoteToggleProps = {
    /** Whether Deny and Approve are on their way, which turns the control off. */
    disabled: boolean;
    /** Opens the note field. */
    onOpen: () => void;
  };

  let { disabled, onOpen }: ApprovalCardNoteToggleProps = $props();
</script>

<!-- A quiet ghost Button with a pencil and "Add note", at the leading end of the action row. Only
     when the row cannot fit the words does `fitNoteLabel` hide them and the stylesheet paints it
     with Deny's outline, so a lone glyph still reads as a button; the tooltip carries the words
     and the accessible name, "Add a note", is the same either way. -->
<Tooltip text="Add a note" describe={false} class="cinder-approval-card__note-toggle-tip">
  <Button
    type="button"
    variant="ghost"
    size="sm"
    class="cinder-approval-card__note-toggle"
    aria-expanded={false}
    label="Add note"
    aria-label="Add a note"
    {disabled}
    onclick={onOpen}
  >
    {#snippet leadingIcon()}<Pencil aria-hidden="true" />{/snippet}
  </Button>
</Tooltip>
