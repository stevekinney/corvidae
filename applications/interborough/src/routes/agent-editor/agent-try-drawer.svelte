<script lang="ts">
  /**
   * Try it: a drawer beside the agent editor that chats with the agent as the form describes it
   * now, saved or not (`bureau.agents.try`, COR-1911). The first message starts a throwaway chat
   * (`agent-try-session.svelte.ts`); from then on the conversation is the application's chat over
   * that chat's context. Nothing is saved: no agent file, no memory, and the chat is not in the chat
   * list.
   *
   * Closing the drawer, starting over, and leaving the page each end the chat, which deletes its
   * context and the agent with it. The agent in the chat is the form as it was when the chat
   * started; the drawer says so once the form has changed, and Start over tries the new one.
   */
  import { onDestroy } from 'svelte';

  import { Alert, Button, Drawer, Textarea } from '@lostgradient/cinder';
  import { Chat } from '@lostgradient/chat';

  import { AGENT_EDITOR_COPY, CHAT_COPY } from '../../app/copy.ts';
  import { getConnection } from '../../app/connection.svelte.ts';
  import type { AgentEditorState } from './agent-editor-state.svelte.ts';
  import { AgentTrySession } from './agent-try-session.svelte.ts';

  interface Props {
    editor: AgentEditorState;
    open: boolean;
  }

  let { editor, open = $bindable() }: Props = $props();

  const copy = AGENT_EDITOR_COPY.try;
  const connection = getConnection();
  const trial = new AgentTrySession();

  let message = $state('');

  const changed = $derived(
    trial.phase === 'chatting' && JSON.stringify(editor.toDefinition()) !== trial.triedWith,
  );
  const startable = $derived(message.trim() !== '' && trial.phase === 'idle');

  // Closing the drawer ends the chat: there is nothing to come back to.
  $effect(() => {
    if (!open) void trial.end();
  });

  onDestroy(() => {
    void trial.end();
  });

  function start(event: SubmitEvent): void {
    event.preventDefault();
    if (!startable) return;
    const first = message.trim();
    message = '';
    void trial.start(editor.toDefinition(), first);
  }

  function startOver(): void {
    void trial.end();
  }
</script>

<Drawer bind:open title={copy.title} size="md">
  <div class="weft-agent-try" data-testid="agent-try" data-context-id={trial.contextId}>
    <p class="weft-agent-try__note">{copy.description}</p>

    {#if trial.failure !== null}
      <Alert variant="danger" dismissible onDismiss={() => (trial.failure = null)}>
        <p class="weft-agent-try__alert-title">{copy.failed}</p>
        <p class="weft-agent-try__alert-body" data-testid="agent-try-failure">{trial.failure}</p>
      </Alert>
    {/if}

    {#if trial.removalFailed}
      <Alert variant="warning" dismissible onDismiss={() => (trial.removalFailed = false)}>
        <p class="weft-agent-try__alert-body">{copy.notRemoved}</p>
      </Alert>
    {/if}

    {#if trial.chat !== undefined && trial.phase === 'chatting'}
      {@const chat = trial.chat}
      {#if changed}
        <Alert variant="info">
          <p class="weft-agent-try__alert-body" data-testid="agent-try-changed">{copy.changed}</p>
        </Alert>
      {/if}
      {#if chat.failure !== undefined}
        <Alert variant="danger" dismissible onDismiss={() => chat.dismissFailure()}>
          <p class="weft-agent-try__alert-title">{CHAT_COPY.failureTitle}</p>
          <p class="weft-agent-try__alert-body">{chat.failure}</p>
        </Alert>
      {/if}
      {#if chat.disconnected}
        <Alert variant="warning">
          <p class="weft-agent-try__alert-title">{CHAT_COPY.disconnected.title}</p>
          <p class="weft-agent-try__alert-body">{CHAT_COPY.disconnected.description}</p>
          <Button size="sm" variant="secondary" onclick={() => void chat.reconnect()}
            >{CHAT_COPY.disconnected.reconnect}</Button
          >
        </Alert>
      {/if}
      <div class="weft-agent-try__chat" role="region" aria-label={copy.chatLabel}>
        <Chat
          id={`try-${chat.sessionId}`}
          conversation={chat.conversation}
          adapter={chat.chatAdapter}
          streaming={chat.streaming}
          disabled={connection.unreachable || chat.disconnected}
          streamingStatus={chat.stopping ? CHAT_COPY.stopping : ''}
          capabilities={{ attachments: false, editing: false, quote: false }}
        />
      </div>
    {:else}
      <form class="weft-agent-try__start" onsubmit={start}>
        <Textarea
          id="agent-try-message"
          label={copy.messageLabel}
          placeholder={copy.messagePlaceholder}
          rows={4}
          disabled={trial.phase === 'starting'}
          bind:value={message}
        />
        <div class="weft-agent-try__actions">
          <Button
            data-changes
            type="submit"
            variant="primary"
            loading={trial.phase === 'starting'}
            disabled={!startable}>{copy.send}</Button
          >
        </div>
      </form>
    {/if}
  </div>

  {#snippet footer()}
    {#if trial.phase === 'chatting'}
      <Button data-changes type="button" variant="secondary" onclick={startOver}
        >{copy.startOver}</Button
      >
    {/if}
    <!-- Ending the trial deletes its chat: a write to the Bureau. -->
    <Button data-changes type="button" variant="primary" onclick={() => (open = false)}
      >{copy.close}</Button
    >
  {/snippet}
</Drawer>

<style>
  .weft-agent-try {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-block-size: 0;
  }

  .weft-agent-try__note,
  .weft-agent-try__alert-title,
  .weft-agent-try__alert-body {
    margin: 0;
  }

  .weft-agent-try__note {
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }

  .weft-agent-try__alert-title {
    font-weight: 600;
  }

  .weft-agent-try__chat {
    display: flex;
    flex-direction: column;
    block-size: min(60vh, 36rem);
    min-block-size: 20rem;
  }

  .weft-agent-try__start {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }

  .weft-agent-try__actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
