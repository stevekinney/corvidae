<script lang="ts">
  /**
   * Home's Start a chat card: a message box, the agent the chat is with, and Send. It starts as
   * Assistant, which is scripted and needs no model, so Send is live with no provider connected.
   * Choosing a model agent while no provider holds a key replaces the box with the composer's one
   * blocked row ("Connect a model provider to chat", with a way to Assistant), because that is what
   * the chat would do. Send opens New chat with the agent and the message, and the chat sends it
   * there; with nothing typed it opens New chat with the agent alone.
   *
   * While the server does not answer, what was typed stays, the agent select is off with a note
   * saying so, and Send is held by the shell like every control that changes something.
   */
  import { ChatInput } from '@lostgradient/chat';
  import { Button, Select, Textarea } from '@lostgradient/cinder';
  import { Send } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { HOME_COPY } from '../../app/copy.ts';
  import { getConnection } from '../../app/connection.svelte.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { getProviders } from '../../lib/host-providers.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { composerStatusOf } from '../chat/composer-state.ts';
  import HomeCard from './home-card.svelte';
  import { useAgentList } from './home-queries.svelte.ts';
  import { newChatAddress, startingAgent } from './home-start-chat.ts';

  const copy = HOME_COPY.startChat;
  const connection = getConnection();
  const agents = useAgentList();
  const providers = createQuery(() => ({
    queryKey: queryKeys.hostProviders(),
    queryFn: ({ signal }: { signal: AbortSignal }) => getProviders({ signal }),
    retry: false,
  }));

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
      !providers.data.providers.some((provider) => provider.hasKey),
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
    (agents.data ?? []).map((agent) => ({
      value: agent.name,
      label: agentLabel(agent.name, agents.data),
      ...(agent.description === null ? {} : { description: agent.description }),
    })),
  );

  function send(event?: Event): void {
    event?.preventDefault();
    if (selected === undefined || connection.unreachable) return;
    router.navigate(newChatAddress(selected, message));
  }

  /** Command or Control with Enter sends from the box; Enter alone makes a new line. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send(event);
  }
</script>

<div data-testid="home-start-chat">
  <HomeCard title={copy.title} flush={false}>
    {#if blocked !== undefined}
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
              disabled={connection.unreachable || options.length === 0}
              onValueChange={(value) => (chosen = value)}
            />
            {#if connection.unreachable}
              <span class="ib-home-start__note">{copy.offNote}</span>
            {/if}
          </div>
          <Button
            type="submit"
            variant="primary"
            disabled={selected === undefined || connection.unreachable}
          >
            {#snippet leadingIcon()}<Send class="cinder-icon-sm" aria-hidden="true" />{/snippet}
            {copy.send}
          </Button>
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

  .ib-home-start__note {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>
