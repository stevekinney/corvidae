<script lang="ts">
  /**
   * Remove a provider's key (board SettingsShell, "Remove key, confirm"): a Cinder confirm dialog
   * with a solid danger button, because removing the key stops every agent that needs one of the
   * provider's models. It names those agents, then says that Run now on their schedules is disabled
   * too and that chats and runs stay. The agents come from the Bureau's definitions (the ones whose
   * default model is on the provider), read when the dialog opens; Assistant and Echo are scripted
   * and never named. The confirm button does not wait for that read, which is only information. The
   * host never answers with a key and this dialog never holds one.
   */
  import { ConfirmDialog } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { MODELS_COPY } from '../../../app/copy.ts';
  import { showToast } from '../../../app/toast-host.svelte';
  import { agentLabel } from '../../../lib/agent-label.ts';
  import { disconnectProvider, HostProviderError } from '../../../lib/host-providers.ts';
  import { listProviderAgents } from '../../../lib/provider-agents.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { providerDisplayName } from './format-model.ts';
  import { refreshAfterKeyChange } from './provider-cache.ts';

  interface Props {
    /** The provider whose key is being removed, or `null` while the dialog is closed. */
    provider: string | null;
  }

  let { provider = $bindable() }: Props = $props();

  const copy = MODELS_COPY.removeDialog;
  const queryClient = useQueryClient();

  let failure = $state('');
  let sending = $state(false);

  const displayName = $derived(provider === null ? '' : providerDisplayName(provider));
  const open = $derived(provider !== null);
  // Only these providers offer a memory embedder.
  const hasEmbedder = $derived(provider === 'openai' || provider === 'gemini');

  const agents = createQuery(
    () => ({
      queryKey: queryKeys.hostProviderAgents(provider ?? ''),
      queryFn: ({ signal }) => listProviderAgents(provider ?? '', { signal }),
      enabled: provider !== null,
      retry: false,
      // The list informs this one confirmation, so it is read each time.
      staleTime: 0,
      gcTime: 0,
    }),
    undefined,
  );

  /** An agent as a person reads it: a code agent's display name is its identifier, which reads as words. */
  const nameOf = (agent: { readonly id: string; readonly displayName: string }): string =>
    agentLabel(agent.id, [{ name: agent.id, displayName: agent.displayName }]);

  const description = $derived.by(() => {
    if (agents.isError) return copy.agentsUnknown(displayName);
    if (!agents.isSuccess) return copy.checking(displayName);
    const names = agents.data.invalid.map(nameOf);
    return names.length === 0 ? copy.descriptionNoAgents(displayName) : copy.description(names);
  });
  const trimmedNames = $derived(agents.isSuccess ? agents.data.trimmed.map(nameOf) : []);

  function wordsFor(error: unknown): string {
    return error instanceof HostProviderError && error.kind === 'locked'
      ? copy.locked
      : copy.failed;
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
      // The catalog changed under the page and under the agent editor's model choices, and the
      // provider's plugin is waiting for its key again.
      refreshAfterKeyChange(queryClient);
    } catch (error) {
      failure = wordsFor(error);
    } finally {
      sending = false;
    }
  }
</script>

<ConfirmDialog
  {open}
  title={copy.title(displayName)}
  {description}
  confirmLabel={copy.confirm}
  busyLabel={copy.busy}
  cancelLabel={copy.cancel}
  destructive
  busy={sending}
  errorTitle={failure === '' ? undefined : copy.failedTitle}
  error={failure === '' ? undefined : failure}
  closeOnConfirm={false}
  onConfirm={() => void submit()}
  onCancel={close}
  onExitComplete={() => {
    if (provider === null) failure = '';
  }}
>
  {#snippet options()}
    {#if trimmedNames.length > 0 || hasEmbedder}
      <div class="ib-remove" data-testid="provider-remove-notes">
        {#if trimmedNames.length > 0}
          <p class="ib-remove__note" data-testid="provider-remove-trimmed">
            {copy.trimmedNote(trimmedNames, displayName)}
          </p>
        {/if}
        {#if hasEmbedder}
          <p class="ib-remove__note" data-testid="provider-remove-embedder">
            {copy.embedderNote}
          </p>
        {/if}
      </div>
    {/if}
  {/snippet}
</ConfirmDialog>

<style>
  .ib-remove {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-remove__note {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }
</style>
