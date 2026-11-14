<script lang="ts">
  /**
   * Try it: chats with the agent as the form describes it now, saved or not (`bureau.agents.try`,
   * COR-1911). The first message starts a throwaway chat (`agent-try-session.svelte.ts`); from then
   * on the conversation is the application's chat over that chat's context. No agent file or memory
   * is saved, and the chat is not in the chat list. The tools are real.
   *
   * Where it is drawn is the page's `placement`: at desktop width a panel always open beside the
   * form, titled "Try it" with "Uses your unsaved changes" and Reset (row 41n); below 1024px a sheet
   * the page header's Try it button opens, a 360px right sheet on a tablet (row 44a) and a bottom
   * sheet on a phone (row 43x), with Reset and Close. One component owns the trial in every
   * placement, so closing the sheet keeps the transcript for the next opening, and Close returns to
   * the form with nothing lost (rows 43z, 44b). Reset, and leaving the page, end the chat, which
   * deletes its context and the agent with it.
   *
   * The composer is one line, "Send a test message", with Send, which becomes Stop while an answer
   * streams (and the field is disabled), and the line about real tools under it (row 41p). With no
   * model provider connected the shared blocked row stands in its place and the transcript is
   * empty; with one, the header says "Provider connected" (row 43g). While the form cannot be tried
   * (no model, limits that do not parse) the composer is off. A tool call reads "Using Lookup
   * order…", and an answer that failed is a titled danger block under the message with Try again;
   * the form is untouched and the composer stays (row 42t).
   *
   * A question the agent asks is answered here. A tool that asks first is the shared approval row
   * in place of its call, under "Waiting on you for Issue refund", with the context line "Test chat,
   * this runs for real", Add a note, Deny and Approve, which answer this test run only (rows 43d,
   * 43e).
   *
   * The agent in the chat is the form as it was when the chat started; Try it says so once the form
   * has changed, and Reset tries the new one.
   */
  import { onDestroy } from 'svelte';

  import { Alert, ApprovalCard, Button, Drawer, RotateCcw } from '@lostgradient/cinder';
  import {
    Chat,
    ChatQuestion,
    createConversationHistory,
    type ChatAdapter,
    type ConversationHistory,
  } from '@lostgradient/chat';

  import { AGENT_EDITOR_COPY } from '../../app/copy/agents.ts';
  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import { getConnection } from '../../app/connection.svelte.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { approvalQuestion, declaredSummary } from '../../lib/tool-text.ts';
  import { composerStatusOf } from '../chat/composer-state.ts';
  import { toolDisplayName } from '../chat/tool-activity.ts';
  import type { AgentEditorState } from './agent-editor-state.svelte.ts';
  import { AgentTrySession, type TryPlacement } from './agent-try-session.svelte.ts';

  interface Props {
    editor: AgentEditorState;
    /** Whether the sheet is open. Ignored `beside` the form, where Try it is always open. */
    open: boolean;
    /** Where Try it is drawn: beside the form, or a right or bottom sheet over it. */
    placement: TryPlacement;
    /**
     * The model providers the host reports, each with whether it is connected, or `undefined` while
     * the host has not said. None connected blocks the composer; one connected is "Provider connected".
     */
    providers: readonly { readonly connected: boolean }[] | undefined;
  }

  let { editor, open = $bindable(), placement, providers }: Props = $props();

  const copy = AGENT_EDITOR_COPY.try;
  const connection = getConnection();
  const trial = new AgentTrySession();
  const headingId = $props.id();

  const changed = $derived(
    trial.phase === 'chatting' && JSON.stringify(editor.toTryDefinition()) !== trial.triedWith,
  );
  const references = $derived(editor.references);

  // With no model provider connected nothing can be answered, so the shared blocked row stands in
  // the composer's place and says so.
  const noProvider = $derived(
    providers !== undefined && !providers.some((provider) => provider.connected),
  );
  const providerConnected = $derived(
    providers !== undefined && providers.some((provider) => provider.connected),
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

  // A tool is named the way it names itself, "Using Lookup order…", from the catalog the form was
  // built with.
  const tools = $derived(new Map(editor.toolChoices.map((tool) => [tool.name, tool])));

  /** The name a person reads for the tool a call names. */
  function toolName(name: string): string {
    return toolDisplayName(name, tools.get(name)?.title);
  }

  /** How risky a tool is, by the tier it declares. */
  /**
   * Holds the approval's buttons while an answer is on its way, and while the run is still
   * streaming, as Chat does: the chat's controller refuses an answer while a turn reads the run.
   */
  function resolvingOf(
    deciding: 'approve' | 'deny' | undefined,
    streaming: boolean,
  ): { resolving?: 'approve' | 'deny' } {
    if (deciding !== undefined) return { resolving: deciding };
    return streaming ? { resolving: 'approve' } : {};
  }

  function riskOf(name: string): 'low' | 'medium' | 'high' {
    const tier = tools.get(name)?.tier;
    return tier === 'read-only' ? 'low' : tier === 'dangerous' ? 'high' : 'medium';
  }

  /** The chat's adapter with the words of a tool call that is running, or that finished. */
  function describedBy(adapter: ChatAdapter): ChatAdapter {
    return {
      ...adapter,
      describeToolCall: (call, result) => {
        const name = toolName(call.name);
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
      if (text !== '' && editor.canTry) await trial.start(editor.toTryDefinition(), text);
    },
  };

  /** The conversation as Try it shows it: a message the trial could not answer is not "Not sent". */
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

  // Closing the sheet keeps the chat (rows 43z, 44b); only Reset and leaving the page end it.
  onDestroy(() => {
    void trial.end();
  });

  function startOver(): void {
    void trial.end();
  }
</script>

{#snippet heading()}
  <div class="weft-agent-try__heading">
    <h2 id={headingId} class="weft-agent-try__title">{copy.title}</h2>
    <p class="weft-agent-try__note" data-testid="agent-try-note">
      <span>{copy.usesChanges}</span>
      {#if providerConnected}
        <span data-testid="agent-try-provider">{copy.providerConnected}</span>
      {/if}
    </p>
  </div>
  <!-- Ending the trial deletes its chat: a write to the Bureau. -->
  <Button
    data-changes
    type="button"
    size="sm"
    variant="secondary"
    label={copy.startOver}
    disabled={trial.phase === 'idle'}
    onclick={startOver}
  >
    {#snippet leadingIcon()}<RotateCcw class="cinder-icon-sm" aria-hidden="true" />{/snippet}
  </Button>
{/snippet}

{#snippet body()}
  <div class="weft-agent-try" data-testid="agent-try" data-context-id={trial.contextId}>
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
      {@const waiting = new Map(
        chat.approvals.map(({ message, result }) => [result.callId, message] as const),
      )}
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
          <!-- A call parked on its approval is the shared approval row, answered here for this test
               run only (rows 43d, 43e); every other row is Chat's own. -->
          {#snippet row({ toolCallPair }, renderDefault)}
            {@const result = toolCallPair?.result}
            {#if toolCallPair !== undefined && result !== undefined && result.action?.type === 'approval' && waiting.has(result.callId)}
              {@const call = toolCallPair.call}
              {@const name = toolName(call.name)}
              {@const reason = waiting.get(result.callId)?.content}
              <div class="weft-agent-try__approval" data-testid="agent-try-approval">
                <p class="weft-agent-try__waiting">{copy.waitingOn(name)}</p>
                <ApprovalCard
                  id={`try-approval-${call.id}`}
                  layout="row"
                  headingLevel={4}
                  question={approvalQuestion({
                    toolName: name,
                    arguments: call.arguments,
                    summary: declaredSummary(
                      result.action.message,
                      typeof reason === 'string' ? reason : undefined,
                    ),
                  })}
                  tool={{
                    name: call.name,
                    label: name,
                    risk: riskOf(call.name),
                    irreversible: tools.get(call.name)?.tier === 'dangerous',
                  }}
                  operation={{ kind: 'other', argsPreview: call.arguments }}
                  policyVersion="try"
                  idempotencyKey={call.id}
                  state="pending"
                  {...resolvingOf(trial.deciding, chat.streaming)}
                  {...connection.unreachable
                    ? { disabledReason: CHAT_COPY.approval.unreachable }
                    : {}}
                  onResolve={(resolution) => void trial.resolveApproval(call.id, resolution)}
                >
                  {#snippet context()}{copy.testChat}{/snippet}
                </ApprovalCard>
              </div>
            {:else}
              {@render renderDefault()}
            {/if}
          {/snippet}
          {#snippet trailing()}
            {#if chat.failure !== undefined && !chat.streaming}
              <div class="weft-agent-try__failure" data-testid="agent-try-answer-failure">
                <Alert variant="danger" heading={copy.failureTitle}>
                  {chat.failure}
                  {copy.nothingSaved}
                  {#snippet actions()}
                    <Button
                      data-changes
                      type="button"
                      size="sm"
                      variant="secondary"
                      label={copy.tryAgain}
                      disabled={!chat.canRetryTurn}
                      onclick={() => void chat.retryTurn()}
                    >
                      {#snippet leadingIcon()}<RotateCcw
                          class="cinder-icon-sm"
                          aria-hidden="true"
                        />{/snippet}
                    </Button>
                  {/snippet}
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
          disabled={trial.phase === 'starting' || connection.unreachable || !editor.canTry}
          capabilities={{ attachments: false, editing: false, quote: false }}
        >
          {#snippet empty()}
            <span></span>
          {/snippet}
        </Chat>
      </div>
    {/if}
  </div>
{/snippet}

{#if placement === 'beside'}
  <aside class="weft-agent-try-panel" aria-labelledby={headingId} data-testid="agent-try-panel">
    <header class="weft-agent-try-panel__title-row">
      {@render heading()}
    </header>
    {@render body()}
  </aside>
{:else}
  <Drawer
    bind:open
    title={copy.title}
    ariaLabelledby={headingId}
    placement={placement === 'bottom' ? 'bottom' : 'right'}
    size="sm"
    closeLabel={copy.closeSheet}
  >
    {#snippet header()}
      <div class="weft-agent-try-sheet__title-row">
        {@render heading()}
      </div>
    {/snippet}
    {@render body()}
  </Drawer>
{/if}

<style>
  .weft-agent-try-panel {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-inline-size: 0;
  }

  .weft-agent-try-panel__title-row,
  .weft-agent-try-sheet__title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-2) var(--cinder-space-3);
  }

  .weft-agent-try-sheet__title-row {
    flex: 1;
    min-inline-size: 0;
  }

  .weft-agent-try__heading {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    min-inline-size: 0;
  }

  .weft-agent-try__title {
    margin: 0;
    font-size: var(--cinder-text-lg);
    font-weight: 600;
  }

  .weft-agent-try {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-block-size: 0;
  }

  .weft-agent-try__note,
  .weft-agent-try__waiting,
  .weft-agent-try__alert-title,
  .weft-agent-try__alert-body {
    margin: 0;
  }

  /* What the trial runs on, then whether a provider is connected: two phrases, no separator glyph. */
  .weft-agent-try__note {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--cinder-space-3);
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }

  .weft-agent-try__waiting {
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

  .weft-agent-try__approval,
  .weft-agent-try__question {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
  }
</style>
