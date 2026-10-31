<script lang="ts">
  /**
   * The Providers part of Settings › Models: each provider the host can call, with a Connected dot
   * and Manage once it has a key, or only Connect while it does not, and a way to read the
   * configuration file again for a person who edited it by hand. A host that keeps its
   * configuration in its deployment cannot save a key, and says so.
   */
  import { Alert, Button, StatusDot } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';

  import { MODELS_COPY } from '../../../app/copy.ts';
  import { showToast } from '../../../app/toast-host.svelte';
  import { reloadProviders, type ProvidersSnapshot } from '../../../lib/host-providers.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import ConnectDialog from './connect-dialog.svelte';

  interface Props {
    snapshot: ProvidersSnapshot;
    /** The provider whose dialog is open, or `null`. The page binds it so the empty Models list can open one too. */
    connecting: string | null;
  }

  let { snapshot, connecting = $bindable() }: Props = $props();

  const copy = MODELS_COPY.providers;
  const queryClient = useQueryClient();

  let reloading = $state(false);

  const locked = $derived(snapshot.lockReason !== undefined);
  const connectingStatus = $derived(snapshot.providers.find((entry) => entry.name === connecting));

  function nameOf(provider: string): string {
    return MODELS_COPY.providerNames[provider] ?? provider;
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

  .ib-providers__count {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>
