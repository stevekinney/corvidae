<script lang="ts">
  /**
   * A line of text with its inline Markdown (`code`, **bold**, *emphasis*) drawn as elements. The
   * text stays the heading's accessible name, minus the marks.
   */
  import { inlineRuns, TITLE_INLINE_RUNS_PROFILE } from '@lostgradient/markdown/inline-runs';

  interface InlineMarkdownProps {
    text: string;
  }

  let { text }: InlineMarkdownProps = $props();
  const runs = $derived(inlineRuns(text, TITLE_INLINE_RUNS_PROFILE));
</script>

{#each runs as run, index (index)}
  {#if run.kind === 'strong'}<strong>{run.text}</strong>
  {:else if run.kind === 'emphasis'}<em>{run.text}</em>
  {:else if run.kind === 'code'}<code class="ib-identifier">{run.text}</code>
  {:else}{run.text}{/if}
{/each}
