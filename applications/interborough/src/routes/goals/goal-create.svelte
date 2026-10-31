<script lang="ts">
  /**
   * `/goals/new`: the page that creates a goal. A goal runs an agent on a prompt until a validator
   * passes, so it takes an agent (chosen from the agents the Bureau lists), the prompt, an identity,
   * the validator's name and version as free text, and the most attempts it may make. The Bureau
   * decides whether the validator exists: one it lacks is `Unprocessable`, which the page says
   * inline, keeping what was typed so the name can be fixed. A goal that is made takes the person to
   * the list of goals.
   */
  import {
    Alert,
    Button,
    EmptyState,
    Input,
    PageHeader,
    Select,
    Textarea,
  } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { AGENT_EDITOR_COPY, GOALS_COPY } from '../../app/copy.ts';
  import { listAgents, wireCodeOf } from '../../lib/bureau-client.ts';
  import { createGoal, type GoalCreated } from '../../lib/bureau-goals.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { goalPath } from '../../lib/identifier-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { GoalFormState } from './goal-form-state.svelte.ts';

  const copy = GOALS_COPY.form;
  const LIST_PATH = '/goals';
  const queryClient = useQueryClient();
  const form = new GoalFormState();

  /** The agents a goal may run. A goal can only run one the Bureau lists, so the field is a picker. */
  const agentsQuery = createQuery(
    () => ({
      queryKey: queryKeys.agents.list(),
      queryFn: ({ signal }) => listAgents({ signal }),
      retry: false,
    }),
    undefined,
  );
  const agentOptions = $derived([
    { value: '', label: copy.agentPlaceholder, disabled: true },
    ...(agentsQuery.data ?? []).map((agent) => ({ value: agent.name, label: agent.displayName })),
  ]);

  /**
   * The goal the Bureau committed but could not start a controller for. Such a goal has no
   * controller and stays pending until recovery, so the page stays to say so. It is read-only from
   * then on, because a second submit repeats the idempotency key, comes back `existing`, and would
   * leave as if the goal had started.
   */
  let notStarted = $state<GoalCreated>();

  const creation = createMutation(() => ({
    mutationFn: () => createGoal(form.toInput()),
    // The fault is said on the page, beside what was typed, so it is not also a toast.
    onError: () => undefined,
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.goals.list() });
      if (created.controller?.status === 'start-failed') {
        notStarted = created;
        return;
      }
      router.navigate(LIST_PATH);
    },
  }));

  const fault = $derived(creation.error);
  const submitting = $derived(creation.isPending);
  /** Whether the goal is made, so the fields and Create are done with. */
  const created = $derived(notStarted !== undefined);

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (!form.isValid || submitting || created) return;
    creation.mutate();
  }

  function leave(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<section class="weft-goal-form" aria-label={copy.title} data-page="goal-new">
  <PageHeader title={copy.title} headingLevel={1} description={copy.description} />
  {#if agentsQuery.isSuccess && agentsQuery.data.length === 0}
    <EmptyState
      kind="first-use"
      title={copy.noAgents.title}
      description={copy.noAgents.description}
      headingLevel={2}
    >
      {#snippet action()}
        <Button
          href={router.href('/agents/new')}
          variant="primary"
          size="sm"
          onclick={(event) => leave(event, '/agents/new')}>{AGENT_EDITOR_COPY.newAction}</Button
        >
      {/snippet}
    </EmptyState>
  {:else}
    <form class="weft-goal-form__fields" onsubmit={submit}>
      <Select
        id="weft-goal-agent"
        label={copy.agentLabel}
        description={agentsQuery.isError ? copy.agentUnavailableDescription : copy.agentDescription}
        bind:value={form.agentName}
        disabled={created || agentsQuery.isPending}
        options={agentOptions}
      />
      <Textarea
        id="weft-goal-prompt"
        label={copy.promptLabel}
        description={copy.promptDescription}
        rows={4}
        disabled={created}
        bind:value={form.prompt}
      />
      <fieldset class="weft-goal-form__group">
        <legend class="weft-goal-form__legend">{copy.identityDescription}</legend>
        <Input
          id="weft-goal-identity-name"
          label={copy.identityNameLabel}
          disabled={created}
          bind:value={form.identityName}
        />
        <Input
          id="weft-goal-identity-version"
          label={copy.identityVersionLabel}
          disabled={created}
          bind:value={form.identityVersion}
        />
      </fieldset>
      <fieldset class="weft-goal-form__group">
        <legend class="weft-goal-form__legend">{copy.validatorDescription}</legend>
        <Input
          id="weft-goal-validator-name"
          label={copy.validatorNameLabel}
          disabled={created}
          bind:value={form.validatorName}
        />
        <Input
          id="weft-goal-validator-version"
          label={copy.validatorVersionLabel}
          disabled={created}
          bind:value={form.validatorVersion}
        />
      </fieldset>
      <Input
        id="weft-goal-maximum-attempts"
        label={copy.maximumAttemptsLabel}
        description={copy.maximumAttemptsDescription}
        inputmode="numeric"
        disabled={created}
        bind:value={form.maximumAttempts}
        error={form.attemptsValid ? '' : copy.maximumAttemptsInvalid}
      />
      <Input
        id="weft-goal-maximum-total-steps"
        label={copy.maximumTotalStepsLabel}
        description={copy.maximumTotalStepsDescription}
        inputmode="numeric"
        disabled={created}
        bind:value={form.maximumTotalSteps}
        error={form.stepsValid ? '' : copy.maximumTotalStepsInvalid}
      />
      {#if notStarted !== undefined}
        <Alert variant="warning" data-testid="goal-not-started">
          <p class="weft-goal-form__alert-title">{copy.startFailedTitle}</p>
          {#if notStarted.controller?.reason}
            <p class="weft-goal-form__alert-body">{notStarted.controller.reason}</p>
          {/if}
          <p class="weft-goal-form__alert-body">
            {copy.startFailedGoal(notStarted.goal.goalRunId)}
          </p>
        </Alert>
      {:else if fault}
        <Alert variant="danger" data-testid="goal-fault" data-fault-code={wireCodeOf(fault) ?? ''}>
          <p class="weft-goal-form__alert-title">{copy.failed}</p>
          <p class="weft-goal-form__alert-body">{faultTreatment(fault).message}</p>
        </Alert>
      {/if}
      <div class="weft-goal-form__footer">
        <Button
          href={router.href(
            notStarted === undefined ? LIST_PATH : goalPath(notStarted.goal.goalRunId),
          )}
          variant="ghost"
          size="sm"
          onclick={(event) =>
            leave(
              event,
              notStarted === undefined ? LIST_PATH : goalPath(notStarted.goal.goalRunId),
            )}>{created ? copy.closeAction : copy.cancelAction}</Button
        >
        <Button
          data-changes
          type="submit"
          variant="primary"
          size="sm"
          disabled={!form.isValid || submitting || created}>{copy.createAction}</Button
        >
      </div>
    </form>
  {/if}
</section>

<style>
  .weft-goal-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .weft-goal-form__fields {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .weft-goal-form__group {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin: 0;
    padding: 0;
    border: 0;
  }

  .weft-goal-form__legend {
    padding: 0;
    margin-bottom: 4px;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-muted);
  }

  .weft-goal-form__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-goal-form__alert-body {
    margin: 4px 0 0;
    overflow-wrap: anywhere;
  }

  .weft-goal-form__footer {
    display: flex;
    gap: 8px;
    align-items: center;
  }
</style>
