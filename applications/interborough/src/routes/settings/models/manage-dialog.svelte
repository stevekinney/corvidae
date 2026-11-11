<script lang="ts">
  /**
   * Manage a connected provider (board SettingsShell, "Manage, a connected provider"): its name,
   * that it is connected and how many models it offers, with Remove key, Replace key and Done. The
   * saved key is never shown again, so there is nothing here to reveal or copy. Remove key and
   * Replace key each close this dialog and open their own.
   */
  import { Button, Modal, StatusDot } from '@lostgradient/cinder';

  import { MODELS_COPY } from '../../../app/copy.ts';
  import { providerDisplayName } from './format-model.ts';

  interface Props {
    /** The provider being managed, or `null` while the dialog is closed. */
    provider: string | null;
    /** How many models the provider offers now. */
    modelCount: number;
    /** Opens the replacement of the key; the dialog closes first. */
    onReplace: (provider: string) => void;
    /** Opens the removal of the key; the dialog closes first. */
    onRemove: (provider: string) => void;
  }

  let { provider = $bindable(), modelCount, onReplace, onRemove }: Props = $props();

  const copy = MODELS_COPY.manageDialog;

  const displayName = $derived(provider === null ? '' : providerDisplayName(provider));
  const open = $derived(provider !== null);

  function close(): void {
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
    <div class="ib-manage" data-testid="provider-manage-body">
      <StatusDot status="success" label={copy.connected} labelVisible />
      <span class="ib-manage__models">{copy.models(modelCount)}</span>
    </div>
  {/snippet}
  {#snippet footer()}
    <Button variant="secondary" onclick={() => hand(onRemove)}>{copy.removeKey}</Button>
    <Button variant="secondary" onclick={() => hand(onReplace)}>{copy.replaceKey}</Button>
    <Button variant="primary" onclick={close}>{copy.done}</Button>
  {/snippet}
</Modal>

<style>
  .ib-manage {
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
