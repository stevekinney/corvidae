<script lang="ts">
  /**
   * Home's Start a chat card: a message box, the agent the chat is with, and Send. It starts as
   * Assistant, which is scripted and needs no model, so Send is live with no provider connected.
   * Choosing a model agent while no provider holds a key replaces the box with the composer's one
   * blocked row ("Connect a model provider to chat", with a way to Assistant), because that is what
   * the chat would do. Send opens New chat with the agent and hands it the message, which the chat
   * sends there as its first (`new-chat-handoff.ts`); with nothing typed it opens New chat with the
   * agent alone.
   *
   * While the server does not answer, what was typed stays, and Send is disabled (and held by the
   * shell like every control that changes something), its description and tooltip saying it is off
   * until the server is back; the agent can still be chosen, which changes nothing. When the agents
   * cannot be read the card says so, with a Try again.
   */
  import { ChatInput } from '@lostgradient/chat';
  import { Button, Select, Textarea, VisuallyHidden } from '@lostgradient/cinder';
  import { Send } from '@lucide/svelte';

  import { HOME_COPY } from '../../app/copy/home.ts';
  import { getConnection } from '../../app/connection.svelte.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { composerStatusOf } from '../chat/composer-state.ts';
  import { handOffFirstMessage } from '../chat/new-chat-handoff.ts';
  import HomeCard from './home-card.svelte';
  import HomeCardError from './home-card-error.svelte';
  import { useAgentList, useHostProviders } from './home-queries.svelte.ts';
  import { newChatAddress, startChatAgents, startingAgent } from './home-start-chat.ts';

  const copy = HOME_COPY.startChat;
  /** The description of Send while the server is off: why it is off. */
  const OFF_NOTE_ID = 'home-start-chat-off';
  const connection = getConnection();
  const agents = useAgentList();
  const providers = useHostProviders();

  let message = $state('');
  /** The agent the person chose, or `undefined` while Home's own choice (Assistant) stands. */
  let chosen = $state<string | undefined>(undefined);

  const assistant = $derived(startingAgent(agents.data ?? []));
  const selected = $derived(chosen ?? assistant);
  const summary = $derived((agents.data ?? []).find((agent) => agent.name === selected));
  // A scripted agent names no model (`media` is null), so it needs no provider.
  const usesModel = $derived(summary !== undefined && summary.media !== null);
  const noProvider = $derived(
    usesModel &&
      providers.data !== undefined &&
      !providers.data.providers.some((provider) => provider.connected),
  );
  const blocked = $derived(
    noProvider
      ? composerStatusOf({
          unreachable: false,
          restarting: false,
          ended: false,
          noProvider: true,
          connectHref: router.href('/settings/models'),
          useAssistant:
            assistant !== undefined && selected !== assistant
              ? () => (chosen = assistant)
              : undefined,
          newChatHref: router.href('/chats/new'),
          reconnectAttempt: 0,
          queuedFollowUps: 0,
          working: false,
        })
      : undefined,
  );
  const options = $derived(
    startChatAgents(agents.data ?? [], selected).map((agent) => ({
      value: agent.name,
      label: agentLabel(agent.name, agents.data),
      ...(agent.description === null ? {} : { description: agent.description }),
    })),
  );

  function send(event?: Event): void {
    event?.preventDefault();
    if (selected === undefined || connection.unreachable) return;
    handOffFirstMessage(selected, message);
    router.navigate(newChatAddress(selected));
  }

  /** Command or Control with Enter sends from the box; Enter alone makes a new line. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send(event);
  }
</script>

<div data-testid="home-start-chat">
  <HomeCard title={copy.title}>
    {#if agents.data === undefined && agents.isError}
      <HomeCardError title={copy.failed} onRetry={() => void agents.refetch()} />
    {:else if blocked !== undefined}
      <ChatInput id="home-start-chat-blocked" status={blocked} />
    {:else}
      <form class="ib-home-start" onsubmit={send}>
        <Textarea
          id="home-start-chat-message"
          aria-label={copy.messageLabel}
          placeholder={copy.placeholder}
          rows={3}
          bind:value={message}
          onkeydown={onKeydown}
        />
        <div class="ib-home-start__controls">
          <div class="ib-home-start__agent">
            <Select
              id="home-start-chat-agent"
              label={copy.agentLabel}
              labelVisible={false}
              valuePrefix={copy.agentLabel}
              variant="ghost"
              presentation="listbox"
              size="sm"
              {options}
              {...selected === undefined ? {} : { value: selected }}
              disabled={options.length === 0}
              onValueChange={(value) => (chosen = value)}
            />
          </div>
          <!-- While the server is off, why Send is off is its own description and tooltip, never a
               line squeezed into the footer beside the agent (COR-2329). -->
          <Button
            type="submit"
            variant="primary"
            disabled={selected === undefined || connection.unreachable}
            title={connection.unreachable ? copy.offNote : undefined}
            aria-describedby={connection.unreachable ? OFF_NOTE_ID : undefined}
          >
            {#snippet leadingIcon()}<Send class="cinder-icon-sm" aria-hidden="true" />{/snippet}
            {copy.send}
          </Button>
          {#if connection.unreachable}
            <VisuallyHidden id={OFF_NOTE_ID}>{copy.offNote}</VisuallyHidden>
          {/if}
        </div>
      </form>
    {/if}
  </HomeCard>
</div>

<style>
  .ib-home-start {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }

  .ib-home-start__controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-3);
  }

  .ib-home-start__agent {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
    min-inline-size: 0;
  }
</style>
