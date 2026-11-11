<script lang="ts">
  /**
   * The body of the run setup page: the input, when the run happens, and the pinned footer that
   * holds the one-line summary, Cancel, and the primary action.
   *
   * The input is `workflow-input.svelte`'s: a Cinder `SchemaForm` or a JSON editor, started only
   * when the footer asked for it, so Enter in a field never starts anything. The When block is the
   * one the new schedule page shares (`schedule-when.svelte`) with its two policy selects, and the
   * Name that comes last. Start run and Create schedule are the same page with a different When
   * choice; the choice is bound to the page, whose heading and breadcrumb follow it.
   *
   * The body stands in every state the page can be in, so When and the footer never move: while
   * the workflow loads (a skeleton in the form's place), when its schema could not be read (the
   * Input section's own error block), for a file that cannot be read, and for one that takes no
   * input. While the page says the action is off (`block`), the reason is drawn beside it.
   *
   * A start and a schedule create real work, so a second ask while one is in flight is dropped
   * before the first `await`, and while it is in flight the form is read-only. A refusal keeps the
   * input where it was: the Bureau's or the engine's field problems go on the fields they name, and
   * any other failure is an alert above the footer, at the action.
   */
  import {
    Alert,
    Button,
    FormField,
    FormSection,
    humanizeIdentifier,
    Input,
    RadioGroup,
    Skeleton,
    type ScheduleValue,
  } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { untrack, type Snippet } from 'svelte';

  import { RETRY_LABEL, WORKFLOW_COPY } from '../../app/copy.ts';
  import { agentFaultOf } from '../../lib/agent-definitions.ts';
  import { getSettings } from '../../lib/bureau-settings.ts';
  import { getClient } from '../../lib/client.ts';
  import { isNetworkFailure } from '../../lib/faults.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router, scheduleDetailPath, workflowRunPath } from '../../lib/router.svelte.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import { startingSchedules } from '../../lib/workflow-catalog.ts';
  import { startWorkflowFile } from '../../lib/workflow-files.ts';
  import { workflowTypePath } from '../../lib/workflow-type-paths.ts';
  import { parseWorkflowAggregateResult } from '../health/aggregate-output.ts';
  import { aggregateInputFor, WORKING_NOW_FILTER } from '../health/health-counts.ts';
  import {
    browserTimeZone,
    scheduleValueTimeZone,
    scheduleValueToWireSpec,
  } from '../schedules/cadence.ts';
  import { MAX_NAME_LENGTH } from '../schedules/new-schedule-model.ts';
  import { createSchedule } from '../schedules/schedule-queries.ts';
  import { cadenceText } from '../schedules/schedule-cadence-text.ts';
  import ScheduleWhen from '../schedules/schedule-when.svelte';
  import {
    actionOffReason,
    inputIssuesOf,
    missingRequiredField,
    runsAtLimit,
    summaryOf,
    takesNoInput,
    type InputState,
    type RunSetupIdentity,
    type StartBlock,
  } from './run-setup-model.ts';
  import type { TriggerSummary } from './workflow-presentation.ts';
  import WorkflowInput from './workflow-input.svelte';

  interface Props {
    /** The workflow's identifier. */
    type: string;
    /** What starts it: a file the Bureau holds, or a type that code registered; `undefined` until it is read. */
    kind?: 'file' | 'code' | undefined;
    /** The JSON Schema its input is described by, or `undefined` when it declares none. */
    schema: unknown;
    /**
     * What the Input section holds: `ready` draws the input from `schema`; `loading` is the form's
     * skeleton while the workflow is read; `failed` is the section's own error block when the
     * schema could not be read; `unreadable` says no form can be drawn from a file that cannot be
     * read.
     * @default 'ready'
     */
    input?: 'ready' | 'loading' | 'failed' | 'unreadable';
    /** Why the primary action is off, which is said beside it; `undefined` while it is on. */
    block?: StartBlock | undefined;
    /** What the workflow is called: its title, or its identifier when the file gives none. */
    identity: RunSetupIdentity;
    /** What starts a file on its own, which the When section says beside Now. */
    trigger: TriggerSummary | null;
    /** The page's alerts about the workflow (paused, can't load, no provider), drawn above Input. */
    notice?: Snippet;
    /** Reads the workflow again, from the Input section's error block. */
    onRetry?: () => void;
    /** The When choice, `now` or `schedule`, which the page's heading and breadcrumb follow. */
    whenChoice?: string;
  }

  let {
    type,
    kind,
    schema,
    input: inputMode = 'ready',
    block,
    identity,
    trigger,
    notice,
    onRetry,
    whenChoice = $bindable('now'),
  }: Props = $props();

  const copy = WORKFLOW_COPY.runSetup;
  const client = getClient();
  const queryClient = useQueryClient();
  const principal = getPrincipalStore();

  /** `RadioGroup` holds its choice as a plain string. */
  const when = $derived<'now' | 'schedule'>(whenChoice === 'schedule' ? 'schedule' : 'now');
  let cadence = $state<ScheduleValue>({ cron: '0 9 * * *', timeZone: browserTimeZone() });
  let overlap = $state('skip');
  let catchUp = $state(false);
  /** The schedule's name starts as the workflow's, until it is edited. */
  const startingName = $derived(
    identity.titled ? identity.name : humanizeIdentifier(type, { casing: 'sentence' }),
  );
  let name = $state(untrack(() => startingName));
  let nameEdited = $state(false);
  let nameError = $state('');
  $effect(() => {
    if (!nameEdited) name = startingName;
  });
  /** Why the last ask did not start or create anything, said in the alert above the footer. */
  let failure = $state<{
    readonly title: string;
    /** What the service said, or `null` when the title says it all. */
    readonly message: string | null;
    /** That nothing was done and the input is still here, for a refusal the service answered. */
    readonly closing: string | null;
    /** Where to look when the answer was lost and the work may have been done. */
    readonly check?: { readonly label: string; readonly path: string };
  } | null>(null);
  /** The first field the last ask found empty, repeated above the footer until the input changes. */
  let inputProblem = $state<string | null>(null);

  /** What the input holds, for the footer's summary. */
  let input = $state<InputState>({ mode: 'form', value: undefined });
  function trackInput(next: InputState): void {
    input = next;
    inputProblem = null;
  }

  /** Whether the workflow takes no input whatever starts it, so the Input section says so in one line. */
  const noInput = $derived(
    inputMode === 'ready' && kind !== undefined && takesNoInput(kind, schema),
  );

  /** The input, which the footer asks for and the Bureau's or the engine's refusal goes back to. */
  let inputField = $state<ReturnType<typeof WorkflowInput<Choice>>>();
  /** The When block, which says whether the cadence it shows is one it emitted. */
  let whenBlock = $state<ReturnType<typeof ScheduleWhen>>();
  /**
   * Whether a start is in flight. It is set before the first `await`, because the mutation's own
   * `isPending` turns true a tick after `mutate`, and two asks can arrive in that tick.
   */
  let sending = false;

  /** The choices the footer's ask was made with, which the start sends whatever changes while the input is checked. */
  type Choice = {
    readonly when: 'now' | 'schedule';
    readonly cadence: ScheduleValue;
    readonly name: string;
    readonly overlap: string;
    readonly catchUp: boolean;
  };

  type Outcome =
    | { readonly kind: 'run'; readonly runId: string }
    | { readonly kind: 'schedule'; readonly id: string };

  const run = createMutation(() => ({
    mutationFn: async (variables: Choice & { readonly input: unknown }): Promise<Outcome> => {
      if (variables.when === 'schedule') {
        const timeZone = scheduleValueTimeZone(variables.cadence);
        const created = await createSchedule(client, {
          workflowType: type,
          input: variables.input,
          spec: scheduleValueToWireSpec(variables.cadence),
          ...(timeZone !== undefined ? { timeZone } : {}),
          description: variables.name.trim(),
          overlap: variables.overlap === 'allow' ? 'allow' : 'skip',
          backfill: variables.catchUp,
          revisionPolicy: 'active-at-fire',
        });
        return { kind: 'schedule', id: created.id };
      }
      if (kind === 'file') {
        const started = await startWorkflowFile(type, variables.input);
        return { kind: 'run', runId: started.runId };
      }
      const handle = await client.start(type, variables.input);
      return { kind: 'run', runId: handle.id };
    },
    onMutate: () => {
      failure = null;
      inputProblem = null;
      inputField?.clear();
    },
    onSuccess: (outcome) => {
      void queryClient.invalidateQueries({ queryKey: ['workflow-catalog'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflowCatalog.list() });
      if (outcome.kind === 'schedule') {
        void queryClient.invalidateQueries({ queryKey: ['schedules'] });
        router.navigate(scheduleDetailPath(outcome.id));
        return;
      }
      router.navigate(workflowRunPath(type, outcome.runId));
    },
    onError: (error, variables) => {
      const refused = inputIssuesOf(error);
      if (refused !== null) {
        inputField?.refuse(refused);
        return;
      }
      const scheduled = variables.when === 'schedule';
      if (isNetworkFailure(error)) {
        // The request may have reached the Bureau before the answer was lost, and a start carries no
        // key that would make a second ask the same one, so a second ask could create a second run:
        // say it may have happened, and where to look, never that nothing started.
        failure = {
          title: scheduled ? copy.scheduleMaybe : copy.startMaybe,
          message: copy.lostDescription,
          closing: null,
          check: scheduled
            ? { label: copy.checkSchedules, path: '/schedules' }
            : { label: copy.checkRuns, path: '/runs' },
        };
        return;
      }
      // The service answered with a refusal, so nothing was done, and the ask can be made again.
      const title = scheduled ? copy.scheduleFailed : copy.startFailed;
      const closing = scheduled ? copy.nothingCreated : copy.nothingStarted;
      const fault = agentFaultOf(error);
      switch (fault.kind) {
        case 'forbidden':
          failure = { title, message: copy.forbidden, closing };
          return;
        case 'not-found':
          failure = { title, message: copy.notFoundOnStart, closing };
          return;
        case 'rejected':
        case 'other':
          failure = { title, message: fault.message, closing };
          return;
        case 'stale':
        case 'identifier-taken':
          // A start names no hash and no identifier, so neither can be told.
          failure = { title, message: null, closing };
          return;
      }
    },
    onSettled: () => {
      sending = false;
    },
  }));

  // The schedules that start the workflow: the same read as the workflow's own page, so one answers the other.
  const schedules = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.schedules(type),
      queryFn: async () => {
        const page = await client.listSchedules({ workflowType: type });
        return startingSchedules(page.items);
      },
    }),
    undefined,
  );

  /** One schedule that also starts the workflow, as the line under Now names it. */
  type StartedBy = {
    readonly id: string;
    readonly label: string;
    readonly href: string;
    /** The note after its name: its cadence, or that it is paused. */
    readonly note: string | null;
    readonly paused: boolean;
  };
  const startedBy = $derived<readonly StartedBy[]>(
    (schedules.data ?? []).map((schedule) => {
      const described = schedule.description?.trim() ?? '';
      return {
        id: schedule.id,
        label: described === '' ? type : described,
        href: scheduleDetailPath(schedule.id),
        note: cadenceText(schedule).file,
        paused: schedule.status === 'paused',
      };
    }),
  );
  /** Whether the read that lists the schedules has answered, so a trigger is not described twice while it is out. */
  const schedulesSettled = $derived(schedules.isSuccess || schedules.isError);
  /** The trigger's own note: a signal always, and a schedule when no schedule line already says it. */
  const triggerNote = $derived.by(() => {
    if (trigger === null) return undefined;
    if (trigger.kind === 'signal') return { kind: 'signal' as const, name: trigger.name };
    if (!schedulesSettled || startedBy.length > 0) return undefined;
    return { kind: 'schedule' as const, text: copy.triggerSchedule(trigger.words) };
  });
  /** Whether the schedules were read and none, not even the file's own trigger, starts the workflow. */
  const notScheduled = $derived(
    schedules.isSuccess && startedBy.length === 0 && trigger?.kind !== 'schedule',
  );

  /**
   * The engine's cap on runs at once, read on load. The value in force is the one the host booted
   * with (`running`): the key applies on restart, so a saved value may not be in force yet. A
   * caller who may not read the settings is told nothing, and Now reads as it always does.
   */
  const settings = createQuery(() => ({
    queryKey: queryKeys.settings.snapshot(),
    queryFn: ({ signal }: { signal: AbortSignal }) => getSettings({ signal }),
    retry: false,
  }));
  /**
   * The runs that are going, by type, so the types the Bureau runs itself (which never take a slot)
   * can be left out. The count is the engine's, which only a caller who may read runs is given.
   */
  const running = createQuery(() => ({
    queryKey: queryKeys.workflows.aggregate('type', WORKING_NOW_FILTER),
    queryFn: async () =>
      parseWorkflowAggregateResult(
        await client.operations['weft.workflows.aggregate']({
          ...aggregateInputFor(WORKING_NOW_FILTER),
          groupBy: 'type' as const,
        }),
      ),
    enabled: principal.hasScope('workflows:read'),
    retry: false,
  }));
  /** The cap, when as many runs as it allows are going: a run started now waits for one to finish. */
  const atLimit = $derived(
    runsAtLimit(
      settings.data?.running['engine.maxConcurrentRuns'] ??
        settings.data?.effective['engine.maxConcurrentRuns'],
      running.data,
    ),
  );

  /** The scope the primary action needs, disabled with its reason when the principal lacks it. */
  const gate = $derived.by(() => {
    if (when === 'schedule') return scopeGate(principal, ['schedules:write']);
    if (kind === 'code') return scopeGate(principal, ['workflows:write']);
    return { disabled: false, title: undefined };
  });
  /** Whether a start or a schedule is in flight: the form is read-only, and Cancel is off. */
  const starting = $derived(run.isPending);
  const action = $derived(when === 'schedule' ? copy.scheduleAction : copy.startAction);
  const actionLabel = $derived(
    starting ? (when === 'schedule' ? copy.creatingAction : copy.startingAction) : action,
  );
  /** Why the primary action is off, beside it, in the action's own name. */
  const offReason = $derived(actionOffReason(block, action));
  const summary = $derived(
    starting && when === 'now'
      ? copy.startingSummary(identity.name)
      : summaryOf({
          name: identity.name,
          when,
          cadence,
          schema,
          input,
          queuedBehind: when === 'now' ? atLimit : undefined,
        }),
  );

  function begin(value: unknown, choice: Choice): void {
    if (sending) return;
    sending = true;
    run.mutate({ input: value, ...choice });
  }

  /** What is wrong with the schedule's name, or the empty string. */
  function nameProblem(text: string): string {
    const trimmed = text.trim();
    if (trimmed === '') return copy.nameRequired;
    return trimmed.length > MAX_NAME_LENGTH ? copy.nameTooLong(MAX_NAME_LENGTH) : '';
  }

  /** The footer's ask. The input checks itself, and starts only what this ask submitted. */
  function request(): void {
    if (sending || gate.disabled || block !== undefined) return;
    if (when === 'schedule') {
      if (whenBlock?.isInvalid() === true) {
        failure = {
          title: copy.scheduleFailed,
          message: copy.scheduleInvalid,
          closing: null,
        };
        return;
      }
      nameError = nameProblem(name);
      if (nameError !== '') {
        document.getElementById('run-setup-name')?.focus();
        return;
      }
    }
    // The mutation reads the schedule after its first `await`, so it gets a copy the builder cannot change.
    const choice: Choice = {
      when,
      cadence: $state.snapshot(cadence),
      name,
      overlap,
      catchUp,
    };
    if (noInput) {
      begin(undefined, choice);
      return;
    }
    // The form marks the field and moves focus to it; the line above the footer repeats it there.
    const missing = input.mode === 'form' ? missingRequiredField(schema, input.value) : undefined;
    inputProblem = missing === undefined ? null : copy.requiredBeforeRun(missing);
    inputField?.request(choice);
  }

  function openLink(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  function cancel(): void {
    router.navigate(workflowTypePath(type));
  }
</script>

<div class="ib-run-setup__body">
  {@render notice?.()}

  <!-- While a start is in flight nothing in the form can be changed: what was sent is what shows. -->
  <div class="ib-run-setup__fields" inert={starting} data-testid="run-setup-fields">
    {#if when === 'schedule'}
      <p class="ib-run-setup__lead" data-testid="run-setup-input-lead-schedule">
        {copy.scheduleInputLead}
      </p>
    {/if}

    <FormSection heading={copy.inputHeading} columns={1}>
      {#if inputMode === 'loading'}
        <!-- Nothing for the first 300 ms, then fields in the form's layout, then the status line. -->
        <Skeleton
          variant="form"
          rows={2}
          delay={300}
          stillLoadingAfter={10_000}
          stillLoadingLabel={copy.loadingInput}
          onCancel={cancel}
          label={copy.loadingInput}
        />
      {:else if inputMode === 'failed'}
        <Alert
          variant="danger"
          heading={copy.inputFailed.title}
          data-testid="run-setup-input-failed"
        >
          {copy.inputFailed.description}
          {#snippet actions()}
            <Button variant="secondary" size="sm" onclick={() => onRetry?.()}>{RETRY_LABEL}</Button>
          {/snippet}
        </Alert>
      {:else if inputMode === 'unreadable'}
        <p class="ib-run-setup__line" data-testid="run-setup-no-form">{copy.unreadableInput}</p>
      {:else if noInput}
        <p class="ib-run-setup__line" data-testid="run-setup-no-form">
          {copy.takesNoInput(identity.name)}
        </p>
      {:else}
        <WorkflowInput
          bind:this={inputField}
          {schema}
          composed
          locked={starting}
          onChange={trackInput}
          onInput={begin}
        />
      {/if}
    </FormSection>

    <FormSection heading={copy.whenHeading} columns={1}>
      <RadioGroup
        name="run-setup-when"
        label={copy.whenLabel}
        variant="card"
        bind:value={whenChoice}
      >
        <RadioGroup.Option
          id="run-setup-when-now"
          value="now"
          label={copy.now}
          description={atLimit === undefined ? copy.nowDescription : copy.nowAtLimit(atLimit)}
        />
        <RadioGroup.Option
          id="run-setup-when-schedule"
          value="schedule"
          label={copy.schedule}
          description={copy.scheduleDescription}
        />
      </RadioGroup>
      {#if when === 'now'}
        <div class="ib-run-setup__starts" data-testid="run-setup-starts">
          {#if triggerNote?.kind === 'signal'}
            <p class="ib-run-setup__line" data-testid="run-setup-trigger">
              {copy.triggerSignal.before}<code>{triggerNote.name}</code>{copy.triggerSignal.after}
            </p>
          {:else if triggerNote?.kind === 'schedule'}
            <p class="ib-run-setup__line" data-testid="run-setup-trigger">{triggerNote.text}</p>
          {/if}
          {#each startedBy as line (line.id)}
            <p class="ib-run-setup__line" data-testid="run-setup-started-by">
              {copy.alsoStartedBy.before}<a
                href={router.href(line.href)}
                onclick={(event) => openLink(event, line.href)}>{line.label}</a
              >{copy.alsoStartedBy.after}{line.paused
                ? copy.alsoStartedBy.paused
                : line.note === null
                  ? copy.alsoStartedBy.bare
                  : copy.alsoStartedBy.cadence(line.note)}
            </p>
          {/each}
          {#if notScheduled}
            <p class="ib-run-setup__line" data-testid="run-setup-not-scheduled">
              {copy.notScheduled}
            </p>
          {/if}
        </div>
      {:else}
        <ScheduleWhen
          bind:this={whenBlock}
          value={cadence}
          onValueChange={(next) => (cadence = next)}
          label={copy.scheduleLabel}
          {overlap}
          onOverlapChange={(next) => (overlap = next)}
          {catchUp}
          onCatchUpChange={(next) => (catchUp = next)}
          catchUpLabel={copy.catchUpLabel}
        />
        <FormField
          id="run-setup-name"
          label={copy.nameLabel}
          description={copy.nameDescription}
          required
          error={nameError}
          errorGlyph="error"
        >
          <Input
            id="run-setup-name"
            required
            bind:value={name}
            oninput={() => {
              nameEdited = true;
              nameError = '';
            }}
          />
        </FormField>
      {/if}
    </FormSection>
  </div>

  <!-- What went wrong with the last ask, at the action: never a banner, and never dismissed by hand. -->
  {#if inputProblem !== null}
    <Alert variant="danger" data-testid="run-setup-input-problem">{inputProblem}</Alert>
  {/if}
  {#if failure !== null}
    <Alert variant="danger" data-testid="run-setup-failure">
      <p class="ib-run-setup__alert-message">
        <span class="ib-run-setup__alert-title">{failure.title}</span>
        {#if failure.message !== null}
          <span>{failure.message}</span>
        {/if}
        {#if failure.closing !== null}
          <span>{failure.closing}</span>
        {/if}
      </p>
      {#if failure.check !== undefined}
        {@const check = failure.check}
        <p class="ib-run-setup__alert-message">
          <a href={router.href(check.path)} onclick={(event) => openLink(event, check.path)}
            >{check.label}</a
          >
        </p>
      {/if}
    </Alert>
  {/if}

  <div class="ib-run-setup__footer" data-testid="run-setup-footer">
    <p class="ib-run-setup__summary" data-testid="run-setup-summary">{summary}</p>
    <div class="ib-run-setup__actions">
      {#if offReason !== null}
        <span
          id="run-setup-action-off"
          class="ib-run-setup__reason"
          data-testid="run-setup-action-off">{offReason}</span
        >
      {/if}
      <Button variant="secondary" disabled={starting} onclick={cancel}>{copy.cancel}</Button>
      <Button
        data-changes
        variant="primary"
        disabled={gate.disabled || block !== undefined || starting}
        title={gate.title}
        aria-describedby={offReason === null ? undefined : 'run-setup-action-off'}
        onclick={request}>{actionLabel}</Button
      >
    </div>
  </div>
</div>

<style>
  .ib-run-setup__body,
  .ib-run-setup__fields {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-6);
    min-width: 0;
  }

  .ib-run-setup__lead {
    margin: 0;
    color: var(--cinder-text-muted);
  }

  /* What else starts the workflow, in lines under the choice. */
  .ib-run-setup__starts {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
  }

  .ib-run-setup__starts:empty {
    display: none;
  }

  .ib-run-setup__line {
    margin: 0;
    color: var(--cinder-text-muted);
    overflow-wrap: anywhere;
  }

  .ib-run-setup__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-run-setup__alert-message {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .ib-run-setup__alert-message + .ib-run-setup__alert-message {
    margin-block-start: var(--cinder-space-1);
  }

  /*
   * What the page will do, and the way to do it. It stays at the foot of the outlet while the form
   * scrolls under it, so the action is always in reach.
   */
  .ib-run-setup__footer {
    position: sticky;
    /* The outlet pads its own bottom edge; reach through it so nothing scrolls under the bar. */
    bottom: calc(-1 * var(--cinder-space-6));
    z-index: 1;
    margin-block-end: calc(-1 * var(--cinder-space-6));
    padding-block: var(--cinder-space-3);
    background: var(--cinder-surface-canvas);
    border-block-start: 1px solid var(--cinder-border);
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-3) var(--cinder-space-4);
    align-items: center;
    justify-content: space-between;
  }

  .ib-run-setup__summary {
    margin: 0;
    min-width: 0;
    flex: 1 1 16rem;
    color: var(--cinder-text-muted);
    overflow-wrap: anywhere;
  }

  .ib-run-setup__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: center;
    margin-inline-start: auto;
  }

  /* Why the primary action is off, beside it. */
  .ib-run-setup__reason {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }
</style>
