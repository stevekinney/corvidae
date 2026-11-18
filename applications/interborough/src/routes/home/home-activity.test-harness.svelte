<script lang="ts">
  /**
   * Test-only: Home's two activity bands, in Home's own activity region, over the feed sources the
   * shell provides (COR-2227). A source left out is not provided, as for a view outside the shell.
   * With `routed`, Home is mounted only while the address is `/`, as the application's outlet
   * mounts it, so following a row's link tears Home down inside a Svelte block effect.
   */
  import { untrack } from 'svelte';

  import { provideFleetEventSource } from '../../app/engine-status.svelte.ts';
  import { provideBureauEventSource } from '../../app/live-polling.svelte.ts';
  import type { BureauEventSource } from '../../lib/live-source/bureau-event-source.svelte.ts';
  import type { FleetEventSource } from '../../lib/live-source/fleet-event-source.svelte.ts';
  import { router } from '../../lib/router.svelte.ts';
  import HomeAgentActivity from './home-agent-activity.svelte';
  import HomeLayout from './home-layout.svelte';
  import HomeWorkflowActivity from './home-workflow-activity.svelte';

  interface Props {
    bureauEvents?: BureauEventSource | undefined;
    fleetEvents?: FleetEventSource | undefined;
    routed?: boolean;
  }

  let { bureauEvents, fleetEvents, routed = false }: Props = $props();

  const bureau = untrack(() => bureauEvents);
  const fleet = untrack(() => fleetEvents);
  if (bureau !== undefined) provideBureauEventSource(bureau);
  if (fleet !== undefined) provideFleetEventSource(fleet);
</script>

{#if !routed || router.pathname === '/'}
  <HomeLayout mode="overview">
    {#snippet date()}Monday, Nov 2.{/snippet}
    {#snippet recent()}{/snippet}
    {#snippet workflowActivity()}<HomeWorkflowActivity />{/snippet}
    {#snippet agentActivity()}<HomeAgentActivity />{/snippet}
  </HomeLayout>
{/if}
