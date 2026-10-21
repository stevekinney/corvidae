<script lang="ts">
  /**
   * The run detail page's fault banner, for a fault a section of the page hits (a rejected attribute
   * edit, an unreadable stream, a refused update). It is the markup `workflow-detail.svelte` renders
   * for the fault of loading the run itself (`weft-workflow-detail__fault-banner`), so every fault on
   * this page reads the same way, from the same classification (`faults.ts`).
   */
  import type { FaultTreatment } from '../../../lib/faults.ts';

  interface RunFaultBannerProps {
    /** `faultTreatment(error)` for a rejected call, or a treatment built for a refusal the client answered as a value. */
    readonly treatment: FaultTreatment;
  }

  let { treatment }: RunFaultBannerProps = $props();
</script>

<div
  class="weft-workflow-detail__fault weft-run-fault"
  data-tone={treatment.kind === 'not-found' ? 'neutral' : 'danger'}
  role="alert"
>
  <div class="weft-workflow-detail__fault-banner">
    <p class="weft-workflow-detail__fault-message">{treatment.message}</p>
  </div>
</div>

<style>
  /* The page-level rule gives a fault the margin of a whole-page state; inside a section it sits flush. */
  .weft-run-fault {
    margin: 0;
  }
</style>
