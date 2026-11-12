<script lang="ts">
  /**
   * One agent of the list as Cinder's status-first two-line row (board PageAgents, "Agents,
   * /agents" and "Phone, list"). Line one is the bold human name, the identifier once in small
   * monospace, and when the agent was last used at the right. Line two is the description on one
   * line, then the chat count at the right (and "Built in" after it for an agent the host ships).
   * The status column is empty for an agent that can run, says "Waiting on you" for one with a chat
   * that waits on the person, and says "Unavailable" in neutral for one its plugin holds back. No
   * avatar is drawn.
   *
   * The whole row is the link to the agent's page (a held-back agent has no page to open yet, so
   * its row is not a link). At the right a fixed slot holds three icon
   * buttons, Memory, New chat and Edit, so the time column lines up whether or not an agent has an
   * editor. An agent a disabled plugin holds back has no buttons: the slot says why, in muted text.
   * New chat stays focusable but inert, with its reason, for an agent that answers with a model
   * while no provider holds a key.
   *
   * On a phone the buttons are not drawn (the agent's page holds Memory, New chat and Edit), and
   * the status moves to line two ahead of the count and the identifier. A held-back agent adds a
   * third line: why, and Enable and restart as an accent link at the right.
   */
  import { Button, StackedListItem, StatusDot } from '@lostgradient/cinder';
  import { Brain, MessageSquarePlus, Pencil } from '@lucide/svelte';

  import { AGENTS_COPY } from '../../app/copy/agents.ts';
  import { agentEditPath, agentMemoryPath, agentPath } from '../../lib/agent-paths.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { rowStatus, type AgentRow } from './agent-list-model.ts';
  import { chatCountText, newChatPath } from './agent-presentation.ts';

  interface Props {
    row: AgentRow;
    /** The viewport is a phone: no buttons, the status on line two and a third line for a held-back agent. */
    phone: boolean;
    /** The time at the right of line one, or `undefined` while the chats are not counted or for a held-back agent with none. */
    activity: string | undefined;
    /** Whether the Bureau has counted the chats, so "No chats yet" is a fact and not a failed read. */
    countsKnown: boolean;
    /** Whether the agent answers with a model and no provider holds a key, so New chat cannot work yet. */
    chatBlocked: boolean;
    /** The plugin's title as a person reads it, for the words of a held-back agent. */
    pluginTitle: string;
    /** Opens the question that enables the plugin and restarts. */
    onEnable: () => void;
  }

  let { row, phone, activity, countsKnown, chatBlocked, pluginTitle, onEnable }: Props = $props();

  const status = $derived(countsKnown || row.state === 'unavailable' ? rowStatus(row) : undefined);
  const count = $derived(
    row.state === 'unavailable' && row.usage === undefined
      ? undefined
      : countsKnown
        ? chatCountText(row.usage)
        : undefined,
  );
  const held = $derived(row.reason ?? AGENTS_COPY.row.pluginDisabled(pluginTitle));
  const reasonId = $derived(`${row.id}-new-chat-reason`);
</script>

{#snippet statusWord()}
  {#if status === 'waiting'}
    <span data-testid="agent-needs-you"><StatusDot word="Waiting on you" size="sm" /></span>
  {:else}
    <StatusDot word="Unavailable" size="sm" />
  {/if}
{/snippet}

{#snippet titleLine()}
  <span class="ib-agent-row__title">
    <span class="ib-agent-name">{row.title}</span>
    {#if !phone}<code class="ib-agent-id" data-testid="agent-identifier">{row.id}</code>{/if}
  </span>
{/snippet}

{#snippet timeText()}
  <span data-testid="agent-last-chat">{activity}</span>
{/snippet}

{#snippet lineTwo()}
  <span class="ib-agent-row__line-two">
    {#if phone}
      {#if count !== undefined}
        <span data-testid="agent-chat-count">{count}</span>
      {/if}
      {#if row.builtIn}<span data-testid="agent-built-in">{AGENTS_COPY.row.builtIn}</span>{/if}
      <code class="ib-agent-id" data-testid="agent-identifier">{row.id}</code>
    {:else}
      <span class="ib-agent-row__description" data-testid="agent-description"
        >{row.description ?? ''}</span
      >
      {#if count !== undefined}
        <span class="ib-agent-row__count">
          <span data-testid="agent-chat-count">{count}</span>
          {#if row.builtIn}<span data-testid="agent-built-in">{AGENTS_COPY.row.builtIn}</span>{/if}
        </span>
      {/if}
    {/if}
  </span>
{/snippet}

{#snippet actionSlot()}
  {#if row.state === 'unavailable'}
    <span class="ib-agent-row__held" data-testid="agent-held">{held}</span>
  {:else}
    <span class="ib-agent-row__actions">
      <Button
        href={router.href(agentMemoryPath(row.id))}
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={AGENTS_COPY.row.memoryOf(row.title)}
        title={AGENTS_COPY.row.memoryOf(row.title)}
        data-testid="agent-memory"
      >
        <Brain size={16} aria-hidden="true" />
      </Button>
      {#if chatBlocked}
        <span id={reasonId} class="cinder-sr-only">{AGENTS_COPY.row.connectToChat}</span>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={AGENTS_COPY.row.newChatWith(row.title)}
          aria-disabled="true"
          aria-describedby={reasonId}
          title={AGENTS_COPY.row.connectToChat}
          data-testid="agent-new-chat"
          onclick={(event) => event.preventDefault()}
        >
          <MessageSquarePlus size={16} aria-hidden="true" />
        </Button>
      {:else}
        <Button
          href={router.href(newChatPath(row.id))}
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={AGENTS_COPY.row.newChatWith(row.title)}
          title={AGENTS_COPY.row.newChatWith(row.title)}
          data-testid="agent-new-chat"
        >
          <MessageSquarePlus size={16} aria-hidden="true" />
        </Button>
      {/if}
      {#if row.editable}
        <Button
          href={router.href(agentEditPath(row.id))}
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={AGENTS_COPY.row.editAgent(row.title)}
          title={AGENTS_COPY.row.editAgent(row.title)}
          data-testid="agent-edit"
        >
          <Pencil size={16} aria-hidden="true" />
        </Button>
      {:else}
        <span class="ib-agent-row__no-edit" aria-hidden="true"></span>
      {/if}
    </span>
  {/if}
{/snippet}

{#snippet heldLine()}
  <span class="ib-agent-row__held-line">
    <span class="ib-agent-row__held" data-testid="agent-held">{held}</span>
    <Button
      variant="ghost-accent"
      size="sm"
      onclick={onEnable}
      data-changes
      data-testid="agent-enable-row">{AGENTS_COPY.enable.action}</Button
    >
  </span>
{/snippet}

<!-- A held-back agent has no page to open yet: its address is not an agent the Bureau lists, so the
     row is not a link, and the only way on is Enable and restart. -->
{#if row.state === 'unavailable'}
  <StackedListItem
    tooltip={row.title}
    data-agent={row.id}
    data-state={row.state}
    {...status === undefined ? {} : { status: statusWord }}
    {...activity === undefined ? {} : { time: timeText }}
    {...phone ? { detail: heldLine } : { trailing: actionSlot }}
  >
    {#snippet title()}{@render titleLine()}{/snippet}
    {#snippet meta()}{@render lineTwo()}{/snippet}
  </StackedListItem>
{:else}
  <StackedListItem
    href={router.href(agentPath(row.id))}
    tooltip={row.title}
    data-agent={row.id}
    data-state={row.state}
    {...status === undefined ? {} : { status: statusWord }}
    {...activity === undefined ? {} : { time: timeText }}
    {...phone ? {} : { trailing: actionSlot }}
  >
    {#snippet title()}{@render titleLine()}{/snippet}
    {#snippet meta()}{@render lineTwo()}{/snippet}
  </StackedListItem>
{/if}
