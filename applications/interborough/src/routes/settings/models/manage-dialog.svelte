<script lang="ts">
  /**
   * Manage a connected provider (board SettingsShell, "Manage, a connected provider"): its name,
   * that it is connected and how many models it offers, with Remove key, Replace key and Done. The
   * saved key is never shown again, so there is nothing here to reveal or copy. Remove key and
   * Replace key each close this dialog and open their own.
   */
  import { Button, ConfirmDialog, Modal, StatusDot } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';

  import { MODELS_COPY } from '../../../app/copy/models.ts';
  import { refreshAfterConfigurationSave } from './provider-cache.ts';
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
  type LeaveAction = 'close' | 'remove' | 'replace';
  let pending = $state<LeaveAction | null>(null);
  let open = $state(false);

  const configuration = new ProviderConfigurationDraft({
    source: () => (provider === null ? undefined : configurations.get(provider)),
    onSaved: () => refreshAfterConfigurationSave(queryClient),
  });

  const displayName = $derived(provider === null ? '' : providerTitle(provider, configurations));

  // Whatever closes the dialog, the settings start over from what is stored the next time it opens.
  $effect(() => {
    open = provider !== null;
    if (provider === null) {
      configuration.reset();
      pending = null;
    }
  });

  function leave(action: LeaveAction): void {
    const name = provider;
    if (name === null) return;
    configuration.reset();
    open = false;
    provider = null;
    pending = null;
    if (action === 'remove') onRemove(name);
    if (action === 'replace') onReplace(name);
  }

  function requestLeave(action: LeaveAction): void {
    if (provider === null || configuration.saving) return;
    if (configuration.dirty) {
      // Escape and the backdrop close the bound Modal first. Reopen it in the same turn so the
      // form stays mounted under the confirmation and Keep editing restores the live draft.
      open = true;
      pending = action;
      return;
    }
    leave(action);
  }
</script>

<Modal
  bind:open
  title={displayName === '' ? copy.fallbackTitle : displayName}
  dismissOnEscape={!configuration.saving}
  dismissOnBackdropClick={!configuration.saving}
  closeButtonVisible={!configuration.saving}
  onDismiss={() => requestLeave('close')}
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
      <Button
        variant="secondary"
        disabled={configuration.saving}
        onclick={() => requestLeave('remove')}
        label={copy.removeKey}
      />
      <Button
        variant="secondary"
        disabled={configuration.saving}
        onclick={() => requestLeave('replace')}
        label={copy.replaceKey}
      />
    {/if}
    {#if configuration.dirty || configuration.saving}
      <Button
        variant="primary"
        disabled={configuration.saving}
        onclick={() => void configuration.save()}
        >{configuration.saving ? copy.saving : copy.save}</Button
      >
    {:else}
      <Button variant="primary" onclick={() => requestLeave('close')} label={copy.done} />
    {/if}
  {/snippet}
</Modal>

<ConfirmDialog
  open={pending !== null}
  title={copy.discardTitle}
  description={copy.discardDescription}
  cancelLabel={copy.keepEditing}
  confirmLabel={copy.discardChanges}
  destructive
  onCancel={() => (pending = null)}
  onConfirm={() => {
    if (pending !== null) leave(pending);
  }}
/>

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
