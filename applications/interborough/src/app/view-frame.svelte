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
   * A view that has shown its data keeps showing it when the next request fails. It stays ready
   * and carries `data-stale`, which one rule in `foundation.css` dims, beside `data-stale-since`,
   * the time of the data on screen. The server not answering (`../app/connection.svelte.ts`) makes
   * every ready view stale, and the shell's banner says so; a server that answers with a fault
   * makes only this view stale, and the frame says what failed above the data, with no banner.
   * With nothing to keep, a request that got no answer replaces the view with the unreachable
   * page, and any other failure with the error.
   *
   * Only the frame writes the words for the non-ready states, and it reads them from `copy.ts`.
   * A view with no probe, such as one run's detail page, is ready unless its scopes are missing:
   * the page handles its own missing run.
   */
  import { untrack, type Snippet } from 'svelte';

  import { EmptyState, ErrorState, Skeleton } from '@lostgradient/cinder';
  import { Inbox } from '@lucide/svelte';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { getClient } from '../lib/client.ts';
  import { classifyFault, isNetworkFailure } from '../lib/faults.ts';
  import {
    AGENT_MEMORY_PATTERN,
    agentMemoryViewInstance,
    queryKeys,
    workflowViewInstance,
  } from '../lib/query.ts';
  import { router } from '../lib/router.svelte.ts';
  import { getPrincipalStore, scopeReason } from '../lib/scopes.svelte.ts';
  import { getConnection } from './connection.svelte.ts';
  import { CONNECTION_COPY, RETRY_LABEL, VIEW_COPY } from './copy.ts';
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

  const connection = getConnection();

  const bureauLive = useBureauEventsLive();
  const fleetLive = useFleetEventsLive();

  /**
   * What the probe's key names besides the view: the one thing the route opens, so two pages of one
   * view that ask different questions, or about different things, never share an answer.
   */
  function probeInstance(): string | null {
    const opened = initial.parameters;
    const agent = opened['agent'];
    if (agent !== undefined) {
      return initial.pattern === AGENT_MEMORY_PATTERN ? agentMemoryViewInstance(agent) : agent;
    }
    const item = opened['run'] ?? opened['schedule'] ?? opened['chat'];
    if (item !== undefined) return item;
    // A type's page, runs, and editor ask different questions about one type.
    const workflow = opened['workflow'];
    if (workflow !== undefined) return workflowViewInstance(initial.pattern ?? '', workflow);
    if (initial.pattern === '/chats/new') return `new:${initial.search.get('agent') ?? ''}`;
    // The sections of Settings that moved out of System ask the engine, not the Bureau.
    return initial.view === 'settings' &&
      initial.pattern !== undefined &&
      initial.pattern !== '/settings'
      ? initial.pattern
      : null;
  }

  const probeQuery = createQuery(() => {
    // Read here, not in the interval below, which TanStack calls on its own and so is not tracked.
    const live = { bureau: bureauLive(), fleet: fleetLive() };
    return {
      queryKey: queryKeys.view(initial.view, probeInstance()),
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

  const state = $derived.by<
    'loading' | 'empty' | 'error' | 'unreachable' | 'forbidden' | 'not-found' | 'ready'
  >(() => {
    if (scopeDenied) return 'forbidden';
    if (probe === undefined || creating) return 'ready';
    if (probeQuery.isError) {
      if (isForbiddenFault(probeQuery.error)) return 'forbidden';
      if (notFoundCopy !== undefined && isNotFoundFault(probeQuery.error)) return 'not-found';
      // What was shown last time stays shown: the view is stale, not failed.
      if (probeQuery.data !== undefined) return answerState(probeQuery.data);
      return isNetworkFailure(probeQuery.error) || connection.unreachable ? 'unreachable' : 'error';
    }
    if (probeQuery.isPending) return connection.unreachable ? 'unreachable' : 'loading';
    return answerState(probeQuery.data);
  });

  function answerState(answer: ViewProbeResult): 'empty' | 'ready' {
    return answer.empty && emptyCopy !== undefined ? 'empty' : 'ready';
  }

  /**
   * Whether what is on screen is older than it should be: the server is not answering, or this
   * view's own request failed after it had shown its data.
   */
  const refreshFailed = $derived(
    state !== 'unreachable' && probeQuery.isRefetchError && probeQuery.data !== undefined,
  );
  const stale = $derived(
    (state === 'ready' || state === 'empty') && (connection.unreachable || refreshFailed),
  );
  const staleSince = $derived(
    probeQuery.dataUpdatedAt > 0 ? probeQuery.dataUpdatedAt : connection.lastHealthyAt,
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

<div
  class="weft-view"
  data-view={initial.view}
  data-state={state}
  data-stale={stale ? 'true' : undefined}
  data-stale-since={stale ? new Date(staleSince).toISOString() : undefined}
>
  {#if state === 'ready'}
    {#if refreshFailed && !connection.unreachable}
      <ErrorState
        class="weft-view__refresh-error"
        variant="flat"
        title={errorCopy.title}
        description={errorCopy.description}
        headingLevel={2}
        retryLabel={RETRY_LABEL}
        onRetry={() => void probeQuery.refetch()}
      />
    {/if}
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
      kind="first-use"
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
    <ErrorState
      variant="flat"
      title={notFoundCopy.title}
      description={notFoundCopy.description}
      headingLevel={1}
    />
  {:else if state === 'error'}
    <ErrorState
      variant="flat"
      title={errorCopy.title}
      description={errorCopy.description}
      headingLevel={1}
      retryLabel={RETRY_LABEL}
      onRetry={() => void probeQuery.refetch()}
    />
  {:else if state === 'unreachable'}
    <ErrorState
      variant="flat"
      title={CONNECTION_COPY.page.title}
      description={CONNECTION_COPY.page.description}
      headingLevel={1}
      retryLabel={RETRY_LABEL}
      onRetry={() => void probeQuery.refetch()}
    />
  {:else}
    <ErrorState
      variant="flat"
      title={forbiddenTitle}
      description={forbiddenDescription}
      headingLevel={1}
    />
  {/if}
</div>
