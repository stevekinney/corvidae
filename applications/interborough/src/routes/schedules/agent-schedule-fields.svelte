<script lang="ts">
  /**
   * The fields of the drawer that creates or edits a schedule that runs an agent. Creating asks for
   * the agent, the text each fire sends, and an optional session as well as the three fields an
   * edit changes, which are the cadence, the description, and the overlap policy: exactly what
   * `bureau.schedules.update` takes, with the overlap policy only `skip` or `allow`, the Bureau's.
   * Mutates the passed-in `form`, as the Weft schedule's fields do.
   */
  import {
    Input,
    RadioGroup,
    ScheduleBuilder,
    Select,
    Textarea,
    type ScheduleValue,
  } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

  import { SCHEDULE_COPY } from '../../app/copy.ts';
  import { computeNextFires } from '../../lib/format/cron-preview.ts';
  import type { AgentScheduleFormState, AgentOverlap } from './agent-schedule-form-state.svelte.ts';
  import { OVERLAP_POLICIES } from './overlap-policy.ts';

  interface Props {
    form: AgentScheduleFormState;
    /** The agents the Bureau lists, or `undefined` when it could not say: then the name is typed. */
    agents: readonly string[] | undefined;
  }

  let { form, agents }: Props = $props();

  const copy = SCHEDULE_COPY.form;
  const creating = $derived(form.mode === 'create');
  const overlaps = OVERLAP_POLICIES.filter((policy) => policy.value === 'skip' || policy.value === 'allow');

  function onCadenceChange(next: ScheduleValue): void {
    form.cadence = next;
  }

  function isOverlap(value: string): value is AgentOverlap {
    return value === 'skip' || value === 'allow';
  }

  // `RadioGroup.value` is a plain string, so a local draft is written back to the form, as the
  // Weft schedule's fields do.
  let overlapDraft = $state<string>(untrack(() => form.overlap));
  $effect(() => {
    if (isOverlap(overlapDraft)) form.overlap = overlapDraft;
  });
</script>

<div class="weft-schedule-form" data-form="agent-schedule">
  {#if creating}
    <section class="weft-schedule-form__section">
      <h3 class="weft-schedule-form__section-title">Basics</h3>
      {#if agents !== undefined && agents.length > 0}
        <Select
          id="weft-agent-schedule-agent"
          label={copy.agentLabel}
          description={copy.agentDescription}
          bind:value={form.agentName}
          options={[
            { value: '', label: copy.agentPlaceholder, disabled: true },
            ...agents.map((name) => ({ value: name, label: name })),
          ]}
          error={form.agentName.trim() === '' ? '' : (form.errors.agentName ?? '')}
        />
      {:else}
        <Input
          id="weft-agent-schedule-agent"
          label={copy.agentLabel}
          description={agents === undefined ? copy.agentFreeTextDescription : copy.noAgents}
          bind:value={form.agentName}
        />
      {/if}
      <Textarea
        id="weft-agent-schedule-input"
        label={copy.inputLabel}
        description={copy.inputDescription}
        rows={4}
        bind:value={form.input}
        error={form.input === '' ? '' : (form.errors.input ?? '')}
      />
      <Input
        id="weft-agent-schedule-session"
        label={copy.sessionLabel}
        description={copy.sessionDescription}
        bind:value={form.sessionId}
        error={form.errors.session ?? ''}
      />
    </section>
  {/if}

  <section class="weft-schedule-form__section">
    <h3 class="weft-schedule-form__section-title">{copy.cadenceLabel}</h3>
    <ScheduleBuilder
      value={form.cadence}
      onValueChange={onCadenceChange}
      {computeNextFires}
      timezoneLabel="UTC"
      label={copy.cadenceLabel}
    />
  </section>

  <section class="weft-schedule-form__section">
    <Input
      id="weft-agent-schedule-description"
      label={copy.descriptionLabel}
      description={copy.descriptionDescription}
      bind:value={form.description}
    />
    <RadioGroup
      name="weft-agent-schedule-overlap"
      label={copy.overlapLabel}
      variant="card"
      bind:value={overlapDraft}
    >
      {#each overlaps as policy (policy.value)}
        <RadioGroup.Option
          id={`weft-agent-schedule-overlap-${policy.value}`}
          value={policy.value}
          label={policy.label}
          description={policy.consequence}
        />
      {/each}
    </RadioGroup>
  </section>
</div>

<style>
  .weft-schedule-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .weft-schedule-form__section {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .weft-schedule-form__section-title {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }
</style>
