<script lang="ts">
  /**
   * The one destructive confirmation for a file agent. Edit and Settings use the same dialog so
   * they name the same effects, wait for the same dependent reads, and hold the question while a
   * delete can still fail. The entry point owns its mutation because its stale recovery differs.
   */
  import { ConfirmDialog } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { AGENT_PAGE_COPY } from '../../app/copy/agents.ts';
  import { listAgentReferences } from '../../lib/agent-definitions.ts';
  import { listAllContexts } from '../../lib/bureau-client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { chatUsageByAgent } from './agent-presentation.ts';
  import { dependentsLine } from './agent-settings.ts';

  interface Props {
    open: boolean;
    id: string;
    name: string;
    busy?: boolean;
    error?: string | undefined;
    onConfirm: () => void;
  }

  let { open = $bindable(), id, name, busy = false, error, onConfirm }: Props = $props();

  const copy = AGENT_PAGE_COPY.settings;
  // Both entry points read these under their normal query keys, so an open question reuses a warm
  // Settings cache rather than inventing a second model of the consequences.
  const references = createQuery(
    () => ({
      queryKey: queryKeys.agents.references(id),
      queryFn: ({ signal }) => listAgentReferences(id, { signal }),
      enabled: open,
      retry: false,
    }),
    undefined,
  );
  const chats = createQuery(
    () => ({
      queryKey: queryKeys.contexts.usage(),
      queryFn: ({ signal }) => listAllContexts({ signal, origin: 'chat' }),
      enabled: open,
      retry: false,
    }),
    undefined,
  );
  const chatCount = $derived(
    chats.data === undefined ? undefined : (chatUsageByAgent(chats.data).get(id)?.count ?? 0),
  );
</script>

<ConfirmDialog
  bind:open
  title={copy.deleteDialog.title(name)}
  description={copy.deleteDialog.description(chatCount, dependentsLine(references.data))}
  typeToConfirm={id}
  typeToConfirmLabel={copy.deleteDialog.typeLabel(id)}
  confirmLabel={copy.deleteDialog.confirm}
  {busy}
  busyLabel="Deleting…"
  errorTitle={copy.deleteFailed}
  {error}
  closeOnConfirm={false}
  destructive
  {onConfirm}
/>
