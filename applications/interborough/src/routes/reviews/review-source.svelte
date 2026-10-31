<script lang="ts">
  /**
   * The one line under a review's question that says where it came from: who asked, in which chat or
   * workflow, and since when. Each part is a link: the agent to its page, the chat (or the run, for
   * a question that has no chat) to where it is, and the time to the run it belongs to. A review
   * that was decided says when it was asked rather than that it is waiting.
   */
  import { RelativeTime } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { REVIEWS_COPY } from '../../app/copy.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import { getContext } from '../../lib/bureau-client.ts';
  import type { ListedReview } from '../../lib/bureau-reviews.ts';
  import { truncateId } from '../../lib/format/index.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router, workflowDetailPath } from '../../lib/router.svelte.ts';

  interface ReviewSourceProps {
    readonly review: ListedReview;
    /** Whether the review is still waiting, which decides between "waiting since" and "asked". */
    readonly waiting: boolean;
  }

  let { review, waiting }: ReviewSourceProps = $props();

  const sessionId = $derived(review.kind === 'engine-review' ? undefined : review.sessionId);

  const chat = createQuery(
    () => ({
      queryKey: queryKeys.contexts.detail(sessionId ?? ''),
      queryFn: ({ signal }) => getContext(sessionId ?? '', { signal }),
      enabled: sessionId !== undefined,
      retry: false,
    }),
    undefined,
  );

  const agent = $derived(
    review.kind === 'engine-review' ? undefined : (review.agentName ?? undefined),
  );
  const runPath = $derived(workflowDetailPath(review.runId));
  const place = $derived.by(() => {
    if (review.kind === 'engine-review') {
      return { path: runPath, label: truncateId(review.runId) };
    }
    if (sessionId === undefined) return { path: runPath, label: REVIEWS_COPY.source.thisRun };
    return {
      path: chatSessionPath(sessionId),
      label: chat.data?.title ?? REVIEWS_COPY.untitledChat,
    };
  });

  /** Follows a link inside the app's router, unless the click asks for a new tab or window. */
  function follow(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<p class="ib-review-source" data-testid="review-source">
  {REVIEWS_COPY.source.askedBy}
  {#if agent !== undefined}
    <a href={router.href(agentPath(agent))} onclick={(event) => follow(event, agentPath(agent))}
      >{agent}</a
    >
  {:else}
    <span
      >{review.kind === 'engine-review'
        ? REVIEWS_COPY.source.unknownWorkflow
        : REVIEWS_COPY.unknownAgent}</span
    >
  {/if}
  {REVIEWS_COPY.source.in}
  <a href={router.href(place.path)} onclick={(event) => follow(event, place.path)}>{place.label}</a>
  <span aria-hidden="true">·</span>
  {waiting ? REVIEWS_COPY.source.waitingSince : REVIEWS_COPY.source.askedAt}
  <a href={router.href(runPath)} onclick={(event) => follow(event, runPath)}
    ><RelativeTime date={review.requestedAt} /></a
  >
</p>
