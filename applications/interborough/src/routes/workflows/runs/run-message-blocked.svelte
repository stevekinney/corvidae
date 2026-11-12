<script lang="ts">
  /**
   * The run page's message bar while a run waits on a person and no model provider is connected:
   * the chat composer's one blocked row, with a link to connect a provider and no text box, and
   * Cancel run beside it, so the person can still stop a run that cannot be answered. With a
   * provider the page has a message bar to send through, and this is absent.
   */
  import { ChatInput } from '@lostgradient/chat';
  import { createQuery } from '@tanstack/svelte-query';

  import { TASK_COPY } from '../../../app/copy/tasks.ts';
  import { isTerminalState, type TaskView } from '../../../lib/bureau-tasks.ts';
  import { getAgentCatalog } from '../../../lib/agent-definitions.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import RunCancel from './run-cancel.svelte';

  interface RunMessageBlockedProps {
    task: TaskView;
  }

  let { task }: RunMessageBlockedProps = $props();

  // The run's own question card decides it the same way: no model in the catalog, no provider.
  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.agents.catalog(),
      queryFn: ({ signal }) => getAgentCatalog({ signal }),
      retry: false,
    }),
    undefined,
  );
  // Until the host has answered nothing is blocked, as in the chat's composer.
  const noProvider = $derived(catalog.data !== undefined && catalog.data.models.length === 0);
  const waiting = $derived(
    !isTerminalState(task.status) && task.openWaits.some((wait) => wait.kind === 'human-wait'),
  );
</script>

{#if noProvider && waiting}
  <div class="ib-run__message-blocked" data-testid="run-message-blocked">
    <div class="ib-run__message-blocked-row">
      <ChatInput
        id={`run-message-${task.id}`}
        status={{
          kind: 'blocked',
          reason: TASK_COPY.messageBlocked.reason,
          link: { label: TASK_COPY.messageBlocked.connect, href: router.href('/settings/models') },
        }}
      />
    </div>
    <RunCancel {task} showStatus={false} />
  </div>
{/if}
