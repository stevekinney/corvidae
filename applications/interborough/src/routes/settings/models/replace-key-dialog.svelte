<script lang="ts">
  /**
   * Replace the key a connected provider already has (board SettingsShell, "Replace key · in
   * progress"): a new key is tested first and saved only once the provider accepts it, so the old key
   * keeps working until then. While it tests, "Replace key" is disabled and Cancel stays. A refused
   * key is worded at the field and nothing is saved. The key sequence lives in
   * `key-flow.svelte.ts`; the saved key is never shown.
   */
  import { Button, Callout, InlineLoading, Input, Modal } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';

  import { MODELS_COPY } from '../../../app/copy.ts';
  import { showToast } from '../../../app/toast-host.svelte';
  import { providerDisplayName } from './format-model.ts';
  import { KeyFlow } from './key-flow.svelte.ts';
  import { markConnected, refreshAfterKeyChange } from './provider-cache.ts';

  interface Props {
    /** The provider whose key is being replaced, or `null` while the dialog is closed. */
    provider: string | null;
  }

  let { provider = $bindable() }: Props = $props();

  const copy = MODELS_COPY.replaceDialog;
  const queryClient = useQueryClient();

  const flow = new KeyFlow({
    provider: () => provider,
    onSaved: (name) => {
      showToast(copy.toast(providerDisplayName(name)), { variant: 'success' });
      markConnected(queryClient, name);
      refreshAfterKeyChange(queryClient);
      flow.reset();
      provider = null;
    },
  });

  const displayName = $derived(provider === null ? '' : providerDisplayName(provider));
  const open = $derived(provider !== null);

  $effect(() => {
    if (provider === null) flow.reset();
  });

  function close(): void {
    if (flow.saving) return;
    flow.reset();
    provider = null;
  }
</script>

<Modal
  {open}
  title={copy.title(displayName)}
  description={copy.subtitle}
  onDismiss={close}
  dismissOnEscape={!flow.saving}
  dismissOnBackdropClick={!flow.saving}
>
  {#snippet children()}
    <form
      class="ib-replace"
      data-testid="provider-replace-form"
      novalidate
      onsubmit={(event) => {
        event.preventDefault();
        void flow.submit();
      }}
    >
      <Input
        id="provider-new-api-key"
        type="password"
        autocomplete="off"
        spellcheck={false}
        variant="code"
        label={copy.keyLabel}
        bind:value={flow.key}
        onValueChange={() => flow.edited()}
        error={flow.fieldError}
        readonly={flow.busy}
      />
      {#if flow.busy}
        <InlineLoading status="active" description={copy.testing} />
      {/if}
      {#if flow.failure !== ''}
        <Callout variant="danger" data-testid="provider-replace-failure">
          <p class="ib-replace__failure">{flow.failure}</p>
        </Callout>
      {/if}
    </form>
  {/snippet}
  {#snippet footer()}
    <Button variant="secondary" onclick={close} disabled={flow.saving}>{copy.cancel}</Button>
    <Button data-changes variant="primary" disabled={flow.busy} onclick={() => void flow.submit()}
      >{copy.replace}</Button
    >
  {/snippet}
</Modal>

<style>
  .ib-replace {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-replace__failure {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
