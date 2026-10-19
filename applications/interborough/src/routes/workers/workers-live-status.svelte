<script lang="ts">
  import { Alert, ConnectionIndicator, Toggle, Tooltip } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';

  import { getFleetEventSource } from '../../app/engine-status.svelte.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import { LONG_POLL_LIMITATION } from './worker-presentation.ts';
  import { invalidateWorkerSurfaceQueries } from './workers-data.ts';

  let { locked = false, longPollWorkers = 0 }: { locked?: boolean; longPollWorkers?: number } =
    $props();
  const fleetSource = getFleetEventSource();
  const principalStore = getPrincipalStore();
  const queryClient = useQueryClient();
  let live = $state(false);
  const liveToggleGate = $derived(scopeGate(principalStore, ['events:read']));
  const workerLivenessKinds = new Set(['worker:connected', 'worker:disconnected']);

  // Observe the shell's shared connection; the route's polling remains active.
  $effect(() => {
    if (!live || liveToggleGate.disabled) return;
    return fleetSource.subscribe((frame) => {
      if (workerLivenessKinds.has(frame.kind)) invalidateWorkerSurfaceQueries(queryClient);
    });
  });
</script>

{#if !locked}
  <div class="weft-workers-route__live">
    {#if live}
      <ConnectionIndicator status={fleetSource.status} />
    {:else}
      <ConnectionIndicator status="polling" label="Updated every 30s" />
    {/if}
    {#if liveToggleGate.disabled}
      <Tooltip text={liveToggleGate.title ?? ''}>
        <Toggle id="workers-live" label="Live" checked={live} disabled />
      </Tooltip>
    {:else}
      <Toggle id="workers-live" label="Live" bind:checked={live} />
    {/if}
  </div>
{/if}

{#if !locked && longPollWorkers > 0}
  <Alert variant="info" class="weft-workers-route__long-poll-note">
    {longPollWorkers}
    {longPollWorkers === 1 ? 'worker uses' : 'workers use'} the HTTP long-poll transport.
    {LONG_POLL_LIMITATION} The Live toggle above refreshes this view on WebSocket worker events only.
  </Alert>
{/if}
