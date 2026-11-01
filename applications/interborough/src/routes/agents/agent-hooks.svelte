<script lang="ts">
  /**
   * The Hooks tab of an agent's page: the hooks list, narrowed by the Bureau to the hooks limited to
   * this agent. New hook starts one already limited to it. A hook that runs for everything also runs
   * for this agent, and is on the Hooks page; this tab holds what belongs to the agent alone.
   */
  import { Alert, Button, EmptyState, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL } from '../../app/copy.ts';
  import { listHooks } from '../../lib/bureau-hooks.ts';
  import { classifyFault } from '../../lib/faults.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { HOOKS_COPY } from '../hooks/hook-copy.ts';
  import HookTable from '../hooks/hook-table.svelte';
  import HooksUnavailable from '../hooks/hooks-unavailable.svelte';

  interface Props {
    /** The agent's identifier. */
    id: string;
  }

  let { id }: Props = $props();

  const copy = HOOKS_COPY.agentTab;

  const hooks = createQuery(
    () => ({
      queryKey: queryKeys.hooks.ofAgent(id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        listHooks({ scope: { kind: 'agent', id } }, { signal }),
      retry: false,
    }),
    undefined,
  );
  const unavailable = $derived(
    hooks.isError && classifyFault(hooks.error)?.kind === 'not-supported',
  );
  const newHookPath = $derived(`/hooks/new?agent=${encodeURIComponent(id)}`);

  function go(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(newHookPath);
  }
</script>

{#snippet newHook()}
  <Button href={router.href(newHookPath)} variant="primary" size="sm" onclick={go}
    >{HOOKS_COPY.newAction}</Button
  >
{/snippet}

<div class="ib-agent-hooks" data-testid="agent-hooks">
  {#if unavailable}
    <HooksUnavailable headingLevel={2} />
  {:else if hooks.isError}
    <Alert variant="danger">
      <p class="ib-agent-hooks__failed">{copy.loadFailed}</p>
      <Button variant="secondary" size="sm" onclick={() => void hooks.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if hooks.isPending}
    <Skeleton height="4rem" />
  {:else if hooks.data !== undefined && hooks.data.length === 0}
    <EmptyState
      kind="first-use"
      title={copy.emptyTitle}
      description={copy.emptyDescription}
      headingLevel={2}
      action={newHook}
    />
  {:else if hooks.data !== undefined}
    <div class="ib-agent-hooks__actions">{@render newHook()}</div>
    <HookTable hooks={hooks.data} />
  {/if}
</div>

<style>
  .ib-agent-hooks {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-agent-hooks__actions {
    display: flex;
    justify-content: flex-end;
  }

  .ib-agent-hooks__failed {
    margin: 0 0 8px;
  }
</style>
