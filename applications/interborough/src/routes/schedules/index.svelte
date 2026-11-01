<script lang="ts">
  /**
   * The schedules area. Each address mounts a page of its own, and the pattern says which:
   *
   *   - `/schedules`                  → the list
   *   - `/schedules/new`              → the page that makes a schedule
   *   - `/schedules/<id>`             → one schedule
   *   - `/schedules/<id>/edit`        → the page that edits it
   */
  import { router } from '../../lib/router.svelte.ts';
  import NewSchedule from './new-schedule.svelte';
  import ScheduleDetail from './schedule-detail.svelte';
  import ScheduleEdit from './schedule-edit.svelte';
  import ScheduleList from './schedule-list.svelte';

  const pattern = $derived(router.current.route?.pattern);
  const id = $derived(router.current.params['schedule'] ?? null);
</script>

{#if pattern === '/schedules/new'}
  <NewSchedule />
{:else if pattern === '/schedules/:schedule/edit' && id !== null}
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
