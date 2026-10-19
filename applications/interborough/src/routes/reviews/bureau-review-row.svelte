<script lang="ts">
  /**
   * One Bureau review in the list: what is waiting (the tool to approve, or the question to
   * answer), which agent is waiting, and how long. Selecting it opens it in the detail pane. It
   * links once, to where the review came from (`bureauReviewTarget`): the chat when it names a
   * session, otherwise its task when the Bureau answers for the run, otherwise the run. Whether
   * there is a task is asked only for a review with no session, and the link waits for the answer.
   */
  import { Badge } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { REVIEWS_COPY } from '../../app/copy.ts';
  import type { BureauReview } from '../../lib/bureau-reviews.ts';
  import { getTask } from '../../lib/bureau-tasks.ts';
  import { formatRelativeTime } from '../../lib/format/index.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { bureauReviewTarget } from './review-items.ts';

  interface BureauReviewRowProps {
    readonly review: BureauReview;
    readonly selected: boolean;
    readonly now: number;
    readonly onSelect: (key: string) => void;
  }

  let { review, selected, now, onSelect }: BureauReviewRowProps = $props();

  const task = createQuery(
    () => ({
      queryKey: queryKeys.bureauTasks.detail(review.runId),
      queryFn: ({ signal }) => getTask(review.runId, { signal }),
      enabled: review.sessionId === undefined,
      retry: false,
    }),
    undefined,
  );

  // Asked and answered: a task is there, or the Bureau says it is not, or it cannot say.
  const taskExists = $derived(
    task.isSuccess ? true : task.isError ? false : undefined,
  );
  const target = $derived(bureauReviewTarget(review, taskExists));
  const LINK_LABEL = { chat: REVIEWS_COPY.openChat, task: REVIEWS_COPY.openTask, run: REVIEWS_COPY.openRun } as const;

  const summary = $derived(
    review.kind === 'tool-approval'
      ? review.approval.toolName
      : (review.prompt ?? review.signalName),
  );

  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<div
  class="weft-bureau-review-row"
  class:weft-bureau-review-row--selected={selected}
  data-kind={review.kind}
>
  <button
    type="button"
    class="weft-review-row"
    class:weft-review-row--selected={selected}
    aria-pressed={selected}
    onclick={() => onSelect(`bureau:${review.id}`)}
  >
    <div class="weft-review-row__top">
      <Badge variant={review.kind === 'tool-approval' ? 'warning' : 'info'} size="sm">
        {review.kind === 'tool-approval' ? REVIEWS_COPY.toolApproval : REVIEWS_COPY.humanWait}
      </Badge>
      {#if review.agentName !== undefined}
        <span class="weft-bureau-review-row__agent">{review.agentName}</span>
      {/if}
    </div>
    <div class="weft-review-row__id">{summary}</div>
    <div class="weft-review-row__bottom">
      <span class="weft-review-row__created">{formatRelativeTime(review.requestedAt, now)}</span>
    </div>
  </button>
  {#if target !== undefined}
    <a
      class="weft-bureau-review-row__link"
      href={router.href(target.path)}
      onclick={(event) => open(event, target.path)}>{LINK_LABEL[target.kind]}</a
    >
  {/if}
</div>
