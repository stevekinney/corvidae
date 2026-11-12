<script lang="ts">
  /**
   * The Input group of a schedule's details card: what each run is sent, as labelled fields by
   * default, or as the JSON that is stored behind them, with one copy button for the whole payload.
   * The switch and the copy button sit at the end of the group's heading, so the group reads like
   * the other groups of the card. It is drawn only for a schedule whose workflow has input.
   */
  import { CopyButton, JsonViewer, Segment, SegmentedControl } from '@lostgradient/cinder';

  import { SCHEDULE_COPY } from '../../app/copy/schedules.ts';
  import type { ScheduleInput } from './schedule-detail-model.ts';

  interface Props {
    input: ScheduleInput;
  }

  let { input }: Props = $props();

  const copy = SCHEDULE_COPY.detail.card;
  let view = $state<'fields' | 'json'>('fields');
</script>

<section class="ib-schedule-card__group" data-testid="schedule-input">
  <div class="ib-schedule-card__head">
    <h3 class="ib-schedule-card__title">{copy.input}</h3>
    <div class="ib-schedule-card__tools">
      <SegmentedControl
        id="ib-schedule-input-view"
        label={copy.inputView}
        labelVisible={false}
        size="sm"
        value={view}
        onValueChange={(choice: 'fields' | 'json') => (view = choice)}
      >
        <Segment value="fields">{copy.fields}</Segment>
        <Segment value="json">{copy.json}</Segment>
      </SegmentedControl>
      <CopyButton
        iconOnly
        label={copy.copyInput}
        value={JSON.stringify(input.payload, null, 2)}
        class="ib-schedule-card__copy"
      />
    </div>
  </div>
  {#if view === 'fields'}
    <dl class="ib-schedule-card__rows">
      {#each input.fields as field (field.label)}
        <div class="ib-schedule-card__row">
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        </div>
      {/each}
    </dl>
  {:else}
    <JsonViewer value={input.payload} initialDepth={2} />
  {/if}
</section>
