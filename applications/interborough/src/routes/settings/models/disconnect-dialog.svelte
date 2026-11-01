<script lang="ts">
  /**
   * Disconnect a provider: remove its key (`DELETE /host/providers/<name>`), so its models leave the
   * catalog and no run that begins afterwards can call it. The dialog names the agents that name one
   * of its models first, because their runs fail until the provider is connected again or the agent
   * is given another model, and the confirm button waits until that list has been read (or has
   * failed, which it says). The host never answers with a key and this dialog never holds one.
   */
  import { Alert, Button, Modal } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { MODELS_COPY } from '../../../app/copy.ts';
  import { showToast } from '../../../app/toast-host.svelte';
  import { disconnectProvider, HostProviderError } from '../../../lib/host-providers.ts';
  import { listProviderAgents } from '../../../lib/provider-agents.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { providerDisplayName } from './format-model.ts';

  interface Props {
    /** The provider the dialog is for, or `null` while it is closed. */
    provider: string | null;
  }

  let { provider = $bindable() }: Props = $props();

  const copy = MODELS_COPY.disconnectDialog;
  const queryClient = useQueryClient();

  let failure = $state('');
  let sending = $state(false);

  const displayName = $derived(provider === null ? '' : providerDisplayName(provider));
  const open = $derived(provider !== null);

  const agents = createQuery(
    () => ({
      queryKey: queryKeys.hostProviderAgents(provider ?? ''),
      queryFn: ({ signal }) => listProviderAgents(provider ?? '', { signal }),
      enabled: provider !== null,
      retry: false,
      // The list is a decision aid for this one confirmation, so it is read each time.
      staleTime: 0,
      gcTime: 0,
    }),
    undefined,
  );
  const settled = $derived(agents.isSuccess || agents.isError);

  function wordsFor(error: unknown): string {
    if (error instanceof HostProviderError && error.kind === 'locked') return copy.locked;
    return copy.failed;
  }

  function close(): void {
    if (sending) return;
    failure = '';
    provider = null;
  }

  async function submit(): Promise<void> {
    if (sending || provider === null) return;
    const name = provider;
    const shownAs = displayName;
    sending = true;
    failure = '';
    try {
      await disconnectProvider(name);
      showToast(copy.toast(shownAs), { variant: 'success' });
      provider = null;
      // The catalog changed under the page and under the agent editor's model choices.
      void queryClient.invalidateQueries({ queryKey: queryKeys.hostProviders() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.catalog() });
      // The provider's plugin is waiting for its key again.
      void queryClient.invalidateQueries({ queryKey: queryKeys.hostPlugins() });
    } catch (error) {
      failure = wordsFor(error);
    } finally {
      sending = false;
    }
  }
</script>

<Modal
  {open}
  title={copy.title(displayName)}
  onDismiss={close}
  dismissOnEscape={!sending}
  dismissOnBackdropClick={!sending}
>
  {#snippet children()}
    <div class="ib-disconnect" data-testid="provider-disconnect-body">
      <p class="ib-disconnect__lead">{copy.description(displayName)}</p>
      {#if agents.isError}
        <Alert variant="warning" data-testid="provider-disconnect-unknown">
          <p class="ib-disconnect__note">{copy.agentsUnknown(displayName)}</p>
        </Alert>
      {:else if agents.isSuccess}
        {#if agents.data.length === 0}
          <p class="ib-disconnect__note" data-testid="provider-disconnect-none">
            {copy.noAgents(displayName)}
          </p>
        {:else}
          <Alert variant="warning" data-testid="provider-disconnect-agents">
            <p class="ib-disconnect__note">
              {copy.agentsHeading(displayName, agents.data.length)}
            </p>
            <ul class="ib-disconnect__agents">
              {#each agents.data as agent (agent.id)}
                <li><code class="ib-identifier">{agent.id}</code></li>
              {/each}
            </ul>
            <p class="ib-disconnect__note">{copy.agentsConsequence}</p>
          </Alert>
        {/if}
      {:else}
        <p class="ib-disconnect__note" role="status" aria-busy="true">
          {copy.checking(displayName)}
        </p>
      {/if}
      {#if failure !== ''}
        <Alert variant="danger" data-testid="provider-disconnect-failure">
          <p class="ib-disconnect__note">{failure}</p>
        </Alert>
      {/if}
    </div>
  {/snippet}
  {#snippet footer()}
    <Button variant="secondary" onclick={close} disabled={sending}>{copy.cancel}</Button>
    <Button
      data-changes
      variant="danger"
      disabled={!settled}
      loading={sending}
      onclick={() => void submit()}>{copy.confirm}</Button
    >
  {/snippet}
</Modal>

<style>
  .ib-disconnect {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-disconnect__lead,
  .ib-disconnect__note {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .ib-disconnect__agents {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    margin: var(--cinder-space-2) 0;
    padding: 0;
    list-style: none;
  }
</style>
