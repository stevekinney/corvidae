<script lang="ts">
  /**
   * What a Workers panel shows when the read behind it failed: the server's fault with a way to
   * read again, or, for a response the browser refused to trust, that it was malformed and where.
   * A failure is shown as a failure, never as an empty state.
   */
  import { Callout } from '@lostgradient/cinder';

  import QueryFaultBanner from '../system/query-fault-banner.svelte';
  import { MalformedDeploymentsError } from './deployments-data.ts';
  import { MalformedWorkerDiagnosticsError } from './worker-manifest-diagnostics.ts';

  interface PanelFaultProps {
    readonly error: unknown;
    /** Reads again; the banner offers it when given. */
    readonly onRetry?: (() => void) | undefined;
  }

  let { error, onRetry = undefined }: PanelFaultProps = $props();

  const malformed = $derived(
    error instanceof MalformedWorkerDiagnosticsError || error instanceof MalformedDeploymentsError,
  );
</script>

{#if malformed && error instanceof Error}
  <Callout variant="danger" semantic="note" title="Malformed server response">
    <p>{error.message}</p>
  </Callout>
{:else}
  <QueryFaultBanner {error} {onRetry} />
{/if}
