<script lang="ts">
  /**
   * The schedules area. Each address mounts a page of its own, and the pattern says which:
   *
   *   - `/schedules`                  → the list, with the create drawer over it at `?create=1`
   *   - `/schedules/<id>`             → one schedule
   *   - `/schedules/<id>/edit`        → the page that edits it
   *
   * The create drawer lives in query state over the list, so it is a location a link can name and
   * the list behind it stays mounted.
   */
  import { router } from '../../lib/router.svelte.ts';
  import ScheduleDetail from './schedule-detail.svelte';
  import ScheduleEdit from './schedule-edit.svelte';
  import ScheduleFormDrawer from './schedule-form-drawer.svelte';
  import ScheduleList from './schedule-list.svelte';

  const pattern = $derived(router.current.route?.pattern);
  const id = $derived(router.current.params['schedule'] ?? null);
  const isCreate = $derived(
    pattern === '/schedules' && router.current.search.get('create') === '1',
  );

  /** Closes the drawer back to the list it opened over. */
  function closeDrawer(): void {
    router.navigate('/schedules');
  }
</script>

{#if pattern === '/schedules/:schedule/edit' && id !== null}
  {#key id}
    <ScheduleEdit {id} />
  {/key}
{:else if id !== null}
  {#key id}
    <ScheduleDetail {id} />
  {/key}
{:else}
  <ScheduleList />
{/if}

{#if isCreate}
  <ScheduleFormDrawer onClose={closeDrawer} />
{/if}
