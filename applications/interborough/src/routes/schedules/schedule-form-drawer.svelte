<script lang="ts">
  /**
   * Create schedule slide-over (Track B, plan §9.3; design
   * `Weft New Surfaces.dc.html` §A2 — 440px right slide-over, BINDING
   * layout). Owns data fetching (the registry-driven workflow picker),
   * submission, and the Drawer chrome; field rendering is
   * `schedule-form-fields.svelte`. Editing a schedule is its own page
   * (`schedule-edit.svelte`); this drawer is retired with the new schedule page.
   */
  import { Button, Collapsible, Drawer } from '@lostgradient/cinder';
  import { RUN_ENGINE_WORKFLOW_TYPES } from '@lostgradient/operative/run-engine-workflow-types';
  import { CalendarPlus, Lock } from '@lucide/svelte';

  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { SCHEDULE_COPY } from '../../app/copy.ts';
  import { listAgents } from '../../lib/bureau-client.ts';
  import { createAgentSchedule } from '../../lib/bureau-schedules.ts';
  import { getClient } from '../../lib/client.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router, scheduleDetailPath } from '../../lib/router.svelte.ts';
  import { AGENT_RUN_TYPE, type ScheduleOverlay } from '../../lib/schedule-kinds.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import AgentScheduleFields from './agent-schedule-fields.svelte';
  import { AgentScheduleFormState } from './agent-schedule-form-state.svelte.ts';
  import FaultBanner from './fault-banner.svelte';
  import { OVERLAY_FAILURE } from './overlay-failure.ts';
  import { scheduleOverlayOptions } from './overlay-query.ts';
  import ScheduleFormFields from './schedule-form-fields.svelte';
  import { ScheduleFormState } from './schedule-form-state.svelte.ts';
  import {
    createSchedule,
    fetchRegisteredWorkflowTypes,
    pauseSchedule,
  } from './schedule-queries.ts';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

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

  let form = $state<ScheduleFormState>();
  let agentForm = $state<AgentScheduleFormState>();

  $effect(() => {
    form = new ScheduleFormState();
    agentForm = new AgentScheduleFormState({ mode: 'create' });
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

  /** The mutation this drawer's submit button runs, by what is being made. */
  const active = $derived(
    starts === 'agent' ? createAgentScheduleMutation : createScheduleMutation,
  );
  const submitting = $derived(active.isPending);
  const submitError = $derived(active.error);

  /** The draft being made, whichever form it is. */
  const draft = $derived(starts === 'agent' ? agentForm : form);
  /** A workflow type is only chosen once the Bureau has said which are agent-authored. */
  const checking = $derived(starts === 'workflow' && overlayQuery.data?.files === undefined);
  const canSubmit = $derived(
    draft !== undefined && draft.isValid && !checking && !writeGate.disabled && !submitting,
  );

  let region = $state<HTMLElement>();
  /** The cadence builder shows a field that is out of range. */
  let invalidCadence = $state(false);

  function submit(): void {
    if (!canSubmit) return;
    // The builder keeps the last cadence it emitted while a custom field is out of range, so the
    // draft is not the cadence on screen: refuse until what is shown is valid.
    invalidCadence = region?.querySelector('[aria-invalid="true"]') != null;
    if (invalidCadence) return;
    active.mutate();
  }

  let open = $state(true);

  $effect(() => {
    if (!open) onClose();
  });
</script>

<Drawer bind:open title="Create schedule" size="md">
  {#snippet header()}
    <div class="weft-schedule-drawer__header">
      <CalendarPlus aria-hidden="true" size={16} />
      <span class="weft-schedule-drawer__title">Create schedule</span>
    </div>
  {/snippet}

  <div bind:this={region}>
    {#if draft !== undefined}
      {#if starts === 'agent'}
        <!-- A new draft is a fresh mount, as the Weft fields below need. -->
        {#key agentForm}
          {#if agentForm}
            <AgentScheduleFields form={agentForm} agents={agentNames} />
          {/if}
        {/key}
      {/if}
      <Collapsible bind:open={workflowOpen} trigger={SCHEDULE_COPY.form.advancedWorkflowLabel}>
        {#if form}
          <!-- Mounted only while the disclosure is open, so each opening is a fresh mount of the fields. -->
          {#key form}
            <ScheduleFormFields
              {form}
              mode="create"
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
      {#if invalidCadence}
        <FaultBanner
          treatment={{
            kind: 'invalid',
            message: SCHEDULE_COPY.edit.invalidCadence,
            fieldErrors: [],
          }}
        />
      {:else if submitError}
        <FaultBanner treatment={faultTreatment(submitError)} />
      {/if}
    {/if}
  </div>

  {#snippet footer()}
    <div class="weft-schedule-drawer__footer">
      <span class="weft-schedule-drawer__service-note">Runs as schedules service account</span>
      <Button variant="ghost" size="sm" onclick={() => (open = false)}>Cancel</Button>
      <Button data-changes variant="primary" size="sm" disabled={!canSubmit} onclick={submit}>
        Create schedule
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
