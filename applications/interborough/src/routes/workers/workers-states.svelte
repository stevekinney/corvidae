<script lang="ts">
  /**
   * What the Workers page is while it has no worker to list: being read (rows 78x and 78y), read
   * and empty because work runs inside Interborough (rows 78c to 78e), or not read at all (row
   * 78z). Each keeps the page's own heading (`workers-heading.svelte`) and draws its body with
   * Cinder: `skeleton` for the first, `empty-state` for the second, `error-state` for the third.
   * None of them draws a worker row, a status word, or a banner.
   */
  import { Button, EmptyState, ErrorState, Skeleton } from '@lostgradient/cinder';
  import { Cpu, ExternalLink } from '@lucide/svelte';

  import { router } from '../../lib/router.svelte.ts';
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
    <WorkersHeading line={copy.empty.summary} />
    <div class="ib-workers-state__card">
      <EmptyState
        kind="first-use"
        bordered
        headingLevel={3}
        title={copy.empty.title}
        description={copy.empty.description}
      >
        {#snippet icon()}<Cpu />{/snippet}
        {#snippet action()}
          <Button
            variant="secondary"
            href={copy.empty.guideAddress}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink aria-hidden="true" size={14} />
            {copy.empty.howToConnect}
          </Button>
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    <WorkersHeading />
    <ErrorState
      bordered
      headingLevel={3}
      tone={kind === 'cancelled' ? 'neutral' : 'danger'}
      title={failure.title}
      description={failure.description}
      retryLabel={copy.failed.tryAgain}
      retryVariant="secondary"
      {onRetry}
    >
      {#snippet secondaryAction()}
        <Button variant="link" href={router.href(copy.failed.openHealthPath)}
          >{copy.failed.openHealth}</Button
        >
      {/snippet}
    </ErrorState>
  {/if}
</section>

<style>
  .ib-workers-state {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
  }

  .ib-workers-state__card {
    max-inline-size: 48rem;
  }
</style>
