<script lang="ts">
  /**
   * The Providers part of Settings › Models: each provider the host can call, with a Connected dot
   * and Manage once it has a key, or only Connect while it does not, and a way to read the
   * configuration file again for a person who edited it by hand. A host that keeps its
   * configuration in its deployment cannot save a key, and says so.
   */
  import { Alert, Button, StatusDot } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { MODELS_COPY } from '../../../app/copy.ts';
  import { showToast } from '../../../app/toast-host.svelte';
  import { getPlugins } from '../../../lib/host-plugins.ts';
  import { reloadProviders, type ProvidersSnapshot } from '../../../lib/host-providers.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import ConnectDialog from './connect-dialog.svelte';
  import { providerDisplayName } from './format-model.ts';

  interface Props {
    snapshot: ProvidersSnapshot;
    /** The provider whose dialog is open, or `null`. The page binds it so the empty Models list can open one too. */
    connecting: string | null;
  }

  let { snapshot, connecting = $bindable() }: Props = $props();

  const copy = MODELS_COPY.providers;
  const queryClient = useQueryClient();

  let reloading = $state(false);

  // A provider is a plugin too (`plugins/anthropic`, `openai`, `gemini`): one that is waiting for
  // its key is `needs-setup` there. A page that cannot read the plugins says nothing about them.
  const plugins = createQuery(
    () => ({
      queryKey: queryKeys.hostPlugins(),
      queryFn: ({ signal }) => getPlugins({ signal }),
      retry: false,
    }),
    undefined,
  );
  const needingSetup = $derived(
    new Set(
      (plugins.data?.plugins ?? [])
        .filter((plugin) => plugin.status === 'needs-setup')
        .map((plugin) => plugin.descriptor.name),
    ),
  );

  function pluginPath(provider: string): string {
    return `/settings/plugins?plugin=${encodeURIComponent(provider)}`;
  }

  function openPlugin(event: MouseEvent, provider: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(pluginPath(provider));
  }

  const locked = $derived(snapshot.lockReason !== undefined);
  const connectingStatus = $derived(snapshot.providers.find((entry) => entry.name === connecting));

  function nameOf(provider: string): string {
    return providerDisplayName(provider);
  }

  function modelCount(provider: string): number {
    return snapshot.models.filter((row) => row.provider === provider).length;
  }

  async function reload(): Promise<void> {
    if (reloading) return;
    reloading = true;
    try {
      await reloadProviders();
      showToast(copy.reloaded, { variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.hostProviders() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.catalog() });
    } catch {
      showToast(copy.reloadFailed, { variant: 'danger' });
    } finally {
      reloading = false;
    }
  }
</script>

<section class="ib-providers" aria-labelledby="models-providers-title" data-section="providers">
  <div class="ib-providers__title-row">
    <h2 id="models-providers-title" class="ib-providers__title">{copy.heading}</h2>
    <Button
      data-changes
      variant="secondary"
      size="sm"
      disabled={reloading}
      onclick={() => void reload()}>{copy.reload}</Button
    >
  </div>
  <p class="ib-providers__description">{copy.description}</p>

  {#if locked}
    <Alert variant="info" data-testid="providers-locked">
      <p class="ib-providers__alert">{MODELS_COPY.locked}</p>
    </Alert>
  {/if}

  <ul class="ib-providers__list" aria-label={copy.listLabel}>
    {#each snapshot.providers as provider (provider.name)}
      <li class="ib-providers__row" data-provider={provider.name}>
        <span class="ib-providers__name">{nameOf(provider.name)}</span>
        {#if provider.hasKey}
          <StatusDot status="success" label={copy.connected} />
          <span class="ib-providers__count">{copy.modelCount(modelCount(provider.name))}</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={locked}
            aria-label={copy.manageLabel(nameOf(provider.name))}
            onclick={() => (connecting = provider.name)}>{copy.manage}</Button
          >
        {:else}
          {#if needingSetup.has(provider.name)}
            <StatusDot status="warning" label={copy.needsSetup} labelVisible />
            <a
              class="ib-providers__plugin"
              href={router.href(pluginPath(provider.name))}
              onclick={(event) => openPlugin(event, provider.name)}
              >{copy.pluginLink(nameOf(provider.name))}</a
            >
          {/if}
          <Button
            variant="primary"
            size="sm"
            disabled={locked}
            aria-label={copy.connectLabel(nameOf(provider.name))}
            onclick={() => (connecting = provider.name)}>{copy.connect}</Button
          >
        {/if}
      </li>
    {/each}
  </ul>
</section>

<ConnectDialog bind:provider={connecting} connected={connectingStatus?.hasKey === true} />

<style>
  .ib-providers {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-providers__title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-2);
    padding-bottom: var(--cinder-space-2);
    border-bottom: 1px solid var(--cinder-border-muted);
  }

  .ib-providers__title {
    margin: 0;
    font-size: var(--cinder-text-lg);
    font-weight: 600;
  }

  .ib-providers__description,
  .ib-providers__alert {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-providers__list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ib-providers__row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-3);
    padding: var(--cinder-space-2) 0;
    border-bottom: 1px solid var(--cinder-border-muted);
  }

  .ib-providers__name {
    flex: 1 1 8rem;
    min-width: 0;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .ib-providers__plugin {
    font-size: var(--cinder-text-sm);
  }

  .ib-providers__count {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>
