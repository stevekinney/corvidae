<script lang="ts">
  /**
   * What a run is waiting on a person for, decided where it is shown. A tool approval is the same
   * flat row the chat shows, decided through `bureau.reviews.resolve`; a question is one text field
   * answered through `bureau.tasks.respond`. The task names a wait by its review's identifier only,
   * so the question, the tool, and its arguments are read from `bureau.reviews.get`.
   */
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { REVIEWS_COPY, TASK_COPY } from '../../../app/copy.ts';
  import {
    getBureauReview,
    isReviewRoundChanged,
    resolveBureauReview,
  } from '../../../lib/bureau-reviews.ts';
  import { respondToTask, type TaskOpenWait } from '../../../lib/bureau-tasks.ts';
  import ApprovalDecision from '../../../lib/decision/approval-decision.svelte';
  import QuestionDecision from '../../../lib/decision/question-decision.svelte';
  import { classifyFault, faultTreatment } from '../../../lib/faults.ts';
  import { createPendingCommandKey } from '../../../lib/pending-command-key.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { invalidateReviewQueries } from '../../../lib/review-queries.ts';
  import { approvalQuestion, declaredSummary } from '../../../lib/tool-text.ts';

  interface RunWaitProps {
    taskId: string;
    wait: TaskOpenWait;
  }

  let { taskId, wait }: RunWaitProps = $props();

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

  const commandKey = createPendingCommandKey();
  let working = $state(false);
  let failure = $state<string | undefined>(undefined);

  async function answer(text: string): Promise<void> {
    if (wait.kind !== 'human-wait') return;
    working = true;
    failure = undefined;
    try {
      await respondToTask({
        taskId,
        messageId: commandKey.keyFor(`${taskId}:${wait.reviewId}`, text),
        answer: text,
        signalName: wait.signalName,
      });
      commandKey.confirmed();
      await invalidateReviewQueries(queryClient);
    } catch (error) {
      failure = faultTreatment(error).message;
    } finally {
      working = false;
    }
  }

  async function decide(decision: 'approve' | 'deny', note: string): Promise<void> {
    working = true;
    failure = undefined;
    try {
      await resolveBureauReview({
        id: wait.reviewId,
        decision: decision === 'deny' && note !== '' ? 'reject' : decision,
        ...(note === '' ? {} : { reason: note }),
        // The round shown: an approval gated again since is refused, not decided.
        ...(review.data?.kind === 'tool-approval' ? { round: review.data.round } : {}),
      });
      await invalidateReviewQueries(queryClient);
    } catch (error) {
      if (isReviewRoundChanged(error)) {
        failure = `${REVIEWS_COPY.roundChanged.title}: ${REVIEWS_COPY.roundChanged.message}`;
        // The review is read again, so the request it changed to is the one shown.
        await invalidateReviewQueries(queryClient);
      } else {
        failure = faultTreatment(error).message;
      }
    } finally {
      working = false;
    }
  }
</script>

<div class="ib-run-wait" data-kind={wait.kind}>
  {#if review.isPending}
    <p class="ib-run-wait__note" role="status" aria-busy="true">{TASK_COPY.readingWait}</p>
  {:else if gone}
    <p class="ib-run-wait__note">{TASK_COPY.waitGone}</p>
  {:else if review.isError}
    <p class="ib-run-wait__note">{TASK_COPY.waitLoadFailed}</p>
  {:else if review.data.kind === 'human-wait'}
    <QuestionDecision
      id={`run-wait-${wait.reviewId}`}
      question={review.data.prompt ?? TASK_COPY.humanWaitFallback}
      identifiers={[]}
      sending={working}
      {failure}
      onSend={answer}
    />
  {:else}
    {@const approval = review.data.approval}
    <ApprovalDecision
      id={`run-wait-${wait.reviewId}`}
      identifiers={[approval.toolName]}
      question={approvalQuestion({
        toolName: approval.toolName,
        arguments: approval.arguments,
        summary: declaredSummary(approval.action.message, approval.reason),
      })}
      deciding={working}
      onDecide={(decision, note) => void decide(decision, note)}
    />
    {#if failure !== undefined}<p class="ib-run-wait__note">{failure}</p>{/if}
  {/if}
</div>
