<script lang="ts">
  /**
   * What the Workers page is while it has no worker to list: being read (rows 78x and 78y), read
   * and empty because work runs inside Interborough (rows 78c to 78e), or not read at all (row
   * 78z). Loading and failed keep the page's own heading (`workers-heading.svelte`); the empty
   * state is Cinder's `empty-state` alone, since a heading over it would say the same thing.
   * The bodies are Cinder: `skeleton`, `empty-state` and `error-state`.
   * None of them draws a worker row, a status word, or a banner.
   */
  import { EmptyState, ErrorState, Skeleton } from '@lostgradient/cinder';
  import { Cpu } from '@lucide/svelte';

  import { faultErrorStateAdvice } from '../../lib/faults.ts';
  import { WORKER_COPY } from './worker-copy.ts';
  import WorkersHeading from './workers-heading.svelte';
  import { workersLoadFailure, type WorkersStateKind } from './workers-states.ts';

  interface Props {
    /** Which state the page is in. */
    readonly kind: WorkersStateKind;
    /** What the read failed with, for the failed state's sentence. */
    readonly error?: unknown;
    /** Called when "Cancel" is pressed in the loading state's "Still loading" line. */
    readonly onCancel: () => void;
    /** Called when "Try again" is pressed in the failed state. */
    readonly onRetry: () => void;
  }

  let { kind, error, onCancel, onRetry }: Props = $props();

  const copy = WORKER_COPY.states;
  const failure = $derived(workersLoadFailure(error, kind === 'cancelled'));
</script>

<section
  class="ib-workers-state"
  data-testid="workers-state"
  data-state={kind}
  aria-label={copy.regionLabel}
  aria-busy={kind === 'loading' ? 'true' : undefined}
>
  {#if kind === 'loading'}
    <WorkersHeading line={copy.loadingLine} lineTestId="workers-loading-line" />
    <Skeleton
      variant="list"
      rows={4}
      statusMarker="dot"
      statusColumn={false}
      delay={copy.loadingDelayMilliseconds}
      stillLoadingAfter={copy.stillLoadingMilliseconds}
      {onCancel}
    />
  {:else if kind === 'empty'}
    <!-- The state alone: no "Workers" heading whose line says the same thing (owner report,
    2026-11-19), in Cinder's one empty-state layout, never in a box. -->
    <EmptyState
      kind="first-use"
      headingLevel={2}
      title={copy.empty.title}
      description={copy.empty.description}
      actions={[{ label: copy.empty.howToConnect, href: copy.empty.guideAddress, external: true }]}
    >
      {#snippet icon()}<Cpu />{/snippet}
    </EmptyState>
  {:else}
    <WorkersHeading />
    <ErrorState
      bordered
      headingLevel={3}
      tone={kind === 'cancelled' ? 'neutral' : 'danger'}
      title={failure.title}
      description={failure.description}
      retryLabel={copy.failed.tryAgain}
      {...kind === 'cancelled' ? { onRetry } : faultErrorStateAdvice(error, onRetry)}
    />
  {/if}
</section>

<style>
  .ib-workers-state {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
  }
</style>
