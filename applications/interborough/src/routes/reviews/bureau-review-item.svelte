<script lang="ts" module>
  /** A decision or an answer that did not simply take effect, and why. */
  export interface ReviewOutcome {
    /** The review it is about, so it is shown with that review and not beside another. */
    readonly reviewId: string;
    readonly tone: 'danger' | 'warning';
    readonly title: string;
    readonly message: string;
  }
</script>

<script lang="ts">
  /**
   * One thing waiting on the caller: the question itself, then one line saying which agent asked
   * and in which chat, then the decision inline. A tool approval is the flat Deny and Approve row
   * every approval is (`lib/decision/approval-decision.svelte`) with an optional note the agent
   * reads when the call is denied; a question is one text field and Send. The Bureau's wording for
   * the call comes from the tool's own summary, or else from its name and arguments
   * (`lib/tool-text.ts`).
   */
  import { Alert, Collapsible } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { REVIEWS_COPY } from '../../app/copy.ts';
  import { getContext } from '../../lib/bureau-client.ts';
  import type { BureauReview, ReviewDecision } from '../../lib/bureau-reviews.ts';
  import ApprovalDecision from '../../lib/decision/approval-decision.svelte';
  import QuestionDecision from '../../lib/decision/question-decision.svelte';
  import { formatRelativeTime } from '../../lib/format/index.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { approvalQuestion, argumentEntries, declaredSummary } from '../../lib/tool-text.ts';
  import BureauReviewOperation from './bureau-review-operation.svelte';

  interface BureauReviewItemProps {
    readonly review: BureauReview;
    /** Whether a decision or an answer is being sent. */
    readonly submitting: boolean;
    /** What became of the last decision or answer, when it was not simply recorded. */
    readonly outcome: ReviewOutcome | undefined;
    readonly onResolve: (decision: ReviewDecision, reason: string | undefined) => void;
    readonly onAnswer: (answer: string) => void;
  }

  let { review, submitting, outcome, onResolve, onAnswer }: BureauReviewItemProps = $props();

  const chat = createQuery(
    () => ({
      queryKey: queryKeys.contexts.detail(review.sessionId ?? ''),
      queryFn: ({ signal }) => getContext(review.sessionId ?? '', { signal }),
      enabled: review.sessionId !== undefined,
      retry: false,
    }),
    undefined,
  );

  const agent = $derived(review.agentName ?? REVIEWS_COPY.unknownAgent);
  const question = $derived(
    review.kind === 'tool-approval'
      ? approvalQuestion({
          toolName: review.approval.toolName,
          arguments: review.approval.arguments,
          summary: declaredSummary(review.approval.action.message, review.approval.reason),
        })
      : `${agent} ${REVIEWS_COPY.asks} ${review.prompt ?? REVIEWS_COPY.questionFallback}`,
  );
  const target = $derived(
    review.sessionId === undefined
      ? { path: `/runs/${encodeURIComponent(review.runId)}`, label: REVIEWS_COPY.openRun }
      : { path: chatSessionPath(review.sessionId), label: REVIEWS_COPY.openChat },
  );

  function open(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(target.path);
  }
</script>

<li class="ib-review" data-review={review.id} data-kind={review.kind}>
  {#if review.kind === 'tool-approval'}
    <ApprovalDecision
      id={`review-${review.id}`}
      {question}
      deciding={submitting}
      withNote
      onDecide={(decision, note) =>
        onResolve(decision === 'deny' && note !== '' ? 'reject' : decision, note === '' ? undefined : note)}
    />
  {:else}
    <QuestionDecision
      id={`review-${review.id}`}
      {question}
      sending={submitting}
      failure={undefined}
      onSend={onAnswer}
    />
  {/if}
  {#if review.kind === 'tool-approval'}
    {@const operation = review.approval.action.type === 'approval' ? review.approval.action.operation : undefined}
    <div class="ib-review__details">
      <Collapsible trigger={REVIEWS_COPY.details}>
        <dl class="ib-tool__details">
          {#each argumentEntries(review.approval.arguments) as [key, value] (key)}
            <dt>{key}</dt>
            <dd>{value}</dd>
          {/each}
        </dl>
        {#if operation !== undefined}
          <BureauReviewOperation {operation} />
        {/if}
      </Collapsible>
    </div>
  {/if}
  <p class="ib-review__origin">
    <span>{agent}</span>
    {#if review.sessionId !== undefined && chat.data}
      · <span>{chat.data.title ?? REVIEWS_COPY.untitledChat}</span>
    {/if}
    · <span>{formatRelativeTime(review.requestedAt, Date.now())}</span>
    · <a href={router.href(target.path)} onclick={open}>{target.label}</a>
  </p>
  {#if outcome !== undefined}
    <Alert variant={outcome.tone}>
      <p class="ib-decision__failure">{outcome.title}{outcome.message === '' ? '' : `: ${outcome.message}`}</p>
    </Alert>
  {/if}
</li>
