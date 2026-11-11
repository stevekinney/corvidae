<script lang="ts">
  /**
   * One line of a schedule row's words: the segments joined by a comma, each part in its own
   * style. A workflow's file name is small and monospaced (`order-refund`), and a reason is in a
   * tone ("can't load" in red, "won't start" in amber). What the line ends with (the last run, which
   * follows the cadence) is a snippet, because it waits for the engine to say how the run ended.
   */
  import type { Snippet } from 'svelte';

  import type { RowSegment } from './schedule-row-model.ts';

  interface Props {
    segments: readonly RowSegment[];
    /** What the line ends with, joined to the last segment by a comma. */
    tail?: Snippet | undefined;
  }

  let { segments, tail }: Props = $props();
</script>

{#each segments as segment, index (index)}
  {#if index > 0}{', '}{/if}
  {#each segment as part, partIndex (partIndex)}
    {#if part.monospace === true}
      <code class="ib-identifier ib-schedule-line__part" data-tone={part.tone}>{part.text}</code>
    {:else if part.tone !== undefined}
      <span class="ib-schedule-line__part" data-tone={part.tone}>{part.text}</span>
    {:else}
      {part.text}
    {/if}
  {/each}
{/each}{#if tail}{#if segments.length > 0}{', '}{/if}{@render tail()}{/if}
