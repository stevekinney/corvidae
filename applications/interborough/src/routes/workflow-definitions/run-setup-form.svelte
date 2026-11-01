<script lang="ts">
  /**
   * The body of the run setup page: the input, when the run happens, and the pinned footer that
   * holds the one-line summary, Cancel, and the primary action.
   *
   * The input is `workflow-input.svelte`'s: a Cinder `SchemaForm` or a JSON editor, started only
   * when the footer asked for it, so Enter in a field never starts anything. The When block is the
   * one the new schedule page shares (`schedule-when.svelte`).
   *
   * A start and a schedule create real work, so a second ask while one is in flight is dropped
   * before the first `await`. A refusal keeps the input where it was: the Bureau's or the engine's
   * field problems go on the fields they name, and any other failure is a banner.
   */
  import { Alert, Button, RadioGroup, type ScheduleValue } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';

  import { WORKFLOW_COPY } from '../../app/copy.ts';
  import { agentFaultOf } from '../../lib/agent-definitions.ts';
  import { getClient } from '../../lib/client.ts';
  import { isNetworkFailure } from '../../lib/faults.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router, scheduleDetailPath, workflowRunPath } from '../../lib/router.svelte.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import { startWorkflowFile } from '../../lib/workflow-files.ts';
  import { workflowTypePath } from '../../lib/workflow-type-paths.ts';
  import {
    browserTimeZone,
    scheduleValueTimeZone,
    scheduleValueToWireSpec,
  } from '../schedules/cadence.ts';
  import { createSchedule } from '../schedules/schedule-queries.ts';
  import ScheduleWhen from '../schedules/schedule-when.svelte';
  import { inputIssuesOf, summaryOf } from './run-setup-model.ts';
  import WorkflowInput from './workflow-input.svelte';

  interface Props {
    /** The workflow's identifier. */
    type: string;
    /** What starts it: a file the Bureau holds, or a type that code registered. */
    kind: 'file' | 'code';
    /** The JSON Schema its input is described by, or `undefined` when it declares none. */
    schema: unknown;
  }

  let { type, kind, schema }: Props = $props();

  const copy = WORKFLOW_COPY.runSetup;
  const client = getClient();
  const queryClient = useQueryClient();
  const principal = getPrincipalStore();

  /** `RadioGroup` holds its choice as a plain string. */
  let whenChoice = $state('now');
  const when = $derived<'now' | 'schedule'>(whenChoice === 'schedule' ? 'schedule' : 'now');
  let cadence = $state<ScheduleValue>({ cron: '0 9 * * *', timeZone: browserTimeZone() });
  let failure = $state<{
    readonly title: string;
    readonly message: string;
    /** Where to look when the answer was lost and the work may have been done. */
    readonly check?: { readonly label: string; readonly path: string };
  } | null>(null);

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
  type Choice = { readonly when: 'now' | 'schedule'; readonly cadence: ScheduleValue };

  type Outcome =
    | { readonly kind: 'run'; readonly runId: string }
    | { readonly kind: 'schedule'; readonly id: string };

  const run = createMutation(() => ({
    mutationFn: async (variables: {
      readonly input: unknown;
      readonly when: 'now' | 'schedule';
      readonly cadence: ScheduleValue;
    }): Promise<Outcome> => {
      if (variables.when === 'schedule') {
        const timeZone = scheduleValueTimeZone(variables.cadence);
        const created = await createSchedule(client, {
          workflowType: type,
          input: variables.input,
          spec: scheduleValueToWireSpec(variables.cadence),
          ...(timeZone !== undefined ? { timeZone } : {}),
          overlap: 'skip',
          backfill: false,
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
      if (isNetworkFailure(error)) {
        // The request may have reached the Bureau before the answer was lost, so a second ask could
        // create a second run: say it may have happened, and where to look.
        const scheduled = variables.when === 'schedule';
        failure = {
          title: scheduled ? copy.scheduleMaybe : copy.startMaybe,
          message: copy.lostDescription,
          check: scheduled
            ? { label: copy.checkSchedules, path: '/schedules' }
            : { label: copy.checkRuns, path: '/runs' },
        };
        return;
      }
      const title = variables.when === 'schedule' ? copy.scheduleFailed : copy.startFailed;
      const fault = agentFaultOf(error);
      switch (fault.kind) {
        case 'forbidden':
          failure = { title, message: copy.forbidden };
          return;
        case 'not-found':
          failure = { title, message: copy.blocked.pausedDescription };
          return;
        case 'rejected':
        case 'other':
          failure = { title, message: fault.message };
          return;
        case 'stale':
        case 'identifier-taken':
          // A start names no hash and no identifier, so neither can be told.
          failure = { title, message: title };
          return;
      }
    },
    onSettled: () => {
      sending = false;
    },
  }));

  /** The scope the primary action needs, disabled with its reason when the principal lacks it. */
  const gate = $derived.by(() => {
    if (when === 'schedule') return scopeGate(principal, ['schedules:write']);
    if (kind === 'code') return scopeGate(principal, ['workflows:write']);
    return { disabled: false, title: undefined };
  });
  const summary = $derived(summaryOf(type, when, cadence));
  const action = $derived(when === 'schedule' ? copy.scheduleAction : copy.startAction);

  function begin(input: unknown, choice: Choice): void {
    if (sending) return;
    sending = true;
    run.mutate({ input, ...choice });
  }

  /** The footer's ask. The input checks itself, and starts only what this ask submitted. */
  function request(): void {
    if (sending || gate.disabled) return;
    if (when === 'schedule' && whenBlock?.isInvalid() === true) {
      failure = { title: copy.scheduleFailed, message: copy.scheduleInvalid };
      return;
    }
    // The mutation reads the schedule after its first `await`, so it gets a copy the builder cannot change.
    inputField?.request({ when, cadence: $state.snapshot(cadence) });
  }

  function openCheck(event: MouseEvent, path: string): void {
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
  {#if failure !== null}
    <Alert variant="danger" dismissible onDismiss={() => (failure = null)}>
      <p class="ib-run-setup__alert-title">{failure.title}</p>
      {#if failure.message !== failure.title}
        <p class="ib-run-setup__alert-message">{failure.message}</p>
      {/if}
      {#if failure.check !== undefined}
        {@const check = failure.check}
        <p class="ib-run-setup__alert-message">
          <a href={router.href(check.path)} onclick={(event) => openCheck(event, check.path)}
            >{check.label}</a
          >
        </p>
      {/if}
    </Alert>
  {/if}

  <section class="ib-run-setup__section">
    <h2 class="ib-run-setup__heading">{copy.inputHeading}</h2>
    <p class="ib-run-setup__lead">{copy.inputDescription}</p>
    <WorkflowInput bind:this={inputField} {schema} onInput={begin} />
  </section>

  <section class="ib-run-setup__section">
    <h2 class="ib-run-setup__heading">{copy.whenHeading}</h2>
    <RadioGroup
      name="run-setup-when"
      label={copy.whenLabel}
      {...kind === 'file' ? { description: copy.scheduleInFile } : {}}
      variant="card"
      bind:value={whenChoice}
    >
      <RadioGroup.Option
        id="run-setup-when-now"
        value="now"
        label={copy.now}
        description={copy.nowDescription}
      />
      {#if kind === 'code'}
        <RadioGroup.Option
          id="run-setup-when-schedule"
          value="schedule"
          label={copy.schedule}
          description={copy.scheduleDescription}
        />
      {/if}
    </RadioGroup>
    {#if when === 'schedule'}
      <ScheduleWhen
        bind:this={whenBlock}
        value={cadence}
        onValueChange={(next) => (cadence = next)}
        label={copy.scheduleLabel}
      />
    {/if}
  </section>

  <div class="ib-run-setup__footer" data-testid="run-setup-footer">
    <p class="ib-run-setup__summary" data-testid="run-setup-summary">{summary}</p>
    <div class="ib-run-setup__actions">
      <Button variant="ghost" onclick={cancel}>{copy.cancel}</Button>
      <Button
        data-changes
        variant="primary"
        disabled={gate.disabled}
        title={gate.title}
        loading={run.isPending}
        onclick={request}>{action}</Button
      >
    </div>
  </div>
</div>

<style>
  .ib-run-setup__body {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-6);
    min-width: 0;
  }

  .ib-run-setup__section {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-run-setup__heading {
    margin: 0;
    font-size: var(--cinder-text-lg);
    font-weight: 600;
  }

  .ib-run-setup__lead {
    margin: 0;
    color: var(--cinder-text-muted);
  }

  .ib-run-setup__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-run-setup__alert-message {
    margin: var(--cinder-space-1) 0 0;
    overflow-wrap: anywhere;
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
</style>
