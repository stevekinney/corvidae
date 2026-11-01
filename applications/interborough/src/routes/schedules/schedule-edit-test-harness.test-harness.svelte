<script lang="ts">
  /**
   * Test-only composition of `<SchedulesTestHarness>` + `<ScheduleEdit>`. The page is reached at its
   * own address, so the harness opens it, and says the page was left (`onClose`) when the address
   * is no longer the edit page's, as a save or Cancel leaves it. See
   * `schedule-list-test-harness.test-harness.svelte` for why this wrapper exists.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import type { QueryClient } from '@tanstack/svelte-query';
  import { Window } from 'happy-dom';
  import { untrack } from 'svelte';

  import { router, scheduleEditPath } from '../../lib/router.svelte.ts';
  import type { AuthorizationScope } from '../../lib/scopes.svelte.ts';
  import ScheduleEdit from './schedule-edit.svelte';
  import SchedulesTestHarness from './schedules-test-harness.test-harness.svelte';

  interface Props {
    client: HttpClient;
    scheduleId: string;
    onClose?: (() => void) | undefined;
    scopes?: readonly AuthorizationScope[] | undefined;
    onQueryClient?: ((queryClient: QueryClient) => void) | undefined;
  }

  let { client, scheduleId, onClose, scopes, onQueryClient }: Props = $props();

  const editPath = untrack(() => scheduleEditPath(scheduleId));
  // A page that was never given an address has none to navigate on.
  if (window instanceof Window && window.location.protocol === 'about:') {
    window.happyDOM.setURL('http://localhost/');
  }
  router.navigate(editPath, { replace: true });

  const editPathname = new URL(editPath, 'http://localhost').pathname;
  /** Whether the address has been the edit page's, so that leaving it is told from not yet being there. */
  let arrived = false;

  $effect(() => {
    const here = router.pathname === editPathname;
    if (here) arrived = true;
    else if (arrived) onClose?.();
  });
</script>

<SchedulesTestHarness {client} {scopes} {onQueryClient}>
  {#snippet children()}
    <ScheduleEdit id={scheduleId} />
  {/snippet}
</SchedulesTestHarness>
