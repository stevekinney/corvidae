<script lang="ts">
  /**
   * `/schedules/:schedule/edit`: the page that changes a schedule (COR-2018, rows 74r, 74t, 75p,
   * 75q). It reads the schedule and what the Bureau says of it, then opens the form that makes a
   * schedule on that schedule (`new-schedule.svelte`). Who writes a schedule is the owner's to say:
   * a schedule that runs an agent changes through the Bureau, an engine schedule through the
   * engine, and a workflow file's schedule is the trigger in its file, so it points at the
   * workflow's editor instead.
   *
   * The form is opened on the schedule as it was first read and is not built again when a refetch
   * brings a newer one, so a refetch never discards what was typed. A save made against a schedule
   * that changed since is refused, nothing is written, and the form says so and offers to start
   * over from the schedule as it is now.
   */
  import { Alert, Button, ErrorState, PageHeader, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL, SCHEDULE_COPY } from '../../app/copy.ts';
  import { getClient } from '../../lib/client.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { kindOf } from '../../lib/schedule-kinds.ts';
  import { workflowEditPath } from '../../lib/workflow-type-paths.ts';
  import FaultBanner from './fault-banner.svelte';
  import NewSchedule from './new-schedule.svelte';
  import { OVERLAY_FAILURE } from './overlay-failure.ts';
  import { scheduleOverlayOptions } from './overlay-query.ts';
  import type { EditTarget } from './schedule-edit-model.ts';
  import { fetchScheduleDetail, scheduleDetailQueryKey } from './schedule-queries.ts';

  interface Props {
    id: string;
  }

  let { id }: Props = $props();

  const copy = SCHEDULE_COPY.edit;
  const client = getClient();

  const detail = createQuery(() => ({
    queryKey: scheduleDetailQueryKey(id),
    queryFn: () => fetchScheduleDetail(client, id),
  }));
  const overlay = createQuery(() => scheduleOverlayOptions(client));

  const kind = $derived(
    detail.data === undefined || detail.data === null
      ? undefined
      : kindOf(detail.data, overlay.data),
  );

  /** The schedule the form was opened on, which a refetch does not replace. */
  let opened = $state<EditTarget>();

  $effect(() => {
    const schedule = detail.data;
    const owner = kind;
    // Which form to open is the owner's to say, so nothing is opened until the Bureau has.
    // The page may be moved to another schedule while it is open, which is a draft of its own.
    if (opened !== undefined && opened.schedule.id !== id) opened = undefined;
    if (!schedule || schedule.id !== id || owner === undefined || opened !== undefined) return;
    if (owner.kind !== 'agent-run' && owner.kind !== 'code') return;
    opened = {
      schedule,
      kind: owner.kind,
      agentName: owner.kind === 'agent-run' ? owner.agentName : null,
      message: owner.kind === 'agent-run' ? (overlay.data?.inputs?.get(schedule.id) ?? null) : null,
    };
  });

  /** Opens the form again on the schedule as it is now. */
  async function startOver(): Promise<void> {
    await Promise.all([detail.refetch(), overlay.refetch()]);
    opened = undefined;
  }
</script>

{#if opened !== undefined}
  <!-- The form is one mount for one schedule: a new one is a new draft. -->
  {#key opened}
    <NewSchedule editing={opened} onStartOver={() => void startOver()} />
  {/key}
{:else}
  <section class="ib-records ib-schedule-edit" aria-label={copy.title} data-page="schedule-edit">
    <PageHeader title={copy.title} headingLevel={1} />

    {#if detail.isPending || (detail.data !== null && detail.data !== undefined && overlay.isPending)}
      <div role="status" aria-busy="true" aria-label={copy.loading}>
        <Skeleton height="220px" />
      </div>
    {:else if detail.isError}
      <ErrorState
        variant="flat"
        title={SCHEDULE_COPY.detail.loadFailed}
        description={faultTreatment(detail.error).message}
        headingLevel={2}
        retryLabel={RETRY_LABEL}
        onRetry={() => void detail.refetch()}
      />
    {:else if detail.data === null}
      <FaultBanner
        treatment={{
          kind: 'not-found',
          message: SCHEDULE_COPY.detail.notFound.description,
        }}
      />
    {:else if kind?.kind === 'unknown' && overlay.data?.failed}
      <FaultBanner treatment={OVERLAY_FAILURE} onRetry={() => void overlay.refetch()} />
    {:else if kind?.kind === 'workflow-file'}
      <!-- A workflow file's schedule is its trigger: everything about it is edited in the workflow. -->
      <Alert variant="info" data-testid="schedule-edit-in-workflow">
        <p class="ib-schedule__alert">{SCHEDULE_COPY.form.notEditable}</p>
        <p>{SCHEDULE_COPY.editWorkflowNote}</p>
        <Button
          variant="secondary"
          size="sm"
          href={router.href(workflowEditPath(kind.file.id))}
          onclick={(event) => {
            event.preventDefault();
            router.navigate(workflowEditPath(kind.file.id));
          }}>{SCHEDULE_COPY.editWorkflowAction}</Button
        >
      </Alert>
    {/if}
  </section>
{/if}
