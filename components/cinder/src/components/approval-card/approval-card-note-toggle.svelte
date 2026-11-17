<script lang="ts">
  import Pencil from '@lucide/svelte/icons/pencil';

  import Button from '../button/button.svelte';
  import Tooltip from '@lostgradient/tooltip/components/tooltip/tooltip.svelte';
  import { focusOpenedNote } from './approval-card-state.ts';

  type ApprovalCardNoteToggleProps = {
    /** Whether Deny and Approve are on their way, which turns the control off. */
    disabled: boolean;
    /** Id of the note field it opens, which takes focus once it is drawn. */
    fieldId: string;
    /** Opens the note field. */
    onOpen: () => void;
    /** The button's words, which ToolCallPanel takes from its own labels. Defaults to "Add note". */
    label?: string | undefined;
  };

  let { disabled, fieldId, onOpen, label = 'Add note' }: ApprovalCardNoteToggleProps = $props();

  function open(): void {
    onOpen();
    // The toggle leaves once the field opens, so focus goes on into the field instead of the page.
    void focusOpenedNote(fieldId);
  }
</script>

<!-- A quiet ghost Button with a pencil and its words, at the leading end of the action row. Only
     when the row cannot fit the words does `fitNoteLabel` hide them and the stylesheet paints it
     with Deny's outline, so a lone glyph still reads as a button; the tooltip carries the words
     and the accessible name is the visible label and the same either way. ToolCallPanel draws the
     same toggle at the start of its decision row. -->
<Tooltip text={label} describe={false} class="cinder-approval-card__note-toggle-tip">
  <Button
    type="button"
    variant="ghost"
    size="sm"
    class="cinder-approval-card__note-toggle"
    aria-expanded={false}
    {label}
    aria-label={label}
    {disabled}
    onclick={open}
  >
    {#snippet leadingIcon()}<Pencil aria-hidden="true" />{/snippet}
  </Button>
</Tooltip>
