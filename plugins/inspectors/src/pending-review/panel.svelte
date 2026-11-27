<script lang="ts">
  import type { CatalogTransport } from '@lostgradient/backchannel/client';
  import { ReviewsProvider } from '@lostgradient/bureau-sdk/reviews/svelte';
  import type { ApprovalHost, ApprovalOutcome } from '@lostgradient/bureau-sdk/reviews/ui';
  import { QueryClient } from '@tanstack/svelte-query';
  import PanelContent from './panel-content.svelte';
  import type { ReviewsOperationTypes } from '@lostgradient/bureau-sdk/reviews';
  import type { ReviewsView } from './view.svelte.ts';

  let {
    transport,
    view,
    handlers,
    authorized,
    onOutcome,
    onReady,
    onData,
  }: {
    transport: CatalogTransport;
    view: ReviewsView;
    handlers: {
      onOpenReject(id: string): void;
      onCancelReject(id: string): void;
      onDraft(id: string, text: string): void;
    };
    authorized: ApprovalHost['authorized'];
    onOutcome(
      seen: { id: string; round: number },
      outcome: ApprovalOutcome,
      receipt?: ReviewsOperationTypes['bureau.reviews.resolve']['output'],
    ): void;
    onReady(refresh: () => Promise<void>): void;
    onData(page: ReviewsOperationTypes['bureau.reviews.list']['output'], truncated: boolean): void;
  } = $props();
  const cache = new QueryClient();
</script>

<ReviewsProvider scope="pending-review-panel" {cache} {transport} {authorized} {onOutcome}>
  <PanelContent {view} {handlers} {onReady} {onData} />
</ReviewsProvider>
