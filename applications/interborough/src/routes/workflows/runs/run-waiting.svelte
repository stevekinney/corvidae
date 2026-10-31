<script lang="ts">
  /**
   * What the run is waiting on a person to answer, at the top of the page: each open question the
   * agent asked, with the control that answers it in place (`run-wait.svelte`). A tool approval is
   * not here: it is decided under the tool call it gates, in the Activity section, as the chat shows
   * it. The section is absent when the run asks nothing. An answered question keeps its row for as
   * long as the page is open: the next read of the task no longer lists the wait, but the row says
   * what was answered (a secret as fixed words) and does not vanish under the person.
   */
  import { TASK_COPY } from '../../../app/copy.ts';
  import type { TaskOpenWait, TaskView } from '../../../lib/bureau-tasks.ts';
  import RunWait from './run-wait.svelte';

  interface RunWaitingProps {
    task: TaskView;
  }

  let { task }: RunWaitingProps = $props();

  /** The questions that were answered here, as they were listed when they were. */
  let kept = $state.raw<readonly TaskOpenWait[]>([]);

  // The open questions, then the answered ones the task no longer lists. One keyed list, so the row
  // that was answered is the same component instance before and after the wait closes.
  const questions = $derived.by(() => {
    const open = task.openWaits.filter((wait) => wait.kind === 'human-wait');
    const openIds = new Set(open.map((wait) => wait.reviewId));
    return [...open, ...kept.filter((wait) => !openIds.has(wait.reviewId))];
  });
</script>

{#if questions.length > 0}
  <section
    class="ib-run__section ib-run__waiting"
    aria-labelledby="ib-run-waiting"
    data-section="waiting"
  >
    <h2 id="ib-run-waiting" class="ib-run__heading-2">{TASK_COPY.waitsHeading}</h2>
    {#each questions as wait (wait.reviewId)}
      <RunWait
        taskId={task.id}
        {wait}
        onAnswered={() => {
          if (!kept.some((entry) => entry.reviewId === wait.reviewId)) kept = [...kept, wait];
        }}
      />
    {/each}
  </section>
{/if}
