<script lang="ts">
  /**
   * ⌘K search over everything the console holds, and the actions it can run, in one order: what is
   * waiting on the person, then chats, workflows and runs (with schedules, workers and reviews by
   * id), then agents and tools, then the actions with their shortcuts. A query that starts with `>`
   * is for actions only, and one that starts with `@` for agents only. Choosing a result opens that
   * record, not the collection it belongs to.
   *
   * What is waiting comes from the notification store, and the actions from the shortcut registry
   * (`../../lib/shortcuts.ts`) plus "New chat with <agent>", so a shortcut registered later is an
   * action here without a second list. Every domain a principal's scopes do not cover is left
   * unread (`./command-palette-search.ts`).
   *
   * Each domain search runs independently and swallows its own failure (a 403
   * from a scope this principal lacks, a transient network error)
   * rather than failing the whole palette — a search-as-you-type surface
   * degrading one section to "no results" beats it going blank.
   */
  import { CommandItem, CommandPalette, EmptyState, ShortcutHint } from '@lostgradient/cinder';
  import type { HttpClient } from '@lostgradient/weft';
  import type { Snippet } from 'svelte';

  import { formatRelativeTime } from '../../lib/format/index.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import { router, workflowDetailPath } from '../../lib/router.svelte.ts';
  import type { ScopeGate } from '../../lib/scopes.svelte.ts';
  import { shortcuts, type ShortcutAction, type ShortcutRegistry } from '../../lib/shortcuts.ts';
  import { CATALOG_STALE_TIME_MS, loadCatalog } from '../../lib/workflow-catalog.ts';
  import { workflowTypePath } from '../../lib/workflow-type-paths.ts';
  import { getAgentCatalog } from '../../lib/agent-definitions.ts';
  import { newChatPath } from '../../routes/agents/agent-presentation.ts';
  import { PALETTE_COPY } from '../copy.ts';
  import type { NotificationStore } from '../notifications.svelte.ts';
  import {
    matchActions,
    matchWaiting,
    memoizeRead,
    NARROWED_RESULTS,
    newChatLabel,
    NO_RESULTS,
    parseQuery,
    schedulePath,
    searchConsole,
    toolPath,
    waitingLabel,
    workerPath,
    type ConsoleSearchResults,
  } from './command-palette-search.ts';

  interface CommandPaletteLauncherProps {
    open: boolean;
    client: HttpClient;
    /** What is waiting on the person; the palette lists it first. Nothing is when omitted. */
    store?: NotificationStore | undefined;
    /** The shortcuts the palette lists as actions. The shell's registry when omitted. */
    registry?: ShortcutRegistry | undefined;
    /** Whether the principal holds `schedules:read`; without it schedules are not searched. Open when omitted. */
    scheduleReadGate?: ScopeGate | undefined;
    /** `workflows:read`, for workflow types and runs. Open when omitted. */
    workflowReadGate?: ScopeGate | undefined;
    /** `reviews:read`, for reviews. Open when omitted. */
    reviewReadGate?: ScopeGate | undefined;
    /** `system:read`, for workers. Open when omitted. */
    systemReadGate?: ScopeGate | undefined;
  }

  const OPEN_GATE: ScopeGate = { disabled: false, title: undefined };

  let {
    open = $bindable(false),
    client,
    store,
    registry = shortcuts,
    scheduleReadGate = OPEN_GATE,
    workflowReadGate = OPEN_GATE,
    reviewReadGate = OPEN_GATE,
    systemReadGate = OPEN_GATE,
  }: CommandPaletteLauncherProps = $props();

  let query = $state('');

  let results = $state<ConsoleSearchResults>(NO_RESULTS);

  // The catalogs change slowly and are large, so a keystroke is answered from the last read.
  const readWorkflows = $derived(memoizeRead(() => loadCatalog(client), CATALOG_STALE_TIME_MS));
  const readTools = $derived(
    memoizeRead(() => getAgentCatalog().then((catalog) => catalog.tools), CATALOG_STALE_TIME_MS),
  );

  async function search(currentQuery: string): Promise<void> {
    const found = await searchConsole(client, currentQuery, {
      scheduleReadGate,
      workflowReadGate,
      reviewReadGate,
      systemReadGate,
      readWorkflows,
      readTools,
    });

    // `currentQuery` may be stale by the time these settle — drop results
    // for a query the user has already changed.
    if (currentQuery !== query) return;
    results = found;
  }

  $effect(() => {
    const currentQuery = query;
    // poll-reason: timer
    const timer = setTimeout(() => void search(currentQuery), 150);
    return () => clearTimeout(timer);
  });

  function goTo(path: string): void {
    router.navigate(path);
    open = false;
  }

  function run(action: ShortcutAction): void {
    open = false;
    action.run();
  }

  const parsed = $derived(parseQuery(query));
  const all = $derived(parsed.mode === 'all');
  const actionsOnly = $derived(parsed.mode === 'actions');
  const agentsOnly = $derived(parsed.mode === 'agents');
  // The local kinds are read from the store and the registry as they are now, not searched for.
  const waiting = $derived(
    all && store !== undefined ? matchWaiting(store.items, parsed.text) : [],
  );
  const actions = $derived(
    all || actionsOnly
      ? matchActions(registry.actions(), parsed.text, actionsOnly ? NARROWED_RESULTS : undefined)
      : [],
  );
  // A search settles after the query changed, so what the query is for decides what is shown of it.
  const shown = $derived<ConsoleSearchResults>(
    actionsOnly
      ? { ...NO_RESULTS, newChats: results.newChats, failed: results.failed }
      : agentsOnly
        ? { ...NO_RESULTS, agents: results.agents, failed: results.failed }
        : parsed.text.length === 0
          ? NO_RESULTS
          : results,
  );
  // The notice sits among the rows only when there are some; with none, the empty state says it.
  const hasRows = $derived(
    waiting.length +
      actions.length +
      shown.chats.length +
      shown.definitions.length +
      shown.workflows.length +
      shown.schedules.length +
      shown.workers.length +
      shown.reviews.length +
      shown.agents.length +
      shown.tools.length +
      shown.newChats.length >
      0,
  );
</script>

{#snippet section(label: string, rows: Snippet)}
  <li role="presentation" class="weft-command-group">
    <span class="weft-command-group__label">{label}</span>
    <ul role="group" aria-label={label}>
      {@render rows()}
    </ul>
  </li>
{/snippet}

<CommandPalette
  bind:open
  bind:query
  label={PALETTE_COPY.label}
  placeholder={PALETTE_COPY.placeholder}
>
  {#snippet items()}
    {#if shown.failed.length > 0 && hasRows}
      <li role="presentation" class="weft-command-group">
        <span role="status" class="weft-command-group__label">
          {PALETTE_COPY.searchFailedDescription(shown.failed)}
        </span>
      </li>
    {/if}
    {#if waiting.length > 0}
      {#snippet waitingRows()}
        {#each waiting as item (item.id)}
          <CommandItem
            value={`waiting-${item.id}`}
            accessibleLabel={waitingLabel(item)}
            onSelect={() => goTo(item.href)}
          >
            {item.title}
            {#snippet trailing()}
              <span class="weft-command-meta">
                {#if item.detail !== ''}<span>{item.detail}</span>{/if}
                <span>{formatRelativeTime(item.emittedAtMs)}</span>
              </span>
            {/snippet}
          </CommandItem>
        {/each}
      {/snippet}
      {@render section(PALETTE_COPY.groups.waiting, waitingRows)}
    {/if}
    {#if shown.chats.length > 0}
      {#snippet chatRows()}
        {#each shown.chats as chat (chat.id)}
          {@const title = chat.title ?? chat.lastMessagePreview ?? PALETTE_COPY.untitledChat}
          <CommandItem
            value={`chat-${chat.id}`}
            accessibleLabel={`${title}, ${chat.agentName}`}
            onSelect={() => goTo(chatSessionPath(chat.id))}
          >
            {title}
            {#snippet trailing()}
              <span class="weft-command-meta">
                <code class="ib-identifier">{chat.agentName}</code>
                <span>{formatRelativeTime(Date.parse(chat.updatedAt))}</span>
              </span>
            {/snippet}
          </CommandItem>
        {/each}
      {/snippet}
      {@render section(PALETTE_COPY.groups.chats, chatRows)}
    {/if}
    {#if shown.definitions.length > 0}
      {#snippet definitionRows()}
        {#each shown.definitions as workflow (workflow.name)}
          <CommandItem
            value={`definition-${workflow.name}`}
            accessibleLabel={workflow.description === null
              ? workflow.name
              : `${workflow.name}, ${workflow.description}`}
            onSelect={() => goTo(workflowTypePath(workflow.name))}
          >
            <code class="ib-identifier">{workflow.name}</code>
            {#snippet trailing()}
              {#if workflow.description !== null}
                <span class="weft-command-meta">{workflow.description}</span>
              {/if}
            {/snippet}
          </CommandItem>
        {/each}
      {/snippet}
      {@render section(PALETTE_COPY.groups.workflows, definitionRows)}
    {/if}
    {#if shown.workflows.length > 0}
      {#snippet runRows()}
        {#each shown.workflows as workflow (workflow.id)}
          <CommandItem
            value={`workflow-${workflow.id}`}
            accessibleLabel={`${workflow.id}, ${workflow.type}`}
            onSelect={() => goTo(workflowDetailPath(workflow.id))}
          >
            <code class="ib-identifier">{workflow.id}</code>
            {#snippet trailing()}
              <span class="weft-command-meta"
                ><code class="ib-identifier">{workflow.type}</code></span
              >
            {/snippet}
          </CommandItem>
        {/each}
      {/snippet}
      {@render section(PALETTE_COPY.groups.runs, runRows)}
    {/if}
    {#if shown.schedules.length > 0}
      {#snippet scheduleRows()}
        {#each shown.schedules as schedule (schedule.id)}
          <CommandItem
            value={`schedule-${schedule.id}`}
            accessibleLabel={`${schedule.id}, ${schedule.workflowType}`}
            onSelect={() => goTo(schedulePath(schedule.id))}
          >
            <code class="ib-identifier">{schedule.id}</code>
            {#snippet trailing()}
              <span class="weft-command-meta"
                ><code class="ib-identifier">{schedule.workflowType}</code></span
              >
            {/snippet}
          </CommandItem>
        {/each}
      {/snippet}
      {@render section(PALETTE_COPY.groups.schedules, scheduleRows)}
    {/if}
    {#if shown.workers.length > 0}
      {#snippet workerRows()}
        {#each shown.workers as worker (worker.id)}
          <CommandItem
            value={`worker-${worker.id}`}
            accessibleLabel={`${worker.id}, ${worker.queue}`}
            onSelect={() => goTo(workerPath(worker.id))}
          >
            <code class="ib-identifier">{worker.id}</code>
            {#snippet trailing()}
              <span class="weft-command-meta"
                ><code class="ib-identifier">{worker.queue}</code></span
              >
            {/snippet}
          </CommandItem>
        {/each}
      {/snippet}
      {@render section(PALETTE_COPY.groups.workers, workerRows)}
    {/if}
    {#if shown.reviews.length > 0}
      {#snippet reviewRows()}
        {#each shown.reviews as review (review.reviewId)}
          <CommandItem
            value={`review-${review.reviewId}`}
            accessibleLabel={`${review.reviewId}, ${review.reviewType}`}
            onSelect={() => goTo('/reviews')}
          >
            <code class="ib-identifier">{review.reviewId}</code>
            {#snippet trailing()}
              <span class="weft-command-meta">{review.reviewType}</span>
            {/snippet}
          </CommandItem>
        {/each}
      {/snippet}
      {@render section(PALETTE_COPY.groups.reviews, reviewRows)}
    {/if}
    {#if shown.agents.length > 0}
      {#snippet agentRows()}
        {#each shown.agents as agent (agent.name)}
          <CommandItem
            value={`agent-${agent.name}`}
            accessibleLabel={agent.description === null
              ? agent.name
              : `${agent.name}, ${agent.description}`}
            onSelect={() => goTo(agentPath(agent.name))}
          >
            <code class="ib-identifier">{agent.name}</code>
            {#snippet trailing()}
              {#if agent.description !== null}
                <span class="weft-command-meta">{agent.description}</span>
              {/if}
            {/snippet}
          </CommandItem>
        {/each}
      {/snippet}
      {@render section(PALETTE_COPY.groups.agents, agentRows)}
    {/if}
    {#if shown.tools.length > 0}
      {#snippet toolRows()}
        {#each shown.tools as tool (tool.name)}
          {@const summary = tool.shortDescription ?? tool.description}
          <CommandItem
            value={`tool-${tool.name}`}
            accessibleLabel={`${tool.name}, ${summary}`}
            onSelect={() => goTo(toolPath(tool.name))}
          >
            <code class="ib-identifier">{tool.name}</code>
            {#snippet trailing()}
              <span class="weft-command-meta">{summary}</span>
            {/snippet}
          </CommandItem>
        {/each}
      {/snippet}
      {@render section(PALETTE_COPY.groups.tools, toolRows)}
    {/if}
    {#if actions.length > 0 || shown.newChats.length > 0}
      {#snippet actionRows()}
        {#each actions as action (action.label)}
          <CommandItem
            value={`action-${action.label}`}
            accessibleLabel={action.label}
            keyboardShortcut={action.keys.join(' ')}
            onSelect={() => run({ ...action })}
          >
            {action.label}
            {#snippet trailing()}
              <ShortcutHint
                keys={[...action.keys]}
                keysLabel={action.keys.join(PALETTE_COPY.keysThen)}
              />
            {/snippet}
          </CommandItem>
        {/each}
        {#each shown.newChats as agent (agent.name)}
          <CommandItem
            value={`new-chat-${agent.name}`}
            accessibleLabel={newChatLabel(agent.name)}
            onSelect={() => goTo(newChatPath(agent.name))}
          >
            New chat with <code class="ib-identifier">{agent.name}</code>
          </CommandItem>
        {/each}
      {/snippet}
      {@render section(PALETTE_COPY.groups.actions, actionRows)}
    {/if}
  {/snippet}
  {#snippet empty()}
    {#if shown.failed.length > 0 && query.length > 0}
      <EmptyState
        kind="first-use"
        title={PALETTE_COPY.searchFailedTitle}
        description={PALETTE_COPY.searchFailedDescription(shown.failed)}
      />
    {:else}
      <EmptyState
        kind={query.length === 0 ? 'first-use' : 'filtered'}
        onClearFilters={() => (query = '')}
        title={query.length === 0 ? PALETTE_COPY.emptyTitle : PALETTE_COPY.noMatchesTitle}
        description={query.length === 0
          ? PALETTE_COPY.emptyDescription
          : PALETTE_COPY.noMatchesDescription(query)}
      />
    {/if}
  {/snippet}
</CommandPalette>
