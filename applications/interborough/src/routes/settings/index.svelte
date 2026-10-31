<script lang="ts">
  /**
   * `/settings`: the Bureau's runtime settings other than the model policy, drawn from
   * `bureau.settings.schema()` and edited through `bureau.settings.update`
   * (`settings-frame.svelte`). Below the form the host's own paths are shown, read-only: they are
   * set by the host and are not settings.
   */
  import { createQuery } from '@tanstack/svelte-query';

  import { SETTINGS_COPY, VIEW_COPY } from '../../app/copy.ts';
  import { getHostPaths } from '../../lib/host-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import SettingsFrame from './settings-frame.svelte';

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

<SettingsFrame
  section="general"
  title={VIEW_COPY.settings.label}
  intro={SETTINGS_COPY.intro}
  page="settings"
>
  {#snippet after()}
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
  {/snippet}
</SettingsFrame>

<style>
  .weft-settings__muted {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
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
