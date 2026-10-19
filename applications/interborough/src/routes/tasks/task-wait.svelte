<script lang="ts">
  /**
   * One wait a task is held on. The task view names a wait by its review's identifier only, so the
   * question a person is asked, or the tool call they are asked to approve, is read from
   * `bureau.reviews.get`. A question is answered here with one text field, through
   * `bureau.tasks.respond`. A tool approval is shown, with the reason and the message of the review,
   * and decided in Reviews, where every approval is.
   */
  import { Alert, Button, Textarea } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { TASK_COPY } from '../../app/copy.ts';
  import { getBureauReview } from '../../lib/bureau-reviews.ts';
  import { respondToTask, type TaskOpenWait } from '../../lib/bureau-tasks.ts';
  import { classifyFault, faultTreatment } from '../../lib/faults.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { invalidateReviewQueries } from '../../lib/review-queries.ts';
  import { router } from '../../lib/router.svelte.ts';

  interface TaskWaitProps {
    taskId: string;
    wait: TaskOpenWait;
  }

  let { taskId, wait }: TaskWaitProps = $props();

  const queryClient = useQueryClient();

  const review = createQuery(
    () => ({
      queryKey: queryKeys.bureauReviews.detail(wait.reviewId),
      queryFn: ({ signal }) => getBureauReview(wait.reviewId, { signal }),
      retry: false,
    }),
    undefined,
  );

  /** A review that was resolved, or that the Bureau no longer has, is not a wait to answer. */
  const gone = $derived(
    (review.isError && classifyFault(review.error)?.kind === 'not-found') ||
      (review.data !== undefined && review.data.status !== 'pending'),
  );

  let answer = $state('');
  let submitting = $state(false);
  let failure = $state<string | undefined>(undefined);

  async function send(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (wait.kind !== 'human-wait' || answer.trim() === '' || submitting) return;
    submitting = true;
    failure = undefined;
    try {
      await respondToTask({
        taskId,
        messageId: crypto.randomUUID(),
        answer: answer.trim(),
        signalName: wait.signalName,
      });
      answer = '';
      // The wait is answered, so the task continues, and the reviews that listed it no longer do.
      await invalidateReviewQueries(queryClient);
    } catch (error) {
      failure = faultTreatment(error).message;
    } finally {
      submitting = false;
    }
  }

  function openReviews(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate('/reviews');
  }
</script>

<div class="weft-task-wait" data-kind={wait.kind}>
  {#if review.isPending}
    <p class="weft-task-wait__note" role="status" aria-busy="true">Reading the wait.</p>
  {:else if gone}
    <p class="weft-task-wait__note">{TASK_COPY.waitGone}</p>
  {:else if review.isError}
    <p class="weft-task-wait__note">{TASK_COPY.waitLoadFailed}</p>
  {:else if review.data.kind === 'human-wait' && wait.kind === 'human-wait'}
    <p class="weft-task-wait__prompt">{review.data.prompt ?? TASK_COPY.humanWaitFallback}</p>
    <form class="weft-task-wait__form" onsubmit={send}>
      <Textarea
        id={`weft-task-answer-${wait.reviewId}`}
        label={TASK_COPY.answerLabel}
        bind:value={answer}
        rows={3}
      />
      {#if failure !== undefined}
        <Alert variant="danger">
          <p class="weft-task-wait__failure-title">{TASK_COPY.respondFailed}</p>
          <p class="weft-task-wait__failure">{failure}</p>
        </Alert>
      {/if}
      <Button
        type="submit"
        variant="primary"
        label={TASK_COPY.sendAnswer}
        loading={submitting}
        disabled={answer.trim() === '' || submitting}
      />
    </form>
  {:else if review.data.kind === 'tool-approval'}
    <h3 class="weft-task-wait__title">{TASK_COPY.approvalHeading}: {review.data.approval.toolName}</h3>
    <dl class="weft-task-wait__facts">
      {#if review.data.approval.reason !== undefined}
        <dt>{TASK_COPY.approvalReason}</dt>
        <dd>{review.data.approval.reason}</dd>
      {/if}
      {#if review.data.approval.action.message !== undefined}
        <dt>{TASK_COPY.approvalMessage}</dt>
        <dd>{review.data.approval.action.message}</dd>
      {/if}
    </dl>
    <a class="weft-task-wait__link" href={router.href('/reviews')} onclick={openReviews}
      >{TASK_COPY.decideInReviews}</a
    >
  {/if}
</div>
