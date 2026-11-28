<script lang="ts">
  /**
   * One classified fault on a Cinder `ErrorState` row, for every surface that shows a fault inline
   * (`fault-boundary.svelte` and the three `query-fault-banner.svelte` components): the treatment's
   * title as the heading, its message as the description, the fault's `remediation` as its own line
   * under the description, and Retry only when the fault is not `retryable: false`
   * (`treatmentErrorStateAdvice`, `lib/faults.ts`). A treatment that names no failure of the
   * request itself (`not-found`, `not-supported`) is Cinder's neutral tone, `conflict` and
   * `unreachable` its warning tone, the rest its danger tone. Every kind is announced as an alert
   * (`announce`). The row is `bordered`, Cinder's quiet hairline in the tone's border token. A
   * fault Health can explain (`internal`, `unreachable`) also gets the "Open Health" action the
   * page-level failed states offer, so a fault that cannot be retried still has a way forward.
   * `children` carries what only some treatments add (a note, the field errors, a stack trace),
   * drawn under the row.
   */
  import type { Snippet } from 'svelte';

  import { Button, ErrorState } from '@lostgradient/cinder';
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
    faultTitle,
    treatmentErrorStateAdvice,
    type FaultTreatment,
    type FaultTreatmentKind,
  } from '../lib/faults.ts';
  import { router } from '../lib/router.svelte.ts';
  import { HEALTH_PATH, OPEN_HEALTH_LABEL, RETRY_LABEL } from './copy/views.ts';

  interface FaultErrorStateProps {
    readonly treatment: FaultTreatment;
    /**
     * What failed to load, in the words of "Couldn’t load ___": the title every screen gives the
     * same fault (`faultTitle`). Left out where the screen does not know, such as the fault boundary.
     */
    readonly subject?: string | undefined;
    /**
     * Whether Open Health can help: `false` for a fault that says nothing about the server, such as
     * a bug the fault boundary caught while rendering. Health's own pages never offer it.
     * @default true
     */
    readonly offerHealth?: boolean | undefined;
    /**
     * Whether the row draws its hairline box. Left off where a box already surrounds it, such as an
     * Alert, so the row does not draw a box inside a box.
     * @default true
     */
    readonly bordered?: boolean | undefined;
    /** What Retry does; the row offers it only when the fault can be retried. */
    readonly onRetry?: (() => void) | undefined;
    /** Extra detail for the treatment, drawn under the row. */
    readonly children?: Snippet | undefined;
  }

  let {
    treatment,
    subject,
    offerHealth = true,
    bordered = true,
    onRetry,
    children,
  }: FaultErrorStateProps = $props();

  /** The address of Health or any page under it. */
  const HEALTH_PAGE = /^\/health(?:\/|$)/;

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

  /**
   * The kinds Health can explain: the server answered with an error or did not answer, so the way
   * forward when Retry is not offered (or does not help) is the page that says which part stopped,
   * as the page-level failed states (the Hooks list) offer.
   */
  const healthExplains = $derived(
    offerHealth &&
      (treatment.kind === 'internal' || treatment.kind === 'unreachable') &&
      // Health's own pages (System, Workers, Storage and the rest) are where that page leads.
      !HEALTH_PAGE.test(router.pathname),
  );

  const Icon = $derived(FAULT_ICON[treatment.kind]);
  const tone = $derived(FAULT_TONE[treatment.kind]);
  const advice = $derived(treatmentErrorStateAdvice(treatment, onRetry));
</script>

{#snippet openHealth()}
  <Button variant="secondary" href={router.href(HEALTH_PATH)} label={OPEN_HEALTH_LABEL} />
{/snippet}

<!-- Every kind is announced as an alert, as every fault was before it was drawn on `ErrorState`. -->
<ErrorState
  variant="row"
  {bordered}
  {tone}
  announce
  title={faultTitle(treatment.kind, subject)}
  description={treatment.message}
  headingLevel={2}
  retryLabel={RETRY_LABEL}
  data-fault-kind={treatment.kind}
  {...advice}
  {...healthExplains ? { secondaryAction: openHealth } : {}}
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
