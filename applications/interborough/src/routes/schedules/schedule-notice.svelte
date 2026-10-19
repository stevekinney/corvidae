<script lang="ts">
  /**
   * What a schedule write that was refused for being stale, or that the engine applied late, says
   * (`schedule-actions.svelte.ts`). The words are `copy.ts`'s.
   */
  import { Alert } from '@lostgradient/cinder';

  import { SCHEDULE_COPY } from '../../app/copy.ts';
  import type { ScheduleNotice } from './schedule-actions.svelte.ts';

  interface Props {
    notice: ScheduleNotice;
    onDismiss: () => void;
  }

  let { notice, onDismiss }: Props = $props();

  const title = $derived(
    notice.kind === 'stale'
      ? SCHEDULE_COPY.stale.title(notice.scheduleId)
      : SCHEDULE_COPY.unapplied.title,
  );
  const description = $derived(
    notice.kind === 'stale' ? SCHEDULE_COPY.stale.description : SCHEDULE_COPY.unapplied.description,
  );
</script>

<Alert variant="warning" dismissible {onDismiss} data-testid="schedule-notice" data-notice={notice.kind}>
  <p class="weft-schedule-notice__title">{title}</p>
  <p class="weft-schedule-notice__body">{description}</p>
</Alert>

<style>
  .weft-schedule-notice__title {
    margin: 0;
    font-weight: 600;
  }

  .weft-schedule-notice__body {
    margin: 4px 0 0;
  }
</style>
