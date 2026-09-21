<script lang="ts">
  import { Timeline } from '@lostgradient/cinder';

  const entries = [
    {
      id: 'green',
      datetime: '2026-05-23T13:00:00Z',
      timestamp: '8:00 AM',
      title: 'Health check passed',
      tone: 'success' as const,
    },
    {
      id: 'yellow',
      datetime: '2026-05-23T13:05:00Z',
      timestamp: '8:05 AM',
      title: 'Capacity warning',
      tone: 'warning' as const,
    },
    {
      id: 'red',
      datetime: '2026-05-23T13:12:00Z',
      timestamp: '8:12 AM',
      title: 'Rollback triggered',
      tone: 'error' as const,
    },
  ];

  const details: Record<string, string> = {
    green: 'All probes returned healthy responses across the deployment target.',
    yellow: 'Projected load crossed the warning threshold for the current pool.',
    red: 'Rollback automation started after error rates continued climbing.',
  };
</script>

<Timeline {entries} label="Incident timeline">
  {#snippet marker(entry)}
    <!-- The marker box is a centered inline-flex container, so each icon sits
         optically centered. State is not colour-alone: each tone gets a
         distinct glyph shape, the tone prop still drives the marker's
         semantic styling, and the entry titles carry the state in prose. -->
    {#if entry.tone === 'success'}
      <span aria-hidden="true">•</span>
    {:else if entry.tone === 'warning'}
      <span aria-hidden="true">•</span>
    {:else}
      <span aria-hidden="true">•</span>
    {/if}
  {/snippet}

  {#snippet children(entry)}
    {details[entry.id]}
  {/snippet}
</Timeline>

<button id="before-horizontal-timeline" type="button">Before horizontal timeline</button>
<div id="example-mount-horizontal" style:inline-size="20rem">
  <Timeline {entries} orientation="horizontal" label="Horizontal incident timeline">
    {#snippet children(entry)}
      {details[entry.id]}
    {/snippet}
  </Timeline>
</div>
