<script lang="ts">
  /**
   * Related runs in the Details rail of a run a goal or a schedule started and the workflow engine
   * does not hold as a run of its own (COR-2424, rows 55h and 55m): a goal's attempt lists the
   * goal's other attempts, each a link to its page ("Attempt 1 of 5 (Check not met)"), and a
   * schedule's run says whether it was the schedule's last and how many occurrences have been missed
   * since. A run with neither says nothing here; a chat's other runs are `run-chat-related.svelte`'s.
   */
  import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
  import type { Goal } from '../../../lib/bureau-goals.ts';
  import type { BureauSchedule } from '../../../lib/bureau-schedules.ts';
  import { router, workflowDetailPath } from '../../../lib/router.svelte.ts';
  import { otherAttempts, scheduleRelatedSentence } from './run-related-lines.ts';

  interface RunRelatedRunsProps {
    runId: string;
    /** The goal the run is an attempt of. */
    goal?: Goal | undefined;
    /** The schedule that started the run, when the page has read it. */
    schedule?: Pick<BureauSchedule, 'lastFireAt'> | undefined;
    /** How many occurrences the schedule missed and has not fired since, from the Bureau's attention list. */
    missedSince?: number | undefined;
    /** When the run started, in epoch milliseconds. */
    startedAt?: number | undefined;
    /**
     * Whether the section draws a heading of its own. The engine's related runs draw one beside it
     * for a run the engine holds, and one heading is enough.
     */
    heading?: boolean;
  }

  let {
    runId,
    goal,
    schedule,
    missedSince,
    startedAt,
    heading = true,
  }: RunRelatedRunsProps = $props();

  const attempts = $derived(goal === undefined ? [] : otherAttempts(goal, runId));
  const sentence = $derived(
    schedule === undefined || startedAt === undefined
      ? undefined
      : scheduleRelatedSentence(schedule, startedAt, missedSince),
  );

  /** Opens a link in place, leaving a modified click to the browser. */
  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

{#if goal !== undefined || sentence !== undefined}
  <!-- Under the engine's own Related runs this is not a region of its own, only more of its list. -->
  <svelte:element
    this={heading ? 'section' : 'div'}
    class="ib-run-related"
    aria-label={heading ? RUN_DETAIL_COPY.related.heading : undefined}
    data-section="related-owner"
  >
    {#if heading}
      <h2 class="ib-run__heading-2">{RUN_DETAIL_COPY.related.heading}</h2>
    {/if}
    {#if goal !== undefined && attempts.length === 0}
      <p class="ib-run__note">{RUN_DETAIL_COPY.related.noOtherAttempts}</p>
    {:else if attempts.length > 0}
      <ul class="ib-run-related__list">
        {#each attempts as attempt (attempt.runId)}
          {@const path = workflowDetailPath(attempt.runId)}
          <li>
            <a href={router.href(path)} onclick={(event) => open(event, path)}>{attempt.label}</a>
          </li>
        {/each}
      </ul>
    {/if}
    {#if sentence !== undefined}<p class="ib-run__note">{sentence}</p>{/if}
  </svelte:element>
{/if}
