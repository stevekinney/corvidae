<script lang="ts">
  /**
   * The run's timeline, from the workflow engine, with the async-activity completion tokens the
   * fleet feed reports for it. The observations start when the timeline mounts, which is as early
   * as this page can reach (`workflow-live-observations.svelte.ts` says why not earlier), and end
   * with it. Only a run the engine answered for mounts this, so a caller without engine access
   * never opens them. Stream links need `streams:read`.
   */
  import type { WorkflowState } from '@lostgradient/weft';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { onDestroy, untrack } from 'svelte';

  import { getFleetEventSource } from '../../../app/engine-status.svelte.ts';
  import { getPrincipalStore } from '../../../lib/scopes.svelte.ts';
  import TimelineTab from '../detail/timeline-tab.svelte';
  import { WorkflowLiveObservations } from '../detail/timeline/workflow-live-observations.svelte.ts';
  import type { RunEngine } from './run-engine.svelte.ts';

  interface RunTimelineProps {
    engine: RunEngine;
    workflow: WorkflowState;
  }

  let { engine, workflow }: RunTimelineProps = $props();

  const principal = getPrincipalStore();
  const canReadStreams = $derived(principal.hasScope('streams:read'));
  const liveObservations = new WorkflowLiveObservations(
    getFleetEventSource(),
    useQueryClient(),
    untrack(() => workflow.id),
  );
  onDestroy(() => liveObservations.dispose());
</script>

<TimelineTab
  client={engine.client}
  {workflow}
  {liveObservations}
  finalizerStatus={engine.finalizerStatus}
  {canReadStreams}
/>
