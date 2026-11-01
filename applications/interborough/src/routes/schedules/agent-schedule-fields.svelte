<script lang="ts">
  /**
   * The fields of the page that edits a schedule that runs an agent. An edit changes only the
   * cadence, the description, and the overlap policy: exactly what `bureau.schedules.update` takes,
   * with the overlap policy only `skip` or `allow`, the Bureau's. A schedule is made on
   * `new-schedule.svelte`. Mutates the passed-in `form`, as the engine schedule's fields do.
   */
  import { Button, Checkbox, Input, type ScheduleValue } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

  import { SCHEDULE_COPY } from '../../app/copy.ts';
  import type { AgentScheduleFormState } from './agent-schedule-form-state.svelte.ts';
  import ScheduleWhen from './schedule-when.svelte';

  interface Props {
    form: AgentScheduleFormState;
  }

  let { form }: Props = $props();

  const copy = SCHEDULE_COPY.form;

  function onCadenceChange(next: ScheduleValue): void {
    form.setCadence(next);
  }

  // A checkbox's state is a boolean and the form's is the Bureau's `skip` or `allow`, so a local
  // draft is written back to the form, as the engine schedule's fields do.
  let skipDraft = $state<boolean>(untrack(() => form.overlap === 'skip'));
  $effect(() => {
    form.overlap = skipDraft ? 'skip' : 'allow';
  });
</script>

<div class="weft-schedule-form" data-form="agent-schedule">
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
      <ScheduleWhen
        value={form.cadence}
        onValueChange={onCadenceChange}
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
    />
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
</style>
