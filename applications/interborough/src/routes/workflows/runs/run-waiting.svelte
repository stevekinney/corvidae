<script lang="ts">
  /**
   * What the run is waiting on a person for, at the top of the page under the heading "What you can
   * do": each open question the agent asked and each tool approval it needs, with the control that
   * answers it in place (`run-wait.svelte`), questions first. The line under the heading says how
   * many of each. An approval is decided here and nowhere else on the page: the tool calls under
   * How it ran show the call, not a second decision. The section is absent when the run asks
   * nothing. An answered question keeps its row for as long as the page is open: the next read of
   * the task no longer lists the wait, but the row says what was answered (a secret as fixed words)
   * and does not vanish under the person.
   */
  import type { QuestionAnswerRecord } from '@lostgradient/chat';

  import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
  import { TASK_COPY } from '../../../app/copy/tasks.ts';
  import type { TaskOpenWait, TaskView } from '../../../lib/bureau-tasks.ts';
  import RunWait from './run-wait.svelte';

  interface RunWaitingProps {
    task: TaskView;
    /** Called with `true` while a picked answer is in its Undo window and `false` when it is not. */
    onAnswerHold?: ((held: boolean) => void) | undefined;
  }

  let { task, onAnswerHold }: RunWaitingProps = $props();

  /** The questions that were sent from here, as they were listed when they were. */
  let kept = $state.raw<readonly TaskOpenWait[]>([]);
  /** What each answered question reads as, kept here so it outlives the wait's own row. */
  let answers = $state.raw<ReadonlyMap<string, QuestionAnswerRecord>>(new Map());

  // The questions lead and the approvals follow, each in the order the task lists them.
  const open = $derived([
    ...task.openWaits.filter((wait) => wait.kind === 'human-wait'),
    ...task.openWaits.filter((wait) => wait.kind === 'tool-approval'),
  ]);
  // The open waits, then the questions sent from here that the task no longer lists. One keyed
  // list, so a row is the same component instance before and after its wait closes, even when the
  // task's next read lands before the answer's response does.
  const questions = $derived.by(() => {
    const openIds = new Set(open.map((wait) => wait.reviewId));
    return [...open, ...kept.filter((wait) => !openIds.has(wait.reviewId))];
  });
</script>

{#if questions.length > 0}
  {@const unanswered = open.filter((wait) => !answers.has(wait.reviewId))}
  <section
    class="ib-run__section ib-run__waiting"
    aria-labelledby="ib-run-waiting"
    data-section="waiting"
  >
    <h2 id="ib-run-waiting" class="ib-run__heading-2">
      {unanswered.length > 0 ? TASK_COPY.waitsHeading : TASK_COPY.waitsAnsweredHeading}
    </h2>
    {#if unanswered.length > 0}
      <p class="ib-run__note">
        {RUN_DETAIL_COPY.waits.summary(
          unanswered.filter((wait) => wait.kind === 'human-wait').length,
          unanswered.filter((wait) => wait.kind === 'tool-approval').length,
        )}
      </p>
    {/if}
    {#each questions as wait (wait.reviewId)}
      <RunWait
        taskId={task.id}
        {wait}
        {onAnswerHold}
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
