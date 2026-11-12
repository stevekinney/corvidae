<script lang="ts">
  /**
   * The form New goal and Edit goal share (COR-2017, rows 68b to 68s): the heading, four fields in
   * the order the design draws them, and the footer's note and buttons. The pages around it
   * (`goal-create.svelte`, `goal-edit.svelte`) own the requests and say what is in flight.
   *
   * The fields are "What should the agent do?" (a prompt), "Check" (a statement that is true or
   * false of the result), "Agent", and "Attempt limit", with Agent and Attempt limit side by side.
   * The first three carry Cinder's red required dot; the limit does not. Create goal and Save stay
   * live whatever the form holds, apart from one case: a model agent while no provider holds a key,
   * which says so in an alert above the first field and in the footer. A submit that finds a
   * problem says it at the field and in the footer, and the page focuses the field.
   *
   * While a create is in flight the fields are read-only and Cancel is off. A goal the Bureau made
   * but could not start a controller for locks the fields (a second submit would repeat the key) and
   * says so in an alert, with Close in place of Cancel.
   */
  import {
    Alert,
    Button,
    FormActions,
    Input,
    NumberInput,
    PageHeader,
    Select,
    Textarea,
  } from '@lostgradient/cinder';

  import { GOALS_COPY } from '../../app/copy/goals.ts';
  import type { AgentSummary } from '../../lib/bureau-client.ts';
  import { agentLabel as agentName } from '../../lib/agent-label.ts';
  import type { GoalCreated } from '../../lib/bureau-goals.ts';
  import { router } from '../../lib/router.svelte.ts';
  import type { GoalFormFailure } from './goal-form-failure.ts';
  import {
    GOAL_FIELD_IDS,
    MINIMUM_ATTEMPTS,
    needsProvider,
    type GoalFormState,
  } from './goal-form-state.svelte.ts';

  interface Props {
    form: GoalFormState;
    mode: 'create' | 'edit';
    /** The agents the Bureau lists, or `undefined` while they are read or when they could not be. */
    agents: readonly AgentSummary[] | undefined;
    /** The agent list could not be read. */
    agentsFailed: boolean;
    /** Whether a provider holds a key, or `undefined` while that is not known. */
    providerConnected: boolean | undefined;
    /** The scripted agent the alert offers instead, when the catalog has one. */
    scripted: { readonly name: string; readonly label: string } | undefined;
    /** A request is in flight: the fields are read-only and Cancel is off. */
    busy: boolean;
    /** The goal is made and could not be started, so the fields and Create are done with. */
    notStarted?: GoalCreated | undefined;
    /** The last request failed, and what it says. */
    failure: GoalFormFailure | undefined;
    /** Where Cancel goes: the list for a new goal, the goal's page for an edit. */
    cancelPath: string;
    /** Submits the form. The page decides whether anything is sent. */
    onSubmit: () => void;
    /** Chooses an agent from the alert's "Use Assistant". */
    onUseAgent: (agentName: string) => void;
  }

  let {
    form,
    mode,
    agents,
    agentsFailed,
    providerConnected,
    scripted,
    busy,
    notStarted,
    failure,
    cancelPath,
    onSubmit,
    onUseAgent,
  }: Props = $props();

  const copy = GOALS_COPY.form;
  /** An agent's name as a person says it, from the catalog's display name or its identifier. */
  const agentNameOf = (identifier: string): string => agentName(identifier, agents);
  const editing = $derived(mode === 'edit');
  const locked = $derived(notStarted !== undefined);
  const problems = $derived(form.shownProblems);
  /** The agent chosen, as the catalog lists it. */
  const chosen = $derived(agents?.find((agent) => agent.name === form.agentName));
  const agentLabel = $derived(agentNameOf(form.agentName));
  /** A model agent is chosen and no provider holds a key, so a goal cannot make attempts yet. Edit gates nothing: saving starts no attempt. */
  const gated = $derived(!editing && needsProvider(agents, form.agentName, providerConnected));

  const agentOptions = $derived([
    { value: '', label: copy.agentPlaceholder, disabled: true },
    ...(agents ?? []).map((agent) => ({ value: agent.name, label: agentNameOf(agent.name) })),
  ]);

  /** The note beside the buttons, in the order of what matters most. */
  const note = $derived.by(() => {
    if (busy) return editing ? copy.edit.saving : copy.footer.creating;
    const first = form.firstProblem;
    if (form.attempted && first !== undefined) {
      return first === 'attempts'
        ? copy.footer.attempts
        : first === 'check'
          ? copy.footer.check
          : first === 'prompt'
            ? copy.footer.prompt
            : copy.agentPlaceholder;
    }
    if (editing) return copy.edit.footer;
    if (gated) return copy.footer.gated(scripted?.label ?? copy.agentPlaceholder);
    return chosen !== undefined && chosen.media === null
      ? copy.footer.scripted(agentLabel)
      : copy.footer.starts;
  });

  const cancelLabel = $derived(locked ? copy.closeAction : copy.cancelAction);

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    onSubmit();
  }

  function leave(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    if (busy) return;
    router.navigate(path);
  }
</script>

<section
  class="ib-goal-form"
  aria-label={editing ? copy.edit.title : copy.title}
  data-page={editing ? 'goal-edit' : 'goal-new'}
>
  <PageHeader
    title={editing ? copy.edit.title : copy.title}
    headingLevel={1}
    description={editing ? copy.edit.description : copy.description}
  />
  <!-- `novalidate`: the form says what is missing at each field itself, so the browser's own bubble never stops a submit. -->
  <form class="ib-goal-form__fields" aria-label={copy.fieldsLabel} novalidate onsubmit={submit}>
    {#if gated}
      <Alert variant="warning" data-testid="goal-needs-provider">
        {copy.needsProvider(agentLabel)}
        {#snippet actions()}
          <Button
            variant="ghost"
            size="sm"
            href={router.href(copy.connectProviderPath)}
            onclick={(event) => leave(event, copy.connectProviderPath)}
            >{copy.connectProvider}</Button
          >
          {#if scripted !== undefined}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onclick={() => onUseAgent(scripted.name)}>{copy.useAgent(scripted.label)}</Button
            >
          {/if}
        {/snippet}
      </Alert>
    {/if}

    <Textarea
      id={GOAL_FIELD_IDS.prompt}
      label={copy.promptLabel}
      description={copy.promptDescription}
      rows={4}
      required={!editing}
      placeholder={editing ? copy.edit.promptPlaceholder(form.currentName) : undefined}
      error={problems.prompt ?? ''}
      disabled={locked}
      readonly={busy}
      bind:value={form.prompt}
    />
    <Input
      id={GOAL_FIELD_IDS.check}
      label={copy.checkLabel}
      description={copy.checkDescription}
      placeholder={copy.checkPlaceholder}
      required
      error={problems.check ?? ''}
      disabled={locked}
      readonly={busy}
      bind:value={form.check}
    />
    <div class="ib-goal-form__pair">
      <div class="ib-goal-form__agent">
        <Select
          id={GOAL_FIELD_IDS.agent}
          label={copy.agentLabel}
          description={editing
            ? copy.edit.agentLocked
            : agentsFailed
              ? copy.agentUnavailableDescription
              : copy.agentDescription}
          required
          error={problems.agent ?? ''}
          bind:value={form.agentName}
          disabled={locked || agents === undefined}
          readonly={busy || editing}
          options={agentOptions}
        />
      </div>
      <NumberInput
        id={GOAL_FIELD_IDS.attempts}
        label={copy.maximumAttemptsLabel}
        description={copy.maximumAttemptsDescription}
        min={MINIMUM_ATTEMPTS}
        error={problems.attempts ?? ''}
        disabled={locked}
        readonly={busy}
        bind:value={form.maximumAttempts}
      />
    </div>

    {#if notStarted !== undefined}
      <Alert variant="warning" data-testid="goal-not-started">
        <p class="ib-goal-form__alert-title">{copy.startFailedTitle}</p>
        {#if notStarted.controller?.reason}
          <p class="ib-goal-form__alert-body">{notStarted.controller.reason}</p>
        {/if}
        <p class="ib-goal-form__alert-body">
          {copy.startFailedGoal(notStarted.goal.goalRunId)}
        </p>
      </Alert>
    {:else if failure !== undefined}
      <Alert variant="danger" data-testid="goal-fault" data-fault-code={failure.code}>
        <span class="ib-goal-form__alert-title">{failure.title}</span>
        {failure.message}
        {#snippet actions()}
          <Button type="submit" variant="secondary" size="sm" disabled={busy}
            >{copy.tryAgain}</Button
          >
        {/snippet}
      </Alert>
    {/if}

    <FormActions label={copy.fieldsLabel}>
      {#snippet summary()}<span data-testid="goal-form-note">{note}</span>{/snippet}
      {#snippet end()}
        <Button
          href={router.href(cancelPath)}
          variant="ghost"
          aria-disabled={busy ? 'true' : undefined}
          onclick={(event) => leave(event, cancelPath)}>{cancelLabel}</Button
        >
        <Button
          data-changes
          type="submit"
          variant="primary"
          loading={busy}
          disabled={locked || gated}
        >
          {#if editing}
            {busy ? copy.edit.savingAction : copy.edit.saveAction}
          {:else}
            {busy ? copy.creatingAction : copy.createAction}
          {/if}
        </Button>
      {/snippet}
    </FormActions>
  </form>
</section>

<style>
  .ib-goal-form {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
  }

  /* The fields keep to Cinder's reading width inside the full-width view. */
  .ib-goal-form__fields {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    max-inline-size: 48rem;
  }

  /* Agent takes the room; Attempt limit keeps the width of a number beside it, and drops under it on a phone. */
  .ib-goal-form__pair {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-4);
    align-items: flex-start;
  }

  .ib-goal-form__agent {
    flex: 1 1 14rem;
    min-inline-size: 0;
  }

  .ib-goal-form__alert-title {
    margin: 0;
    font-weight: var(--cinder-font-semibold);
  }

  .ib-goal-form__alert-body {
    margin: var(--cinder-space-1) 0 0;
    overflow-wrap: anywhere;
  }
</style>
