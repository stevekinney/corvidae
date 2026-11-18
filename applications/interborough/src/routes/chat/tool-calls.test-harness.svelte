<script lang="ts">
  /**
   * Test-only page that renders the tool calls with the decision a call that needs one is shown
   * with, since a test cannot pass a snippet. Never imported by production code.
   */
  import ToolCalls from './tool-calls.svelte';
  import type { ToolCallEntry } from './tool-activity.ts';

  interface HarnessProps {
    entries: readonly ToolCallEntry[];
    endLabel?: string;
    duration?: string;
    onSelect?: (callId: string) => void;
    selectedId?: string;
    onRetryStep?: (callId: string) => void;
    groupApprovals?: boolean;
  }

  let {
    entries,
    endLabel,
    duration,
    onSelect,
    selectedId,
    onRetryStep,
    groupApprovals = false,
  }: HarnessProps = $props();
</script>

<ToolCalls
  id="turn-1"
  {entries}
  {endLabel}
  {duration}
  {onSelect}
  {selectedId}
  {onRetryStep}
  {groupApprovals}
>
  {#snippet decision(entry, layout)}
    <p data-layout={layout}>Decide on {entry.name}</p>
  {/snippet}
</ToolCalls>
