<script lang="ts">
  /**
   * Connect a provider (board SettingsShell, "Connect, empty", "testing", "invalid key" and
   * "connected"): one API key, tested before it is saved. Connect is always enabled: pressing it
   * stores the settings the person changed, tests the key against them, then saves the key, or shows
   * why the provider refused it at the field. Test is an optional secondary that only asks about the
   * key (it stores changed settings first, which the probe reads). Once the key is saved the dialog says Connected, with how many
   * models it added (no restart), and its footer is a single Done.
   *
   * The key sequence lives in `key-flow.svelte.ts`. The key is held only in the field, only until the
   * host has saved it or the dialog is dismissed, and it is never put in a message.
   */
  import { Button, Callout, InlineLoading, Input, Link, Modal } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';

  import { MODELS_COPY } from '../../../app/copy/models.ts';
  import { maskedKey, providerKeyPage } from './format-model.ts';
  import { KeyFlow } from './key-flow.svelte.ts';
  import {
    markConnected,
    refreshAfterConfigurationSave,
    refreshAfterKeyChange,
  } from './provider-cache.ts';
  import { providerTitle, type ProviderConfigurationSource } from './provider-configuration.ts';
  import ProviderConfiguration from './provider-configuration.svelte';
  import { ProviderConfigurationDraft } from './provider-configuration.svelte.ts';

  interface Props {
    /** The provider the dialog is for, or `null` while it is closed. */
    provider: string | null;
    /** The configuration of each provider's plugin, by provider name, which Connect saves with the key. */
    configurations?: ReadonlyMap<string, ProviderConfigurationSource>;
  }

  let { provider = $bindable(), configurations = new Map() }: Props = $props();

  const copy = MODELS_COPY.connectDialog;
  const queryClient = useQueryClient();

  /**
   * The provider's plugin settings, stored before the key is tested: the host probes with the
   * settings it holds, so the key is tested against what will stay stored. A refused key leaves the
   * settings stored, as `interborough providers connect` does.
   */
  const configuration = new ProviderConfigurationDraft({
    source: () => (provider === null ? undefined : configurations.get(provider)),
    onSaved: () => refreshAfterConfigurationSave(queryClient),
  });

  const flow = new KeyFlow({
    provider: () => provider,
    onSaved: (name) => {
      markConnected(queryClient, name);
      refreshAfterKeyChange(queryClient);
    },
    beforeTest: async () => {
      const changed = configuration.dirty;
      if (!(await configuration.save())) return 'refused';
      return changed ? 'stored' : 'unchanged';
    },
  });

  const displayName = $derived(provider === null ? '' : providerTitle(provider, configurations));
  const keyPage = $derived(provider === null ? undefined : providerKeyPage(provider));
  const open = $derived(provider !== null);
  const connected = $derived(flow.phase === 'connected');
  const subtitle = $derived(
    flow.phase === 'testing' || flow.phase === 'saving'
      ? copy.subtitle.testing
      : flow.phase === 'failed'
        ? copy.subtitle.failed
        : flow.phase === 'tested'
          ? copy.subtitle.tested
          : flow.phase === 'connected'
            ? copy.subtitle.connected
            : flow.failure !== ''
              ? copy.subtitle.saveFailed
              : copy.subtitle.idle,
  );

  /**
   * Whether the field shows the key's masked form (`sk-ant-••••`) instead of the key: while it is
   * tested, and after a provider refused it until the person goes back into the field to change it
   * (board SettingsShell, "Connect, testing" and "Connect, invalid key"). A password field can only
   * show bullets, so the masked form is a text the field is given, never built from the key itself.
   */
  let revealed = $state(false);
  const masked = $derived(
    provider !== null && (flow.busy || (flow.phase === 'failed' && !revealed)),
  );
  const shownKey = $derived(masked && provider !== null ? maskedKey(provider) : flow.key);

  // Whatever closes the dialog, the sequence starts over the next time it opens.
  $effect(() => {
    if (provider === null) {
      flow.reset();
      configuration.reset();
    }
  });

  function close(): void {
    // A key being written cannot be taken back half way; a test being waited for can.
    if (flow.saving) return;
    flow.reset();
    configuration.reset();
    provider = null;
  }
</script>

<Modal
  {open}
  title={copy.title(displayName)}
  description={subtitle}
  onDismiss={close}
  dismissOnEscape={!flow.saving}
  dismissOnBackdropClick={!flow.saving}
>
  {#snippet children()}
    <div class="ib-connect">
      <form
        class="ib-connect__key"
        data-testid="provider-connect-form"
        novalidate
        onsubmit={(event) => {
          event.preventDefault();
          void flow.submit();
        }}
      >
        {#if connected}
          <Input
            id="provider-api-key"
            type="text"
            variant="code"
            label={copy.keyLabel}
            required
            disabled
            description={copy.keyHelp}
            value={provider === null ? '' : maskedKey(provider)}
          >
            {#snippet descriptionAction()}
              {#if keyPage !== undefined}
                <Link href={keyPage} external underline="always">{copy.getKey}</Link>
              {/if}
            {/snippet}
          </Input>
        {:else}
          <Input
            id="provider-api-key"
            type={masked ? 'text' : 'password'}
            autocomplete="off"
            spellcheck={false}
            variant="code"
            label={copy.keyLabel}
            placeholder={copy.keyPlaceholder}
            required
            description={copy.keyHelp}
            bind:value={
              () => shownKey,
              (next) => {
                if (!masked) flow.key = next;
              }
            }
            onValueChange={() => {
              if (!masked) flow.edited();
            }}
            onfocus={() => (revealed = true)}
            onblur={() => (revealed = false)}
            error={flow.fieldError}
            readonly={flow.busy}
          >
            {#snippet descriptionAction()}
              {#if keyPage !== undefined}
                <Link href={keyPage} external underline="always">{copy.getKey}</Link>
              {/if}
            {/snippet}
          </Input>
        {/if}
        {#if flow.busy}
          <InlineLoading status="active" description={copy.testing} />
        {/if}
      </form>
      <!-- The configuration draws its own form, so it sits beside the key's form, not inside it. -->
      {#if !connected}
        <ProviderConfiguration {configuration} heading />
      {/if}
      {#if connected || flow.phase === 'tested'}
        <div role="status" data-testid="provider-connect-result">
          <Callout
            variant="success"
            title={connected ? copy.connectedTitle : copy.testedTitle}
            data-testid="provider-connect-success"
          >
            <p class="ib-connect__result">{copy.models(flow.models)}</p>
          </Callout>
        </div>
      {/if}
      {#if flow.failure !== ''}
        <Callout variant="danger" data-testid="provider-connect-failure">
          <p class="ib-connect__result">{flow.failure}</p>
        </Callout>
      {/if}
    </div>
  {/snippet}
  {#snippet footer()}
    {#if connected}
      <Button variant="primary" onclick={close}>{copy.done}</Button>
    {:else}
      <Button variant="secondary" onclick={close} disabled={flow.saving}>{copy.cancel}</Button>
      {#if !flow.busy}
        <Button variant="secondary" onclick={() => void flow.test()}>{copy.test}</Button>
      {/if}
      <Button data-changes variant="primary" disabled={flow.busy} onclick={() => void flow.submit()}
        >{flow.busy ? copy.connecting : copy.connect}</Button
      >
    {/if}
  {/snippet}
</Modal>

<style>
  .ib-connect {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-connect__key {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-connect__result {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
