<script lang="ts">
  /**
   * What the run is waiting on a person to answer, at the top of the page: each open question the
   * agent asked, with the control that answers it in place (`run-wait.svelte`). A tool approval is
   * not here: it is decided under the tool call it gates, in the Activity section, as the chat shows
   * it. The section is absent when the run asks nothing. An answered question keeps its row for as
   * long as the page is open: the next read of the task no longer lists the wait, but the row says
   * what was answered (a secret as fixed words) and does not vanish under the person.
   */
  import type { QuestionAnswerRecord } from '@lostgradient/chat';

  import { TASK_COPY } from '../../../app/copy.ts';
  import type { TaskOpenWait, TaskView } from '../../../lib/bureau-tasks.ts';
  import RunWait from './run-wait.svelte';

  interface RunWaitingProps {
    task: TaskView;
  }

  let { task }: RunWaitingProps = $props();

  /** The questions that were sent from here, as they were listed when they were. */
  let kept = $state.raw<readonly TaskOpenWait[]>([]);
  /** What each answered question reads as, kept here so it outlives the wait's own row. */
  let answers = $state.raw<ReadonlyMap<string, QuestionAnswerRecord>>(new Map());

  const open = $derived(task.openWaits.filter((wait) => wait.kind === 'human-wait'));
  // The open questions, then the ones sent from here that the task no longer lists. One keyed list,
  // so a row is the same component instance before and after its wait closes, even when the task's
  // next read lands before the answer's response does.
  const questions = $derived.by(() => {
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
    <h2 id="ib-run-waiting" class="ib-run__heading-2">
      {open.some((wait) => !answers.has(wait.reviewId))
        ? TASK_COPY.waitsHeading
        : TASK_COPY.waitsAnsweredHeading}
    </h2>
    {#each questions as wait (wait.reviewId)}
      <RunWait
        taskId={task.id}
        {wait}
        answered={answers.get(wait.reviewId)}
        onSending={() => {
          if (!kept.some((entry) => entry.reviewId === wait.reviewId)) kept = [...kept, wait];
        }}
        onAnswered={(record) => (answers = new Map(answers).set(wait.reviewId, record))}
        onFailed={() => {
          // A wait that is no longer listed has nothing left to show once its answer failed.
          if (!answers.has(wait.reviewId)) {
            kept = kept.filter((entry) => entry.reviewId !== wait.reviewId);
          }
        }}
      />
    {/each}
  </section>
{/if}
