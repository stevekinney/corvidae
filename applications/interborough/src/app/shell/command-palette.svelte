<script lang="ts">
  /**
   * ⌘K search: chats and agents first, then runs, schedules, workers and reviews by id, then the
   * engine's pages and the commands ("New chat with <agent>", "Go to Reviews"). Choosing a result
   * opens that record, not the collection it belongs to.
   *
   * Each domain search runs independently and swallows its own failure (a 403
   * from a scope this principal lacks, a transient network error)
   * rather than failing the whole palette — a search-as-you-type surface
   * degrading one section to "no results" beats it going blank.
   */
  import { CommandItem, CommandPalette, EmptyState } from '@lostgradient/cinder';
  import type { HttpClient } from '@lostgradient/weft';

  import { formatRelativeTime } from '../../lib/format/index.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import { router, workflowDetailPath } from '../../lib/router.svelte.ts';
  import type { ScopeGate } from '../../lib/scopes.svelte.ts';
  import { newChatPath } from '../../routes/agents/agent-presentation.ts';
  import { PALETTE_COPY } from '../copy.ts';
  import {
    newChatLabel,
    schedulePath,
    searchConsole,
    workerPath,
    type ConsoleSearchResults,
  } from './command-palette-search.ts';

  interface CommandPaletteLauncherProps {
    open: boolean;
    client: HttpClient;
    /** Whether the principal holds `schedules:read`; without it schedules are not searched. Open when omitted. */
    scheduleReadGate?: ScopeGate | undefined;
  }

  let {
    open = $bindable(false),
    client,
    scheduleReadGate = { disabled: false, title: undefined },
  }: CommandPaletteLauncherProps = $props();

  let query = $state('');

  const NOTHING: ConsoleSearchResults = {
    chats: [],
    agents: [],
    newChats: [],
    workflows: [],
    schedules: [],
    workers: [],
    reviews: [],
    pages: [],
  };
  let results = $state<ConsoleSearchResults>(NOTHING);

  async function search(currentQuery: string): Promise<void> {
    const found = await searchConsole(client, currentQuery, { scheduleReadGate });

    // `currentQuery` may be stale by the time these settle — drop results
    // for a query the user has already changed.
    if (currentQuery !== query) return;
    results = found;
  }

  $effect(() => {
    const currentQuery = query;
    const timer = setTimeout(() => void search(currentQuery), 150);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    function onKeydown(event: KeyboardEvent): void {
      const isCommandK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
      if (!isCommandK) return;
      event.preventDefault();
      open = true;
    }
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  function goTo(path: string): void {
    router.navigate(path);
    open = false;
  }

  const enginePages = $derived(results.pages.filter((page) => page.group === 'engine'));
  const reviewsCommand = $derived(results.pages.filter((page) => page.group === 'command'));
  const hasCommands = $derived(results.newChats.length > 0 || reviewsCommand.length > 0);
</script>

<CommandPalette
  bind:open
  bind:query
  label={PALETTE_COPY.label}
  placeholder={PALETTE_COPY.placeholder}
>
  {#snippet items()}
    {#if results.chats.length > 0}
      <li role="presentation" class="weft-command-group">
        <span class="weft-command-group__label">Chats</span>
        <ul role="group" aria-label="Chats">
          {#each results.chats as chat (chat.id)}
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
        </ul>
      </li>
    {/if}
    {#if results.agents.length > 0}
      <li role="presentation" class="weft-command-group">
        <span class="weft-command-group__label">Agents</span>
        <ul role="group" aria-label="Agents">
          {#each results.agents as agent (agent.name)}
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
        </ul>
      </li>
    {/if}
    {#if results.workflows.length > 0}
      <li role="presentation" class="weft-command-group">
        <span class="weft-command-group__label">Runs</span>
        <ul role="group" aria-label="Runs">
          {#each results.workflows as workflow (workflow.id)}
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
        </ul>
      </li>
    {/if}
    {#if results.schedules.length > 0}
      <li role="presentation" class="weft-command-group">
        <span class="weft-command-group__label">Schedules</span>
        <ul role="group" aria-label="Schedules">
          {#each results.schedules as schedule (schedule.id)}
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
        </ul>
      </li>
    {/if}
    {#if results.workers.length > 0}
      <li role="presentation" class="weft-command-group">
        <span class="weft-command-group__label">Workers</span>
        <ul role="group" aria-label="Workers">
          {#each results.workers as worker (worker.id)}
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
        </ul>
      </li>
    {/if}
    {#if results.reviews.length > 0}
      <li role="presentation" class="weft-command-group">
        <span class="weft-command-group__label">Reviews</span>
        <ul role="group" aria-label="Reviews">
          {#each results.reviews as review (review.reviewId)}
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
        </ul>
      </li>
    {/if}
    {#if enginePages.length > 0}
      <li role="presentation" class="weft-command-group">
        <span class="weft-command-group__label">Engine pages</span>
        <ul role="group" aria-label="Engine pages">
          {#each enginePages as page (page.path)}
            <CommandItem value={`page-${page.view}`} onSelect={() => goTo(page.path)}>
              {page.label}
            </CommandItem>
          {/each}
        </ul>
      </li>
    {/if}
    {#if hasCommands}
      <li role="presentation" class="weft-command-group">
        <span class="weft-command-group__label">Commands</span>
        <ul role="group" aria-label="Commands">
          {#each results.newChats as agent (agent.name)}
            <CommandItem
              value={`new-chat-${agent.name}`}
              accessibleLabel={newChatLabel(agent.name)}
              onSelect={() => goTo(newChatPath(agent.name))}
            >
              New chat with <code class="ib-identifier">{agent.name}</code>
            </CommandItem>
          {/each}
          {#each reviewsCommand as page (page.path)}
            <CommandItem value={`go-to-${page.view}`} onSelect={() => goTo(page.path)}>
              Go to {page.label}
            </CommandItem>
          {/each}
        </ul>
      </li>
    {/if}
  {/snippet}
  {#snippet empty()}
    <EmptyState
      title={query.length === 0 ? PALETTE_COPY.emptyTitle : PALETTE_COPY.noMatchesTitle}
      description={query.length === 0
        ? PALETTE_COPY.emptyDescription
        : PALETTE_COPY.noMatchesDescription(query)}
    />
  {/snippet}
</CommandPalette>
