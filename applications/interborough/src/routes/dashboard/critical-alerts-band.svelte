<script lang="ts">
  /**
   * Critical-alerts band (plan §9.1, this track's brief): diagnostic chips
   * (`GET /api/v1/tasks/diagnostics`, scope `system:read`) + reviews-near-
   * timeout (`listReviews`, scope `reviews:read`), each deep-linking. See
   * `./critical-alerts.ts`'s module doc for why a "lease contested" chip is
   * intentionally omitted (COR-124 admits only worker-diagnostics and
   * task-detail lease fields; engine lease health is on System → Health).
   *
   * Scope gating (plan §6): the principal store optimistically grants every
   * scope until a real `403` is observed, so both queries fire on mount;
   * a `403` degrades the principal (`denyScope`) rather than surfacing as a
   * generic fault, and `enabled` re-checks `hasScope` so a known-denied
   * scope stops refetching. Missing-scope sections render a lock notice
   * (disable-with-reason for VIEWING, plan §6/§10) rather than hiding.
   */
  import type { HttpClient, PendingReviewEntry, ReviewListEntry } from '@lostgradient/weft';

  import { Lock } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { useFleetEventsLive } from '../../app/live-polling.svelte.ts';
  import { getClient } from '../../lib/client.ts';
  import { getPrincipalStore, isForbidden, scopeReason } from '../../lib/scopes.svelte.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import {
    buildDiagnosticChips,
    buildReviewsNearTimeoutChip,
    type AlertChip,
  } from './critical-alerts.ts';
  import { TASK_HEARTBEAT_STALE_AFTER_MS } from '../workers/worker-catalog-types.ts';

  const client = getClient();
  const principal = getPrincipalStore();

  const DIAGNOSTICS_POLL_INTERVAL_MS = 30_000;

  /**
   * `weft.tasks.diagnostics`'s generated operation-client input type requires
   * these fields even though the server's zod schema defaults them
   * (`weft/src/server/operations/get-task-diagnostics.ts`'s
   * `DEFAULT_STALE_QUEUED_AFTER_MS`/etc.) — the generated type is derived
   * from the schema's post-default output shape, not its optional input
   * shape. Passed explicitly here, matching the server defaults verbatim, so
   * this call means exactly what an empty `{}` means server-side. The
   * heartbeat threshold is the Workers route's, so a stale-inflight chip and
   * the Workers diagnostics it links to cannot disagree.
   */
  const DIAGNOSTICS_DEFAULT_INPUT = {
    staleQueuedAfterMs: 60_000,
    staleHeartbeatAfterMs: TASK_HEARTBEAT_STALE_AFTER_MS,
    retryStormMinimumAttempts: 3,
    includeExpectedDelayed: true,
    unadoptedAfterMs: 60_000,
    limit: 50,
  } as const;

  /**
   * `listReviews({ status: 'pending' })` filters server-side, but its
   * return type is the general `ReviewListEntry[]` union (weft's typed
   * client can't narrow a return type by an argument value) — narrow with a
   * real type guard rather than an `as` cast so a wire-shape drift would
   * surface as an empty result, not a silently-wrong assertion.
   */
  function isPendingReview(entry: ReviewListEntry): entry is PendingReviewEntry {
    return entry.status === 'pending';
  }

  const canReadSystem = $derived(principal.hasScope('system:read'));
  const canReadReviews = $derived(principal.hasScope('reviews:read'));

  const diagnosticsQuery = createQuery(() => ({
    queryKey: queryKeys.diagnostics(),
    queryFn: (): ReturnType<HttpClient['operations']['weft.tasks.diagnostics']> =>
      client.operations['weft.tasks.diagnostics'](DIAGNOSTICS_DEFAULT_INPUT),
    enabled: canReadSystem,
    // A task turns stale by the clock (queued too long, no heartbeat), which no event announces; a
    // dead letter asks again at once (`../../app/task-event-queries.ts`).
    // poll-reason: time-derived
    refetchInterval: DIAGNOSTICS_POLL_INTERVAL_MS,
  }));

  // `human-review:requested` and `human-review:completed`, and a run that ends with reviews open,
  // ask for the pending reviews again; the timer runs only while the fleet feed is not live.
  const fleetLive = useFleetEventsLive();
  const reviewsQuery = createQuery(() => {
    // Read here, not in the interval, which TanStack Query reads untracked.
    const polling = !fleetLive();
    return {
      queryKey: queryKeys.reviews.list({ status: 'pending' }),
      queryFn: () => client.listReviews({ status: 'pending' }),
      enabled: canReadReviews,
      // poll-reason: fallback
      refetchInterval: polling ? DIAGNOSTICS_POLL_INTERVAL_MS : false,
    };
  });

  /**
   * `canReadSystem`/`canReadReviews` guards below are load-bearing, not a
   * redundant check: `PrincipalStore.denyScope()` unconditionally writes a
   * NEW `principal` object even when the scope was already absent (it
   * filters the scopes array without checking whether anything changed
   * first — `src/lib/scopes.svelte.ts`, frozen). Reading `this.principal`
   * inside `denyScope()` while INSIDE this `$effect` (via the synchronous
   * nested call) registers that read as one of the effect's own
   * dependencies, so an unconditional call here would write the exact
   * state the effect depends on on every run — an infinite
   * `effect_update_depth_exceeded` loop as long as the query keeps
   * reporting the same 403 (verified empirically: a scripted standing 403
   * route reproduces this every time without the guard). Checking
   * `canReadSystem`/`canReadReviews` first means the SECOND run of the
   * effect (triggered by the first `denyScope()` call) short-circuits
   * before touching `principal` again, so the loop terminates after
   * exactly one real write.
   */
  $effect(() => {
    if (canReadSystem && diagnosticsQuery.error && isForbidden(diagnosticsQuery.error)) {
      principal.denyScope('system:read');
    }
  });

  $effect(() => {
    if (canReadReviews && reviewsQuery.error && isForbidden(reviewsQuery.error)) {
      principal.denyScope('reviews:read');
    }
  });

  const chips = $derived.by((): AlertChip[] => {
    const list: AlertChip[] = [];
    if (diagnosticsQuery.data)
      list.push(
        ...buildDiagnosticChips(diagnosticsQuery.data.summary, diagnosticsQuery.data.items),
      );
    if (reviewsQuery.data) {
      const pending = reviewsQuery.data.filter(isPendingReview);
      const reviewsChip = buildReviewsNearTimeoutChip(pending, Date.now());
      if (reviewsChip) list.push(reviewsChip);
    }
    return list;
  });

  // Read both query states before deciding whether either is pending. A
  // single logical OR can skip the reviews state while diagnostics is
  // pending, leaving it out of this derived value's dependency set.
  const isLoading = $derived.by(() => {
    const diagnosticsPending = canReadSystem && diagnosticsQuery.isPending;
    const reviewsPending = canReadReviews && reviewsQuery.isPending;
    return diagnosticsPending || reviewsPending;
  });

  const bothScopesDenied = $derived(!canReadSystem && !canReadReviews);

  /** One scope denied, the other granted — show a partial lock note alongside whatever chips the granted scope produced. */
  const deniedScope = $derived.by((): 'system:read' | 'reviews:read' | null => {
    if (!canReadSystem && canReadReviews) return 'system:read';
    if (canReadSystem && !canReadReviews) return 'reviews:read';
    return null;
  });

  const hasVisibleContent = $derived(chips.length > 0 || deniedScope !== null);
</script>

{#if bothScopesDenied}
  <div class="weft-critical-alerts-band__lock">
    <Lock aria-hidden="true" size={15} />
    <span>{scopeReason('system:read', 'reviews:read')} to see critical alerts here.</span>
  </div>
{:else if isLoading}
  <div
    class="weft-critical-alerts-band__skeleton"
    role="status"
    aria-busy="true"
    aria-label="Loading alerts"
  >
    <div class="weft-alert-chip-skeleton"></div>
    <div class="weft-alert-chip-skeleton"></div>
    <div class="weft-alert-chip-skeleton"></div>
  </div>
{:else if hasVisibleContent}
  <div class="weft-critical-alerts-band">
    {#each chips as chip (chip.id)}
      <a
        href={router.href(chip.href)}
        class="weft-alert-chip"
        data-tone={chip.tone}
        onclick={(event) => {
          event.preventDefault();
          router.navigate(chip.href);
        }}
      >
        <span class="weft-alert-chip__label">{chip.label}</span>
      </a>
      {#if chip.workflow}
        {@const workflowHref = chip.workflow.href}
        <a
          href={router.href(workflowHref)}
          class="weft-alert-chip weft-alert-chip--workflow"
          data-tone={chip.tone}
          aria-label={`Open workflow ${chip.workflow.id}`}
          onclick={(event) => {
            event.preventDefault();
            router.navigate(workflowHref);
          }}
        >
          <span class="weft-alert-chip__label">Open workflow</span>
        </a>
      {/if}
    {/each}
    {#if deniedScope}
      <span class="weft-critical-alerts-band__partial-lock">
        <Lock aria-hidden="true" size={13} />
        {scopeReason(deniedScope)}
      </span>
    {/if}
  </div>
{/if}
