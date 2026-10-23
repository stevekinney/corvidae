<script lang="ts">
  /**
   * The fields of the drawer that creates or edits a schedule that runs an agent. Creating asks for
   * the agent, what to send each fire, and how often, then an optional description (which names
   * the schedule) and whether a fire is skipped while the previous run is still going; an optional
   * session to continue is under "Advanced". Editing changes only the cadence, the description,
   * and the overlap policy: exactly what `bureau.schedules.update` takes, with the overlap policy
   * only `skip` or `allow`, the Bureau's. Mutates the passed-in `form`, as the Weft schedule's
   * fields do.
   */
  import {
    Button,
    Checkbox,
    Collapsible,
    Input,
    ScheduleBuilder,
    Select,
    Textarea,
    type ScheduleValue,
  } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

  import { SCHEDULE_COPY } from '../../app/copy.ts';
  import { computeNextFires } from '../../lib/format/cron-preview.ts';
  import type { AgentScheduleFormState } from './agent-schedule-form-state.svelte.ts';

  interface Props {
    form: AgentScheduleFormState;
    /** The agents the Bureau lists, or `undefined` when it could not say: then the name is typed. */
    agents: readonly string[] | undefined;
  }

  let { form, agents }: Props = $props();

  const copy = SCHEDULE_COPY.form;
  const creating = $derived(form.mode === 'create');

  function onCadenceChange(next: ScheduleValue): void {
    form.setCadence(next);
  }

  // A checkbox's state is a boolean and the form's is the Bureau's `skip` or `allow`, so a local
  // draft is written back to the form, as the Weft schedule's fields do.
  let skipDraft = $state<boolean>(untrack(() => form.overlap === 'skip'));
  $effect(() => {
    form.overlap = skipDraft ? 'skip' : 'allow';
  });

  let advancedOpen = $state(untrack(() => form.sessionId !== ''));
</script>

<div class="weft-schedule-form" data-form="agent-schedule">
  {#if creating}
    <section class="weft-schedule-form__section">
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
    </section>
  {/if}

  <section class="weft-schedule-form__section">
    {#if form.exactCadenceText !== undefined}
      <!-- The builder counts in whole minutes, so a cadence below that is shown as it is and kept. -->
      <Input
        id="weft-agent-schedule-exact-cadence"
        label={copy.cadenceLabel}
        description={copy.exactCadenceDescription}
        value={form.exactCadenceText}
        disabled
      />
      <div>
        <Button variant="secondary" size="sm" onclick={() => form.changeCadence()}
          >{copy.changeCadenceAction}</Button
        >
      </div>
    {:else}
      <ScheduleBuilder
        value={form.cadence}
        onValueChange={onCadenceChange}
        {computeNextFires}
        timezoneLabel="UTC"
        label={copy.cadenceLabel}
      />
    {/if}
  </section>

  <section class="weft-schedule-form__section">
    <Input
      id="weft-agent-schedule-description"
      label={copy.descriptionLabel}
      description={copy.descriptionDescription}
      bind:value={form.description}
      error={form.errors.description ?? ''}
    />
    <Checkbox
      id="weft-agent-schedule-skip-overlap"
      label={copy.skipOverlapLabel}
      bind:checked={skipDraft}
      error={form.errors.session ?? ''}
    />
  </section>

  {#if creating}
    <Collapsible bind:open={advancedOpen} trigger={copy.advancedLabel}>
      <div class="weft-schedule-form__section">
        <Input
          id="weft-agent-schedule-session"
          label={copy.sessionLabel}
          description={copy.sessionDescription}
          bind:value={form.sessionId}
        />
      </div>
    </Collapsible>
  {/if}
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
</style>
