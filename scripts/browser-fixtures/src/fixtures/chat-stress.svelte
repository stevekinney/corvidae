<script lang="ts">
  import {
    Chat,
    advanceTurnState,
    appendAssistantMessage,
    appendStreamingMessage,
    appendUserMessage,
    createConversation,
    finalizeStreamingMessage,
    updateStreamingMessage,
    type ChatAdapter,
    type ChatAttachmentReference,
    type ChatAttachmentUpload,
    type ChatAvailability,
    type ChatComposerStatus,
    type ChatTurnEvent,
    type ChatTurnState,
    type ConversationHistory,
    type Message,
    type ReasoningInfo,
  } from '@lostgradient/chat';
  import type { ApprovalResolution, CitationSource } from '@lostgradient/cinder';

  import casesData from './chat-stress.json';
  import { findStressCase, parseStressCases } from './chat-stress/stress-cases.ts';
  import {
    buildStressSetup,
    failedStressSetup,
    type StressSetup,
  } from './chat-stress/stress-scenarios.ts';

  // One real Chat per page load, chosen by `?case=NN` (COR-2289). The case's scenario seeds what the
  // person would find on arrival; every later change comes from a control the capture tool presses
  // or from a host operation on `window.corvidaeChatStress`, which does only what a host does (a
  // dropped connection, a token arriving, a source taken away).
  const requested = Number(new URLSearchParams(globalThis.location.search).get('case') ?? '1');
  const cases = parseStressCases(casesData);
  const stressCase = findStressCase(cases, requested);
  let failure: string | undefined;
  let built: StressSetup | undefined;
  if (stressCase === undefined) failure = `Chat stress case '${requested}' does not exist.`;
  else {
    try {
      built = buildStressSetup(stressCase);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }
  // With a failure the page draws only the error, so the empty setup is never shown.
  const setup = built ?? failedStressSetup();

  const ACCEPTED_TYPES = ['image/*', 'application/pdf', 'text/plain'];

  let chat: ReturnType<typeof Chat> | undefined;
  let conversation = $state.raw<ConversationHistory>(setup.conversation);
  let secondConversation = $state.raw<ConversationHistory>(
    appendAssistantMessage(
      appendUserMessage(createConversation({ id: 'stress-two-b' }), 'Second chat: status?'),
      'Second chat: all green.',
    ),
  );
  let streaming = $state(setup.streaming);
  let turnStates = $state<Record<number, ChatTurnState>>({ ...setup.turnStates });
  let online = $state(true);
  let availabilityKind = $state<'loading' | 'canceled' | 'error' | 'deleted' | undefined>(
    setup.availability?.kind,
  );
  let statusCleared = $state(false);
  let sources = $state.raw<Record<number, CitationSource[]>>({ ...setup.sources });
  let streamMessageId: string | undefined;
  let streamContent = '';

  let runInputLog = $state.raw<string[]>([]);
  let submissions = $state.raw<string[]>([]);
  let approvals = $state.raw<{ toolCallId: string; decision: string }[]>([]);
  let answers = $state.raw<{ toolCallId: string; value: unknown }[]>([]);
  let turnActions = $state.raw<string[]>([]);
  let ready = $state(false);

  function textOf(content: unknown): string {
    return typeof content === 'string' ? content : JSON.stringify(content);
  }

  function assistantOrdinal(history: ConversationHistory, messageId: string): number {
    let ordinal = -1;
    for (const id of history.ids) {
      const candidate = history.messages[id];
      if (candidate?.role === 'assistant') ordinal += 1;
      if (id === messageId) return candidate?.role === 'assistant' ? ordinal : -1;
    }
    return -1;
  }

  function lastAssistantOrdinal(): number {
    let count = 0;
    for (const id of conversation.ids)
      if (conversation.messages[id]?.role === 'assistant') count += 1;
    return count - 1;
  }

  function turnStateFor(message: Message): ChatTurnState | undefined {
    const ordinal = assistantOrdinal(conversation, message.id);
    return ordinal < 0 ? undefined : turnStates[ordinal];
  }

  function applyTurnEvent(event: ChatTurnEvent): void {
    const ordinal = lastAssistantOrdinal();
    const current = turnStates[ordinal];
    if (ordinal < 0 || current === undefined) return;
    turnStates = { ...turnStates, [ordinal]: advanceTurnState(current, event) };
  }

  function recordTurnAction(name: string, messageId: string): void {
    turnActions = [...turnActions, `${name}:${messageId}`];
  }

  const adapter: ChatAdapter = {
    sendMessage: async (message) => {
      submissions = [...submissions, textOf(message.content)];
      conversation = appendUserMessage(conversation, message.content);
    },
    ...(setup.runInput
      ? {
          sendRunInput: async (_conversationId: string, message: { content: unknown }) => {
            runInputLog = [...runInputLog, textOf(message.content)];
          },
          removeRunInput: async () => {},
        }
      : {}),
    stopGenerating: async () => {
      applyTurnEvent({ type: 'stop' });
      streaming = false;
    },
    describeApproval: (toolCall) => setup.approvalDetails[toolCall.name],
    resolveToolApproval: async (toolCallId, resolution: ApprovalResolution) => {
      approvals = [...approvals, { toolCallId, decision: resolution.decision }];
      return 'resolved';
    },
  };

  function handleInputSubmit(toolCallId: string, value: unknown): void {
    answers = [...answers, { toolCallId, value }];
  }

  const uploadAttachment: ChatAttachmentUpload | undefined =
    setup.uploads === 'none'
      ? undefined
      : async (file, { signal, onProgress }) => {
          if (file.name.startsWith('upload-fail'))
            throw new Error('The upload service refused the file.');
          if (file.name.startsWith('uploading')) {
            onProgress?.(0.42);
            return new Promise<ChatAttachmentReference>((_resolve, reject) => {
              signal.addEventListener('abort', () =>
                reject(new DOMException('Aborted', 'AbortError')),
              );
            });
          }
          return { id: `reference-${file.name}`, mimeType: file.type };
        };

  const composerStatus = $derived.by((): ChatComposerStatus | undefined => {
    if (!online) return { kind: 'offline' };
    const status = setup.status;
    if (status === undefined || statusCleared) return undefined;
    if (status.kind === 'blocked') {
      return {
        kind: 'blocked',
        reason: status.reason,
        action: { label: status.action, primary: true, onclick: () => {} },
        ...(status.link === undefined ? {} : { link: { label: status.link, onclick: () => {} } }),
      };
    }
    if (status.kind === 'archived') {
      return {
        kind: 'archived',
        when: status.when,
        newChat: { label: 'New chat', onclick: () => {} },
        unarchive: { label: 'Unarchive', primary: true, onclick: () => {} },
      };
    }
    if (status.kind === 'read-only') {
      return {
        kind: 'read-only',
        tooltip: status.tooltip,
        request: { label: 'Request access', primary: true, onclick: () => {} },
      };
    }
    if (status.kind === 'draft-restored') {
      return { kind: 'draft-restored', when: status.when, ondiscard: () => (statusCleared = true) };
    }
    return { kind: 'offline' };
  });

  const availability = $derived.by((): ChatAvailability | undefined => {
    const seeded = setup.availability;
    if (seeded === undefined || availabilityKind === undefined) return undefined;
    const allConversations = { label: 'All conversations', onclick: () => {} };
    if (availabilityKind === 'loading') {
      return {
        kind: 'loading',
        slowAfterSeconds: seeded.kind === 'loading' ? (seeded.slowAfterSeconds ?? 10) : 10,
        onCancel: () => (availabilityKind = 'canceled'),
      };
    }
    if (availabilityKind === 'canceled') {
      return { kind: 'canceled', onRetry: () => (availabilityKind = 'loading'), allConversations };
    }
    if (availabilityKind === 'error') {
      return {
        kind: 'error',
        cause: seeded.kind === 'error' ? seeded.cause : 'The conversation could not be loaded.',
        ...(seeded.kind === 'error' && seeded.detail !== undefined
          ? { detail: seeded.detail }
          : {}),
        onRetry: () => (availabilityKind = 'loading'),
        allConversations,
      };
    }
    return { kind: 'deleted', allConversations };
  });

  function reasoningFor(message: Message): ReasoningInfo | undefined {
    const ordinal = assistantOrdinal(conversation, message.id);
    return ordinal < 0 ? undefined : setup.reasoning[ordinal];
  }

  const sourcesByMessageId = $derived.by(() => {
    const map = new Map<string, readonly CitationSource[]>();
    for (const [ordinal, list] of Object.entries(sources)) {
      let seen = -1;
      for (const id of conversation.ids) {
        if (conversation.messages[id]?.role !== 'assistant') continue;
        seen += 1;
        if (seen === Number(ordinal)) map.set(id, list);
      }
    }
    return map;
  });

  // What only a host does. A case calls these through a `hook` step.
  const hooks = {
    startStream(): void {
      const started = appendStreamingMessage(conversation, 'assistant');
      conversation = started.conversation;
      streamMessageId = started.messageId;
      streamContent = '';
      streaming = true;
      turnStates = { ...turnStates, [lastAssistantOrdinal()]: { kind: 'streaming' } };
      chat?.beginStreaming(started.messageId);
    },
    pushToken(text: string): void {
      if (streamMessageId === undefined) return;
      streamContent += text;
      conversation = updateStreamingMessage(conversation, streamMessageId, streamContent);
      chat?.pushToken(text);
    },
    endStream(): void {
      if (streamMessageId !== undefined) {
        conversation = finalizeStreamingMessage(conversation, streamMessageId);
      }
      chat?.endStreaming();
      streaming = false;
      applyTurnEvent({ type: 'finish', answered: true });
    },
    turnEvent(event: ChatTurnEvent): void {
      applyTurnEvent(event);
      if (event.type === 'fail' || event.type === 'finish' || event.type === 'stop')
        streaming = false;
    },
    finishRun(): void {
      streaming = false;
      applyTurnEvent({ type: 'finish', answered: true });
    },
    setOnline(next: boolean): void {
      online = next;
    },
    withdrawSource(ordinal: number, index: number): void {
      const list = sources[ordinal];
      if (list === undefined) return;
      sources = { ...sources, [ordinal]: list.filter((_, position) => position !== index) };
    },
  };

  $effect(() => {
    const host = window as Window & { corvidaeChatStress?: typeof hooks };
    host.corvidaeChatStress = hooks;
    return () => delete host.corvidaeChatStress;
  });

  // The host puts a saved draft back once, after the composer exists, as it does after a reload.
  $effect(() => {
    if (setup.restoredDraft !== undefined)
      chat?.insertAtRange({ start: 0, end: 0 }, setup.restoredDraft);
  });

  // Ready when the case's chat has mounted and drawn; a failure never marks the page ready.
  $effect(() => {
    ready = failure === undefined;
  });
</script>

{#if failure !== undefined}
  <p data-chat-stress-error role="alert">{failure}</p>
{:else}
  <div
    class="stress-page"
    data-testid="chat-stress-shell"
    data-chat-stress-case={stressCase?.id}
    data-chat-stress-ready={ready ? 'true' : 'false'}
    data-chat-stress-direction={setup.direction ?? 'ltr'}
    data-two-chats={setup.secondChat ? 'true' : 'false'}
  >
    <div
      class="stress-shell"
      style:inline-size={setup.shellWidth === undefined ? undefined : `${setup.shellWidth}px`}
    >
      <Chat
        bind:this={chat}
        id="stress-chat"
        {conversation}
        {streaming}
        {adapter}
        variant={setup.variant}
        capabilities={setup.capabilities}
        {composerStatus}
        {availability}
        messageTurnState={turnStateFor}
        messageReasoning={reasoningFor}
        questionPlacement={setup.questionPlacement}
        onInputSubmit={handleInputSubmit}
        emptyPrompts={setup.emptyPrompts}
        emptyTitle="Start a conversation"
        emptyDescription="Ask the agent about orders, refunds and the ledger."
        {sourcesByMessageId}
        sourcePresentation={setup.sourcePresentation}
        onRegenerate={setup.regenerate ? () => {} : undefined}
        onRetryConnection={(messageId) => {
          recordTurnAction('retry-now', messageId);
          applyTurnEvent({ type: 'reconnected' });
        }}
        onContinueTurn={(messageId) => {
          recordTurnAction('continue', messageId);
          applyTurnEvent({ type: 'continue' });
          streaming = true;
        }}
        onDiscardTurn={(messageId) => recordTurnAction('discard', messageId)}
        onRetryTurn={(messageId) => {
          recordTurnAction('retry', messageId);
          applyTurnEvent({ type: 'retry' });
          streaming = true;
        }}
        onRetryStep={(toolCallId) => recordTurnAction('retry-step', toolCallId)}
        {uploadAttachment}
        acceptedTypes={setup.uploads === 'none' ? undefined : ACCEPTED_TYPES}
      />
    </div>
    {#if setup.secondChat}
      <div class="stress-shell">
        <Chat
          id="stress-chat-two"
          conversation={secondConversation}
          capabilities={{ attachments: false }}
          variant="transcript"
          onSubmit={(event) => {
            secondConversation = appendUserMessage(secondConversation, event.message.content);
          }}
        />
      </div>
    {/if}
    <output class="cinder-sr-only" data-testid="stress-run-input-log"
      >{JSON.stringify(runInputLog)}</output
    >
    <output class="cinder-sr-only" data-testid="stress-submission-log"
      >{JSON.stringify(submissions)}</output
    >
    <output class="cinder-sr-only" data-testid="stress-approval-log"
      >{JSON.stringify(approvals)}</output
    >
    <output class="cinder-sr-only" data-testid="stress-answer-log">{JSON.stringify(answers)}</output
    >
    <output class="cinder-sr-only" data-testid="stress-turn-action-log"
      >{JSON.stringify(turnActions)}</output
    >
  </div>
{/if}

<style>
  .stress-page {
    display: grid;
    grid-auto-rows: minmax(0, 1fr);
    block-size: 100dvh;
    min-inline-size: 0;
    overflow: hidden;
    background: var(--cinder-surface-default);
  }

  .stress-page[data-two-chats='true'] {
    grid-template-rows: repeat(2, minmax(0, 1fr));
  }

  .stress-shell {
    display: flex;
    flex-direction: column;
    min-block-size: 0;
    min-inline-size: 0;
    max-inline-size: 100%;
  }

  .stress-shell :global(.chat-container) {
    flex: 1;
    min-block-size: 0;
  }

  [data-chat-stress-error] {
    margin: var(--cinder-space-4);
    color: var(--cinder-danger-text);
  }
</style>
