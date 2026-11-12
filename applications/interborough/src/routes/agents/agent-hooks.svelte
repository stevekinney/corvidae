<script lang="ts">
  /**
   * The Hooks tab of an agent's page: the hooks list, narrowed by the Bureau to the hooks limited to
   * this agent. A line says so ("Hooks that run for Tool runner. This is the Hooks list filtered to
   * this agent.") with a secondary New hook at the right, which starts one already limited to the
   * agent. A hook that runs for everything also runs for this agent, and is on the Hooks page; this
   * tab holds what belongs to the agent alone. Its rows are the Hooks page's (`hook-rows.svelte`),
   * with the switch worded Active. An agent with none shows the empty state naming it, whose New
   * hook is secondary too (board PageAgent, rows 38s, 38t and 39q; sweep S51).
   */
  import { Alert, Button, EmptyState, Skeleton } from '@lostgradient/cinder';
  import { Plus } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL } from '../../app/copy/views.ts';
  import { listHooks } from '../../lib/bureau-hooks.ts';
  import { classifyFault } from '../../lib/faults.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { HOOKS_COPY } from '../hooks/hook-copy.ts';
  import HookRows from '../hooks/hook-rows.svelte';
  import HooksUnavailable from '../hooks/hooks-unavailable.svelte';

  interface Props {
    /** The agent's identifier. */
    id: string;
    /** The agent's name as a person reads it, which the line over the rows and the empty state say. */
    name: string;
  }

  let { id, name }: Props = $props();

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
  <Button href={router.href(newHookPath)} variant="secondary" size="sm" onclick={go}>
    {#snippet leadingIcon()}<Plus aria-hidden="true" size={14} />{/snippet}
    {HOOKS_COPY.newAction}
  </Button>
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
      title={copy.emptyTitle(name)}
      description={copy.emptyDescription}
      headingLevel={2}
      action={newHook}
    />
  {:else if hooks.data !== undefined}
    <div class="ib-agent-hooks__intro">
      <p class="ib-agent-hooks__line">{copy.intro(name)}</p>
      {@render newHook()}
    </div>
    <HookRows hooks={hooks.data} />
  {/if}
</div>

<style>
  .ib-agent-hooks {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-agent-hooks__intro {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2) var(--cinder-space-3);
    align-items: center;
    justify-content: space-between;
  }

  .ib-agent-hooks__line {
    flex: 1 1 16rem;
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-agent-hooks__failed {
    margin: 0 0 8px;
  }
</style>
