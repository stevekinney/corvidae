<script lang="ts">
  /**
   * A line of text with its inline Markdown (`code`, **bold**, *emphasis*) drawn as elements. The
   * text stays the heading's accessible name, minus the marks.
   */
  import { inlineRuns } from './inline-markdown.ts';

  interface InlineMarkdownProps {
    text: string;
  }

  let { text }: InlineMarkdownProps = $props();
  const runs = $derived(inlineRuns(text));
</script>

{#each runs as run, index (index)}
  {#if run.kind === 'strong'}<strong>{run.text}</strong>
  {:else if run.kind === 'emphasis'}<em>{run.text}</em>
  {:else if run.kind === 'code'}<code class="ib-identifier">{run.text}</code>
  {:else}{run.text}{/if}
{/each}
