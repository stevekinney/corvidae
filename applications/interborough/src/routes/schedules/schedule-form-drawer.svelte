<script lang="ts">
  /**
   * Create/Edit schedule slide-over (Track B, plan §9.3; design
   * `Weft New Surfaces.dc.html` §A2 — 440px right slide-over, BINDING
   * layout). Owns data fetching (edit-mode prefill, registry-driven
   * workflow picker), submission, and the Drawer chrome; field rendering is
   * `schedule-form-fields.svelte`.
   */
  import { Alert, Button, Collapsible, Drawer, Skeleton } from '@lostgradient/cinder';
  import { RUN_ENGINE_WORKFLOW_TYPES } from '@lostgradient/operative/run-engine-workflow-types';
  import { CalendarPlus, Lock } from '@lucide/svelte';

  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { SCHEDULE_COPY } from '../../app/copy.ts';
  import { agentFaultOf } from '../../lib/agent-definitions.ts';
  import { listAgents } from '../../lib/bureau-client.ts';
  import { createAgentSchedule, updateAgentSchedule } from '../../lib/bureau-schedules.ts';
  import { getClient } from '../../lib/client.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router, scheduleDetailPath } from '../../lib/router.svelte.ts';
  import { AGENT_RUN_TYPE, kindOf, type ScheduleOverlay } from '../../lib/schedule-kinds.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import { workflowEditPath } from '../../lib/workflow-type-paths.ts';
  import AgentScheduleFields from './agent-schedule-fields.svelte';
  import { AgentScheduleFormState } from './agent-schedule-form-state.svelte.ts';
  import { cadenceOf, cadenceToScheduleValue } from './cadence.ts';
  import FaultBanner from './fault-banner.svelte';
  import { OVERLAY_FAILURE } from './overlay-failure.ts';
  import { scheduleOverlayOptions } from './overlay-query.ts';
  import ScheduleFormFields from './schedule-form-fields.svelte';
  import { ScheduleFormState } from './schedule-form-state.svelte.ts';
  import {
    createSchedule,
    fetchRegisteredWorkflowTypes,
    fetchScheduleDetail,
    pauseSchedule,
    scheduleDetailQueryKey,
    updateScheduleSpec,
  } from './schedule-queries.ts';

  interface Props {
    mode: 'create' | 'edit';
    /** Required when `mode === 'edit'`. */
    scheduleId?: string | undefined;
    onClose: () => void;
  }

  let { mode, scheduleId, onClose }: Props = $props();

  const client = getClient();
  const principal = getPrincipalStore();
  const queryClient = useQueryClient();
  const writeGate = $derived(scopeGate(principal, ['schedules:write']));

  /** Degrades to a free-text field on error/pending — the create action itself only needs `schedules:write`, not `system:read` (this query's scope). */
  const registryQuery = createQuery(() => ({
    queryKey: queryKeys.registry(),
    queryFn: () => fetchRegisteredWorkflowTypes(client),
  }));

  // What the Bureau knows of the schedules: which workflows are agent-authored, whose schedule is
  // the trigger in their file, and so cannot be scheduled from here.
  const overlayQuery = createQuery(() => scheduleOverlayOptions(client));

  /** The agents a schedule may run. Degrades to a typed name when the Bureau cannot list them. */
  const agentsQuery = createQuery(() => ({
    queryKey: queryKeys.agents.list(),
    queryFn: ({ signal }) => listAgents({ signal }),
    enabled: mode === 'create',
    retry: false,
  }));
  const agentNames = $derived(
    agentsQuery.isSuccess ? agentsQuery.data.map((agent) => agent.name) : undefined,
  );

  /**
   * What is reserved to another owner: `agentRun` to the agent choice, a workflow file's type to its
   * file, and every other type the Bureau's run engine registers to the Bureau, which starts them
   * with the checks a schedule made here would skip. The Operative package says which types those are.
   */
  function reservedTypes(overlay: ScheduleOverlay | undefined): ReadonlyMap<string, string> {
    const reserved = new Map<string, string>(
      RUN_ENGINE_WORKFLOW_TYPES.map((type) => [
        type,
        type === AGENT_RUN_TYPE
          ? SCHEDULE_COPY.form.reservedAgentRun
          : SCHEDULE_COPY.form.reservedBureauWorkflow,
      ]),
    );
    for (const id of overlay?.files?.keys() ?? []) {
      reserved.set(id, SCHEDULE_COPY.form.reservedAgentAuthored);
    }
    return reserved;
  }

  /**
   * The registry's types a schedule may start: those code defines. `agentRun` is the Bureau's, made
   * only by the agent choice, which checks the agent and its owner, and an agent-authored type's
   * schedule is the trigger in its file. With no registry the list is `undefined`, a typed name.
   */
  const workflowTypeOptions = $derived.by(() => {
    if (!registryQuery.isSuccess) return undefined;
    const reserved = reservedTypes(overlayQuery.data);
    return registryQuery.data.filter((type) => !reserved.has(type));
  });

  /**
   * A new schedule runs an agent. Starting a code-defined workflow instead is under an "Advanced"
   * disclosure, which swaps the agent's fields for a workflow type's while it is open.
   */
  let workflowOpen = $state(false);
  const starts = $derived<'agent' | 'workflow'>(workflowOpen ? 'workflow' : 'agent');

  const editDetailQuery = createQuery(() => ({
    queryKey: scheduleDetailQueryKey(scheduleId ?? ''),
    queryFn: () => fetchScheduleDetail(client, scheduleId ?? ''),
    enabled: mode === 'edit' && scheduleId !== undefined,
  }));

  let form = $state<ScheduleFormState>();
  let agentForm = $state<AgentScheduleFormState>();

  /** Who owns the schedule being edited, once the Bureau has said. */
  const editKind = $derived(
    mode === 'edit' && editDetailQuery.data
      ? kindOf(editDetailQuery.data, overlayQuery.data)
      : undefined,
  );

  /**
   * `updatedAt` of the schedule the current `form` was built from. Plain
   * (non-reactive) bookkeeping for the effect below.
   */
  let builtFromUpdatedAt: number | undefined;

  /**
   * Edit-mode form rebuild (COR-15). The query result changes identity
   * whenever a background refetch (tab refocus, live-update invalidation,
   * another operator's edit) delivers different server data. Rebuilding
   * `form` on every such change discarded an operator's unsaved edits, so:
   * the form is (re)built only when the schedule's `updatedAt` has actually
   * moved since the last build, and even then a form with unsaved edits
   * (`isDirty`) is kept as-is rather than replaced. A clean form still
   * follows server changes, so an externally applied change shows up.
   */
  /** The schedule the agent form was built from, and when it was last changed. Plain bookkeeping for the effect below. */
  let agentBuiltFor: { readonly id: string; readonly updatedAt: number } | undefined;

  $effect(() => {
    if (mode === 'create') {
      form = new ScheduleFormState();
      agentForm = new AgentScheduleFormState({ mode: 'create' });
      builtFromUpdatedAt = undefined;
      return;
    }
    const schedule = editDetailQuery.data;
    const kind = editKind;
    // Which form to build is the owner's to say, so nothing is built until the Bureau has.
    if (!schedule || kind === undefined) return;
    if (kind.kind === 'agent-run') {
      // The same rule as the Weft form below: rebuilt only when the schedule changed, and never over unsaved edits.
      const currentAgentForm = untrack(() => agentForm);
      const same = currentAgentForm !== undefined && agentBuiltFor?.id === schedule.id;
      if (same && agentBuiltFor?.updatedAt === schedule.updatedAt) return;
      if (same && currentAgentForm.isDirty) return;
      agentBuiltFor = { id: schedule.id, updatedAt: schedule.updatedAt };
      agentForm = new AgentScheduleFormState({
        mode: 'edit',
        cadence: cadenceToScheduleValue(schedule),
        originalCadence: cadenceOf(schedule),
        description: schedule.description ?? '',
        overlap: schedule.overlap === 'allow' ? 'allow' : 'skip',
        revision: schedule.revision,
      });
      return;
    }
    if (kind.kind !== 'code') return;
    const current = untrack(() => form);
    // A form built for a different schedule is never kept: saving it would
    // write that schedule's edits onto this one.
    const sameSchedule = current !== undefined && current.id === schedule.id;
    if (sameSchedule && builtFromUpdatedAt === schedule.updatedAt) return;
    if (sameSchedule && current.isDirty) return;
    builtFromUpdatedAt = schedule.updatedAt;
    form = new ScheduleFormState({
      id: schedule.id,
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

  // A type that is not the engine's to schedule is refused for a typed name as well as left out of the list.
  $effect(() => {
    const reserved = reservedTypes(overlayQuery.data);
    if (form !== undefined) form.reservedTypes = reserved;
  });

  function invalidateSchedules(): void {
    void queryClient.invalidateQueries({ queryKey: ['schedules'] });
  }

  const createScheduleMutation = createMutation(() => ({
    mutationFn: async () => {
      if (!form) throw new Error('Form not ready.');
      const created = await createSchedule(client, form.toCreateArgs());
      if (form.startPaused) await pauseSchedule(client, created.id);
      return created;
    },
    onSuccess: (created) => {
      invalidateSchedules();
      onClose();
      router.navigate(scheduleDetailPath(created.id));
    },
  }));

  const createAgentScheduleMutation = createMutation(() => ({
    mutationFn: () => {
      if (!agentForm) throw new Error('Form not ready.');
      return createAgentSchedule(agentForm.toCreateInput());
    },
    onSuccess: (created) => {
      invalidateSchedules();
      onClose();
      router.navigate(scheduleDetailPath(created.id));
    },
  }));

  const updateScheduleMutation = createMutation(() => ({
    mutationFn: async () => {
      if (!form || scheduleId === undefined) throw new Error('Form not ready.');
      await updateScheduleSpec(client, scheduleId, form.cadenceSpec, form.toUpdateOptions());
    },
    onSuccess: () => {
      invalidateSchedules();
      onClose();
    },
  }));

  /** An edit was refused because the schedule changed after the drawer read it. */
  let stale = $state(false);

  const updateAgentScheduleMutation = createMutation(() => ({
    mutationFn: async () => {
      if (!agentForm || scheduleId === undefined) throw new Error('Form not ready.');
      await updateAgentSchedule(scheduleId, agentForm.toUpdate(), agentForm.revision);
    },
    onMutate: () => {
      stale = false;
    },
    onSuccess: () => {
      invalidateSchedules();
      onClose();
    },
    onError: (error: unknown) => {
      if (agentFaultOf(error).kind !== 'stale') return;
      // The page behind the drawer reads the schedule again; the drawer keeps what was typed
      // until the person asks to start over from what the schedule is now.
      stale = true;
      invalidateSchedules();
    },
  }));

  /** Drops the draft and builds it again from the schedule as it is now. */
  async function reloadFromSchedule(): Promise<void> {
    agentForm = undefined;
    agentBuiltFor = undefined;
    stale = false;
    updateAgentScheduleMutation.reset();
    await editDetailQuery.refetch();
  }

  /** The mutation this drawer's submit button runs, by what is being made or changed. */
  const active = $derived.by(() => {
    if (mode === 'create') {
      return starts === 'agent' ? createAgentScheduleMutation : createScheduleMutation;
    }
    return editKind?.kind === 'agent-run' ? updateAgentScheduleMutation : updateScheduleMutation;
  });
  const submitting = $derived(active.isPending);
  const submitError = $derived(active.error);

  /** The draft being edited, whichever form it is. */
  const draft = $derived(
    (mode === 'create' ? starts === 'agent' : editKind?.kind === 'agent-run') ? agentForm : form,
  );
  /** A workflow type is only chosen once the Bureau has said which are agent-authored. */
  const checking = $derived(
    mode === 'create' && starts === 'workflow' && overlayQuery.data?.files === undefined,
  );
  const canSubmit = $derived(
    draft !== undefined &&
      draft.isValid &&
      !checking &&
      !stale &&
      !writeGate.disabled &&
      !submitting,
  );

  function submit(): void {
    if (!canSubmit) return;
    active.mutate();
  }

  let open = $state(true);

  $effect(() => {
    if (!open) onClose();
  });
</script>

<Drawer bind:open title={mode === 'create' ? 'Create schedule' : 'Edit schedule'} size="md">
  {#snippet header()}
    <div class="weft-schedule-drawer__header">
      <CalendarPlus aria-hidden="true" size={16} />
      <span class="weft-schedule-drawer__title">
        {mode === 'create' ? 'Create schedule' : 'Edit schedule'}
      </span>
    </div>
  {/snippet}

  {#if mode === 'edit' && (editDetailQuery.isPending || (editDetailQuery.isSuccess && editDetailQuery.data !== null && overlayQuery.isPending))}
    <div role="status" aria-busy="true" aria-label="Loading schedule">
      <Skeleton height="220px" />
    </div>
  {:else if mode === 'edit' && editDetailQuery.isError}
    <FaultBanner
      treatment={faultTreatment(editDetailQuery.error)}
      onRetry={() => void editDetailQuery.refetch()}
    />
  {:else if mode === 'edit' && editDetailQuery.data === null}
    <FaultBanner
      treatment={{
        kind: 'not-found',
        message: `No schedule with id "${scheduleId}" exists — it may have been cancelled and purged.`,
      }}
    />
  {:else if mode === 'edit' && editKind?.kind === 'unknown' && overlayQuery.data?.failed}
    <FaultBanner treatment={OVERLAY_FAILURE} onRetry={() => void overlayQuery.refetch()} />
  {:else if mode === 'edit' && editKind?.kind === 'workflow-file'}
    <!-- A workflow file's schedule is its trigger: everything about it is edited in the workflow. -->
    <Alert variant="info" data-testid="schedule-edit-in-workflow">
      <p class="weft-schedule-drawer__alert-title">{SCHEDULE_COPY.form.notEditable}</p>
      <p class="weft-schedule-drawer__alert-body">{SCHEDULE_COPY.editWorkflowNote}</p>
      <Button
        variant="secondary"
        size="sm"
        href={router.href(workflowEditPath(editKind.file.id))}
        onclick={(event) => {
          event.preventDefault();
          router.navigate(workflowEditPath(editKind.file.id));
        }}>{SCHEDULE_COPY.editWorkflowAction}</Button
      >
    </Alert>
  {:else if draft !== undefined}
    {#if mode === 'edit' ? editKind?.kind === 'agent-run' : starts === 'agent'}
      <!-- A new draft is a fresh mount, as the Weft fields below need. -->
      {#key agentForm}
        {#if agentForm}
          <AgentScheduleFields form={agentForm} agents={agentNames} />
        {/if}
      {/key}
    {:else if form && mode === 'edit'}
      <!--
        Keyed on `form` itself (WFT-117, Codex review round 2): the `$effect`
        above can reconstruct `form` as a brand-new `ScheduleFormState` while
        this drawer stays open (e.g. a background `editDetailQuery` refetch).
        `ScheduleFormFields` captures `form.revisionPolicy` into a one-shot
        local draft at mount, which is correct only if a NEW `form` instance
        always gets a FRESH mount: `{#key}` guarantees that instead of
        leaving a stale draft to silently overwrite the new form's value.
      -->
      {#key form}
        <ScheduleFormFields
          {form}
          {mode}
          {workflowTypeOptions}
          registeredTypeCount={registryQuery.isSuccess ? registryQuery.data.length : 0}
        />
      {/key}
    {/if}
    {#if mode === 'create'}
      <Collapsible bind:open={workflowOpen} trigger={SCHEDULE_COPY.form.advancedWorkflowLabel}>
        {#if form}
          <!-- Mounted only while the disclosure is open, so each opening is a fresh mount of the fields. -->
          {#key form}
            <ScheduleFormFields
              {form}
              {mode}
              {workflowTypeOptions}
              registeredTypeCount={registryQuery.isSuccess ? registryQuery.data.length : 0}
            />
          {/key}
          {#if overlayQuery.data?.failed && overlayQuery.data.files === undefined}
            <FaultBanner treatment={OVERLAY_FAILURE} onRetry={() => void overlayQuery.refetch()} />
          {:else if overlayQuery.isPending}
            <p class="weft-schedule-drawer__note">{SCHEDULE_COPY.form.overlayLoading}</p>
          {:else}
            <p class="weft-schedule-drawer__note">{SCHEDULE_COPY.form.registryNote}</p>
          {/if}
        {/if}
      </Collapsible>
    {/if}
    {#if stale && scheduleId !== undefined}
      <Alert variant="warning" data-testid="schedule-notice" data-notice="stale">
        <p class="weft-schedule-drawer__alert-title">{SCHEDULE_COPY.stale.title(scheduleId)}</p>
        <p class="weft-schedule-drawer__alert-body">{SCHEDULE_COPY.stale.description}</p>
        <Button variant="secondary" size="sm" onclick={() => void reloadFromSchedule()}
          >Start over from the current schedule</Button
        >
      </Alert>
    {:else if submitError}
      <FaultBanner treatment={faultTreatment(submitError)} />
    {/if}
  {/if}

  {#snippet footer()}
    <div class="weft-schedule-drawer__footer">
      <span class="weft-schedule-drawer__service-note">Runs as schedules service account</span>
      <Button variant="ghost" size="sm" onclick={() => (open = false)}>Cancel</Button>
      <Button variant="primary" size="sm" disabled={!canSubmit} onclick={submit}>
        {mode === 'create' ? 'Create schedule' : 'Save changes'}
      </Button>
      {#if writeGate.disabled}
        <span class="weft-schedule-drawer__scope-pill">
          <Lock aria-hidden="true" size={12} />
          {writeGate.title}
        </span>
      {/if}
    </div>
  {/snippet}
</Drawer>

<style>
  .weft-schedule-drawer__header {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .weft-schedule-drawer__title {
    font-size: var(--cinder-text-md);
    font-weight: 600;
  }

  .weft-schedule-drawer__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-schedule-drawer__alert-body {
    margin: 4px 0 8px;
  }

  .weft-schedule-drawer__note {
    margin: 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-muted);
  }

  .weft-schedule-drawer__footer {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .weft-schedule-drawer__service-note {
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-disabled);
  }

  .weft-schedule-drawer__scope-pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: var(--cinder-space-2) var(--cinder-space-2);
    background: var(--cinder-surface-raised);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-md);
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-subtle);
    box-shadow: var(--cinder-shadow-sm);
  }
</style>
