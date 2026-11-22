<script lang="ts">
  /**
   * Inline fault banner for a TanStack `createQuery` error (plan §10.4).
   * `query.ts`'s own doc is explicit that query failures do NOT throw (they
   * degrade to last-known cached data instead), so `<FaultBoundary>`
   * (`src/app/fault-boundary.svelte`) never sees them — route components
   * read `query.error` directly and render the same six-treatment banner
   * inline themselves. Mirrors the Workflows list track's identical
   * component (`src/routes/workflows/list/query-fault-banner.svelte`) —
   * shared by the reviews page's two lists, so a non-403 query failure (401, 500, network)
   * never renders as a false "all caught up" / "nothing decided yet" empty state. It is drawn by
   * `fault-error-state.svelte`, so it shows the fault's remediation and offers Retry only when the
   * fault can be retried.
   */
  import FaultErrorState from '../../app/fault-error-state.svelte';
  import { faultTreatment } from '../../lib/faults.ts';

  interface QueryFaultBannerProps {
    error: unknown;
    onRetry: () => void;
  }

  let { error, onRetry }: QueryFaultBannerProps = $props();

  const treatment = $derived(faultTreatment(error));
</script>

<div class="weft-query-fault">
  <FaultErrorState {treatment} {onRetry} />
</div>
