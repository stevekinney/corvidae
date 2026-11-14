<script lang="ts">
  /**
   * The fields of one step that holds no steps of its own: an agent, a wait for a person or a
   * signal (each with its limit), a wait, an activity a plugin provides, a code workflow a plugin
   * contributed, and a step the builder can only move and remove. The step's name, its fields and
   * their problems, drawn inside the card or the row the list gave it. An activity's or a workflow's
   * input is drawn from the JSON Schema the Bureau's catalog gives it: while the catalog loads, after
   * a failed read, when no running plugin provides it, and when its registration declares no schema,
   * the step's `input` is kept exactly as the file writes it and a note says why it is not drawn.
   */
  import { Button, Input, Select, Textarea } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

  import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
  import ContributedConfigurationForm from '../../lib/contributed-configuration-form.svelte';
  import { stepFieldId } from './workflow-builder-addresses.ts';
  import { useBuilderHost } from './workflow-builder-host.ts';
  import {
    setStepField,
    setStepInput,
    setStepTimeout,
    setStepTitle,
    setTimeoutDuration,
    setWaitDuration,
    type BuilderStep,
    type StepPath,
    type WaitUnit,
  } from './workflow-builder-model.ts';
  import WorkflowDurationPair from './workflow-duration-pair.svelte';

  interface Props {
    step: Exclude<BuilderStep, { kind: 'branch' | 'parallel' | 'map' }>;
    path: StepPath;
    /** The step's address, which makes its ids. */
    address: string;
    /** What the step is called in a label: "step 3", or "step 1 of the approved case of step 2". */
    where: string;
    /** The step's key, which makes its input form start over when the step is another. */
    stepKey: string;
  }

  let { step, path, address, where, stepKey }: Props = $props();

  const host = useBuilderHost();
  const copy = WORKFLOW_COPY.builder;
  const id = $derived(`workflow-builder-step-${address}`);

  /** The kind label a field's placeholder names. */
  const kindLabel = $derived(
    step.kind === 'activity' ? host.activityTitle(step.handler) : copy.stepKinds[step.kind],
  );

  /** The unit a limit that is still empty is counted in, so choosing a unit first keeps it. */
  // svelte-ignore state_referenced_locally
  let limitUnit = $state<WaitUnit>(
    step.kind === 'person' || step.kind === 'signal'
      ? (step.timeout?.parts?.unit ?? 'minutes')
      : 'minutes',
  );

  // A limit the file holds sets the unit; an empty one keeps the unit the person chose.
  $effect.pre(() => {
    if (step.kind !== 'person' && step.kind !== 'signal') return;
    const parts = step.timeout?.parts;
    if (parts !== undefined && parts !== null && parts.amount !== '') {
      untrack(() => (limitUnit = parts.unit));
    }
  });

  /** The workflows a `workflow` step's select offers: the one the file names stays even when no plugin lists it. */
  function workflowOptions(
    current: string,
  ): { value: string; label: string; disabled?: boolean }[] {
    const entries = host.workflows.status === 'ready' ? host.workflows.entries : [];
    const listed = entries.some((entry) => entry.id === current);
    return [
      { value: '', label: copy.workflowCard.placeholder, disabled: true },
      ...(current !== '' && !listed
        ? [
            {
              value: current,
              label:
                host.workflows.status === 'ready' ? copy.workflowCard.missing(current) : current,
            },
          ]
        : []),
      ...entries.map((entry) => ({ value: entry.id, label: entry.title })),
    ];
  }
</script>

{#snippet limit(timeout: Extract<BuilderStep, { kind: 'person' | 'signal' }>['timeout'])}
  {#if timeout !== null && timeout.parts === null}
    <Input
      id={`${id}-timeout`}
      label={copy.timeoutLabel}
      aria-label={copy.timeoutText(where)}
      description={copy.timeoutTextDescription}
      size="sm"
      variant="code"
      value={timeout.duration}
      onValueChange={(next) => host.commit(setStepTimeout(host.text, path, next))}
    />
  {:else}
    <WorkflowDurationPair
      amountId={`${id}-timeout`}
      unitId={`${id}-timeout-unit`}
      amount={timeout?.parts?.amount ?? ''}
      unit={limitUnit}
      amountLabel={copy.timeoutLabel}
      amountName={copy.timeoutAmountLabel(where)}
      unitLabel={copy.unitFieldLabel}
      unitName={copy.timeoutUnitLabel(where)}
      onChange={(amount: string, unit: WaitUnit) => {
        limitUnit = unit;
        host.commit(setTimeoutDuration(host.text, path, amount, unit));
      }}
    />
    <p class="weft-step-fields__note">{copy.timeoutDescription}</p>
  {/if}
{/snippet}

{#if step.kind === 'other'}
  <p class="weft-step-fields__other">{step.label}</p>
  <p class="weft-step-fields__note">{copy.otherStepNote}</p>
{:else}
  <Input
    id={`${id}-title`}
    label={copy.stepNameLabel}
    aria-label={copy.stepName(where)}
    placeholder={kindLabel}
    size="sm"
    value={step.title}
    onValueChange={(next) => host.commit(setStepTitle(host.text, path, next))}
  />
{/if}

{#if step.kind === 'agent'}
  {#if host.agentsFailed}
    <Input
      id={`${id}-agent`}
      label={copy.agentFieldLabel}
      aria-label={copy.agentLabel(where)}
      placeholder={copy.agentPlaceholder}
      size="sm"
      variant="code"
      required
      {...host.errorOf(stepFieldId(address, 'agent'))}
      value={step.agent}
      onValueChange={(next) => host.commit(setStepField(host.text, path, 'agent', next))}
    />
  {:else}
    <Select
      id={`${id}-agent`}
      label={copy.agentFieldLabel}
      aria-label={copy.agentLabel(where)}
      size="sm"
      required
      {...host.errorOf(stepFieldId(address, 'agent'))}
      value={step.agent}
      options={host.agentOptions(step.agent)}
      {...host.agentNeedsProvider(step.agent) ? { description: copy.needsProvider } : {}}
      onValueChange={(next: string) => host.commit(setStepField(host.text, path, 'agent', next))}
    />
  {/if}
  <Textarea
    id={`${id}-message`}
    label={copy.messageFieldLabel}
    aria-label={copy.messageLabel(where)}
    placeholder={copy.messagePlaceholder}
    size="sm"
    rows={3}
    required
    {...host.errorOf(stepFieldId(address, 'message'))}
    value={step.message}
    oninput={(event) =>
      host.commit(setStepField(host.text, path, 'message', event.currentTarget.value))}
  />
{:else if step.kind === 'person'}
  <p class="weft-step-fields__note">{copy.personDescription}</p>
  {@render limit(step.timeout)}
{:else if step.kind === 'signal'}
  <Input
    id={`${id}-signal`}
    label={copy.signalFieldLabel}
    aria-label={copy.signalLabel(where)}
    placeholder={copy.signalPlaceholder}
    description={copy.signalDescription}
    size="sm"
    variant="code"
    required
    {...host.errorOf(stepFieldId(address, 'signal'))}
    value={step.signal}
    onValueChange={(next) => host.commit(setStepField(host.text, path, 'signal', next))}
  />
  {@render limit(step.timeout)}
{:else if step.kind === 'wait' && step.parts !== null}
  {@const parts = step.parts}
  <WorkflowDurationPair
    amountId={`${id}-duration`}
    unitId={`${id}-unit`}
    amount={parts.amount}
    unit={parts.unit}
    amountLabel={copy.amountFieldLabel}
    amountName={copy.durationLabel(where)}
    unitLabel={copy.unitFieldLabel}
    unitName={copy.unitLabel(where)}
    required
    error={host.errorOf(stepFieldId(address, 'duration'))}
    onChange={(amount: string, unit: WaitUnit) =>
      host.commit(setWaitDuration(host.text, path, amount, unit))}
  />
{:else if step.kind === 'wait'}
  <Input
    id={`${id}-duration`}
    label={copy.durationFieldLabel}
    aria-label={copy.durationLabel(where)}
    description={copy.durationDescription}
    size="sm"
    variant="code"
    required
    value={step.duration}
    onValueChange={(next) => host.commit(setStepField(host.text, path, 'duration', next))}
  />
{:else if step.kind === 'activity'}
  {@const activities = host.activities}
  {#if activities.status === 'loading'}
    <p class="weft-step-fields__note" data-testid="step-activity-loading">
      {copy.activity.checking(step.handler)}
    </p>
  {:else if activities.status === 'failed'}
    <div class="weft-step-fields__group" data-testid="step-activity-error">
      <p class="weft-step-fields__note" role="alert">{copy.activity.failed(step.handler)}</p>
      <Button variant="secondary" onclick={activities.retry}>{copy.activity.retry}</Button>
    </div>
  {:else}
    {@const entry = activities.entries.find((candidate) => candidate.id === step.handler)}
    {#if entry === undefined}
      <p class="weft-step-fields__note" data-testid="step-activity-unavailable">
        {copy.activity.unavailable(step.handler)}
      </p>
    {:else}
      {#if entry.description !== null}
        <p class="weft-step-fields__note">{entry.description}</p>
      {/if}
      {#if step.input === null}
        <p class="weft-step-fields__note" data-testid="step-input-note">
          {copy.activity.inputNotObject}
        </p>
      {:else if entry.inputSchema === null}
        <p class="weft-step-fields__note" data-testid="step-input-note">
          {copy.activity.noSchema}
        </p>
      {:else}
        {@const schema = entry.inputSchema}
        {#key stepKey}
          <ContributedConfigurationForm
            kindId={step.handler}
            {schema}
            value={step.input}
            hosted
            reportInitialDraft={false}
            noFieldsText={copy.activity.noInput}
            unavailableText={copy.activity.noSchema}
            onChange={(next) => host.commit(setStepInput(host.text, path, next, schema))}
          />
        {/key}
      {/if}
    {/if}
  {/if}
{:else if step.kind === 'workflow'}
  {#if host.workflows.status === 'failed'}
    <div class="weft-step-fields__group" data-testid="step-workflow-error">
      <p class="weft-step-fields__note" role="alert">{copy.workflowCard.failed}</p>
      <Button variant="secondary" onclick={host.workflows.retry}>
        {copy.workflowCard.retry}
      </Button>
    </div>
  {/if}
  <Select
    id={`${id}-workflow`}
    label={copy.workflowCard.field}
    aria-label={copy.workflowCard.label(where)}
    size="sm"
    required
    {...host.errorOf(stepFieldId(address, 'workflow'))}
    value={step.workflow}
    options={workflowOptions(step.workflow)}
    onValueChange={(next: string) => host.commit(setStepField(host.text, path, 'workflow', next))}
  />
  {@const workflows = host.workflows}
  {@const entry =
    workflows.status === 'ready'
      ? workflows.entries.find((candidate) => candidate.id === step.workflow)
      : undefined}
  {#if step.input === null}
    <p class="weft-step-fields__note" data-testid="step-input-note">
      {copy.workflowCard.inputNotObject}
    </p>
  {:else if entry === undefined || entry.inputSchema === null}
    <p class="weft-step-fields__note" data-testid="step-input-note">
      {copy.workflowCard.noSchema}
    </p>
  {:else}
    {@const schema = entry.inputSchema}
    {#key `${stepKey}:${step.workflow}`}
      <ContributedConfigurationForm
        kindId={step.workflow}
        {schema}
        value={step.input}
        hosted
        reportInitialDraft={false}
        noFieldsText={copy.workflowCard.noInput}
        unavailableText={copy.workflowCard.noSchema}
        onChange={(next) => host.commit(setStepInput(host.text, path, next, schema))}
      />
    {/key}
  {/if}
{/if}

<style>
  .weft-step-fields__group {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .weft-step-fields__other {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .weft-step-fields__note {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
  }
</style>
