<script lang="ts">
  /**
   * Inline six-treatment fault banner for `createQuery` errors (plan §10.4;
   * design `Weft Patterns.dc.html` "Fault / error banner"). `query.ts`'s own
   * module doc is explicit that query errors never reach `<FaultBoundary>`
   * (it only catches render-phase exceptions) and that route components
   * "render the SAME six-treatment FaultDisplay banner inline" themselves —
   * this component is that banner for the System tabs, drawn by the same
   * `fault-error-state.svelte` (a Cinder `ErrorState`) the boundary uses, so it shows the
   * fault's remediation and offers Retry only when the fault can be retried.
   */
  import FaultErrorState from '../../app/fault-error-state.svelte';
  import { faultTreatment } from '../../lib/faults.ts';

  interface Props {
    error: unknown;
    onRetry?: (() => void) | undefined;
  }

  let { error, onRetry }: Props = $props();

  const treatment = $derived(faultTreatment(error));
</script>

<FaultErrorState {treatment} {onRetry}>
  {#if treatment.kind === 'internal' && treatment.tryViaJsonRpc}
    <p class="weft-fault-boundary__note">
      The REST API hides internal error detail on this response — the same request over JSON-RPC
      returns the full fault.
    </p>
  {/if}
</FaultErrorState>
