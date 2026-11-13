<script lang="ts">
  /**
   * Manage a connected provider (board SettingsShell, "Manage, a connected provider"): its name,
   * that it is connected and how many models it offers, with Remove key, Replace key and Done. The
   * saved key is never shown again, so there is nothing here to reveal or copy. Remove key and
   * Replace key each close this dialog and open their own.
   */
  import { Button, Modal, StatusDot } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';

  import { MODELS_COPY } from '../../../app/copy/models.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { providerTitle, type ProviderConfigurationSource } from './provider-configuration.ts';
  import ProviderConfiguration from './provider-configuration.svelte';
  import { ProviderConfigurationDraft } from './provider-configuration.svelte.ts';

  interface Props {
    /** The provider being managed, or `null` while the dialog is closed. */
    provider: string | null;
    /** How many models the provider offers now. */
    modelCount: number;
    /** Opens the replacement of the key; the dialog closes first. */
    onReplace: (provider: string) => void;
    /** Opens the removal of the key; the dialog closes first. */
    onRemove: (provider: string) => void;
    /** The configuration of each provider's plugin, by provider name, which the dialog edits and saves. */
    configurations?: ReadonlyMap<string, ProviderConfigurationSource>;
    /**
     * Whether the provider holds a saved key. A keyless provider (a local Ollama) is connected with
     * none, so the dialog offers neither Remove key nor Replace key: only its settings.
     */
    hasKey?: boolean;
  }

  let {
    provider = $bindable(),
    modelCount,
    onReplace,
    onRemove,
    configurations = new Map(),
    hasKey = true,
  }: Props = $props();

  const copy = MODELS_COPY.manageDialog;
  const queryClient = useQueryClient();

  const configuration = new ProviderConfigurationDraft({
    source: () => (provider === null ? undefined : configurations.get(provider)),
    onSaved: () => queryClient.invalidateQueries({ queryKey: queryKeys.hostPlugins() }),
  });

  const displayName = $derived(provider === null ? '' : providerTitle(provider, configurations));
  const open = $derived(provider !== null);

  // Whatever closes the dialog, the settings start over from what is stored the next time it opens.
  $effect(() => {
    if (provider === null) configuration.reset();
  });

  function close(): void {
    configuration.reset();
    provider = null;
  }

  function hand(next: (provider: string) => void): void {
    if (provider === null) return;
    const name = provider;
    provider = null;
    next(name);
  }
</script>

<Modal
  {open}
  title={displayName === '' ? copy.fallbackTitle : displayName}
  description={copy.subtitle}
  onDismiss={close}
>
  {#snippet children()}
    <div class="ib-manage">
      <div class="ib-manage__status" data-testid="provider-manage-body">
        <StatusDot status="success" label={copy.connected} labelVisible />
        <span class="ib-manage__models">{copy.models(modelCount)}</span>
      </div>
      <ProviderConfiguration {configuration} />
    </div>
  {/snippet}
  {#snippet footer()}
    {#if hasKey}
      <Button variant="secondary" onclick={() => hand(onRemove)}>{copy.removeKey}</Button>
      <Button variant="secondary" onclick={() => hand(onReplace)}>{copy.replaceKey}</Button>
    {/if}
    {#if configuration.dirty || configuration.saving}
      <Button
        variant="primary"
        disabled={configuration.saving}
        onclick={() => void configuration.save()}
        >{configuration.saving ? copy.saving : copy.save}</Button
      >
    {:else}
      <Button variant="primary" onclick={close}>{copy.done}</Button>
    {/if}
  {/snippet}
</Modal>

<style>
  .ib-manage {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-manage__status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-manage__models {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>
