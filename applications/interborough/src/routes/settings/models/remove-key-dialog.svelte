<script lang="ts">
  /**
   * Remove a provider's key (board SettingsShell, "Remove key, confirm"): a Cinder confirm dialog
   * with a solid danger button, because removing the key stops every agent that needs one of the
   * provider's models. It names those agents, then says that Run now on their schedules is disabled
   * too and that chats and runs stay. The agents come from the Bureau's definitions (the ones whose
   * default model is on the provider), read when the dialog opens; Assistant and Echo are scripted
   * and never named. The confirm button does not wait for that read, which is only information. When
   * memory search uses, or is switching to, an embedder the provider's plugin adds, the dialog says
   * that removing the key stops it (EM6-22); which providers offer an embedder is read from the
   * plugins' contributions, never listed here. The host never answers with a key and this dialog
   * never holds one.
   */
  import { ConfirmDialog, GroupedList, GroupedListItem } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { EMBEDDER_COPY } from '../../../app/copy/embedder.ts';
  import { MODELS_COPY } from '../../../app/copy/models.ts';
  import { showToast } from '../../../app/toast-host.svelte';
  import { agentLabel } from '../../../lib/agent-label.ts';
  import { getEmbeddingStatus } from '../../../lib/bureau-embedding.ts';
  import { listContributedProviders } from '../../../lib/bureau-plugin-kinds.ts';
  import { getPlugins } from '../../../lib/host-plugins.ts';
  import { disconnectProvider, HostProviderError } from '../../../lib/host-providers.ts';
  import { listProviderAgents } from '../../../lib/provider-agents.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { embedderName, providerEmbedder } from '../embedder-model.ts';
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

  // Whether memory search depends on this provider's key is read, not listed: the provider's
  // plugin says which embedders it adds (`GET /host/plugins`), and the embedding status says which
  // one memory uses or is switching to. Both are only information for this confirmation, so a read
  // that fails leaves the sentence out and never holds the confirm button.
  const contributed = createQuery(
    () => ({
      queryKey: queryKeys.contributedProviders(),
      queryFn: ({ signal }) => listContributedProviders({ signal }),
      enabled: provider !== null,
      retry: false,
    }),
    undefined,
  );
  const plugins = createQuery(
    () => ({
      queryKey: queryKeys.hostPlugins(),
      queryFn: ({ signal }) => getPlugins({ signal }),
      enabled: provider !== null,
      retry: false,
    }),
    undefined,
  );
  const embedding = createQuery(
    () => ({
      queryKey: queryKeys.memoryEmbedding(),
      queryFn: ({ signal }) => getEmbeddingStatus({ signal }),
      enabled: provider !== null,
      retry: false,
      // The answer decides a sentence about what memory uses now, so it is read each time.
      staleTime: 0,
    }),
    undefined,
  );
  const providerPlugin = $derived.by(() => {
    const entry = (contributed.data ?? []).find((candidate) => candidate.name === provider);
    return (plugins.data?.plugins ?? []).find(
      (candidate) => candidate.descriptor.name === entry?.plugin,
    );
  });
  const embedderInUse = $derived(
    embedding.data === undefined ? undefined : providerEmbedder(providerPlugin, embedding.data),
  );
  const embedderNote = $derived(
    embedderInUse === undefined
      ? undefined
      : EMBEDDER_COPY.removeKey(embedderName(embedderInUse, plugins.data?.plugins ?? [])),
  );

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
    {#if trimmedNames.length > 0 || embedderNote !== undefined}
      <GroupedList data-testid="provider-remove-notes" aria-label={copy.title(displayName)}>
        {#if trimmedNames.length > 0}
          <GroupedListItem data-testid="provider-remove-trimmed"
            >{#snippet title()}{copy.trimmedNote(
                trimmedNames,
                displayName,
              )}{/snippet}</GroupedListItem
          >
        {/if}
        {#if embedderNote !== undefined}
          <GroupedListItem data-testid="provider-remove-embedder"
            >{#snippet title()}{embedderNote}{/snippet}</GroupedListItem
          >
        {/if}
      </GroupedList>
    {/if}
  {/snippet}
</ConfirmDialog>
