<script lang="ts">
  import { INPUT_SUMMARY_ROWS } from './approval-card-state.ts';
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
  const summaryRows = $derived(rows.slice(0, INPUT_SUMMARY_ROWS));
  const restRows = $derived(rows.slice(INPUT_SUMMARY_ROWS));
  const restId = $derived(`${id}-rest`);
</script>

<!-- The input in the open, at the card's content edge: each pair a row of its own, the label over
     the value, so the value starts on the title's edge and a long one wraps there instead of in a
     column beside its label. No chevron and no box. A long input shows its first rows and a plain
     "Show all" under them. -->
{#snippet inputRow(row: InputRow)}
  <div class="cinder-approval-card__input-row">
    <dt class="cinder-approval-card__pair-label" dir="auto">{row.label}</dt>
    {' '}
    <dd
      class="cinder-approval-card__pair-value"
      data-cinder-muted={row.muted || undefined}
      data-cinder-monospace={row.structured || undefined}
      dir="auto"
    >
      {row.text}
    </dd>
  </div>
{/snippet}

<div {id} class="cinder-approval-card__input-list" role="group" aria-label={label}>
  <dl class="cinder-approval-card__input-rows">
    {#each summaryRows as row (row.key)}
      {@render inputRow(row)}
    {/each}
  </dl>
  {#if restRows.length > 0}
    <dl id={restId} class="cinder-approval-card__input-rows" hidden={!showAll}>
      {#each restRows as row (row.key)}
        {@render inputRow(row)}
      {/each}
    </dl>
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
