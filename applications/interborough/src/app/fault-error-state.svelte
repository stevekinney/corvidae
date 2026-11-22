<script lang="ts">
  /**
   * One classified fault on a Cinder `ErrorState` row, for every surface that shows a fault inline
   * (`fault-boundary.svelte` and the three `query-fault-banner.svelte` components): the treatment's
   * title as the heading, its message as the description, the fault's `remediation` as its own line
   * under the description, and Retry only when the fault is not `retryable: false`
   * (`treatmentErrorStateAdvice`, `lib/faults.ts`). A treatment that names no failure of the
   * request itself (`not-found`, `not-supported`) is Cinder's neutral tone, the rest its danger tone
   * (`ErrorState` has no warning tone, so `conflict` and `unreachable` read as danger). Every kind
   * is announced as an alert. `children` carries what only some treatments add (a note, the field
   * errors, a stack trace), drawn under the row inside the same box.
   */
  import type { Snippet } from 'svelte';

  import { ErrorState } from '@lostgradient/cinder';
  import type { LucideIcon } from '@lucide/svelte';
  import {
    CircleSlash,
    CircleX,
    GitPullRequestClosed,
    Lock,
    SearchX,
    ServerCrash,
    WifiOff,
  } from '@lucide/svelte';

  import {
    FAULT_TREATMENT_TITLE,
    treatmentErrorStateAdvice,
    type FaultTreatment,
    type FaultTreatmentKind,
  } from '../lib/faults.ts';
  import { RETRY_LABEL } from './copy/views.ts';

  interface FaultErrorStateProps {
    readonly treatment: FaultTreatment;
    /** What Retry does; the row offers it only when the fault can be retried. */
    readonly onRetry?: (() => void) | undefined;
    /** Extra detail for the treatment, drawn under the row. */
    readonly children?: Snippet | undefined;
  }

  let { treatment, onRetry, children }: FaultErrorStateProps = $props();

  /** Icon per treatment kind, matching the design reference's fault-banner icons. */
  const FAULT_ICON: Readonly<Record<FaultTreatmentKind, LucideIcon>> = {
    'not-found': SearchX,
    conflict: GitPullRequestClosed,
    invalid: CircleX,
    unauthorized: Lock,
    'not-supported': CircleSlash,
    internal: ServerCrash,
    unreachable: WifiOff,
  };

  const Icon = $derived(FAULT_ICON[treatment.kind]);
  const tone = $derived(
    treatment.kind === 'not-found' || treatment.kind === 'not-supported' ? 'neutral' : 'danger',
  );
  const advice = $derived(treatmentErrorStateAdvice(treatment, onRetry));
</script>

<!-- Cinder's neutral tone is a plain group, so a fault of that tone is announced by this box, as every
     fault was before it was drawn on `ErrorState`; a danger-toned `ErrorState` is its own alert. -->
<div
  class="weft-fault-boundary"
  data-tone={tone}
  data-kind={treatment.kind}
  role={tone === 'neutral' ? 'alert' : undefined}
>
  <ErrorState
    variant="row"
    {tone}
    title={FAULT_TREATMENT_TITLE[treatment.kind]}
    description={treatment.message}
    headingLevel={2}
    retryLabel={RETRY_LABEL}
    {...advice}
  >
    {#snippet icon()}
      <Icon aria-hidden="true" />
    {/snippet}
  </ErrorState>
  {#if children}
    <div class="weft-fault-boundary__details">
      {@render children()}
    </div>
  {/if}
</div>
