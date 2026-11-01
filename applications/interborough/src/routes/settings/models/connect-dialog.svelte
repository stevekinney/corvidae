<script lang="ts">
  /**
   * Connect a provider, or replace the key it already has: one API key, sent to the host in one
   * request (`PUT /host/providers/<name>`), which stores it in a file only the person can read and
   * lists the provider, so its models join the catalog with no restart.
   *
   * The key is held only in the field, only until the request settles. It is cleared whether the
   * host accepted it or refused it, and when the dialog is dismissed, and it is never put in a
   * message: a refusal is worded by the host in terms of the field, and a message that held the key
   * is replaced before it gets here (`lib/host-providers.ts`).
   */
  import { Alert, Button, Input, Modal } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';

  import { showToast } from '../../../app/toast-host.svelte';
  import { MODELS_COPY } from '../../../app/copy.ts';
  import { connectProvider, HostProviderError } from '../../../lib/host-providers.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { providerDisplayName } from './format-model.ts';

  interface Props {
    /** The provider the dialog is for, or `null` while it is closed. */
    provider: string | null;
    /** Whether that provider already has a key, which makes this a replacement. */
    connected: boolean;
  }

  let { provider = $bindable(), connected }: Props = $props();

  const copy = MODELS_COPY.connectDialog;
  const queryClient = useQueryClient();

  let key = $state('');
  let keyError = $state('');
  let failure = $state('');
  let sending = $state(false);

  const displayName = $derived(provider === null ? '' : providerDisplayName(provider));
  const open = $derived(provider !== null);

  /** The words for a refusal, none of which is the key. */
  function wordsFor(error: unknown): string {
    if (!(error instanceof HostProviderError)) return copy.failed;
    if (error.kind === 'locked') return copy.locked;
    if (error.kind === 'partial') return error.message === '' ? copy.partial : error.message;
    return error.message === '' ? copy.failed : `${copy.failed} ${error.message}`;
  }

  function close(): void {
    if (sending) return;
    key = '';
    keyError = '';
    failure = '';
    provider = null;
  }

  async function submit(): Promise<void> {
    if (sending || provider === null) return;
    if (key.trim() === '') {
      keyError = copy.keyRequired;
      return;
    }
    const name = provider;
    const wasConnected = connected;
    sending = true;
    keyError = '';
    failure = '';
    try {
      await connectProvider(name, key);
      showToast(wasConnected ? copy.replacedToast(displayName) : copy.connectedToast(displayName), {
        variant: 'success',
      });
      provider = null;
      // The catalog changed under the page and under the agent editor's model choices.
      void queryClient.invalidateQueries({ queryKey: queryKeys.hostProviders() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.catalog() });
      // The provider's plugin was waiting for this key.
      void queryClient.invalidateQueries({ queryKey: queryKeys.hostPlugins() });
    } catch (error) {
      failure = wordsFor(error);
    } finally {
      // Settled either way: the key is not kept.
      key = '';
      sending = false;
    }
  }
</script>

<Modal
  {open}
  title={connected ? copy.manageTitle(displayName) : copy.connectTitle(displayName)}
  onDismiss={close}
  dismissOnEscape={!sending}
  dismissOnBackdropClick={!sending}
>
  {#snippet children()}
    <form
      class="ib-connect"
      data-testid="provider-connect-form"
      onsubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p class="ib-connect__lead">{copy.description(displayName)}</p>
      <Input
        id="provider-api-key"
        type="password"
        autocomplete="off"
        spellcheck={false}
        variant="code"
        label={copy.keyLabel}
        description={copy.keyDescription}
        bind:value={key}
        error={keyError}
        disabled={sending}
      />
      {#if failure !== ''}
        <Alert variant="danger" data-testid="provider-connect-failure">
          <p class="ib-connect__failure">{failure}</p>
        </Alert>
      {/if}
    </form>
  {/snippet}
  {#snippet footer()}
    <Button variant="secondary" onclick={close} disabled={sending}>{copy.cancel}</Button>
    <Button data-changes variant="primary" onclick={() => void submit()} loading={sending}
      >{connected ? copy.replace : copy.connect}</Button
    >
  {/snippet}
</Modal>

<style>
  .ib-connect {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-connect__lead,
  .ib-connect__failure {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
