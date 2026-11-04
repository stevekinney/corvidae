<script lang="ts">
  /**
   * ⌘K search over everything the console holds, and the actions it can run, in one order: what is
   * waiting on the person, then chats, runs and workflows (with schedules, workers and reviews by
   * id), then agents and tools under one heading, then the actions with their shortcuts. A query
   * that starts with `>` is for actions only, and one that starts with `@` for agents only.
   * Choosing a result opens that record, not the collection it belongs to.
   *
   * With nothing typed it lists what is waiting, then the "Go to" rows and New chat, under no
   * heading of their own (design row 03c). Each row is a glyph, the title, and its meta on the same
   * line ("Refund order 4471 for $42.00? · Approval · waiting"); the footer names the `>` and `@`
   * prefixes (design rows 03c, 03g).
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
  import { CommandItem, CommandPalette, EmptyState, Kbd } from '@lostgradient/cinder';
  import type { HttpClient } from '@lostgradient/weft';
  import {
    Bot,
    CalendarClock,
    CircleQuestionMark,
    Cpu,
    Inbox,
    MessageSquare,
    Play,
    Plus,
    Workflow,
    Wrench,
  } from '@lucide/svelte';
  import type { Snippet } from 'svelte';

  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import { router, workflowDetailPath } from '../../lib/router.svelte.ts';
  import type { ScopeGate } from '../../lib/scopes.svelte.ts';
  import { shortcuts, type ShortcutAction, type ShortcutRegistry } from '../../lib/shortcuts.ts';
  import { CATALOG_STALE_TIME_MS, loadCatalog } from '../../lib/workflow-catalog.ts';
  import { workflowTypePath } from '../../lib/workflow-type-paths.ts';
  import { getAgentCatalog } from '../../lib/agent-definitions.ts';
  import { newChatPath } from '../../routes/agents/agent-presentation.ts';
  import { actionIcon } from './destinations.ts';
  import { PALETTE_COPY } from '../copy.ts';
  import type { NotificationStore } from '../notifications.svelte.ts';
  import {
    matchActions,
    matchWaiting,
    memoizeRead,
    NARROWED_RESULTS,
    newChatAboutPath,
    newChatLabel,
    newChatTopic,
    NO_RESULTS,
    parseQuery,
    runMeta,
    schedulePath,
    searchConsole,
    toolPath,
    waitingLabel,
    waitingMeta,
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
  // Read when the palette opens as well as when the query changes, because whether the registry's
  // keys are printed beside an action depends on a preference that is changed while it is closed.
  const actions = $derived(
    open && (all || actionsOnly)
      ? matchActions(
          registry.actions(),
          parsed.text,
          actionsOnly || parsed.text.length === 0 ? NARROWED_RESULTS : undefined,
        )
      : [],
  );
  // A search settles after the query changed, so what the query is for decides what is shown of it.
  const shown = $derived<ConsoleSearchResults>(
    actionsOnly
      ? { ...NO_RESULTS, newChats: results.newChats, failed: results.failed }
      : agentsOnly
        ? {
            ...NO_RESULTS,
            agents: results.agents,
            agentNames: results.agentNames,
            failed: results.failed,
          }
        : parsed.text.length === 0
          ? NO_RESULTS
          : results,
  );
  // The notice sits among the rows only when there are some; with none, the empty state says it.
  const hasRows = $derived(
    waiting.length +
      actions.length +
      shown.chats.length +
      shown.runs.length +
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
  /**
   * What "New chat about" starts with, listed last among the actions so that Enter on a search that
   * names a place goes there: the typed text of a search that names no kind and found something. A search that found nothing says so instead (the palette's empty state), so the
   * action never stands alone under a "No matches".
   */
  const topic = $derived(all && hasRows ? newChatTopic(parsed.text) : undefined);
  /** A person's name for an agent: its display name, else the identifier it is known by. */
  const agentLabel = (name: string): string => shown.agentNames.get(name) ?? name;
  /** With nothing typed, the "Go to" rows and New chat run on under no heading of their own (row 03c). */
  const actionsHeading = $derived(parsed.text.length > 0 || !all);
</script>

{#snippet section(label: string, rows: Snippet, heading: boolean = true)}
  <li role="presentation" class="cinder-command-group">
    {#if heading}<span class="cinder-command-group__label">{label}</span>{/if}
    <ul role="group" aria-label={label}>
      {@render rows()}
    </ul>
  </li>
{/snippet}

{#snippet footer()}
  <span><Kbd size="sm" label=">" /> {PALETTE_COPY.footer.actions}</span>
  <span><Kbd size="sm" label="@" /> {PALETTE_COPY.footer.agents}</span>
  <span>{PALETTE_COPY.footer.open}</span>
{/snippet}

<CommandPalette
  bind:open
  bind:query
  label={PALETTE_COPY.label}
  placeholder={PALETTE_COPY.placeholder}
  {footer}
>
  {#snippet items()}
    {#if shown.failed.length > 0 && hasRows}
      <li role="presentation" class="cinder-command-group">
        <span role="status" class="cinder-command-group__label">
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
            leadingTone="warning"
            onSelect={() => goTo(item.href)}
          >
            {item.title}
            {#snippet leading()}
              {#if item.kind === 'approval'}<Inbox />{:else}<CircleQuestionMark />{/if}
            {/snippet}
            {#snippet meta()}{waitingMeta(item)}{/snippet}
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
            accessibleLabel={`${title}, ${agentLabel(chat.agentName)}`}
            onSelect={() => goTo(chatSessionPath(chat.id))}
          >
            {title}
            {#snippet leading()}<MessageSquare />{/snippet}
            {#snippet meta()}{agentLabel(chat.agentName)}{/snippet}
          </CommandItem>
        {/each}
      {/snippet}
      {@render section(PALETTE_COPY.groups.chats, chatRows)}
    {/if}
    {#if shown.runs.length > 0 || shown.workflows.length > 0}
      {#snippet runRows()}
        {#each shown.runs as run (run.id)}
          {@const agent = run.agentName === null ? undefined : agentLabel(run.agentName)}
          <CommandItem
            value={`run-${run.id}`}
            accessibleLabel={`${run.title}, ${runMeta(run, agent).replaceAll(' · ', ', ')}`}
            onSelect={() => goTo(workflowDetailPath(run.id))}
          >
            {run.title}
            {#snippet leading()}<Play />{/snippet}
            {#snippet meta()}{runMeta(run, agent)}{/snippet}
          </CommandItem>
        {/each}
        {#each shown.workflows as workflow (workflow.id)}
          <CommandItem
            value={`workflow-${workflow.id}`}
            accessibleLabel={`${workflow.id}, ${workflow.type}`}
            onSelect={() => goTo(workflowDetailPath(workflow.id))}
          >
            <code class="ib-identifier">{workflow.id}</code>
            {#snippet leading()}<Play />{/snippet}
            {#snippet meta()}<code class="ib-identifier">{workflow.type}</code>{/snippet}
          </CommandItem>
        {/each}
      {/snippet}
      {@render section(PALETTE_COPY.groups.runs, runRows)}
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
            {#snippet leading()}<Workflow />{/snippet}
            {#snippet meta()}{#if workflow.description !== null}{workflow.description}{/if}{/snippet}
          </CommandItem>
        {/each}
      {/snippet}
      {@render section(PALETTE_COPY.groups.workflows, definitionRows)}
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
            {#snippet leading()}<CalendarClock />{/snippet}
            {#snippet meta()}<code class="ib-identifier">{schedule.workflowType}</code>{/snippet}
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
            {#snippet leading()}<Cpu />{/snippet}
            {#snippet meta()}<code class="ib-identifier">{worker.queue}</code>{/snippet}
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
            {#snippet leading()}<Inbox />{/snippet}
            {#snippet meta()}{review.reviewType}{/snippet}
          </CommandItem>
        {/each}
      {/snippet}
      {@render section(PALETTE_COPY.groups.reviews, reviewRows)}
    {/if}
    {#if shown.agents.length > 0 || shown.tools.length > 0}
      {#snippet agentAndToolRows()}
        {#each shown.agents as agent (agent.name)}
          {@const label = agentLabel(agent.name)}
          {@const named = label !== agent.name}
          <CommandItem
            value={`agent-${agent.name}`}
            accessibleLabel={[label, ...(named ? [agent.name] : []), PALETTE_COPY.agentKind].join(
              ', ',
            )}
            onSelect={() => goTo(agentPath(agent.name))}
          >
            {label}
            {#snippet leading()}<Bot />{/snippet}
            {#snippet meta()}{#if named}<code class="ib-identifier">{agent.name}</code
                >{' · '}{/if}{PALETTE_COPY.agentKind}{/snippet}
          </CommandItem>
        {/each}
        {#each shown.tools as tool (tool.name)}
          {@const users = tool.users.map(agentLabel)}
          {@const named = tool.title !== null && tool.title !== tool.name}
          <CommandItem
            value={`tool-${tool.name}`}
            accessibleLabel={[
              tool.title ?? tool.name,
              ...(named ? [tool.name] : []),
              PALETTE_COPY.toolKind,
              ...users,
            ].join(', ')}
            onSelect={() => goTo(toolPath(tool.name))}
          >
            {tool.title ?? tool.name}
            {#snippet leading()}<Wrench />{/snippet}
            {#snippet meta()}{#if named}<code class="ib-identifier">{tool.name}</code
                >{' · '}{/if}{PALETTE_COPY.toolKind}{#if users.length > 0}{' · '}{users.join(
                  ', ',
                )}{/if}{/snippet}
          </CommandItem>
        {/each}
      {/snippet}
      {@render section(PALETTE_COPY.groups.agentsAndTools, agentAndToolRows)}
    {/if}
    {#if actions.length > 0 || shown.newChats.length > 0 || topic !== undefined}
      {#snippet actionRows()}
        {#each actions as action (action.label)}
          {@const Icon = actionIcon(action.label)}
          <CommandItem
            value={`action-${action.label}`}
            accessibleLabel={action.label}
            keys={action.keys.length > 0 ? action.keys : undefined}
            onSelect={() => run({ ...action })}
          >
            {action.label}
            {#snippet leading()}<Icon />{/snippet}
          </CommandItem>
        {/each}
        {#each shown.newChats as agent (agent.name)}
          <CommandItem
            value={`new-chat-${agent.name}`}
            accessibleLabel={newChatLabel(agent.name)}
            onSelect={() => goTo(newChatPath(agent.name))}
          >
            New chat with <code class="ib-identifier">{agent.name}</code>
            {#snippet leading()}<Plus />{/snippet}
          </CommandItem>
        {/each}
        {#if topic !== undefined}
          <CommandItem
            value="new-chat-about"
            accessibleLabel={PALETTE_COPY.newChatAbout(topic)}
            onSelect={() => goTo(newChatAboutPath(topic))}
          >
            {PALETTE_COPY.newChatAbout(topic)}
            {#snippet leading()}<Plus />{/snippet}
          </CommandItem>
        {/if}
      {/snippet}
      {@render section(PALETTE_COPY.groups.actions, actionRows, actionsHeading)}
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
