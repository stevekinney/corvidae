<script lang="ts">
  /**
   * Test-only harness: the route outlet with the shell's one fleet feed provided, which the engine's
   * workflow page (a run's Engine tab) reads from its ancestors. Never imported by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { untrack } from 'svelte';

  import { provideFleetEventSource } from '../../../app/engine-status.svelte.ts';
  import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
  import { FleetEventSource } from '../../../lib/live-source/fleet-event-source.svelte.ts';
  import type { AuthorizationScope } from '../../../lib/scopes.svelte.ts';

  interface RunDetailEngineHarnessProps {
    client: HttpClient;
    scopes: readonly AuthorizationScope[];
  }

  let { client, scopes }: RunDetailEngineHarnessProps = $props();

  // Never subscribed to by a test of this page's heading, so it opens no connection of its own.
  provideFleetEventSource(untrack(() => new FleetEventSource({ baseUrl: 'http://weft.test' })));
</script>

<RouteOutletHarness {client} {scopes} />
