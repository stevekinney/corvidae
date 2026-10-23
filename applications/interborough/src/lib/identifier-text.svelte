<script lang="ts">
  /** A line of prose with its identifiers (kebab-case names and ids) set in monospace. */
  import { segmentIdentifiers } from './identifier-text.ts';

  interface IdentifierTextProps {
    text: string;
  }

  let { text }: IdentifierTextProps = $props();
</script>

{#each segmentIdentifiers(text) as segment, index (index)}{#if segment.identifier}<code
      class="ib-identifier">{segment.text}</code
    >{:else}{segment.text}{/if}{/each}
