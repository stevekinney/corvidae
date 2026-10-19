<script lang="ts">
  /**
   * The drawer that creates a goal. A goal runs an agent on a prompt until a validator passes, so it
   * takes an agent, the prompt, an identity, the validator's name and version as free text, and the
   * most attempts it may make. The Bureau decides whether the validator exists: one it lacks is
   * `Unprocessable`, which the drawer says inline, keeping what was typed so the name can be fixed.
   */
  import { Alert, Button, Drawer, Input, Select, Textarea } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { GOALS_COPY } from '../../app/copy.ts';
  import { createGoal } from '../../lib/bureau-goals.ts';
  import { listAgents, wireCodeOf } from '../../lib/bureau-client.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { GoalFormState } from './goal-form-state.svelte.ts';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  const copy = GOALS_COPY.form;
  const queryClient = useQueryClient();
  const form = new GoalFormState();

  /** The agents a goal may run. Degrades to a typed name when the Bureau cannot list them. */
  const agentsQuery = createQuery(
    () => ({
      queryKey: queryKeys.agents.list(),
      queryFn: ({ signal }) => listAgents({ signal }),
      retry: false,
    }),
    undefined,
  );
  const agentNames = $derived(
    agentsQuery.isSuccess ? agentsQuery.data.map((agent) => agent.name) : undefined,
  );

  const creation = createMutation(() => ({
    mutationFn: () => createGoal(form.toInput()),
    // The fault is said in the drawer, beside what was typed, so it is not also a toast.
    onError: () => undefined,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.goals.list() });
      onClose();
    },
  }));

  const fault = $derived(creation.error);
  const submitting = $derived(creation.isPending);

  function submit(): void {
    if (!form.isValid || submitting) return;
    creation.mutate();
  }

  let open = $state(true);
  $effect(() => {
    if (!open) onClose();
  });
</script>

<Drawer bind:open title={copy.title} size="md">
  <div class="weft-goal-form">
    {#if agentNames !== undefined && agentNames.length > 0}
      <Select
        id="weft-goal-agent"
        label={copy.agentLabel}
        description={copy.agentDescription}
        bind:value={form.agentName}
        options={[
          { value: '', label: copy.agentPlaceholder, disabled: true },
          ...agentNames.map((name) => ({ value: name, label: name })),
        ]}
      />
    {:else}
      <Input
        id="weft-goal-agent"
        label={copy.agentLabel}
        description={agentNames === undefined
          ? copy.agentFreeTextDescription
          : copy.agentDescription}
        bind:value={form.agentName}
      />
    {/if}
    <Textarea
      id="weft-goal-prompt"
      label={copy.promptLabel}
      description={copy.promptDescription}
      rows={4}
      bind:value={form.prompt}
    />
    <fieldset class="weft-goal-form__group">
      <legend class="weft-goal-form__legend">{copy.identityDescription}</legend>
      <Input
        id="weft-goal-identity-name"
        label={copy.identityNameLabel}
        bind:value={form.identityName}
      />
      <Input
        id="weft-goal-identity-version"
        label={copy.identityVersionLabel}
        bind:value={form.identityVersion}
      />
    </fieldset>
    <fieldset class="weft-goal-form__group">
      <legend class="weft-goal-form__legend">{copy.validatorDescription}</legend>
      <Input
        id="weft-goal-validator-name"
        label={copy.validatorNameLabel}
        bind:value={form.validatorName}
      />
      <Input
        id="weft-goal-validator-version"
        label={copy.validatorVersionLabel}
        bind:value={form.validatorVersion}
      />
    </fieldset>
    <Input
      id="weft-goal-maximum-attempts"
      label={copy.maximumAttemptsLabel}
      description={copy.maximumAttemptsDescription}
      inputmode="numeric"
      bind:value={form.maximumAttempts}
      error={form.attemptsValid ? '' : copy.maximumAttemptsInvalid}
    />
    <Input
      id="weft-goal-maximum-total-steps"
      label={copy.maximumTotalStepsLabel}
      description={copy.maximumTotalStepsDescription}
      inputmode="numeric"
      bind:value={form.maximumTotalSteps}
      error={form.stepsValid ? '' : copy.maximumTotalStepsInvalid}
    />
    {#if fault}
      <Alert variant="danger" data-testid="goal-fault" data-fault-code={wireCodeOf(fault) ?? ''}>
        <p class="weft-goal-form__alert-title">{copy.failed}</p>
        <p class="weft-goal-form__alert-body">{faultTreatment(fault).message}</p>
      </Alert>
    {/if}
  </div>

  {#snippet footer()}
    <div class="weft-goal-form__footer">
      <Button variant="ghost" size="sm" onclick={() => (open = false)}>{copy.cancelAction}</Button>
      <Button variant="primary" size="sm" disabled={!form.isValid || submitting} onclick={submit}
        >{copy.createAction}</Button
      >
    </div>
  {/snippet}
</Drawer>

<style>
  .weft-goal-form {
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
