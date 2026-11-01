<script lang="ts">
  /**
   * `/schedules/:schedule/edit`: the page that changes a schedule's cadence, description and overlap
   * policy, and for an engine schedule the rest of its settings. Which fields it shows is the
   * owner's to say: a schedule that runs an agent changes only what the Bureau takes, an engine
   * schedule changes its cadence and options, and a workflow file's schedule is the trigger in its
   * file, so it points at the workflow's editor instead.
   *
   * The draft is built from the schedule once, and built again only when the schedule changed and
   * the draft holds no unsaved edit, so a refetch never discards what was typed. A save made against
   * a schedule that changed since it was read is refused, nothing is written, and the page says so
   * and offers to start over from the schedule as it is now. The cadence builder keeps the last
   * cadence it emitted while a custom field is out of range, so a save is refused until every field
   * the builder shows is valid.
   */
  import { Alert, Button, ErrorState, PageHeader, Skeleton } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { RETRY_LABEL, SCHEDULE_COPY } from '../../app/copy.ts';
  import { agentFaultOf } from '../../lib/agent-definitions.ts';
  import { updateAgentSchedule } from '../../lib/bureau-schedules.ts';
  import { getClient } from '../../lib/client.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router, scheduleDetailPath } from '../../lib/router.svelte.ts';
  import { kindOf } from '../../lib/schedule-kinds.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import { workflowEditPath } from '../../lib/workflow-type-paths.ts';
  import AgentScheduleFields from './agent-schedule-fields.svelte';
  import { AgentScheduleFormState } from './agent-schedule-form-state.svelte.ts';
  import { cadenceOf, cadenceToScheduleValue, shownCadenceIsInvalid } from './cadence.ts';
  import FaultBanner from './fault-banner.svelte';
  import { OVERLAY_FAILURE } from './overlay-failure.ts';
  import { scheduleOverlayOptions } from './overlay-query.ts';
  import ScheduleFormFields from './schedule-form-fields.svelte';
  import { ScheduleFormState } from './schedule-form-state.svelte.ts';
  import {
    fetchScheduleDetail,
    scheduleDetailQueryKey,
    updateScheduleSpec,
  } from './schedule-queries.ts';

  interface Props {
    id: string;
  }

  let { id }: Props = $props();

  const copy = SCHEDULE_COPY.edit;
  const client = getClient();
  const principal = getPrincipalStore();
  const queryClient = useQueryClient();
  const writeGate = $derived(scopeGate(principal, ['schedules:write']));

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

  let form = $state<ScheduleFormState>();
  let agentForm = $state<AgentScheduleFormState>();
  /** The schedule the draft was built from, and when it was last changed. Plain bookkeeping for the effect below. */
  let builtFrom:
    { readonly id: string; readonly updatedAt: number; readonly revision: number } | undefined;
  /** A save was refused because the schedule changed after the draft was built. */
  let stale = $state(false);
  /** The cadence builder shows a field that is out of range. */
  let invalidCadence = $state(false);
  let region = $state<HTMLElement>();

  $effect(() => {
    const schedule = detail.data;
    const owner = kind;
    // Which form to build is the owner's to say, so nothing is built until the Bureau has.
    if (!schedule || owner === undefined) return;
    if (owner.kind !== 'agent-run' && owner.kind !== 'code') return;
    const same = untrack(() =>
      owner.kind === 'agent-run' ? agentForm !== undefined : form !== undefined,
    );
    const current = untrack(() => (owner.kind === 'agent-run' ? agentForm : form));
    const builtForThis = same && builtFrom?.id === schedule.id;
    if (builtForThis && builtFrom?.updatedAt === schedule.updatedAt) return;
    // A draft with unsaved edits is kept over the newer schedule; saving it is then refused as stale.
    if (builtForThis && current?.isDirty === true) return;
    builtFrom = { id: schedule.id, updatedAt: schedule.updatedAt, revision: schedule.revision };
    if (owner.kind === 'agent-run') {
      agentForm = new AgentScheduleFormState({
        cadence: cadenceToScheduleValue(schedule),
        originalCadence: cadenceOf(schedule),
        description: schedule.description ?? '',
        overlap: schedule.overlap === 'allow' ? 'allow' : 'skip',
        revision: schedule.revision,
      });
      return;
    }
    form = new ScheduleFormState({
      workflowType: schedule.workflowType,
      ...(schedule.description !== undefined ? { description: schedule.description } : {}),
      cadence: cadenceToScheduleValue(schedule),
      originalCadence: cadenceOf(schedule),
      overlap: schedule.overlap,
      jitterText: schedule.jitterMs !== undefined ? `${schedule.jitterMs}ms` : '',
      backfill: schedule.backfill,
      revisionPolicy: schedule.revisionPolicy,
    });
  });

  function leave(): void {
    router.navigate(scheduleDetailPath(id));
  }

  function invalidateSchedules(): void {
    void queryClient.invalidateQueries({ queryKey: ['schedules'] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.schedules.overlay() });
  }

  const saveAgent = createMutation(() => ({
    mutationFn: async () => {
      if (!agentForm) throw new Error('Form not ready.');
      await updateAgentSchedule(id, agentForm.toUpdate(), agentForm.revision);
    },
    onMutate: () => {
      stale = false;
    },
    onSuccess: () => {
      invalidateSchedules();
      leave();
    },
    onError: (error: unknown) => {
      if (agentFaultOf(error).kind === 'stale') {
        stale = true;
        invalidateSchedules();
      }
    },
  }));

  /** Signals a save to an engine schedule that its draft is out of date, which the engine cannot compare itself. */
  class StaleDraft extends Error {}

  const saveEngine = createMutation(() => ({
    mutationFn: async () => {
      if (!form) throw new Error('Form not ready.');
      // The draft and what it was built from are read before the first `await`, because the page
      // may build another draft while the schedule is read.
      const spec = form.cadenceSpec;
      const options = form.toUpdateOptions();
      const builtRevision = builtFrom?.revision;
      // The engine has no revision to compare inside its write, so the schedule is read just before
      // it, which narrows the window to one round trip and does not close it.
      const now = await fetchScheduleDetail(client, id);
      // A fire moves `updatedAt` but not the revision, which only a change to the schedule does.
      if (now === null || now.revision !== builtRevision) throw new StaleDraft();
      await updateScheduleSpec(client, id, spec, options);
    },
    onMutate: () => {
      stale = false;
    },
    onSuccess: () => {
      invalidateSchedules();
      leave();
    },
    onError: (error: unknown) => {
      if (error instanceof StaleDraft) {
        stale = true;
        invalidateSchedules();
      }
    },
  }));

  const active = $derived(kind?.kind === 'agent-run' ? saveAgent : saveEngine);
  const draft = $derived(kind?.kind === 'agent-run' ? agentForm : form);
  const submitError = $derived(stale ? undefined : active.error);
  const canSave = $derived(
    draft !== undefined && draft.isValid && !stale && !writeGate.disabled && !active.isPending,
  );

  function save(): void {
    if (!canSave) return;
    // The builder keeps the last cadence it emitted while a field is out of range, so the draft is
    // not the cadence on screen: refuse until what is shown is valid.
    invalidCadence = shownCadenceIsInvalid(region);
    if (invalidCadence) return;
    active.mutate();
  }

  /** Drops the draft and builds it again from the schedule as it is now. */
  async function startOver(): Promise<void> {
    agentForm = undefined;
    form = undefined;
    builtFrom = undefined;
    stale = false;
    saveAgent.reset();
    saveEngine.reset();
    await detail.refetch();
  }
</script>

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
  {:else if draft !== undefined}
    <div class="ib-schedule-edit__body" bind:this={region}>
      {#if kind?.kind === 'agent-run'}
        <!-- A new draft is a fresh mount, as the fields need. -->
        {#key agentForm}
          {#if agentForm}
            <AgentScheduleFields form={agentForm} />
          {/if}
        {/key}
      {:else if form}
        <!--
          Keyed on `form` itself: the effect above can build a new draft while this page stays open,
          and `ScheduleFormFields` captures `form.revisionPolicy` into a one-shot local draft at
          mount, which is correct only if a new draft always gets a fresh mount.
        -->
        {#key form}
          <ScheduleFormFields {form} />
        {/key}
      {/if}
    </div>
    {#if detail.data?.skipUntil !== undefined && draft?.cadenceDiffersFromLoaded === true}
      <!-- The engine keeps a pending skip across an update that leaves the next run where it was, and drops it when the cadence or zone changes. -->
      <Alert variant="info" data-testid="schedule-edit-skip-pending">{copy.skipPending}</Alert>
    {/if}
    {#if invalidCadence}
      <Alert variant="danger" dismissible onDismiss={() => (invalidCadence = false)}>
        {copy.invalidCadence}
      </Alert>
    {/if}
    {#if stale}
      <Alert variant="warning" data-testid="schedule-notice" data-notice="stale">
        <p class="ib-schedule__alert">{SCHEDULE_COPY.stale.title(id)}</p>
        <p>{SCHEDULE_COPY.stale.description}</p>
        <Button variant="secondary" size="sm" onclick={() => void startOver()}
          >{copy.startOver}</Button
        >
      </Alert>
    {:else if submitError}
      <FaultBanner treatment={faultTreatment(submitError)} />
    {/if}
    <div class="ib-schedule-edit__footer">
      <Button variant="ghost" onclick={leave}>{copy.cancel}</Button>
      <Button
        data-changes
        variant="primary"
        disabled={!canSave}
        loading={active.isPending}
        onclick={save}>{copy.save}</Button
      >
    </div>
  {/if}
</section>
