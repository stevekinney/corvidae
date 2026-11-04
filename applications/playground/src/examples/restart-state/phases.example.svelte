<script lang="ts" module>
  export const title = 'Restarting, reconnecting and failed';
  export const description =
    'The state takes over the page and cannot be dismissed (here Restarting closes itself after three seconds, as the page would when the host answers): the host is not answering, so the page behind it would show nothing true. restarting lists the steps, reconnecting counts the attempts (backing off 1, 2, 4, 8 s) with Retry now, and failed says what to check, how to start the host again with a Copy button, and offers Keep waiting. There is no restart-again action, because the route that restarts lives on the host that is not answering.';
</script>

<script lang="ts">
  import { Button, RestartState, restartRetryDelaySeconds } from '@lostgradient/cinder';
  import type { RestartStatePhase } from '@lostgradient/cinder';

  let phase = $state<RestartStatePhase | undefined>(undefined);
  let attempt = $state(3);

  // The page closes the state when the host answers. Here that is three seconds after it opens.
  $effect(() => {
    if (phase !== 'restarting') return;
    const timer = setTimeout(() => (phase = undefined), 3000);
    return () => clearTimeout(timer);
  });
</script>

<div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
  <Button label="Restarting" variant="secondary" onclick={() => (phase = 'restarting')} />
  <Button label="Reconnecting" variant="secondary" onclick={() => (phase = 'reconnecting')} />
  <Button label="Failed" variant="secondary" onclick={() => (phase = 'failed')} />
</div>

<RestartState
  open={phase !== undefined}
  phase={phase ?? 'restarting'}
  description={phase === 'restarting'
    ? 'Unloading Web search. Running work picks up where it stopped; reviews stay waiting.'
    : phase === 'failed'
      ? 'It didn’t answer after 8 tries. Your choice to disable Web search was saved before it stopped, so it applies once Interborough starts.'
      : undefined}
  currentStep={2}
  {attempt}
  retryInSeconds={restartRetryDelaySeconds(attempt)}
  onRetry={() => (phase = undefined)}
  check="That Interborough is still running on this machine, and that its address is reachable from this browser."
  command="bun run start"
  onKeepWaiting={() => {
    phase = 'reconnecting';
    attempt = 1;
  }}
>
  {#snippet details()}
    <code>fetch failed: connect ECONNREFUSED 127.0.0.1:3000</code>
  {/snippet}
</RestartState>
