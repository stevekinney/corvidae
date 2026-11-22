<script lang="ts">
  /**
   * Inline fault banner for a TanStack `createQuery` error (plan §10.4).
   * `query.ts`'s own doc is explicit that query failures do NOT throw (they
   * degrade to last-known cached data instead), so `<FaultBoundary>`
   * (`src/app/fault-boundary.svelte`) never sees them — route components
   * read `query.error` directly and render the same six-treatment banner
   * inline themselves. This is that inline banner, shared by every surface
   * in this track (list/aggregate/start) that reads a query error, kept
   * intentionally simpler than `<FaultBoundary>`'s render-error version (no
   * collapsible stack trace — a query error is always either a wire fault
   * or a plain network failure, never a caught local rendering bug). It is drawn by
   * `fault-error-state.svelte`, so it shows the fault's remediation and offers Retry only when
   * the fault can be retried.
   */
  import FaultErrorState from '../../../app/fault-error-state.svelte';
  import { faultTreatment } from '../../../lib/faults.ts';

  interface QueryFaultBannerProps {
    error: unknown;
    /** What failed to load, for the title ("Couldn’t load workflows"). */
    subject?: string | undefined;
    onRetry: () => void;
  }

  let { error, subject, onRetry }: QueryFaultBannerProps = $props();

  const treatment = $derived(faultTreatment(error));
</script>

<FaultErrorState {treatment} {subject} {onRetry} />
