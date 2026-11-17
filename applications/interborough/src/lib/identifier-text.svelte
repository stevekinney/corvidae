<script lang="ts">
  /**
   * A line of prose with the identifiers the caller names (an agent, a tool, a run id) set in
   * monospace, whatever their shape: the owner rule is that identifiers are monospace, and the
   * place a line is shown knows what is one. Each identifier is Cinder's `Text variant="code"`, which
   * takes the size of the line around it.
   */
  import { Text } from '@lostgradient/cinder';

  import { segmentIdentifiers } from './identifier-text.ts';

  interface IdentifierTextProps {
    text: string;
    /** The parts of `text` that are identifiers. Prose that merely looks like one stays prose. */
    identifiers: readonly string[];
  }

  let { text, identifiers }: IdentifierTextProps = $props();
</script>

{#each segmentIdentifiers(text, identifiers) as segment, index (index)}{#if segment.identifier}<Text
      variant="code">{segment.text}</Text
    >{:else}{segment.text}{/if}{/each}
