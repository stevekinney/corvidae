<script lang="ts">
  /**
   * The one line under a review's question that says where it came from: who asked, in which chat or
   * workflow, and since when. Each part is a link: the agent to its page, the chat (or the run, for
   * a question that has no chat) to where it is, and the time to the run it belongs to. A review
   * that was decided says when it was asked rather than that it is waiting.
   */
  import { RelativeTime, humanizeIdentifier } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { REVIEWS_COPY } from '../../app/copy/reviews.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { useAgentDisplayName } from '../../lib/agent-display-name.svelte.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import { getContext } from '../../lib/bureau-client.ts';
  import type { ListedReview } from '../../lib/bureau-reviews.ts';
  import { waitingFor } from '../../lib/format/clock.ts';
  import { truncateId } from '../../lib/format/index.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { workflowDetailPath } from '../../lib/router.svelte.ts';
  import { reviewsNavigation } from '../../lib/reviews-navigation.ts';

  interface ReviewSourceProps {
    readonly review: ListedReview;
    /** Whether the review is still waiting, which decides between "waiting since" and "asked". */
    readonly waiting: boolean;
  }

  let { review, waiting }: ReviewSourceProps = $props();

  const router = reviewsNavigation();
  const displayName = useAgentDisplayName();
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
</script>

{#snippet when()}
  {#if waiting}
    <!-- How long it has waited, as a duration: "waiting 4 min" (rows 25f, 26o). -->
    {REVIEWS_COPY.source.waiting}
    <a href={router.href(runPath)}>{waitingFor(review.requestedAt, Date.now())}</a>
  {:else}
    {REVIEWS_COPY.source.askedAt}
    <a href={router.href(runPath)}><RelativeTime date={review.requestedAt} /></a>
  {/if}
{/snippet}

{#if review.kind === 'engine-review' && review.workflowName !== undefined}
  <!-- COR-2426, row 25o: the workflow by its name, and the step that asked. -->
  <p class="ib-review-source" data-testid="review-source">
    {REVIEWS_COPY.source.askedBy}
    <a href={router.href(runPath)}
      >{REVIEWS_COPY.source.workflowNamed(
        humanizeIdentifier(review.workflowName, { casing: 'sentence' }),
      )}</a
    >{#if review.step !== undefined}, {REVIEWS_COPY.source.step(review.step)}{/if},
    {@render when()}
  </p>
{:else}
  <p class="ib-review-source" data-testid="review-source">
    {REVIEWS_COPY.source.askedBy}
    {#if agent !== undefined}
      <a href={router.href(agentPath(agent))}>{agentLabel(displayName(agent), undefined)}</a>
    {:else}
      <span
        >{review.kind === 'engine-review'
          ? REVIEWS_COPY.source.unknownWorkflow
          : REVIEWS_COPY.unknownAgent}</span
      >
    {/if}
    {REVIEWS_COPY.source.in}
    <a href={router.href(place.path)}>{place.label}</a>,
    {@render when()}
  </p>
{/if}
