<script lang="ts">
  /**
   * The conversation: the session's title and agent once, the approvals the run is waiting on, and
   * `@lostgradient/chat`'s surface over the session's controller (`chat-session.svelte.ts`). The
   * controller owns what is sent and when, so a message typed while the run is going is a
   * follow-up and a decision on an approval continues the run. A question the run is waiting on a
   * person to answer is shown above the transcript, and the next message answers it; when it waits
   * on several, the first without an answer is shown, and each message answers the next.
   *
   * What a person may attach comes from the selected agent's model (`bureau.agents.list`'s `media`):
   * the file picker is on for an agent whose model takes media and off for one that names no model,
   * and off while a run streams or waits on the person's answer, because a follow-up and an answer
   * carry text only. Files upload as they are attached (`../../lib/chat-attachments.ts`), and the
   * assets a row carries, returned by the agent or attached by the person, are shown under it.
   *
   * Quoting is on (`capabilities.quote`): a reader selects part of an agent's reply, or uses its Quote
   * message action, and the quotes go out as Markdown block quotes ahead of the typed text, as part
   * of the message itself, so the controller sends them like any other text.
   *
   * A session has a model picker in the composer (`model-picker.svelte`), and the final agent
   * message of each completed turn offers Branch from here (`branch-points.ts`), which opens a new
   * session that continues from that reply. A branch's header says where it came from
   * (`branch-origin.svelte`). The header's More menu (`chat-more-menu.svelte`) renames, branches,
   * exports and deletes the chat, and editing a message the person sent resends by fork
   * (`edit-fork.ts`): the chat is branched before the message and the edited text is sent on the
   * branch.
   *
   * A new chat (`isNew`, at `/chats/new`) has no session yet. The client names the thread, the agent
   * is chosen from the pill in the composer, the transcript's place shows a greeting, the prompts
   * the agent suggests and the other agents (`new-chat-welcome.svelte`; a prompt fills the composer
   * and sends nothing), and the first message
   * starts the run. When the run has started
   * the address becomes `/chats/:chat` by replacing the history entry, with this page kept
   * mounted (`router.navigate`'s `keep`), and the agent is fixed from then on.
   */
  import { onMount, untrack } from 'svelte';

  import { Alert, Button, Combobox, EmptyState, PageHeader } from '@lostgradient/cinder';
  import { Chat } from '@lostgradient/chat';
  import { GitBranch } from '@lucide/svelte';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { CHAT_COPY } from '../../app/copy.ts';
  import { showToast } from '../../app/toast-host.svelte';
  import { getConnection } from '../../app/connection.svelte.ts';
  import { useBureauEventsLive } from '../../app/live-polling.svelte.ts';
  import {
    forkContext,
    forkRefusalReason,
    getAgentModels,
    getContext,
    getContextWindow,
    listAgents,
    steerContext,
    type AgentSummary,
    type Effort,
    type PermissionMode,
  } from '../../lib/bureau-client.ts';
  import {
    attachmentSettings,
    chatAttachmentErrorMessage,
    createAttachmentUpload,
  } from '../../lib/chat-attachments.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { createPendingCommandKey } from '../../lib/pending-command-key.ts';
  import { queryKeys } from '../../lib/query.ts';
  import ApprovalDecision from '../../lib/decision/approval-decision.svelte';
  import { approvalQuestion, declaredSummary } from '../../lib/tool-text.ts';
  import { listBureauReviews } from '../../lib/bureau-reviews.ts';
  import { invalidateReviewQueries } from '../../lib/review-queries.ts';
  import { getPrincipalStore, hasPrincipalStore } from '../../lib/scopes.svelte.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { downloadText } from '../audit/audit-export.ts';
  import BranchOrigin from './branch-origin.svelte';
  import { branchPointIds } from './branch-points.ts';
  import { agentModel } from './agent-model.ts';
  import ChatAssets from './chat-assets.svelte';
  import {
    CHAT_EXPORT_TYPE,
    chatExportFilename,
    chatMarkdown,
    hasExportableText,
  } from './chat-export.ts';
  import ChatMoreMenu from './chat-more-menu.svelte';
  import ContextWindowRing from './context-window-ring.svelte';
  import SettingSelect from './setting-select.svelte';
  import { withTypedAnswers } from './answer-rows.ts';
  import { assetsOf, hasContent, withoutAssetParts } from './chat-assets.ts';
  import { ChatSessionState } from './chat-session.svelte.ts';
  import { decidedKey, SeenReviews } from './decided-elsewhere.ts';
  import { editForkPoint, holdEdit, lastBranchPoint, takeEdit } from './edit-fork.ts';
  import ModelPicker from './model-picker.svelte';
  import NewChatWelcome from './new-chat-welcome.svelte';
  import { toolGroups } from './tool-activity.ts';
  import ToolCalls from './tool-calls.svelte';
  import SessionTasks from './session-tasks.svelte';

  interface ChatConversationProps {
    sessionId: string;
    title: string | null;
    agentName: string;
    /** Whether this is a chat that has no session until its first run starts. */
    isNew?: boolean;
    /** For a new chat: whether the address names the agent, rather than the default being used. */
    agentChosen?: boolean;
  }

  let {
    sessionId,
    title,
    agentName,
    isNew = false,
    agentChosen = false,
  }: ChatConversationProps = $props();

  const queryClient = useQueryClient();
  // The agent is chosen until the run starts, and fixed once the session exists.
  let agent = $state(untrack(() => agentName));
  let choosing = $state(untrack(() => isNew));
  // Whether the person has picked the agent: the address named it, or they chose one since.
  let chosen = $state(untrack(() => agentChosen));
  let chat = $state<ReturnType<typeof Chat> | undefined>();

  const connection = getConnection();

  const session = new ChatSessionState({
    sessionId: untrack(() => sessionId),
    agentName: () => agent,
    // Editing a message resends by fork (`editMessage`), not in place.
    onEdit: (event) => editMessage(event),
    onRunStarted: () => {
      if (!choosing) return;
      choosing = false;
      // The session exists now. Its address replaces the new chat's, so Back returns to where the
      // person came from, and this page stays mounted so the run carries on.
      router.navigate(chatSessionPath(sessionId), { replace: true, keep: true });
      void queryClient.invalidateQueries({ queryKey: ['contexts'] });
    },
  });

  const agents = createQuery(
    () => ({
      queryKey: queryKeys.agents.list(),
      queryFn: ({ signal }) => listAgents({ signal }),
    }),
    undefined,
  );
  const choices = $derived(
    (agents.data ?? []).map((entry: AgentSummary) => ({
      value: entry.name,
      label: entry.displayName,
      ...(entry.description === null ? {} : { description: entry.description }),
    })),
  );

  // What the selected agent's model lets a person attach. An agent the Bureau has not listed yet,
  // or one that names no model, takes no attachment.
  const settings = $derived(
    attachmentSettings(agents.data?.find((entry) => entry.name === agent)?.media),
  );
  const upload = $derived(settings === null ? undefined : createAttachmentUpload(settings));
  // A follow-up and an answer to the run's question carry text only, so a file attached then
  // would be dropped without a word. The picker is off for both, and while the page is still
  // finding out whether the session has a run going, which would make the next message a
  // follow-up.
  const attachable = $derived(
    settings !== null &&
      !session.attaching &&
      !session.streaming &&
      session.humanRequests.length === 0,
  );

  // Once the session exists its title comes from the Bureau, and it is read again when a run ends.
  const context = createQuery(
    () => ({
      queryKey: queryKeys.contexts.detail(sessionId),
      queryFn: ({ signal }) => getContext(sessionId, { signal }),
      enabled: !choosing,
      retry: false,
    }),
    undefined,
  );
  // How full the session's window is. Like the title, it is read when the page opens and again when
  // a run ends, since a run adds to the conversation; and when the model changes, which changes the
  // window (`reloadContext`).
  const contextWindow = createQuery(
    () => ({
      queryKey: queryKeys.contexts.window(sessionId),
      queryFn: ({ signal }) => getContextWindow(sessionId, { signal }),
      enabled: !choosing,
      retry: false,
    }),
    undefined,
  );
  $effect(() => {
    // Only the end of a run asks again. Reading the queries here would make each answer ask again.
    if (!choosing && !session.streaming) {
      untrack(() => {
        void context.refetch();
        void contextWindow.refetch();
      });
    }
  });
  const displayTitle = $derived(context.data?.title ?? title ?? CHAT_COPY.untitled);

  /** Reads the session again, for the settings' controls, and says whether it could. */
  async function reloadContext(): Promise<boolean> {
    const result = await context.refetch();
    // A new model has a window of its own.
    void contextWindow.refetch();
    return !result.isError;
  }

  // The settings the header shows and the composer changes. The model is always shown: the session's
  // own, else its agent's default.
  const SETTINGS = CHAT_COPY.settings;
  const models = createQuery(
    () => ({
      queryKey: queryKeys.agents.models(agent),
      queryFn: ({ signal }) => getAgentModels(agent, { signal }),
      enabled: !choosing,
      retry: false,
    }),
    undefined,
  );
  const shownModel = $derived.by(() => {
    if (context.data === undefined) return undefined;
    const name = context.data.model ?? agentModel(models.data);
    if (name === null) return SETTINGS.agentDefault;
    const listed = models.data?.models.find(
      (choice) =>
        choice.model === name.model &&
        (name.provider === null || choice.provider === name.provider),
    );
    return listed?.displayName ?? name.model;
  });
  const shownEffort = $derived(
    context.data === undefined
      ? undefined
      : (SETTINGS.effortOptions.find((option) => option.value === context.data?.effort)?.label ??
          SETTINGS.agentDefault),
  );
  const shownPermission = $derived(
    SETTINGS.permissionOptions.find((option) => option.value === context.data?.permissionMode)
      ?.label,
  );
  const permissionDescription = $derived(
    context.data === undefined || context.data.permissionMode === 'on-changes'
      ? undefined
      : SETTINGS.permissionDescriptions[context.data.permissionMode],
  );

  // The settings share one revision, so while one is being changed the others wait for it.
  let steering = $state(false);
  // When the change the person made takes effect, which depends on whether a run is going.
  let appliesNote = $state<string | undefined>(undefined);
  // A run is going while it streams, and also while it is parked on an approval or a question: it
  // streams nothing then, but it resumes into the same run, which reads a mode at each tool call
  // and the model and effort at each step. Only the Bureau's reading of the chat says it is parked
  // (`activity`), and the page reads it again as the run stops streaming.
  const runGoing = $derived(session.streaming || (context.data?.activity ?? 'idle') !== 'idle');
  $effect(() => {
    // A note about a run's next step is out of date once the run starts or ends.
    void runGoing;
    untrack(() => (appliesNote = undefined));
  });
  function noted(setting: 'step' | 'toolCall'): void {
    appliesNote = runGoing ? SETTINGS.applies[setting] : SETTINGS.applies.nextRun;
  }

  // Steering admits only the chat's own principal (`bureau.contexts.steer`). The page knows who that
  // is only for the one local caller, whose subject is the owner of every chat it started; for any
  // other credential the owner's form is the Bureau's to compare, so the controls stay and a refusal
  // is shown when it comes.
  const principals = hasPrincipalStore() ? getPrincipalStore() : undefined;
  const cannotSteer = $derived.by(() => {
    const principal = principals?.principal;
    const owner = context.data?.owner;
    if (principal === null || principal === undefined || owner === undefined) return undefined;
    if (principal.unauthenticatedAccess === null || typeof principal.subject !== 'string') {
      return undefined;
    }
    return owner !== null && owner !== principal.subject ? SETTINGS.notYours : undefined;
  });

  function openAgent(event: MouseEvent, name: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    router.navigate(agentPath(name));
  }

  function chooseAgent(value: string): void {
    agent = value;
    chosen = true;
    router.navigate(`/chats/new?agent=${encodeURIComponent(value)}`, { replace: true });
  }

  /**
   * Puts a suggested prompt in the composer for the person to send or change; it sends nothing.
   * The prompt replaces whatever was typed, in one operation on the textarea's own range, because
   * the composer's value only catches up with a cleared textarea after the next render.
   */
  function fillComposer(prompt: string): void {
    const typed = chat?.getEditorElement()?.value ?? chat?.getComposerValue() ?? '';
    chat?.insertAtRange({ start: 0, end: typed.length }, prompt);
    chat?.focusInput();
  }

  // Chat lays out the conversation without the Bureau's files in it; they are shown under their
  // rows (`chat-assets.svelte`). An answer to a question is shown as it was typed (`answer-rows.ts`).
  const shown = $derived(withoutAssetParts(withTypedAnswers(session.conversation)));

  // The messages that offer a branch. A run that is going, or that the page is still reading, has
  // not finished its last message.
  const branchPoints = $derived(
    branchPointIds(session.conversation, session.streaming || session.attaching),
  );
  let branching = $state(false);
  let branchFailure = $state<string | undefined>(undefined);
  const branchCommands = createPendingCommandKey();
  // The reply the More menu's Branch branches from: the last one a branch can be made from.
  const lastBranchTarget = $derived(lastBranchPoint(session.conversation, branchPoints));

  /** What a refused or failed branch says: the Bureau's reason when it gave one, else `fault`. */
  function branchFailureText(error: unknown, fault: string): string {
    const reason = forkRefusalReason(error);
    const refused: Readonly<Record<string, string>> = CHAT_COPY.branch.refused;
    return (reason === undefined ? undefined : refused[reason]) ?? fault;
  }

  /**
   * Branches the chat through `messageId`, or before its first message when that is `null`, and
   * opens the branch. A message `edited` is the person's edited text, which goes with them to the
   * branch and is sent there as a new turn (`edit-fork.ts`); the original chat keeps what it had.
   */
  async function branchThrough(messageId: string | null, edited?: string): Promise<void> {
    branching = true;
    branchFailure = undefined;
    try {
      const branchId = await forkContext({
        contextId: sessionId,
        commandId: branchCommands.keyFor(sessionId, messageId ?? ''),
        throughMessageId: messageId,
      });
      branchCommands.confirmed();
      if (edited !== undefined) holdEdit(branchId, edited);
      void queryClient.invalidateQueries({ queryKey: ['contexts'] });
      router.navigate(chatSessionPath(branchId));
    } catch (error) {
      // A conflict is the Bureau's final answer for that command, so the next attempt is a new one.
      // Any other fault, a Bureau that was shutting down included, may have come after the Bureau
      // created the branch, so the retry keeps its identifier and finds it.
      const reason = forkRefusalReason(error);
      if (reason !== undefined && Object.hasOwn(CHAT_COPY.branch.refused, reason)) {
        branchCommands.confirmed();
      }
      branchFailure = branchFailureText(
        error,
        edited === undefined ? CHAT_COPY.branch.fault : CHAT_COPY.edit.fault,
      );
    } finally {
      branching = false;
    }
  }

  /**
   * Editing a message resends by fork: the chat is branched at the reply before the message, and
   * the edited text is sent on the branch. The chat the person edited from is left as it was.
   */
  function editMessage(event: { readonly messageId: string; readonly content: string }): void {
    const sent = session.conversation.messages[event.messageId];
    // The edited text is all that goes to the branch, so a message that carried files would lose them.
    if (sent !== undefined && assetsOf(sent).length > 0) {
      branchFailure = CHAT_COPY.edit.withFiles;
      return;
    }
    const point = editForkPoint(session.conversation, event.messageId, branchPoints);
    if (point === undefined) {
      branchFailure = CHAT_COPY.edit.unavailable;
      return;
    }
    void branchThrough(point, event.content);
  }

  /** Saves the conversation as a Markdown file. */
  function exportChat(): void {
    try {
      downloadText(
        chatMarkdown({ title: displayTitle, agent, conversation: shown }),
        chatExportFilename(displayTitle),
        CHAT_EXPORT_TYPE,
      );
    } catch {
      showToast(CHAT_COPY.more.exportFault, { variant: 'danger', duration: 0 });
    }
  }

  let deciding = $state(false);

  /** Each approval the conversation waits on, as the question it asks and the call it belongs to. */
  const approvals = $derived(
    session.approvals.map(({ message, result }) => {
      const call = Object.values(session.conversation.messages).find(
        (row) => row.toolCall?.id === result.callId,
      )?.toolCall;
      const reason = typeof message.content === 'string' ? message.content : undefined;
      const summary = declaredSummary(
        result.action.type === 'approval' ? result.action.message : undefined,
        reason,
      );
      // The name the approval reports the tool by (`plugin:tool` for a plugin's tool), not the
      // provider's `plugin__tool` the model called it by (COR-1879); the call's name until the
      // Bureau's pending reviews have been read.
      const reviewed = pendingReviews.data?.find(
        (review) => review.kind === 'tool-approval' && review.approval.callId === result.callId,
      );
      const toolName = reviewed?.kind === 'tool-approval' ? reviewed.approval.toolName : call?.name;
      return {
        toolCallId: result.callId,
        toolName,
        question: approvalQuestion({
          toolName: toolName ?? 'a tool',
          arguments: call?.arguments,
          summary,
        }),
      };
    }),
  );
  const approvalsByCall = $derived(
    new Map(approvals.map((entry) => [entry.toolCallId, entry] as const)),
  );
  const activity = $derived(toolGroups(session.conversation));

  // A decision made somewhere else (`/reviews`, a run's page, another tab) is written into the
  // conversation by the Bureau, and this page is not told. While the conversation waits on a person,
  // the Bureau's pending reviews are read again when `bureau.events` reports a review (the shell
  // invalidates them), and every few seconds while that feed is not live. When a review this page has seen
  // pending is no longer pending, the thread is read again. A review is decided only if it was seen
  // pending first: the list is shared with the navigation's count, so a read can predate the review
  // (a chat that has just started the run) and say nothing about a decision. Each set of decided
  // reviews is read once, and the record is cleared when nothing is decided, so the next decision
  // of the same kind is read again.
  const REREAD_POLL_MILLISECONDS = 3_000;
  const bureauLive = useBureauEventsLive();
  const waitingOnPerson = $derived(
    !choosing &&
      !session.streaming &&
      (session.approvals.length > 0 || session.humanRequests.length > 0),
  );
  const pendingReviews = createQuery(
    () => ({
      queryKey: queryKeys.bureauReviews.list(),
      queryFn: ({ signal }) => listBureauReviews({ signal }),
      enabled: waitingOnPerson,
      // poll-reason: fallback
      refetchInterval: bureauLive() ? false : REREAD_POLL_MILLISECONDS,
      retry: false,
    }),
    undefined,
  );
  let rereadFor = '';
  const seen = new SeenReviews();
  $effect(() => {
    const reviews = pendingReviews.data;
    if (!waitingOnPerson) {
      // Nothing is owed, so what was seen belongs to a wait that is over.
      seen.clear();
      rereadFor = '';
      return;
    }
    if (reviews === undefined) return;
    const decided = seen.observe(
      reviews.filter((review) => review.sessionId === sessionId),
      {
        shownCalls: approvals.map((entry) => entry.toolCallId),
        questionOpen: session.humanRequests.length > 0,
      },
    );
    const key = decidedKey(decided);
    if (key === '') {
      rereadFor = '';
      return;
    }
    if (key === rereadFor) return;
    rereadFor = key;
    untrack(() => {
      // A superseded approval keeps its review id, so what was read of it is out of date, and the
      // run page's wait must read the approval it is at now.
      for (const reviewId of decided.superseded) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.bureauReviews.detail(reviewId) });
      }
      // A read the page could not make (a turn is going) is tried again at the next poll.
      void (async () => {
        // A read that threw is as unsuccessful as one that said no: the key is cleared for both, so
        // the next poll tries again instead of skipping this set of reviews for good.
        const read = await session.refresh().catch(() => false);
        if (read) {
          // The thread now says what is decided, so these reviews are not watched for any longer.
          seen.forget(decided);
        } else if (rereadFor === key) {
          rereadFor = '';
        }
      })();
      // The strip of runs under the header reads the same decision.
      void queryClient.invalidateQueries({ queryKey: ['bureau-tasks'] });
    });
  });

  async function decide(toolCallId: string, decision: 'approve' | 'deny'): Promise<void> {
    deciding = true;
    try {
      await session.controller.adapter.resolveToolApproval?.(toolCallId, {
        decision,
        remember: false,
      });
    } catch {
      // The controller reported it, and the approval is still pending for another try.
    } finally {
      deciding = false;
      // Whether it took effect or not, the approval is not what `/reviews` last listed, so the
      // inbox and the count in the navigation read again at once and do not wait for their poll.
      void invalidateReviewQueries(queryClient);
    }
  }

  onMount(() => {
    // A new chat has no thread yet, so there is nothing to attach to or to read back.
    if (!untrack(() => isNew)) void session.attach();
    // A branch made to resend an edited message opens with that message to send.
    const edited = untrack(() => (isNew ? undefined : takeEdit(sessionId)));
    if (edited !== undefined) void session.send(edited).catch(() => undefined);
    return () => session.dispose();
  });
</script>

{#snippet details()}
  <a
    class="weft-chat-header__agent"
    href={router.href(agentPath(agent))}
    onclick={(event) => openAgent(event, agent)}><code class="ib-identifier">{agent}</code></a
  >
  {#if context.data?.parentContextId}
    <BranchOrigin parentId={context.data.parentContextId} />
  {/if}
{/snippet}

{#snippet headerActions()}
  <ContextWindowRing report={contextWindow.data} failed={contextWindow.isError} />
  <ChatMoreMenu
    {sessionId}
    title={displayTitle}
    {runGoing}
    branchTarget={lastBranchTarget}
    {branching}
    canExport={hasExportableText(shown)}
    onBranch={(messageId) => void branchThrough(messageId)}
    onExport={exportChat}
  />
{/snippet}

<section class="weft-chat-route" aria-label={CHAT_COPY.regionLabel} data-session={sessionId}>
  {#if choosing}
    <PageHeader data-testid="chat-header" title={displayTitle} headingLevel={1} />
  {:else}
    <PageHeader
      data-testid="chat-header"
      title={displayTitle}
      headingLevel={1}
      description={details}
      actions={headerActions}
    />
  {/if}
  {#if !choosing}
    <div class="weft-chat-settings" data-testid="chat-settings">
      {#if context.data !== undefined}
        <dl class="weft-chat-settings__list" aria-label={SETTINGS.summaryLabel}>
          <div class="weft-chat-settings__item">
            <dt>{SETTINGS.model}</dt>
            <dd data-setting="model">{shownModel}</dd>
          </div>
          <div class="weft-chat-settings__item">
            <dt>{SETTINGS.effort}</dt>
            <dd data-setting="effort">{shownEffort}</dd>
          </div>
          <div class="weft-chat-settings__item">
            <dt>{SETTINGS.permission}</dt>
            <dd data-setting="permission">{shownPermission}</dd>
          </div>
        </dl>
      {/if}
      <p class="weft-chat-strip" role="status" data-testid="chat-settings-note">
        {#if appliesNote !== undefined}{appliesNote}{/if}
        {#if permissionDescription !== undefined}
          <span data-testid="permission-description">{permissionDescription}</span>
        {/if}
      </p>
    </div>
  {/if}

  {#if !choosing}
    <SessionTasks {sessionId} streaming={session.streaming} />
  {/if}

  <!-- The run reports a question as it parks, a moment before the turn that carried it is over; a
       message sent in between would be a follow-up, so the question waits for the turn's end. -->
  {#each session.streaming ? [] : session.humanRequests.slice(0, 1) as request (request.interruptId)}
    <Alert variant="info" class="weft-chat-approval" data-interrupt={request.interruptId}>
      <p class="weft-chat-approval__title">{CHAT_COPY.humanRequestTitle}</p>
      <p class="weft-chat-approval__message">
        {request.message === '' ? CHAT_COPY.humanRequestFallback : request.message}
      </p>
      <p class="weft-chat-approval__message">{CHAT_COPY.humanRequestHint}</p>
    </Alert>
  {/each}

  {#if session.failure !== undefined}
    <Alert variant="danger" dismissible onDismiss={() => session.dismissFailure()}>
      <p class="weft-chat-approval__title">{CHAT_COPY.failureTitle}</p>
      <p class="weft-chat-approval__message">{session.failure}</p>
    </Alert>
  {/if}

  {#if session.disconnected}
    <Alert variant="warning">
      <p class="weft-chat-approval__title">{CHAT_COPY.disconnected.title}</p>
      <p class="weft-chat-approval__message">{CHAT_COPY.disconnected.description}</p>
      <Button
        size="sm"
        variant="secondary"
        label={CHAT_COPY.disconnected.reconnect}
        onclick={() => void session.reconnect()}
      />
    </Alert>
  {/if}

  {#if branchFailure !== undefined}
    <Alert variant="danger" dismissible onDismiss={() => (branchFailure = undefined)}>
      <p class="weft-chat-approval__message">{branchFailure}</p>
    </Alert>
  {/if}

  <div class="weft-chat-surface">
    <Chat
      bind:this={chat}
      id={`chat-${sessionId}`}
      conversation={shown}
      adapter={session.chatAdapter}
      streaming={session.streaming}
      disabled={connection.unreachable || session.disconnected}
      streamingStatus={session.stopping ? CHAT_COPY.stopping : ''}
      capabilities={{ attachments: attachable, editing: !session.attaching, quote: true }}
      uploadAttachment={upload}
      acceptedTypes={settings?.acceptedTypes ?? []}
      maxFileSize={settings?.maxFileSize}
      formatAttachmentError={chatAttachmentErrorMessage}
    >
      {#snippet empty()}
        {#if choosing}
          <NewChatWelcome
            agents={agents.data ?? []}
            selected={agent}
            {chosen}
            onChoose={chooseAgent}
            onExample={fillComposer}
          />
        {:else}
          <EmptyState
            kind="first-use"
            size="compact"
            headingLevel={2}
            title={CHAT_COPY.emptyTranscript.title}
            description={CHAT_COPY.emptyTranscript.description}
          />
        {/if}
      {/snippet}
      {#snippet composerActions()}
        {#if choosing}
          <div class="ib-agent-pill">
            <Combobox
              id="weft-chat-agent"
              aria-label={CHAT_COPY.agentLabel}
              placeholder={CHAT_COPY.agentPlaceholder}
              size="sm"
              options={choices}
              value={agent}
              onValueChange={chooseAgent}
            />
          </div>
        {:else}
          <div class="weft-chat-controls">
            <ModelPicker
              {sessionId}
              agentName={agent}
              current={context.data?.model}
              revision={context.data?.configVersion}
              reload={reloadContext}
              locked={steering}
              unavailable={cannotSteer}
              onBusyChange={(busy) => (steering = busy)}
              onApplied={() => noted('step')}
            />
            <SettingSelect
              {sessionId}
              id="weft-chat-effort"
              label={SETTINGS.effort}
              options={SETTINGS.effortOptions}
              current={context.data?.effort}
              unsetLabel={SETTINGS.agentDefault}
              revision={context.data?.configVersion}
              send={(value, commandId, expectedRevision) =>
                steerContext({
                  contextId: sessionId,
                  commandId,
                  expectedRevision,
                  effort: value as Effort,
                })}
              notices={SETTINGS.effortNotices}
              reload={reloadContext}
              locked={steering}
              unavailable={cannotSteer}
              onBusyChange={(busy) => (steering = busy)}
              onApplied={() => noted('step')}
            />
            <SettingSelect
              {sessionId}
              id="weft-chat-permission"
              label={SETTINGS.permission}
              options={SETTINGS.permissionOptions}
              current={context.data?.permissionMode}
              revision={context.data?.configVersion}
              send={(value, commandId, expectedRevision) =>
                steerContext({
                  contextId: sessionId,
                  commandId,
                  expectedRevision,
                  permissionMode: value as PermissionMode,
                })}
              notices={SETTINGS.permissionNotices}
              reload={reloadContext}
              locked={steering}
              unavailable={cannotSteer}
              onBusyChange={(busy) => (steering = busy)}
              onApplied={() => noted('toolCall')}
            />
          </div>
        {/if}
      {/snippet}
      {#snippet messageActions({ message })}
        {#if branchPoints.has(message.id)}
          <Button
            data-changes
            type="button"
            class="chat-message-action-button"
            size="xs"
            variant="ghost"
            iconOnly
            label={CHAT_COPY.branch.action}
            disabled={branching}
            onclick={() => void branchThrough(message.id)}
          >
            <GitBranch class="cinder-icon-xs" />
          </Button>
        {/if}
      {/snippet}
      {#snippet row({ message }, renderDefault)}
        {@const group = activity.groups.get(message.id)}
        {@const assets = assetsOf(session.conversation.messages[message.id] ?? message)}
        {#if group !== undefined}
          <ToolCalls id={`tools-${message.id}`} entries={group.entries}>
            {#snippet decision(entry)}
              {@const asked = approvalsByCall.get(entry.callId)}
              {#if asked !== undefined}
                <ApprovalDecision
                  id={`tools-${message.id}-${entry.callId}`}
                  question={asked.question}
                  identifiers={asked.toolName === undefined ? [] : [asked.toolName]}
                  deciding={deciding || session.streaming}
                  onDecide={(choice) => void decide(entry.callId, choice)}
                />
              {/if}
            {/snippet}
          </ToolCalls>
        {:else if !activity.absorbed.has(message.id) && (assets.length === 0 || hasContent(message))}
          <!-- A message of only files has no bubble to show. A row with no file is Chat's own. A
               later call of a run of tool rows is shown with the first (`tool-activity.ts`). -->
          {@render renderDefault()}
        {/if}
        <ChatAssets {assets} role={message.role === 'user' ? 'user' : 'assistant'} />
      {/snippet}
      {#snippet messagePart(part, renderDefault)}
        {#if part.type !== 'tool-approval'}
          {@render renderDefault(part)}
        {/if}
      {/snippet}
    </Chat>
  </div>
</section>
