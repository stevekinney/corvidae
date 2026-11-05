<script lang="ts">
  /**
   * Try it: a drawer beside the agent editor that chats with the agent as the form describes it
   * now, saved or not (`bureau.agents.try`, COR-1911). The first message starts a throwaway chat
   * (`agent-try-session.svelte.ts`); from then on the conversation is the application's chat over
   * that chat's context. No agent file or memory is saved, and the chat is not in the chat list. The
   * tools are real. A question the agent asks is answered here; a tool that would ask first ends the
   * trial, because the drawer has no approval to give.
   *
   * The composer is one line, "Send a test message", with Send, which becomes Stop while an answer
   * streams (and the field is disabled). With no model provider connected the shared blocked row
   * stands in its place and the transcript is empty. A tool call reads "Using Lookup order…", and an
   * answer that failed is a titled danger block under the message with Try again.
   *
   * Closing the drawer, resetting, and leaving the page each end the chat, which deletes its
   * context and the agent with it. The agent in the chat is the form as it was when the chat
   * started; the drawer says so once the form has changed, and Reset tries the new one.
   */
  import { onDestroy } from 'svelte';

  import { Alert, Button, Drawer } from '@lostgradient/cinder';
  import {
    Chat,
    ChatQuestion,
    createConversationHistory,
    type ChatAdapter,
    type ConversationHistory,
  } from '@lostgradient/chat';
  import { createQuery } from '@tanstack/svelte-query';

  import { AGENT_EDITOR_COPY, CHAT_COPY } from '../../app/copy.ts';
  import { getConnection } from '../../app/connection.svelte.ts';
  import { getAgentCatalog } from '../../lib/agent-definitions.ts';
  import { getProviders } from '../../lib/host-providers.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { composerStatusOf } from '../chat/composer-state.ts';
  import { toolDisplayName } from '../chat/tool-activity.ts';
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

  const changed = $derived(
    trial.phase === 'chatting' && JSON.stringify(editor.toTryDefinition()) !== trial.triedWith,
  );
  const references = $derived(editor.references);

  // With no model provider connected nothing can be answered, so the shared blocked row stands in
  // the composer's place and says so.
  const providers = createQuery(
    () => ({
      queryKey: queryKeys.hostProviders(),
      queryFn: ({ signal }) => getProviders({ signal }),
      enabled: open,
      retry: false,
    }),
    undefined,
  );
  const noProvider = $derived(
    providers.data !== undefined && !providers.data.providers.some((provider) => provider.hasKey),
  );
  const composerStatus = $derived(
    composerStatusOf({
      unreachable: connection.unreachable,
      restarting: false,
      ended: false,
      noProvider,
      connectHref: router.href('/settings/models'),
      newChatHref: router.href('/chats/new'),
      reconnectAttempt: 0,
      queuedFollowUps: 0,
      working: false,
    }),
  );

  // A tool call is named the way the tool names itself, "Using Lookup order…".
  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.agents.catalog(),
      queryFn: ({ signal }) => getAgentCatalog({ signal }),
      enabled: open,
      retry: false,
    }),
    undefined,
  );
  const titles = $derived(
    new Map((catalog.data?.tools ?? []).map((tool) => [tool.name, tool.title])),
  );

  /** The chat's adapter with the words of a tool call that is running, or that finished. */
  function describedBy(adapter: ChatAdapter): ChatAdapter {
    return {
      ...adapter,
      describeToolCall: (call, result) => {
        const name = toolDisplayName(call.name, titles.get(call.name));
        return result === undefined
          ? { verb: copy.usingTool, detail: `${name}…`, tense: 'present' }
          : { verb: copy.usedTool, detail: name, tense: 'past' };
      },
    };
  }

  // Before a first message there is no chat: sending one starts it.
  const idleConversation = createConversationHistory({ id: 'agent-try-idle' });
  const idleAdapter: ChatAdapter = {
    sendMessage: async (message) => {
      const text = typeof message.content === 'string' ? message.content.trim() : '';
      if (text !== '') await trial.start(editor.toTryDefinition(), text);
    },
  };

  /** The conversation as the drawer shows it: a message the trial could not answer is not "Not sent". */
  function answered(conversation: ConversationHistory): ConversationHistory {
    const failed = Object.entries(conversation.messages).filter(
      ([, row]) => row.metadata['_deliveryStatus'] === 'failed',
    );
    if (failed.length === 0) return conversation;
    const messages = { ...conversation.messages };
    for (const [id, row] of failed) {
      const { _deliveryStatus: _unused, ...metadata } = row.metadata;
      messages[id] = { ...row, metadata };
    }
    return { ...conversation, messages };
  }

  // Closing the drawer ends the chat: there is nothing to come back to.
  $effect(() => {
    if (!open) void trial.end();
  });

  // A tool that asks first parks the run on an approval this drawer cannot show, so the next message
  // would answer it unseen. The trial ends and says why.
  $effect(() => {
    if (trial.phase === 'chatting' && (trial.chat?.approvals.length ?? 0) > 0) {
      void trial.endWith(copy.approvalEnded);
    }
  });

  onDestroy(() => {
    void trial.end();
  });

  function startOver(): void {
    void trial.end();
  }
</script>

<Drawer bind:open title={copy.title} size="md">
  <div class="weft-agent-try" data-testid="agent-try" data-context-id={trial.contextId}>
    <div class="weft-agent-try__bar">
      <p class="weft-agent-try__note">{copy.usesChanges}</p>
      <Button
        data-changes
        type="button"
        size="sm"
        variant="secondary"
        label={copy.startOver}
        disabled={trial.phase === 'idle'}
        onclick={startOver}
      />
    </div>
    <p class="weft-agent-try__description">{copy.description}</p>

    {#if references.length > 0}
      <Alert variant="info">
        <p class="weft-agent-try__alert-body" data-testid="agent-try-left-out">
          {copy.leftOut(references)}
        </p>
      </Alert>
    {/if}

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
          conversation={answered(chat.conversation)}
          adapter={describedBy(chat.chatAdapter)}
          streaming={chat.streaming}
          surfaceMode="transparent"
          variant="transcript"
          composerCompact
          composerPlaceholder={copy.messagePlaceholder}
          composerHint={copy.hint}
          {composerStatus}
          disabled={connection.unreachable || chat.disconnected}
          streamingStatus={chat.stopping ? CHAT_COPY.stopping : ''}
          capabilities={{ attachments: false, editing: false, quote: false }}
        >
          {#snippet trailing()}
            {#if chat.failure !== undefined && !chat.streaming}
              <div class="weft-agent-try__failure" data-testid="agent-try-answer-failure">
                <Alert variant="danger">
                  <p class="weft-agent-try__alert-title">{copy.failureTitle}</p>
                  <p class="weft-agent-try__alert-body">{chat.failure} {copy.nothingSaved}</p>
                  <Button
                    data-changes
                    type="button"
                    size="sm"
                    variant="secondary"
                    label={copy.tryAgain}
                    disabled={!chat.canRetryTurn}
                    onclick={() => void chat.retryTurn()}
                  />
                </Alert>
              </div>
            {/if}
            <!-- The run reports a question as it parks, a moment before the turn that carried it is
                 over; a message sent in between would be a follow-up, so the question waits for the
                 turn's end. -->
            {#each chat.streaming ? [] : chat.humanRequests.slice(0, 1) as request (request.interruptId)}
              <div class="weft-agent-try__question" data-testid="agent-try-question">
                <p class="weft-agent-try__alert-body">
                  {request.message === '' ? CHAT_COPY.humanRequestFallback : request.message}
                </p>
                <ChatQuestion
                  {...{ 'data-changes': true }}
                  id={`try-question-${request.interruptId}`}
                  schema={request.schema ?? {
                    type: 'string',
                    title: CHAT_COPY.questionAnswerLabel,
                  }}
                  answerInComposer
                  busy={chat.attaching}
                  onSubmit={(value) => void chat.answerQuestion(request.interruptId, value)}
                />
              </div>
            {/each}
          {/snippet}
        </Chat>
      </div>
    {:else}
      <!-- No chat exists yet, so there is no trial chat to name: this is the composer that starts it. -->
      <div class="weft-agent-try__chat">
        <Chat
          id="agent-try-idle"
          conversation={idleConversation}
          adapter={idleAdapter}
          surfaceMode="transparent"
          variant="transcript"
          composerCompact
          composerPlaceholder={copy.messagePlaceholder}
          composerHint={copy.hint}
          {composerStatus}
          disabled={trial.phase === 'starting' || connection.unreachable}
          capabilities={{ attachments: false, editing: false, quote: false }}
        >
          {#snippet empty()}
            <span></span>
          {/snippet}
        </Chat>
      </div>
    {/if}
  </div>

  {#snippet footer()}
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
  .weft-agent-try__description,
  .weft-agent-try__alert-title,
  .weft-agent-try__alert-body {
    margin: 0;
  }

  .weft-agent-try__bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-3);
  }

  .weft-agent-try__note,
  .weft-agent-try__description {
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

  .weft-agent-try__question {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
  }
</style>
