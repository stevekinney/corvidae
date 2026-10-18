<script lang="ts">
  /**
   * ⌘K search skeleton (plan §13 T1.6): ID-prefix search across workflows /
   * schedules / workers / reviews via each domain's list operation,
   * navigating to the selected record (a run, a schedule, a worker) on select; a review has no page of its own, so it opens the inbox. "Skeleton" per the task
   * brief — this is a jump-to-record finder, not the full command surface
   * (actions, recent items) a later pass may add.
   *
   * Each domain search runs independently and swallows its own failure (a
   * 403 from a scope this principal lacks, a transient network error)
   * rather than failing the whole palette — a search-as-you-type surface
   * degrading one section to "no results" beats it going blank.
   */
  import { CommandItem, CommandPalette, EmptyState } from '@lostgradient/cinder';
  import type {
    ReviewListEntry,
    ScheduleSummary,
    WorkflowSummary,
    HttpClient,
  } from '@lostgradient/weft';

  import { router, workflowDetailPath } from '../../lib/router.svelte.ts';
  import type { ScopeGate } from '../../lib/scopes.svelte.ts';
  import { schedulePath, searchConsole, workerPath } from './command-palette-search.ts';

  interface CommandPaletteLauncherProps {
    open: boolean;
    client: HttpClient;
    /** Whether the principal holds `schedules:read`; without it schedules are not searched. Open when omitted. */
    scheduleReadGate?: ScopeGate | undefined;
  }

  let {
    open = $bindable(false),
    client,
    scheduleReadGate = { disabled: false, title: undefined },
  }: CommandPaletteLauncherProps = $props();

  let query = $state('');

  let workflowResults = $state<WorkflowSummary[]>([]);
  let scheduleResults = $state<ScheduleSummary[]>([]);
  let workerResults = $state<{ id: string; queue: string }[]>([]);
  let reviewResults = $state<ReviewListEntry[]>([]);

  async function search(currentQuery: string): Promise<void> {
    const results = await searchConsole(client, currentQuery, { scheduleReadGate });

    // `currentQuery` may be stale by the time these settle — drop results
    // for a query the user has already changed.
    if (currentQuery !== query) return;
    workflowResults = results.workflows;
    scheduleResults = results.schedules;
    workerResults = results.workers;
    reviewResults = results.reviews;
  }

  $effect(() => {
    const currentQuery = query;
    const timer = setTimeout(() => void search(currentQuery), 150);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    function onKeydown(event: KeyboardEvent): void {
      const isCommandK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
      if (!isCommandK) return;
      event.preventDefault();
      open = true;
    }
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  function goTo(path: string): void {
    router.navigate(path);
    open = false;
  }
</script>

<CommandPalette
  bind:open
  bind:query
  label="Command palette"
  placeholder="Search workflows, schedules, workers, reviews…"
>
  {#snippet items()}
    {#if workflowResults.length > 0}
      <li role="presentation" class="weft-command-group">
        <span class="weft-command-group__label">Runs</span>
        <ul role="group" aria-label="Runs">
          {#each workflowResults as workflow (workflow.id)}
            <CommandItem
              value={`workflow-${workflow.id}`}
              description={workflow.type}
              onSelect={() => goTo(workflowDetailPath(workflow.id))}
            >
              {workflow.id}
            </CommandItem>
          {/each}
        </ul>
      </li>
    {/if}
    {#if scheduleResults.length > 0}
      <li role="presentation" class="weft-command-group">
        <span class="weft-command-group__label">Schedules</span>
        <ul role="group" aria-label="Schedules">
          {#each scheduleResults as schedule (schedule.id)}
            <CommandItem
              value={`schedule-${schedule.id}`}
              description={schedule.workflowType}
              onSelect={() => goTo(schedulePath(schedule.id))}
            >
              {schedule.id}
            </CommandItem>
          {/each}
        </ul>
      </li>
    {/if}
    {#if workerResults.length > 0}
      <li role="presentation" class="weft-command-group">
        <span class="weft-command-group__label">Workers</span>
        <ul role="group" aria-label="Workers">
          {#each workerResults as worker (worker.id)}
            <CommandItem
              value={`worker-${worker.id}`}
              description={worker.queue}
              onSelect={() => goTo(workerPath(worker.id))}
            >
              {worker.id}
            </CommandItem>
          {/each}
        </ul>
      </li>
    {/if}
    {#if reviewResults.length > 0}
      <li role="presentation" class="weft-command-group">
        <span class="weft-command-group__label">Reviews</span>
        <ul role="group" aria-label="Reviews">
          {#each reviewResults as review (review.reviewId)}
            <CommandItem
              value={`review-${review.reviewId}`}
              description={review.reviewType}
              onSelect={() => goTo('/inbox')}
            >
              {review.reviewId}
            </CommandItem>
          {/each}
        </ul>
      </li>
    {/if}
  {/snippet}
  {#snippet empty()}
    <EmptyState
      title={query.length === 0 ? 'Search the console' : 'No matches'}
      description={query.length === 0
        ? 'Type an id or name to jump to a run, schedule, worker, or review.'
        : `Nothing matched "${query}".`}
    />
  {/snippet}
</CommandPalette>
