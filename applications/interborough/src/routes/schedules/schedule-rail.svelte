<script lang="ts">
  /**
   * The details of a schedule beside its runs: the workflow it runs and the input it sends, how it
   * repeats and in which zone, what happens when a fire is due while a run is still going, whether
   * it catches up after downtime, and the run in progress. The facts are the schedule's own, read
   * from the engine, and the agent and the input are what the Bureau says of a schedule it owns.
   */
  import type { ScheduleSummary } from '@lostgradient/weft';

  import { SCHEDULE_COPY } from '../../app/copy.ts';
  import { formatRelativeTime, truncateId } from '../../lib/format/index.ts';
  import IdentifierText from '../../lib/identifier-text.svelte';
  import { router, workflowDetailPath } from '../../lib/router.svelte.ts';
  import type { ScheduleKind } from '../../lib/schedule-kinds.ts';
  import WorkerInheritanceNote from '../../lib/worker-inheritance-note.svelte';
  import { describeCadence } from './cadence.ts';
  import { overlapConsequence } from './overlap-policy.ts';
  import { revisionPolicyLabel } from './revision-policy.ts';
  import { cadenceIdentifiers } from './schedule-presentation.ts';
  import ScheduleTarget from './schedule-target.svelte';
  import { sentenceZone } from './schedule-time.ts';

  interface Props {
    schedule: ScheduleSummary;
    kind: ScheduleKind;
    /** The start of the text each fire sends, when the Bureau shows it. */
    input: string | undefined;
  }

  let { schedule, kind, input }: Props = $props();

  const copy = SCHEDULE_COPY.detail.rail;
  const zone = $derived(sentenceZone(schedule));
  const jitter = $derived(
    schedule.jitterMs !== undefined && schedule.jitterMs > 0
      ? `±${String(schedule.jitterMs)}ms`
      : copy.noJitter,
  );
  const revision = $derived(
    schedule.revisionPolicy === 'pinned' && schedule.pinnedRevision !== undefined
      ? `${revisionPolicyLabel(schedule.revisionPolicy)} (${schedule.pinnedRevision})`
      : revisionPolicyLabel(schedule.revisionPolicy),
  );

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<aside
  class="ib-schedule__rail"
  aria-label={SCHEDULE_COPY.detail.railHeading}
  data-testid="schedule-rail"
>
  <h2 class="ib-records__subheading">{SCHEDULE_COPY.detail.railHeading}</h2>
  <dl class="ib-schedule__facts">
    <div class="ib-facts__item">
      <dt>{copy.workflow}</dt>
      <dd class="ib-records__wrap"><ScheduleTarget {schedule} {kind} /></dd>
    </div>
    <div class="ib-facts__item">
      <dt>{copy.input}</dt>
      <dd class="ib-records__wrap" data-testid="schedule-input">
        {input === undefined ? copy.noInput : `“${input}”`}
      </dd>
    </div>
    <div class="ib-facts__item">
      <dt>{copy.repeats}</dt>
      <dd class="ib-records__wrap">
        <IdentifierText
          text={describeCadence(schedule)}
          identifiers={cadenceIdentifiers(schedule)}
        />
      </dd>
    </div>
    {#if zone !== null}
      <div class="ib-facts__item">
        <dt>{copy.zone}</dt>
        <dd class="ib-records__wrap" data-testid="schedule-rail-zone">{zone}</dd>
      </div>
    {/if}
    <div class="ib-facts__item">
      <dt>{copy.overlap}</dt>
      <dd data-testid="schedule-overlap" title={overlapConsequence(schedule.overlap)}>
        {SCHEDULE_COPY.overlapLine[schedule.overlap]}
      </dd>
    </div>
    <div class="ib-facts__item">
      <dt>{copy.catchUp}</dt>
      <dd>{schedule.backfill ? copy.catchUpOn : copy.catchUpOff}</dd>
    </div>
    <div class="ib-facts__item">
      <dt>{copy.jitter}</dt>
      <dd>{jitter}</dd>
    </div>
    <div class="ib-facts__item">
      <dt>{copy.revision}</dt>
      <dd>{revision}</dd>
    </div>
    <div class="ib-facts__item">
      <dt>{copy.runningNow}</dt>
      <dd>
        {#if schedule.currentWorkflowId !== undefined}
          {@const path = workflowDetailPath(schedule.currentWorkflowId)}
          <a href={router.href(path)} onclick={(event) => go(event, path)}
            ><code class="ib-identifier">{truncateId(schedule.currentWorkflowId)}</code></a
          >
        {:else}
          {copy.nothingRunning}
        {/if}
      </dd>
    </div>
    {#if schedule.queuedRuns.length > 0}
      <div class="ib-facts__item">
        <dt>{copy.queued}</dt>
        <dd>
          <ul class="ib-schedule__queue">
            {#each schedule.queuedRuns as queued (queued.workflowId)}
              {@const path = workflowDetailPath(queued.workflowId)}
              <li>
                <a href={router.href(path)} onclick={(event) => go(event, path)}
                  ><code class="ib-identifier">{truncateId(queued.workflowId)}</code></a
                >
                {formatRelativeTime(queued.queuedAt)}
              </li>
            {/each}
          </ul>
        </dd>
      </div>
    {/if}
    <div class="ib-facts__item">
      <dt>{copy.created}</dt>
      <dd>{formatRelativeTime(schedule.createdAt)}</dd>
    </div>
  </dl>
  <WorkerInheritanceNote surface="schedule" />
</aside>
