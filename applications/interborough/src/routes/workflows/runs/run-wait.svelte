<script lang="ts">
  /**
   * What a run is waiting on a person for, decided where it is shown. A tool approval is the same
   * flat row the chat shows, decided through `bureau.reviews.resolve`; a question is one text field
   * answered through `bureau.tasks.respond`. The task names a wait by its review's identifier only,
   * so the question, the tool, and its arguments are read from `bureau.reviews.get`.
   *
   * A question is the chat package's own (`ChatQuestion`), drawn for a text answer with the field
   * in place (`answerInComposer` off: the page has no composer), drawn from the review's own
   * `inputSchema`, so a secret question is a masked field. Once it is answered it reads
   * "You answered ...", masked the way the chat masks it (`recordAnswer`, on that same schema, so a
   * secret is never shown), for as long as the page is open: the page that lists the waits keeps the
   * row (`onAnswered`) after the next read of the task no longer lists the wait.
   */
  import {
    ChatQuestion,
    recordAnswer,
    type ChatQuestionIssue,
    type QuestionAnswerRecord,
  } from '@lostgradient/chat';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { REVIEWS_COPY, TASK_COPY } from '../../../app/copy.ts';
  import { uploadAsset } from '../../../lib/bureau-assets.ts';
  import {
    getBureauReview,
    isReviewRoundChanged,
    resolveBureauReview,
  } from '../../../lib/bureau-reviews.ts';
  import {
    answerRefusalIssues,
    respondToTask,
    taskAnswerText,
    type TaskOpenWait,
  } from '../../../lib/bureau-tasks.ts';
  import ApprovalDecision from '../../../lib/decision/approval-decision.svelte';
  import { classifyFault, faultTreatment } from '../../../lib/faults.ts';
  import IdentifierText from '../../../lib/identifier-text.svelte';
  import { createPendingCommandKey } from '../../../lib/pending-command-key.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { invalidateReviewQueries } from '../../../lib/review-queries.ts';
  import { approvalQuestion, declaredSummary } from '../../../lib/tool-text.ts';

  interface RunWaitProps {
    taskId: string;
    wait: TaskOpenWait;
    /** The answer once it was sent; the page keeps it, so it outlives this row's wait. */
    answered?: QuestionAnswerRecord | undefined;
    /** Called as the answer is sent, so the page keeps this row if the task stops listing the wait. */
    onSending?: (() => void) | undefined;
    /** Called with what the answer reads as once the Bureau took it. */
    onAnswered?: ((record: QuestionAnswerRecord) => void) | undefined;
    /** Called when the answer was not taken, so the page need not keep a wait that is closed. */
    onFailed?: (() => void) | undefined;
  }

  let { taskId, wait, answered, onSending, onAnswered, onFailed }: RunWaitProps = $props();

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
  let issues = $state.raw<readonly ChatQuestionIssue[]>([]);

  /** What a question that declares no schema takes: free text, which `bureau.tasks.respond` sends. */
  const FREE_TEXT_SCHEMA = { type: 'string', title: REVIEWS_COPY.answerLabel } as const;
  /** The schema the question is drawn and its answer recorded on: the review's own, when it has one. */
  const schema = $derived<Readonly<Record<string, unknown>>>(
    review.data?.kind === 'human-wait' && review.data.inputSchema !== undefined
      ? review.data.inputSchema
      : FREE_TEXT_SCHEMA,
  );

  /**
   * Sends what the question's control gave. Text goes as typed; any other answer (a yes or no, a
   * pick of several, an object, a number) goes as the JSON text the Bureau reads back into it
   * (`answerFromText`), and is recorded as the value it is.
   */
  async function answer(given: unknown): Promise<void> {
    const value = typeof given === 'string' ? given.trim() : given;
    const text = taskAnswerText(value);
    if (wait.kind !== 'human-wait' || text === '') return;
    // What was asked is read once, before the first await: the props are the page's and move on,
    // and the task's next read may unmount this row while the answer is still on its way.
    const { reviewId, signalName } = wait;
    const kept = { onAnswered, onFailed };
    onSending?.();
    const prompt = review.data?.kind === 'human-wait' ? review.data.prompt : undefined;
    const answeredSchema = schema;
    working = true;
    failure = undefined;
    issues = [];
    try {
      await respondToTask({
        taskId,
        messageId: commandKey.keyFor(`${taskId}:${reviewId}`, text),
        answer: text,
        signalName,
      });
      commandKey.confirmed();
      kept.onAnswered?.(
        recordAnswer({
          toolCallId: reviewId,
          toolName: 'agent',
          message: prompt,
          schema: answeredSchema,
          value,
        }),
      );
      await invalidateReviewQueries(queryClient);
    } catch (error) {
      // A refusal that names fields is shown on them; any other failure is the message below.
      kept.onFailed?.();
      const refusal = answerRefusalIssues(error);
      if (refusal === undefined) failure = faultTreatment(error).message;
      else issues = refusal;
    } finally {
      working = false;
    }
  }

  async function decide(decision: 'approve' | 'deny'): Promise<void> {
    working = true;
    failure = undefined;
    try {
      await resolveBureauReview({
        id: wait.reviewId,
        decision,
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
  {#if answered !== undefined}
    <ChatQuestion
      id={`run-wait-${wait.reviewId}`}
      schema={answered.schema}
      answer={answered}
      onSubmit={() => {}}
    />
  {:else if working && (gone || review.isError)}
    <!-- The task's or the review's next read can land before the answer's response does. -->
    <p class="ib-run-wait__note" role="status" aria-busy="true">{TASK_COPY.sendingAnswer}</p>
  {:else if review.isPending}
    <p class="ib-run-wait__note" role="status" aria-busy="true">{TASK_COPY.readingWait}</p>
  {:else if gone}
    <p class="ib-run-wait__note">{TASK_COPY.waitGone}</p>
  {:else if review.isError}
    <p class="ib-run-wait__note">{TASK_COPY.waitLoadFailed}</p>
  {:else if review.data.kind === 'human-wait'}
    <p class="ib-run-wait__prompt" id={`run-wait-${wait.reviewId}-prompt`}>
      <IdentifierText text={review.data.prompt ?? TASK_COPY.humanWaitFallback} identifiers={[]} />
    </p>
    <ChatQuestion
      {...{ 'data-changes': true }}
      id={`run-wait-${wait.reviewId}`}
      {schema}
      answerInComposer={false}
      busy={working}
      {issues}
      failed={failure !== undefined}
      uploadFile={async (file, signal) => (await uploadAsset(file, { signal })).assetId}
      onSubmit={(value) => void answer(value)}
    />
    {#if failure !== undefined}<p class="ib-run-wait__note" role="alert">{failure}</p>{/if}
    <p class="ib-run-wait__note">{REVIEWS_COPY.answerHint}</p>
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
      onDecide={(decision) => void decide(decision)}
    />
    {#if failure !== undefined}<p class="ib-run-wait__note">{failure}</p>{/if}
  {/if}
</div>
