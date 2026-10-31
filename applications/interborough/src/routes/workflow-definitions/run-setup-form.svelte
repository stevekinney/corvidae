<script lang="ts">
  /**
   * The body of the run setup page: the input, when the run happens, and the pinned footer that
   * holds the one-line summary, Cancel, and the primary action.
   *
   * The input is a Cinder `SchemaForm` when the workflow declares an object schema with fields, and
   * a JSON editor otherwise. The primary action is in the footer, outside the form, so the form's
   * own submit button is not drawn, and a submit counts only when the footer asked for it: Enter in
   * a field validates the input and shows its errors but never starts anything. The schema is read
   * once when the form mounts, because the form starts over when its schema changes, and a
   * background reload must not discard what was typed.
   *
   * A start and a schedule create real work, so a second ask while one is in flight is dropped
   * before the first `await`. A refusal keeps the input where it was: the Bureau's or the engine's
   * field problems go on the fields they name, and any other failure is a banner.
   */
  import {
    Alert,
    Button,
    RadioGroup,
    ScheduleBuilder,
    SchemaForm,
    Textarea,
    type ScheduleValue,
  } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { WORKFLOW_COPY } from '../../app/copy.ts';
  import { agentFaultOf } from '../../lib/agent-definitions.ts';
  import { getClient } from '../../lib/client.ts';
  import { computeNextFires } from '../../lib/format/cron-preview.ts';
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
  import { formSchemaOf, inputIssuesOf, summaryOf, type InputIssue } from './run-setup-model.ts';

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

  /** The schema as the form mounted with it. */
  const formSchema = untrack(() => formSchemaOf(schema));
  const FORM_ID = 'run-setup-input';

  /** `RadioGroup` holds its choice as a plain string. */
  let whenChoice = $state('now');
  const when = $derived<'now' | 'schedule'>(whenChoice === 'schedule' ? 'schedule' : 'now');
  let cadence = $state<ScheduleValue>({ cron: '0 9 * * *', timeZone: browserTimeZone() });
  let jsonText = $state('');
  let jsonError = $state('');
  let issues = $state<readonly InputIssue[]>([]);
  let failure = $state<{ readonly title: string; readonly message: string } | null>(null);

  let inputRegion: HTMLElement | undefined;
  /** The footer asked for a submit and its event has not been seen yet. */
  let asked = false;
  /** The submit event the footer asked for, which is the only one that may start anything. */
  let requested: Event | null = null;
  /**
   * Whether a start is in flight. It is set before the first `await`, because the mutation's own
   * `isPending` turns true a tick after `mutate`, and two asks can arrive in that tick.
   */
  let sending = false;

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
      issues = [];
      jsonError = '';
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
        if (formSchema !== undefined) issues = refused;
        else jsonError = refused.map((issue) => issue.message).join(' ');
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

  function begin(input: unknown): void {
    if (sending) return;
    sending = true;
    // The mutation reads the schedule after its first `await`, so it gets a copy the builder cannot change.
    run.mutate({ input, when, cadence: $state.snapshot(cadence) });
  }

  /** Reads the JSON the editor holds: empty is no input, and anything else must parse. */
  function beginFromJson(): void {
    if (sending) return;
    const text = jsonText.trim();
    if (text === '') {
      begin(undefined);
      return;
    }
    try {
      begin(JSON.parse(text));
    } catch {
      jsonError = copy.invalidJson;
    }
  }

  /** The footer's ask. The form validates, and starts only what this ask submitted. */
  function request(): void {
    if (sending || gate.disabled) return;
    if (formSchema === undefined) {
      beginFromJson();
      return;
    }
    const form = inputRegion?.querySelector('form');
    if (form === null || form === undefined) return;
    asked = true;
    form.requestSubmit();
  }

  /** Marks the submit the footer asked for, before the form handles it. */
  function noteSubmit(event: Event): void {
    // A submit that was not asked for leaves a pending ask alone: it only ever fails to match.
    if (asked) requested = event;
    asked = false;
  }

  function onSubmit(value: unknown, event: Event): void {
    if (event !== requested) return;
    requested = null;
    begin(value);
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
    </Alert>
  {/if}

  <section class="ib-run-setup__section">
    <h2 class="ib-run-setup__heading">{copy.inputHeading}</h2>
    <p class="ib-run-setup__lead">{copy.inputDescription}</p>
    <div
      class="ib-run-setup__input"
      bind:this={inputRegion}
      onsubmitcapture={noteSubmit}
      data-testid="run-setup-input"
    >
      {#if formSchema !== undefined}
        <SchemaForm
          data-changes
          id={FORM_ID}
          schema={formSchema}
          name="run-setup-input"
          {issues}
          {onSubmit}
        />
      {:else}
        <Textarea
          id="run-setup-json"
          label={copy.jsonLabel}
          description={copy.jsonDescription}
          variant="code"
          rows={8}
          bind:value={jsonText}
          error={jsonError}
          oninput={() => (jsonError = '')}
        />
      {/if}
    </div>
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
      <ScheduleBuilder
        value={cadence}
        onValueChange={(next) => (cadence = next)}
        {computeNextFires}
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

  .ib-run-setup__input {
    min-width: 0;
  }

  /*
   * A field name or description with a word no line can break at wraps instead of widening the
   * page. Cinder gives a field's description break-word, which unlike anywhere does not shrink the
   * field's minimum width, so every element under the form is given anywhere.
   */
  .ib-run-setup__input,
  .ib-run-setup__input :global(*) {
    overflow-wrap: anywhere;
  }

  /* The footer holds the primary action, so the form's own submit button is not drawn. */
  .ib-run-setup__input :global(button[type='submit']) {
    display: none;
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
