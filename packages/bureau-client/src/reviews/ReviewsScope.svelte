<script lang="ts">
  import { getCatalogHost } from '@lostgradient/backchannel-svelte';
  import { untrack, type Snippet } from 'svelte';
  import { setReviewsHost } from './context.ts';
  import type { ApprovalHost } from './tool-approval-actions.svelte.ts';

  let {
    authorized,
    decisionSurface,
    onOutcome,
    children,
  }: Omit<ApprovalHost, 'catalog'> & { children: Snippet } = $props();
  const catalog = getCatalogHost();
  setReviewsHost(
    Object.assign(catalog, {
      catalog,
      authorized: (review: Parameters<ApprovalHost['authorized']>[0]) => authorized(review),
      decisionSurface: untrack(() => decisionSurface),
      onOutcome: (...args: Parameters<NonNullable<ApprovalHost['onOutcome']>>) =>
        onOutcome?.(...args),
    }),
  );
</script>

{@render children()}
