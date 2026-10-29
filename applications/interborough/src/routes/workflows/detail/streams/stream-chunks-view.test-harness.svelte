<script lang="ts">
  /**
   * Test-only page that provides the shell's fleet feed to `<StreamChunksView>`, as `shell.svelte`
   * does for every route. Never imported by production code.
   */
  import type { WorkflowStatus } from '@lostgradient/weft';
  import { untrack } from 'svelte';

  import { provideFleetEventSource } from '../../../../app/engine-status.svelte.ts';
  import type { FleetEventSource } from '../../../../lib/live-source/fleet-event-source.svelte.ts';
  import type { StreamChunksClient } from './stream-chunks-data.ts';
  import StreamChunksView from './stream-chunks-view.svelte';

  interface Props {
    fleetEvents: FleetEventSource;
    client: StreamChunksClient;
    workflowId: string;
    streamKey: string;
    status: WorkflowStatus;
    onClose: () => void;
  }

  let { fleetEvents, ...view }: Props = $props();

  provideFleetEventSource(untrack(() => fleetEvents));
</script>

<StreamChunksView {...view} />
