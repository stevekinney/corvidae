<script lang="ts">
  import { getCatalogHost } from '@lostgradient/backchannel-svelte';
  import { untrack, type Snippet } from 'svelte';
  import { setReviewsHost } from './context.ts';
  import type { ApprovalHost } from './tool-approval-actions.svelte.ts';
  import { parseReviewsOutput } from './validation.ts';
  import type { ReviewsOperationTypes } from '../generated/reviews-operations.generated.ts';

  let {
    authorized,
    decisionSurface,
    onOutcome,
    takeSeed,
    children,
  }: Omit<ApprovalHost, 'catalog'> & {
    children: Snippet;
    takeSeed: (scope: string) => readonly { input: unknown; data: unknown }[];
  } = $props();
  const catalog = getCatalogHost();
  const opening = new Map<string, ReviewsOperationTypes['bureau.reviews.list']['output']>();
  for (const entry of untrack(() => takeSeed(catalog.scope))) {
    const data = parseReviewsOutput(
      'bureau.reviews.list',
      entry.data,
    ) as ReviewsOperationTypes['bureau.reviews.list']['output'];
    catalog.seed('bureau.reviews.list', entry.input, data, (_value): _value is unknown => true);
    opening.set(JSON.stringify(entry.input), data);
  }
  const authorize = untrack(() => authorized);
  setReviewsHost(
    Object.assign(catalog, {
      catalog,
      opening,
      authorized: (review: Parameters<ApprovalHost['authorized']>[0]) => authorize(review),
      decisionSurface: untrack(() => decisionSurface),
      onOutcome: (...args: Parameters<NonNullable<ApprovalHost['onOutcome']>>) =>
        onOutcome?.(...args),
    }),
  );
</script>

{@render children()}
