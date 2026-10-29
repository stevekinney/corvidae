<script lang="ts">
  /**
   * `/settings`: the Bureau's runtime settings, drawn from `bureau.settings.schema()` and edited
   * through `bureau.settings.update`. Which control a key gets is read from its schema shape
   * (`settings-controls.ts`), so a key the Bureau adds appears here with no change. Each key says
   * how it applies, live or at a restart, and which keys the deployment locked, which are shown and
   * cannot be edited. Below the form the host's own paths are shown, read-only: they are set by the
   * host and are not settings.
   *
   * The page subscribes to `bureau.settings.events` over Server-Sent Events (`settings-follower.ts`)
   * and reads the settings again on each event, so a change made elsewhere shows here as it
   * happens. It also reads them again when the window regains focus, which is how it catches up
   * when the stream is down.
   *
   * Owner scoping does not apply: the settings are deployment-wide, and the caller holds the scopes
   * that read and change them (`bureau.settings:read`, `:write`). Whether the Bureau is failing or
   * refusing is the view frame's to say (`app/view-probes.ts`).
   */
  import { Alert, Button } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';
  import { onMount } from 'svelte';

  import { RETRY_LABEL, SETTINGS_COPY, VIEW_COPY } from '../../app/copy.ts';
  import { getSettings, getSettingsSchema } from '../../lib/bureau-settings.ts';
  import { getHostPaths } from '../../lib/host-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import SettingsEditor from './settings-editor.svelte';
  import { SettingsFollower } from './settings-follower.ts';
  import { SettingsReader } from './settings-reader.ts';

  const schema = createQuery(
    () => ({
      queryKey: queryKeys.settings.schema(),
      queryFn: ({ signal }) => getSettingsSchema({ signal }),
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
    }),
    undefined,
  );

  const snapshot = createQuery(
    () => ({
      queryKey: queryKeys.settings.snapshot(),
      queryFn: ({ signal }) => getSettings({ signal }),
      retry: false,
    }),
    undefined,
  );

  // A refetch of a query that holds no data joins the fetch in flight, which may have read the
  // settings before the change; the reader reads again when the read it got is not known to be new
  // enough (`settings-reader.ts`).
  const reader = new SettingsReader({
    read: async () => {
      const joined = snapshot.isFetching && snapshot.data === undefined;
      const result = await snapshot.refetch();
      return result.isSuccess ? { revision: result.data.revision, fresh: !joined } : undefined;
    },
  });

  // A change made elsewhere reaches the page as an event; the settings are read again on each one,
  // and once the Bureau accepts the subscription, so none is missed in between.
  onMount(() => {
    const follower = new SettingsFollower({
      onChange: (revision) => void reader.notify(revision),
    });
    void follower.start();
    return () => follower.dispose();
  });

  const hostPaths = createQuery(
    () => ({
      queryKey: queryKeys.hostPaths(),
      queryFn: ({ signal }) => getHostPaths({ signal }),
      retry: false,
    }),
    undefined,
  );

  /** The words that name where the host keeps its state: a host that keeps it in a bucket says so. */
  const words = $derived(
    hostPaths.data?.mode === 'remote'
      ? { ...SETTINGS_COPY.hostPaths, ...SETTINGS_COPY.remote.hostPaths }
      : SETTINGS_COPY.hostPaths,
  );
</script>

<section class="weft-settings" aria-labelledby="weft-settings-title" data-page="settings">
  <header class="weft-settings__header">
    <h1 id="weft-settings-title" class="weft-settings__title">{VIEW_COPY.settings.label}</h1>
    <p class="weft-settings__intro">{SETTINGS_COPY.intro}</p>
  </header>

  <!-- A read that fails while the page holds the settings leaves the form as it is, edits and all. -->
  {#if (schema.isError && schema.data === undefined) || (snapshot.isError && snapshot.data === undefined)}
    <Alert variant="danger">
      <p class="weft-settings__alert-title">{VIEW_COPY.settings.error.title}</p>
      <p class="weft-settings__alert-body">{VIEW_COPY.settings.error.description}</p>
      <Button
        variant="secondary"
        size="sm"
        onclick={() => {
          void schema.refetch();
          void snapshot.refetch();
        }}>{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if schema.data === undefined || snapshot.data === undefined}
    <p role="status" aria-busy="true" class="weft-settings__muted">
      {VIEW_COPY.settings.loading.title}
    </p>
  {:else}
    {#if !snapshot.data.persisted}
      <Alert variant="info" data-testid="settings-not-persisted">
        <p class="weft-settings__alert-body">{SETTINGS_COPY.notPersisted}</p>
      </Alert>
    {/if}
    {#if snapshot.isError}
      <Alert variant="warning" data-testid="settings-refresh-failed">
        <p class="weft-settings__alert-title">{SETTINGS_COPY.refreshFailed.title}</p>
        <p class="weft-settings__alert-body">{SETTINGS_COPY.refreshFailed.description}</p>
      </Alert>
    {/if}
    <SettingsEditor schema={schema.data} snapshot={snapshot.data} />
  {/if}

  <section class="weft-settings__paths" aria-labelledby="weft-settings-paths-title">
    <h2 id="weft-settings-paths-title" class="weft-settings__paths-title">
      {words.title}
    </h2>
    <p class="weft-settings__muted">{SETTINGS_COPY.hostPaths.description}</p>
    {#if hostPaths.data !== undefined}
      <dl class="weft-settings__path-list">
        <dt>{words.agents}</dt>
        <dd><code>{hostPaths.data.agentDirectory}</code></dd>
        <dt>{words.workflows}</dt>
        <dd><code>{hostPaths.data.workflowDirectory}</code></dd>
        <dt>{words.configuration}</dt>
        <dd><code>{hostPaths.data.configurationFile}</code></dd>
        <dt>{words.providers}</dt>
        <dd>
          <ul class="weft-settings__path-providers">
            {#each hostPaths.data.providers as provider (provider.name)}
              <li><code>{provider.secretFile}</code></li>
            {/each}
          </ul>
        </dd>
      </dl>
    {:else if hostPaths.isError}
      <p class="weft-settings__muted">{SETTINGS_COPY.hostPaths.unavailable}</p>
    {/if}
  </section>
</section>

<style>
  .weft-settings {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
  }

  .weft-settings__title {
    margin: 0;
    font-size: var(--cinder-text-xl);
    font-weight: 600;
  }

  .weft-settings__intro,
  .weft-settings__muted {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .weft-settings__header {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
  }

  .weft-settings__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-settings__alert-body {
    margin: var(--cinder-space-1) 0 var(--cinder-space-2);
  }

  .weft-settings__paths {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    padding-top: var(--cinder-space-4);
    border-top: 1px solid var(--cinder-border-muted);
  }

  .weft-settings__paths-title {
    margin: 0;
    font-size: var(--cinder-text-lg);
    font-weight: 600;
  }

  .weft-settings__path-list {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--cinder-space-1) var(--cinder-space-4);
    margin: 0;
    font-size: var(--cinder-text-sm);
  }

  .weft-settings__path-list dt {
    color: var(--cinder-text-muted);
  }

  .weft-settings__path-list dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .weft-settings__path-providers {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  code {
    font-family: var(--cinder-font-mono);
  }

  @media (max-width: 40rem) {
    .weft-settings__path-list {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
