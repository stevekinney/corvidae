<script lang="ts">
  /**
   * The details of a schedule, in a card beside its runs: What runs (the workflow, and the agent),
   * Input (only for a workflow that has input), When (in the New schedule form's own words, with the
   * time in the viewer's zone), Behaviour (what happens when a run is still going, when
   * Interborough was off, and which workflow version a run starts on) and when it was created. A
   * run that is going, and the runs queued behind it, are said here only while there are any.
   */
  import { Card, formatDate, Link, Tooltip } from '@lostgradient/cinder';
  import { Info } from '@lucide/svelte';

  import type { ScheduleSummary } from '@lostgradient/weft';

  import { SCHEDULE_COPY } from '../../app/copy.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import { formatRelativeTime, truncateId } from '../../lib/format/index.ts';
  import { router, workflowDetailPath } from '../../lib/router.svelte.ts';
  import { AGENT_RUN_TYPE } from '../../lib/schedule-kinds.ts';
  import { internalWorkflowsPath, workflowTypePath } from '../../lib/workflow-type-paths.ts';
  import type { AgentSummary } from '../../lib/bureau-client.ts';
  import { overlapConsequence } from './overlap-policy.ts';
  import { type ScheduleInput, viewerClockNote, whenRows } from './schedule-detail-model.ts';
  import ScheduleInputGroup from './schedule-input-group.svelte';
  import type { ScheduleRow } from './schedule-row-model.ts';

  interface Props {
    schedule: ScheduleSummary;
    row: ScheduleRow;
    input: ScheduleInput | undefined;
    agents: readonly AgentSummary[] | undefined;
    /** Where When › Edit goes, or `undefined` for a schedule whose cadence is not edited here. */
    editPath: string | undefined;
    now: number;
  }

  let { schedule, row, input, agents, editPath, now }: Props = $props();

  const copy = SCHEDULE_COPY.detail.card;
  const when = $derived(whenRows(schedule));
  const viewerClock = $derived(viewerClockNote(schedule, now));
  const isChat = $derived(schedule.workflowType === AGENT_RUN_TYPE);
  const workflowPath = $derived(
    isChat ? internalWorkflowsPath() : workflowTypePath(schedule.workflowType),
  );
  const cannotLoad = $derived(row.blockers.some((blocker) => blocker.kind === 'cannot-load'));
  const pinned = $derived(
    schedule.revisionPolicy === 'pinned' && schedule.pinnedRevision !== undefined,
  );
  const revision = $derived(
    pinned ? copy.revisionPinned(schedule.pinnedRevision ?? '') : copy.revisionLatest,
  );
  const overlap = $derived(copy.overlapValue[schedule.overlap]);
</script>

<aside aria-label={copy.label} data-testid="schedule-details">
  <Card class="ib-schedule-card">
    <div class="ib-schedule-card__body">
      <section class="ib-schedule-card__group">
        <h3 class="ib-schedule-card__title">{copy.whatRuns}</h3>
        <dl class="ib-schedule-card__rows">
          <div class="ib-schedule-card__row">
            <dt>{copy.workflow}</dt>
            <dd data-testid="schedule-workflow">
              <Link underline="always" href={router.href(workflowPath)}>
                {#if cannotLoad}<code class="ib-identifier">{row.workflowType}</code
                  >{:else}{row.workflowLabel}{/if}
              </Link>
              {#if isChat}
                <span class="ib-schedule-card__aside">{copy.builtIn}</span>
                <code class="ib-identifier">{AGENT_RUN_TYPE}</code>
              {/if}
            </dd>
          </div>
          {#if row.agentIds.length > 0}
            <div class="ib-schedule-card__row">
              <dt>{row.agentIds.length === 1 ? copy.agent : copy.agents}</dt>
              <dd data-testid="schedule-agents">
                {#each row.agentIds as id, index (id)}
                  {#if index > 0}{', '}{/if}<Link href={router.href(agentPath(id))}
                    >{agentLabel(id, agents)}</Link
                  >
                {/each}
              </dd>
            </div>
          {/if}
        </dl>
      </section>

      {#if input !== undefined}
        <ScheduleInputGroup {input} />
      {/if}

      <section class="ib-schedule-card__group">
        <div class="ib-schedule-card__head">
          <h3 class="ib-schedule-card__title">{copy.when}</h3>
          {#if editPath !== undefined}
            {@const path = editPath}
            <Link href={router.href(path)}>{copy.whenEdit}</Link>
          {/if}
        </div>
        <dl class="ib-schedule-card__rows">
          {#each when as field (field.label)}
            <div class="ib-schedule-card__row">
              <dt>{field.label}</dt>
              <dd>
                {#if field.code === true}<code class="ib-identifier">{field.value}</code
                  >{:else}{field.value}{/if}
              </dd>
            </div>
          {/each}
        </dl>
        {#if viewerClock !== null}
          <p class="ib-schedule-card__note" data-testid="schedule-viewer-clock">{viewerClock}</p>
        {/if}
      </section>

      <section class="ib-schedule-card__group">
        <h3 class="ib-schedule-card__title">{copy.behaviour}</h3>
        <dl class="ib-schedule-card__rows">
          <div class="ib-schedule-card__row">
            <dt>{copy.overlap}</dt>
            <dd data-testid="schedule-overlap" title={overlapConsequence(schedule.overlap)}>
              {overlap}
            </dd>
          </div>
          <div class="ib-schedule-card__row">
            <dt>{copy.catchUp}</dt>
            <dd data-testid="schedule-catch-up">
              {schedule.backfill ? copy.catchUpOn : copy.catchUpOff}
            </dd>
          </div>
          <div class="ib-schedule-card__row">
            <dt>
              {copy.revision}
              <Tooltip text={pinned ? copy.revisionInfoPinned : copy.revisionInfo}>
                <button
                  type="button"
                  class="ib-schedule-card__info"
                  aria-label={copy.revisionInfoLabel}
                >
                  <Info aria-hidden="true" size={14} />
                </button>
              </Tooltip>
            </dt>
            <dd data-testid="schedule-revision">{revision}</dd>
          </div>
          {#if schedule.currentWorkflowId !== undefined}
            {@const path = workflowDetailPath(schedule.currentWorkflowId)}
            <div class="ib-schedule-card__row">
              <dt>{copy.runningNow}</dt>
              <dd>
                <Link href={router.href(path)}
                  ><code class="ib-identifier">{truncateId(schedule.currentWorkflowId)}</code></Link
                >
              </dd>
            </div>
          {/if}
          {#if schedule.queuedRuns.length > 0}
            <div class="ib-schedule-card__row">
              <dt>{copy.queued}</dt>
              <dd>
                <ul class="ib-schedule-card__queue">
                  {#each schedule.queuedRuns as queued (queued.workflowId)}
                    {@const path = workflowDetailPath(queued.workflowId)}
                    <li>
                      <Link href={router.href(path)}
                        ><code class="ib-identifier">{truncateId(queued.workflowId)}</code></Link
                      >
                      {formatRelativeTime(queued.queuedAt)}
                    </li>
                  {/each}
                </ul>
              </dd>
            </div>
          {/if}
        </dl>
      </section>

      <p class="ib-schedule-card__created" data-testid="schedule-created">
        {copy.created(formatDate(schedule.createdAt, 'en-US', { month: 'short', day: 'numeric' }))}
      </p>
    </div>
  </Card>
</aside>
