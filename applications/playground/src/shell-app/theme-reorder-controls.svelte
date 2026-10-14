<script lang="ts">
  /*
   * Move up, Move down and Remove for one row of an ordered list (COR-488): shadow layers,
   * gradient stops and stroke dashes. Reordering never needs a pointer. A move is announced by
   * its new position, and focus follows the moved row, because rows are keyed by position and
   * the focused button would otherwise stay with whichever row now occupies the old slot.
   */
  import { Button } from '@lostgradient/cinder';
  import { tick } from 'svelte';

  type Props = {
    /** Names the row in every label, for example `Shadow layer 2`. */
    subject: string;
    index: number;
    count: number;
    idBase: string;
    disabled: boolean;
    /** False when removing would leave the list below its minimum. */
    canRemove: boolean;
    onmove: (delta: -1 | 1) => void;
    onremove: () => void;
    announce: (message: string) => void;
  };
  let { subject, index, count, idBase, disabled, canRemove, onmove, onremove, announce }: Props =
    $props();

  async function move(delta: -1 | 1): Promise<void> {
    const target = index + delta;
    if (target < 0 || target >= count) return;
    onmove(delta);
    announce(`Moved ${subject} to position ${target + 1} of ${count}`);
    await tick();
    const preferred = document.getElementById(`${idBase}-${delta === -1 ? 'up' : 'down'}-${target}`);
    const fallback = document.getElementById(`${idBase}-${delta === -1 ? 'down' : 'up'}-${target}`);
    for (const candidate of [preferred, fallback]) {
      if (candidate instanceof HTMLButtonElement && !candidate.disabled) {
        candidate.focus();
        return;
      }
    }
  }
</script>

<div class="reorder" role="group" aria-label={`${subject}, position ${index + 1} of ${count}`}>
  <Button
    id={`${idBase}-up-${index}`}
    label="Move up"
    aria-label={`Move ${subject} up`}
    variant="secondary"
    size="sm"
    disabled={disabled || index === 0}
    onclick={() => void move(-1)}
  />
  <Button
    id={`${idBase}-down-${index}`}
    label="Move down"
    aria-label={`Move ${subject} down`}
    variant="secondary"
    size="sm"
    disabled={disabled || index === count - 1}
    onclick={() => void move(1)}
  />
  <Button
    id={`${idBase}-remove-${index}`}
    label="Remove"
    aria-label={`Remove ${subject}`}
    variant="ghost-danger"
    size="sm"
    disabled={disabled || !canRemove}
    onclick={() => {
      onremove();
      announce(`Removed ${subject}`);
    }}
  />
</div>

<style>
  .reorder {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
