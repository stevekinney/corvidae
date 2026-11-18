<script lang="ts">
  /**
   * A list row's time with its day and its clock each kept whole ("Yesterday," / "6:00 PM"). On a
   * phone a StackedListItem row with a control at its end lets its time wrap at its spaces when line
   * one is short; this keeps that break between the day and the clock, never inside either.
   */
  interface Props {
    /** The time as the row says it: "6:00 PM", "Oct 30" or "Yesterday, 6:00 PM". */
    text: string;
  }

  let { text }: Props = $props();

  /** Where the time may break: after the day's comma. */
  const parts = $derived(text.split(/(?<=,) /));
</script>

{#each parts as part, index (index)}{#if index > 0}{' '}{/if}<span class="ib-time-part">{part}</span
  >{/each}

<style>
  .ib-time-part {
    white-space: nowrap;
  }
</style>
