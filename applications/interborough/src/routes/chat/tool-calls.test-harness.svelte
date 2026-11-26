<script lang="ts">
  /**
   * Test-only page that renders the tool calls with the decision a call that needs one is shown
   * with, since a test cannot pass a snippet. Never imported by production code.
   */
  import ToolCalls from './tool-calls.svelte';
  import type { ToolCallEntry } from './tool-activity.ts';

  interface HarnessProps {
    entries: readonly ToolCallEntry[];
    duration?: string;
    onSelect?: (callId: string) => void;
    onRetryStep?: (callId: string) => void;
    selectedId?: string;
  }

  let { entries, duration, onSelect, onRetryStep, selectedId }: HarnessProps = $props();
</script>

<ToolCalls id="turn-1" {entries} {duration} {onSelect} {onRetryStep} {selectedId}>
  {#snippet decision(entry)}
    <p>Decide on {entry.name}</p>
  {/snippet}
</ToolCalls>
