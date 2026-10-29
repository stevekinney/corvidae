<script lang="ts">
  /**
   * The frame every view renders in. A view is loading, empty, failing, forbidden, or showing its
   * content, and the frame says which in one `data-state` attribute on its root, beside a
   * `data-view` naming the view, so a test, a screen reader's tooling, and a stylesheet can all
   * ask the same question.
   *
   * The state comes from two places. The principal decides first: a view whose scopes the
   * principal lacks is forbidden without asking the server anything. Otherwise the view's probe
   * (`view-probes.ts`) makes the one request that settles it, and its answer is loading while it
   * is pending, forbidden when the server says 403, an error for any other failure, empty when
   * the view lists nothing, and ready otherwise. A 403 also tells the principal store the scope is
   * gone, as every other 403 in the application does.
   *
   * Only the frame writes the words for the non-ready states, and it reads them from `copy.ts`.
   * A view with no probe, such as one run's detail page, is ready unless its scopes are missing:
   * the page handles its own missing run.
   */
  import { untrack, type Snippet } from 'svelte';

  import { EmptyState, ErrorState, Skeleton } from '@lostgradient/cinder';
  import { Inbox, Lock, SearchX } from '@lucide/svelte';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { getClient } from '../lib/client.ts';
  import { classifyFault } from '../lib/faults.ts';
  import {
    AGENT_MEMORY_PATTERN,
    agentMemoryViewInstance,
    queryKeys,
    workflowViewInstance,
  } from '../lib/query.ts';
  import { router } from '../lib/router.svelte.ts';
  import { getPrincipalStore, scopeReason } from '../lib/scopes.svelte.ts';
  import { RETRY_LABEL, VIEW_COPY } from './copy.ts';
  import { useBureauEventsLive, useFleetEventsLive } from './live-polling.svelte.ts';
  import WelcomeAgents from './welcome-agents.svelte';
  import { probeFor, ViewProbeFault, type ViewProbeResult } from './view-probes.ts';
  import { VIEWS, type ViewName } from './views.ts';

  interface ViewFrameProps {
    view: ViewName;
    /** The matched route's pattern, for a view whose routes ask different questions. */
    pattern?: string | undefined;
    /** The matched route's parameters, such as the run `id`. */
    parameters?: Readonly<Record<string, string>>;
    children: Snippet;
  }

  let { view, parameters = {}, pattern, children }: ViewFrameProps = $props();

  const client = getClient();
  const queryClient = useQueryClient();
  const principalStore = getPrincipalStore();

  // A frame belongs to one route: the outlet mounts a new one when the path changes, so the
  // view and its parameters are read once.
  const initial = untrack(() => ({
    view,
    parameters,
    pattern,
    search: new URLSearchParams(router.current.search),
  }));
  const copy = VIEW_COPY[initial.view];
  const notFoundCopy = copy.notFoundByPattern?.[initial.pattern ?? ''] ?? copy.notFound;
  const emptyCopy = copy.emptyByPattern?.[initial.pattern ?? ''] ?? copy.empty;
  const loadingCopy = copy.loadingByPattern?.[initial.pattern ?? ''] ?? copy.loading;
  const errorCopy = copy.errorByPattern?.[initial.pattern ?? ''] ?? copy.error;
  const forbiddenCopy = copy.forbiddenByPattern?.[initial.pattern ?? ''];
  const definition = VIEWS[initial.view];
  const probe = probeFor(initial.view, initial.parameters, initial.pattern, initial.search);

  const scopeDenied = $derived(!principalStore.hasScope(...definition.scopes));

  // The location can be the view's way of creating its first item (`views.ts`, `creating`).
  const creating = $derived(definition.creating?.(router.current.search) ?? false);

  const bureauLive = useBureauEventsLive();
  const fleetLive = useFleetEventsLive();

  const probeQuery = createQuery(() => {
    // Read here, not in the interval below, which TanStack calls on its own and so is not tracked.
    const live = { bureau: bureauLive(), fleet: fleetLive() };
    return {
      queryKey: queryKeys.view(
        initial.view,
        (initial.pattern === AGENT_MEMORY_PATTERN && initial.parameters['id'] !== undefined
          ? agentMemoryViewInstance(initial.parameters['id'])
          : initial.parameters['id']) ??
          initial.parameters['sessionId'] ??
          // A type's page, runs, and editor ask different questions about one type.
          (initial.parameters['type'] === undefined
            ? null
            : workflowViewInstance(initial.pattern ?? '', initial.parameters['type'])) ??
          (initial.pattern === '/chat/new' ? `new:${initial.search.get('agent') ?? ''}` : null),
      ),
      queryFn: () => (probe ? probe(client, queryClient) : Promise.resolve({ empty: false })),
      enabled: probe !== undefined && !scopeDenied,
      retry: false,
      staleTime: 5_000,
      // A probe that expects its empty answer to change is asked again when the feed it names
      // reports the change, and, while that feed is not live, on a timer until there is something to
      // show.
      // poll-reason: fallback
      refetchInterval: (query: { state: { data: ViewProbeResult | undefined } }) => {
        const answer = query.state.data;
        if (!answer?.empty) return false;
        if (answer.liveSource !== undefined && live[answer.liveSource]) return false;
        return answer.recheckMs ?? false;
      },
      // A probe nobody is watching is dropped, so coming back to the view asks again and never
      // shows what it found last time.
      gcTime: 0,
    };
  }, undefined);

  function isForbiddenFault(error: unknown): boolean {
    if (error instanceof ViewProbeFault) return error.status === 403;
    const treatment = classifyFault(error);
    return treatment?.kind === 'unauthorized' && treatment.mode === 'forbidden';
  }

  function isNotFoundFault(error: unknown): boolean {
    if (error instanceof ViewProbeFault) return error.status === 404;
    return classifyFault(error)?.kind === 'not-found';
  }

  const state = $derived.by<'loading' | 'empty' | 'error' | 'forbidden' | 'not-found' | 'ready'>(
    () => {
      if (scopeDenied) return 'forbidden';
      if (probe === undefined || creating) return 'ready';
      if (probeQuery.isError) {
        if (isForbiddenFault(probeQuery.error)) return 'forbidden';
        return notFoundCopy !== undefined && isNotFoundFault(probeQuery.error)
          ? 'not-found'
          : 'error';
      }
      if (probeQuery.isPending) return 'loading';
      return probeQuery.data.empty && emptyCopy !== undefined ? 'empty' : 'ready';
    },
  );

  $effect(() => {
    if (!probeQuery.isError || !isForbiddenFault(probeQuery.error)) return;
    // `denyScope()` reads and rewrites the principal, which this effect would otherwise depend on.
    untrack(() => {
      if (definition.scopes.length > 0 && principalStore.hasScope(...definition.scopes)) {
        principalStore.denyScope(...definition.scopes);
      }
    });
  });

  // Leaving the creation flow (saving, or closing it) is when the probe's answer goes stale: the
  // first item may exist now.
  let wasCreating = false;
  $effect(() => {
    const now = creating;
    if (wasCreating && !now && probe !== undefined) void probeQuery.refetch();
    wasCreating = now;
  });

  const forbiddenDescription = $derived(
    forbiddenCopy !== undefined
      ? forbiddenCopy.description
      : definition.scopes.length > 0
        ? scopeReason(...definition.scopes)
        : 'This view is not available to the current principal.',
  );
  const forbiddenTitle = $derived(forbiddenCopy?.title ?? copy.forbidden.title);

  function navigateTo(event: MouseEvent, href: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    router.navigate(href);
  }
</script>

<div class="weft-view" data-view={initial.view} data-state={state}>
  {#if state === 'ready'}
    {@render children()}
  {:else if state === 'loading'}
    <div class="weft-view__loading" role="status" aria-busy="true">
      <h1 class="weft-view__loading-title">{loadingCopy.title}</h1>
      <p class="weft-view__loading-description">{loadingCopy.description}</p>
      <Skeleton height="1.5rem" width="40%" />
      <Skeleton height="10rem" />
    </div>
  {:else if state === 'empty' && emptyCopy}
    <EmptyState
      class="weft-view__empty"
      title={emptyCopy.title}
      description={emptyCopy.description}
      headingLevel={1}
    >
      {#snippet icon()}<Inbox size={28} aria-hidden="true" />{/snippet}
      {#snippet action()}
        {#if emptyCopy.action}
          {@const emptyAction = emptyCopy.action}
          <a
            class="weft-view__action"
            href={router.href(emptyAction.href)}
            onclick={(event) => navigateTo(event, emptyAction.href)}>{emptyAction.label}</a
          >
        {/if}
        {#if initial.view === 'chat'}
          <WelcomeAgents />
        {/if}
      {/snippet}
    </EmptyState>
  {:else if state === 'not-found' && notFoundCopy}
    <EmptyState
      class="weft-view__empty"
      title={notFoundCopy.title}
      description={notFoundCopy.description}
      headingLevel={1}
    >
      {#snippet icon()}<SearchX size={28} aria-hidden="true" />{/snippet}
    </EmptyState>
  {:else if state === 'error'}
    <ErrorState
      variant="flat"
      title={errorCopy.title}
      description={errorCopy.description}
      headingLevel={1}
      retryLabel={RETRY_LABEL}
      onRetry={() => void probeQuery.refetch()}
    />
  {:else}
    <EmptyState
      class="weft-view__empty"
      title={forbiddenTitle}
      description={forbiddenDescription}
      headingLevel={1}
    >
      {#snippet icon()}<Lock size={28} aria-hidden="true" />{/snippet}
    </EmptyState>
  {/if}
</div>
