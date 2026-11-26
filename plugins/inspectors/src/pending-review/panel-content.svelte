<script lang="ts">
  import { getReviewsHost, useBureauReviewsList } from '@lostgradient/bureau-client/reviews/svelte';
  import { useToolApprovalActions } from '@lostgradient/bureau-client/reviews/ui';
  import { onMount } from 'svelte';
  import { MAXIMUM_PAGES, PAGE_LIMIT } from './model.ts';
  import type { ReviewsOperationTypes } from '@lostgradient/bureau-client/reviews';
  import ReviewList from './review-list.svelte';
  import type { ReviewsView } from './view.svelte.ts';

  let {
    view,
    handlers,
    onReady,
    onData,
  }: {
    view: ReviewsView;
    handlers: {
      onOpenReject(id: string): void;
      onCancelReject(id: string): void;
      onDraft(id: string, text: string): void;
    };
    onReady(refresh: () => Promise<void>): void;
    onData(page: ReviewsOperationTypes['bureau.reviews.list']['output'], truncated: boolean): void;
  } = $props();
  const host = getReviewsHost();
  const actionsFor = useToolApprovalActions(host);
  const input = { status: 'pending' as const, limit: PAGE_LIMIT };
  const read = useBureauReviewsList(host, () => input);
  let pending: Promise<void> | undefined;

  function refresh(): Promise<void> {
    if (pending) return pending;
    pending = (async () => {
      let page = await read.refresh();
      let pages = 1;
      while (page.nextPageToken !== null && pages < MAXIMUM_PAGES) {
        await read.loadMore();
        const current = host.cache.getQueryData<typeof page>(
          host.key('bureau.reviews.list', input),
        );
        if (!current || host.disposed) return;
        page = current;
        pages++;
      }
      if (host.disposed) return;
      onData(page, page.nextPageToken !== null);
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  }
  onMount(() => onReady(refresh));
</script>

<ReviewList {view} {handlers} {actionsFor} />
