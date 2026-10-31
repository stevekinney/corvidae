<script lang="ts">
  /**
   * The schedules area: `/schedules` is the list and `/schedules/:schedule` is one schedule's page. The
   * create and edit drawers live in query state over those two, so a drawer is a location a link
   * can name and the page behind it stays mounted:
   *
   *   - `/schedules`                  → list
   *   - `/schedules?create=1`         → list + create drawer over it
   *   - `/schedules/<id>`             → detail (a full page, not a split panel)
   *   - `/schedules/<id>?edit=1`      → detail + edit drawer over it
   */
  import { router, scheduleDetailPath } from '../../lib/router.svelte.ts';
  import ScheduleDetail from './schedule-detail.svelte';
  import ScheduleFormDrawer from './schedule-form-drawer.svelte';
  import ScheduleList from './schedule-list.svelte';

  const search = $derived(router.current.search);
  // A path that names a schedule is its page, and the outlet mounts a page for each address.
  const id = $derived(router.current.params['schedule'] ?? null);
  const isCreate = $derived(id === null && search.get('create') === '1');
  const isEdit = $derived(id !== null && search.get('edit') === '1');

  /** Closes the drawer back to the surface it opened over: the schedule's page for edit, the list for create. */
  function closeDrawer(): void {
    router.navigate(id !== null ? scheduleDetailPath(id) : '/schedules');
  }
</script>

{#if id !== null}
  {#key id}
    <ScheduleDetail {id} />
  {/key}
{:else}
  <ScheduleList />
{/if}

{#if isCreate}
  <ScheduleFormDrawer mode="create" onClose={closeDrawer} />
{:else if isEdit && id !== null}
  <ScheduleFormDrawer mode="edit" scheduleId={id} onClose={closeDrawer} />
{/if}
