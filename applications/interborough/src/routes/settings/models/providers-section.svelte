<script lang="ts">
  /**
   * The Providers part of Settings › Models (board SettingsShell, "Models, /settings/models" and
   * "Models, provider connected"): each provider that has a plugin, in the order Anthropic, OpenAI,
   * Gemini, with what its models are called under its name. A provider that needs a key it lacks
   * shows only Connect; a connected one shows a Connected dot and Manage, which opens the dialog
   * that replaces or removes its key and edits its plugin's settings. A provider that declares no
   * secret (a local Ollama) is connected with no key: its Manage holds only its settings, and with
   * none it shows the Connected dot alone. There is no banner and no "Not connected" badge: while
   * none is connected, the description says why agents cannot answer. A host that keeps its
   * configuration in its deployment cannot save a key, and says so.
   */
  import { Alert, Button, FormSection, StatusDot } from '@lostgradient/cinder';

  import { MODELS_COPY } from '../../../app/copy/models.ts';
  import type { ProvidersSnapshot } from '../../../lib/host-providers.ts';
  import ConnectDialog from './connect-dialog.svelte';
  import ManageDialog from './manage-dialog.svelte';
  import RemoveKeyDialog from './remove-key-dialog.svelte';
  import ReplaceKeyDialog from './replace-key-dialog.svelte';
  import { providerTagline, providersInOrder } from './format-model.ts';
  import {
    hasSettingsToShow,
    providerTitle,
    type ProviderConfigurationSource,
  } from './provider-configuration.ts';

  interface Props {
    snapshot: ProvidersSnapshot;
    /** The provider whose dialog is open, or `null`. The page binds it so the empty Models list can open one too. */
    connecting: string | null;
    /** The configuration of each provider's plugin, by provider name, which Connect and Manage draw and save. */
    configurations?: ReadonlyMap<string, ProviderConfigurationSource>;
  }

  let { snapshot, connecting = $bindable(), configurations = new Map() }: Props = $props();

  const copy = MODELS_COPY.providers;

  /** The provider whose Manage dialog is open. */
  let managing = $state<string | null>(null);
  /** The provider whose Replace key dialog is open. */
  let replacing = $state<string | null>(null);
  /** The provider whose Remove key confirmation is open. */
  let removing = $state<string | null>(null);

  const locked = $derived(snapshot.lockReason !== undefined);
  const entries = $derived(providersInOrder(snapshot.providers));
  const anyConnected = $derived(entries.some((entry) => entry.connected));
  /** Whether the provider being managed holds a key the dialog can replace or remove: a keyless one has none. */
  const managedHasKey = $derived(
    snapshot.providers.some((entry) => entry.name === managing && entry.hasKey),
  );
  const managedModelCount = $derived(
    snapshot.models.filter((entry) => entry.provider === managing && !entry.off).length,
  );
</script>

<div class="ib-providers" data-section="providers">
  <FormSection
    grouped
    heading={copy.heading}
    description={anyConnected ? copy.connectedDescription : copy.description}
  >
    {#if locked}
      <Alert variant="info" data-testid="providers-locked">
        <p class="ib-providers__alert">{MODELS_COPY.locked}</p>
      </Alert>
    {/if}
    {#each entries as provider (provider.name)}
      {@const name = providerTitle(provider.name, configurations)}
      {@const tagline = providerTagline(provider.name)}
      <div class="ib-providers__row" data-provider={provider.name}>
        <div class="ib-providers__identity">
          <span class="ib-providers__name">{name}</span>
          {#if tagline !== undefined}
            <span class="ib-providers__tagline">{tagline}</span>
          {/if}
        </div>
        {#if provider.connected}
          <StatusDot status="success" label={copy.connected} labelVisible />
          <!-- A keyless provider has no key to manage: Manage is there only for its settings. -->
          {#if provider.hasKey || hasSettingsToShow(configurations.get(provider.name))}
            <Button
              variant="secondary"
              size="sm"
              disabled={locked}
              aria-label={copy.manageLabel(name)}
              onclick={() => (managing = provider.name)}>{copy.manage}</Button
            >
          {/if}
        {:else}
          <Button
            variant="secondary"
            size="sm"
            disabled={locked}
            aria-label={copy.connectLabel(name)}
            onclick={() => (connecting = provider.name)}>{copy.connect}</Button
          >
        {/if}
      </div>
    {/each}
  </FormSection>
</div>

<ConnectDialog bind:provider={connecting} {configurations} />
<ManageDialog
  bind:provider={managing}
  {configurations}
  hasKey={managedHasKey}
  modelCount={managedModelCount}
  onReplace={(provider: string) => (replacing = provider)}
  onRemove={(provider: string) => (removing = provider)}
/>
<ReplaceKeyDialog bind:provider={replacing} />
<RemoveKeyDialog bind:provider={removing} />

<style>
  .ib-providers {
    min-inline-size: 0;
  }

  .ib-providers__alert {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-providers__row {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-3);
    padding: var(--cinder-space-3) var(--cinder-space-4);
    min-inline-size: 0;
  }

  .ib-providers__identity {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-inline-size: 0;
  }

  .ib-providers__name {
    font-weight: var(--cinder-font-semibold);
    overflow-wrap: anywhere;
  }

  .ib-providers__tagline {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>
