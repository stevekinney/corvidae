<script lang="ts">
  /**
   * One classified fault on a Cinder `ErrorState` row, for every surface that shows a fault inline
   * (`fault-boundary.svelte` and the three `query-fault-banner.svelte` components): the treatment's
   * title as the heading, its message as the description, the fault's `remediation` as its own line
   * under the description, and Retry only when the fault is not `retryable: false`
   * (`treatmentErrorStateAdvice`, `lib/faults.ts`). A treatment that names no failure of the
   * request itself (`not-found`, `not-supported`) is Cinder's neutral tone, `conflict` and
   * `unreachable` its warning tone, the rest its danger tone. Every kind is announced as an alert
   * (`announce`). `children` carries what only some treatments add (a note, the field
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

  /**
   * Tone per treatment kind. `not-found` and `not-supported` are neutral (a missing or unsupported
   * resource, not a failure); `conflict` and `unreachable` are warnings (the person can resolve the
   * conflict, and the server may answer again); the rest are danger.
   */
  const FAULT_TONE: Readonly<Record<FaultTreatmentKind, 'neutral' | 'warning' | 'danger'>> = {
    'not-found': 'neutral',
    conflict: 'warning',
    invalid: 'danger',
    unauthorized: 'danger',
    'not-supported': 'neutral',
    internal: 'danger',
    unreachable: 'warning',
  };

  const Icon = $derived(FAULT_ICON[treatment.kind]);
  const tone = $derived(FAULT_TONE[treatment.kind]);
  const advice = $derived(treatmentErrorStateAdvice(treatment, onRetry));
</script>

<div class="weft-fault-boundary" data-tone={tone} data-kind={treatment.kind}>
  <!-- Every kind is announced as an alert, as every fault was before it was drawn on `ErrorState`. -->
  <ErrorState
    variant="row"
    {tone}
    announce
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
    {@render children()}
  {/if}
</div>
