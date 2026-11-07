<script lang="ts">
  /**
   * The Your scopes tab (board PageSettingsSections, "API reference · Your scopes"): what this
   * session may do through Interborough's API. Interborough is single-user for now, so these are
   * the scopes of the person at the keyboard, and the page's own boards act with them. The host
   * says which scopes the session holds (`/host/session`), because the host is what checks them on
   * every `/api` operation; each is a small monospaced name with what it lets the session do, from
   * the one catalog the host enforces (`lib/api-scopes.ts`). A forbidden page links here
   * (`app/copy.ts`, `scopes`).
   */
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { API_REFERENCE_COPY } from '../../../app/copy.ts';
  import { API_SCOPE_CATALOG } from '../../../lib/api-scopes.ts';
  import { getHostSession } from '../../../lib/host-session.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { failureStatusOf } from './failure-status.ts';
  import LoadState from './load-state.svelte';

  const queryClient = useQueryClient();
  const copy = API_REFERENCE_COPY.scopes;

  const session = createQuery(
    () => ({
      queryKey: queryKeys.hostSession(),
      queryFn: ({ signal }) => getHostSession({ signal }),
      // A failure is shown with Try again, not retried behind the person's back.
      retry: false,
    }),
    undefined,
  );

  let canceled = $state(false);

  const granted = $derived.by(() => {
    const held = new Set(session.data?.scopes ?? []);
    return API_SCOPE_CATALOG.filter((entry) => held.has(entry.scope));
  });

  function cancelLoading(): void {
    canceled = true;
    void queryClient.cancelQueries({ queryKey: queryKeys.hostSession() });
  }

  function tryAgain(): void {
    canceled = false;
    void session.refetch();
  }
</script>

<div class="ib-scopes" data-testid="api-scopes">
  <p class="ib-scopes__intro">{copy.intro}</p>
  {#if session.data === undefined}
    <LoadState
      kind={session.isError ? 'error' : canceled ? 'canceled' : 'loading'}
      status={failureStatusOf(session.error)}
      onCancel={cancelLoading}
      onRetry={tryAgain}
    />
  {:else if granted.length === 0}
    <p class="ib-scopes__muted">{copy.none}</p>
  {:else}
    <ul class="ib-scopes__list" aria-label={copy.listLabel}>
      {#each granted as entry (entry.scope)}
        <li data-scope={entry.scope}>
          <code class="ib-scopes__name">{entry.scope}</code>
          <span>{entry.description}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .ib-scopes {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-inline-size: 0;
  }

  .ib-scopes__intro,
  .ib-scopes__muted {
    margin: 0;
    font-size: var(--cinder-text-sm);
  }

  .ib-scopes__muted {
    color: var(--cinder-text-muted);
  }

  .ib-scopes__list {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
  }

  .ib-scopes__list > li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-3);
    align-items: baseline;
    padding: var(--cinder-space-2) var(--cinder-space-3);
    font-size: var(--cinder-text-sm);
  }

  .ib-scopes__list > li + li {
    border-block-start: 1px solid var(--cinder-border-muted);
  }

  .ib-scopes__name {
    font-size: var(--cinder-text-xs);
  }
</style>
