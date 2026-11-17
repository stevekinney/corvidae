<script lang="ts">
  import DescriptionList from '../description-list/description-list.svelte';
  import type { DescriptionListItem } from '../description-list/description-list.types.ts';
  import { INPUT_SUMMARY_ROWS, INPUT_WIDE_CHARACTERS } from './approval-card-state.ts';
  import type { InputRow } from './approval-card-state.ts';

  type ApprovalCardInputRowsProps = {
    /** Id of the group; the rows past the summary take `<id>-rest`. */
    id: string;
    /** What the input is called, which names the group: "Input", or the host's own words. */
    label: string;
    /** Every row of the input, in order. */
    rows: readonly InputRow[];
  };

  let { id, label, rows }: ApprovalCardInputRowsProps = $props();

  let showAll = $state(false);
  const restId = $derived(`${id}-rest`);

  /** One pair as a DescriptionList item: a long, multi-line or structured value takes the row. */
  function toItem(row: InputRow): DescriptionListItem {
    return {
      id: row.key,
      term: row.label,
      definition: row.muted
        ? { type: 'empty', label: row.text }
        : row.structured
          ? { type: 'code', value: row.text }
          : row.text,
      wide: row.structured || row.text.includes('\n') || row.text.length > INPUT_WIDE_CHARACTERS,
    };
  }

  const summaryItems = $derived(rows.slice(0, INPUT_SUMMARY_ROWS).map(toItem));
  const restItems = $derived(rows.slice(INPUT_SUMMARY_ROWS).map(toItem));
</script>

<!-- The input in the open, at the card's content edge with no chevron and no box: DescriptionList's
     grid, which fits as many columns as the card is wide, each label over its value, and gives a
     long value the whole row. A long input shows its first pairs and a plain "Show all" under them. -->
<div {id} class="cinder-approval-card__input-list" role="group" aria-label={label}>
  <DescriptionList items={summaryItems} variant="grid" class="cinder-approval-card__input-rows" />
  {#if restItems.length > 0}
    <DescriptionList
      id={restId}
      items={restItems}
      variant="grid"
      class="cinder-approval-card__input-rows"
      hidden={!showAll}
    />
    <button
      type="button"
      class="cinder-approval-card__show-all"
      aria-expanded={showAll}
      aria-controls={restId}
      onclick={() => (showAll = !showAll)}
    >
      {showAll ? 'Show less' : `Show all ${rows.length}`}
    </button>
  {/if}
</div>
