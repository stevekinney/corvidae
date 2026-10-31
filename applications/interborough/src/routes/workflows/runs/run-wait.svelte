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
  import {
    getBureauReview,
    isReviewRoundChanged,
    resolveBureauReview,
  } from '../../../lib/bureau-reviews.ts';
  import {
    answerRefusalIssues,
    respondToTask,
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
    /** Called once the question is answered, so the page can keep its row after the wait closes. */
    onAnswered?: (() => void) | undefined;
  }

  let { taskId, wait, onAnswered }: RunWaitProps = $props();

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
  let answered = $state.raw<QuestionAnswerRecord | undefined>(undefined);
  let issues = $state.raw<readonly ChatQuestionIssue[]>([]);

  /** What a question that declares no schema takes: free text, which `bureau.tasks.respond` sends. */
  const FREE_TEXT_SCHEMA = { type: 'string', title: REVIEWS_COPY.answerLabel } as const;
  /** The schema the question is drawn and its answer recorded on: the review's own, when it has one. */
  const schema = $derived<Readonly<Record<string, unknown>>>(
    review.data?.kind === 'human-wait' && review.data.inputSchema !== undefined
      ? review.data.inputSchema
      : FREE_TEXT_SCHEMA,
  );

  async function answer(text: string): Promise<void> {
    if (wait.kind !== 'human-wait' || text === '') return;
    // What was asked is read once, before the first await: the props are the page's and move on.
    const { reviewId, signalName } = wait;
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
      answered = recordAnswer({
        toolCallId: reviewId,
        toolName: 'agent',
        message: prompt,
        schema: answeredSchema,
        value: text,
      });
      onAnswered?.();
      await invalidateReviewQueries(queryClient);
    } catch (error) {
      // A refusal that names fields is shown on them; any other failure is the message below.
      const refusal = answerRefusalIssues(error);
      if (refusal === undefined) failure = faultTreatment(error).message;
      else issues = refusal;
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
  {:else if answered !== undefined}
    <ChatQuestion
      id={`run-wait-${wait.reviewId}`}
      schema={answered.schema}
      answer={answered}
      onSubmit={() => {}}
    />
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
      onSubmit={(value) => void answer(String(value).trim())}
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
      onDecide={(decision, note) => void decide(decision, note)}
    />
    {#if failure !== undefined}<p class="ib-run-wait__note">{failure}</p>{/if}
  {/if}
</div>
