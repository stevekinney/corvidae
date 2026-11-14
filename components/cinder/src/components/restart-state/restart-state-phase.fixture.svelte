<script lang="ts">
  import type { RestartStatePhase } from './restart-state.types.ts';
  import { RestartState } from './index.ts';

  let { phase = 'failed' }: { phase?: RestartStatePhase } = $props();
</script>

<!-- One phase of RestartState, open, as the page shows it, so the layout tests and the review
     captures can see the card without a click. -->
<RestartState
  open
  {phase}
  description={phase === 'failed'
    ? 'It didn’t answer after 8 tries. Your choice to disable Web search was saved before it stopped, so it applies once Interborough starts.'
    : undefined}
  currentStep={2}
  attempt={3}
  retryInSeconds={4}
  onRetry={() => {}}
  check="That Interborough is still running on this machine, and that its address is reachable from this browser."
  command="bun run start"
  onKeepWaiting={() => {}}
>
  {#snippet details()}
    <code>fetch failed: connect ECONNREFUSED 127.0.0.1:3000</code>
  {/snippet}
</RestartState>
