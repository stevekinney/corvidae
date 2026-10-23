<script lang="ts">
  /**
   * A line of prose with the identifiers the caller names (an agent, a tool, a run id) set in
   * monospace, whatever their shape: the owner rule is that identifiers are monospace, and the
   * place a line is shown knows what is one.
   */
  import { segmentIdentifiers } from './identifier-text.ts';

  interface IdentifierTextProps {
    text: string;
    /** The parts of `text` that are identifiers. Prose that merely looks like one stays prose. */
    identifiers: readonly string[];
  }

  let { text, identifiers }: IdentifierTextProps = $props();
</script>

{#each segmentIdentifiers(text, identifiers) as segment, index (index)}{#if segment.identifier}<code
      class="ib-identifier">{segment.text}</code
    >{:else}{segment.text}{/if}{/each}
