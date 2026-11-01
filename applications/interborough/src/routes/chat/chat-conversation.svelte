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
   * An agent's reply offers its details (`reply-details.svelte`): why it ran on its model and what the
   * model saw, from `bureau.tasks.inspect`, and the tokens its run used when this page watched the
   * run end. A reply the Bureau did not name as a step of a run has none.
   *
   * A session has a model picker in the composer (`model-picker.svelte`), and the final agent
   * message of each completed turn offers Branch from here (`branch-points.ts`), which opens a new
   * session that continues from that reply. A branch's header says where it came from
   * (`branch-origin.svelte`). The header's More menu (`chat-more-menu.svelte`) renames, branches,
   * exports and deletes the chat, and editing a message the person sent resends by fork
   * (`edit-fork.ts`): the chat is branched before the message and the edited text is sent on the
   * branch. An edit that does not branch keeps its text in a notice with Copy and Try again.
   * A chat deleted while its page is open closes the composer and says so, with a way back to the
   * list: the Bureau would start it again if it were sent to.
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
  import { Chat, ChatNote, ChatQuestion, resolveMessageNotes } from '@lostgradient/chat';
  import { GitBranch } from '@lucide/svelte';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { CHAT_COPY, REVIEWS_COPY } from '../../app/copy.ts';
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
    wireCodeOf,
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
  import { uploadAsset } from '../../lib/bureau-assets.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { createPendingCommandKey } from '../../lib/pending-command-key.ts';
  import { queryKeys } from '../../lib/query.ts';
  import ApprovalDecision from '../../lib/decision/approval-decision.svelte';
  import { approvalQuestion, argumentEntries, declaredSummary } from '../../lib/tool-text.ts';
  import { resolveBureauReviewMutation } from '../reviews/reviews-data.ts';
  import { isReviewRoundChanged, listBureauReviews } from '../../lib/bureau-reviews.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import InlineMarkdown from '../../lib/inline-markdown.svelte';
  import { invalidateReviewQueries } from '../../lib/review-queries.ts';
  import { getPrincipalStore, hasPrincipalStore } from '../../lib/scopes.svelte.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { shortcuts } from '../../lib/shortcuts.ts';
  import { downloadText } from '../audit/audit-export.ts';
  import BranchOrigin from './branch-origin.svelte';
  import { branchPointIds } from './branch-points.ts';
  import { agentModel } from './agent-model.ts';
  import { choiceButtons, pickChoice } from '../reviews/choice-buttons.ts';
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
  import ReplyDetails from './reply-details.svelte';
  import { replyStepOf } from './reply-details.ts';
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
    // A deleted chat is sent nothing, and a not-found is checked against a read of the chat.
    closed: () => gone,
    onNotFound: () => void context.refetch(),
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
  // The chat was deleted, here or elsewhere: the Bureau reads `session.deleted` into the chats, this
  // read is asked again, and it says not-found. A send then would start the chat again under the
  // same identifier, with every row it had, so the composer is closed.
  const gone = $derived(context.isError && wireCodeOf(context.error) === 'NotFound');
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
  const shown = $derived(
    withoutAssetParts(withTypedAnswers(session.conversation, session.schemaOfAnswer)),
  );

  // The messages that offer a branch. A run that is going, or that the page is still reading, has
  // not finished its last message.
  const branchPoints = $derived(
    branchPointIds(session.conversation, session.streaming || session.attaching),
  );
  /** A link in a line under a message (a memory record, a child run) opens its page inside the app. */
  function openNoteLink(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    const link =
      event.target instanceof Element ? event.target.closest('a[data-chat-note-link]') : null;
    const href = link?.getAttribute('href');
    if (href === null || href === undefined) return;
    event.preventDefault();
    router.navigate(href);
  }
  let branching = $state(false);
  let branchFailure = $state<string | undefined>(undefined);
  // The text of an edit that did not branch. Chat closes its editor when the person saves, so this
  // is the only place the text is kept.
  let keptEdit = $state<{ readonly messageId: string; readonly content: string } | undefined>();
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
    if (edited === undefined) keptEdit = undefined;
    try {
      const branchId = await forkContext({
        contextId: sessionId,
        commandId: branchCommands.keyFor(sessionId, messageId ?? ''),
        throughMessageId: messageId,
      });
      branchCommands.confirmed();
      keptEdit = undefined;
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
    // Kept until the branch is made: the editor has closed on the text, and a refusal or a failed
    // branch would otherwise lose it.
    keptEdit = event;
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

  /** Puts the kept edit on the clipboard, and says whether it got there. */
  async function copyKeptEdit(): Promise<void> {
    if (keptEdit === undefined) return;
    try {
      await navigator.clipboard.writeText(keptEdit.content);
      showToast(CHAT_COPY.edit.copied);
    } catch {
      showToast(CHAT_COPY.edit.copyFailed, { variant: 'danger', duration: 0 });
    }
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

  /** What a question that declares no schema takes: free text, answered in the composer. */
  const FREE_TEXT_SCHEMA = { type: 'string', title: CHAT_COPY.questionAnswerLabel } as const;
  let questionElement = $state<HTMLElement | undefined>();
  // Whether the open question draws choices to pick, which the drawn buttons say. It is read again
  // for each question, because the page stays mounted while the open question changes.
  let pickable = $state(false);
  $effect(() => {
    void session.humanRequests[0]?.interruptId;
    pickable = choiceButtons(questionElement).length > 0;
  });

  async function uploadQuestionFile(file: File, signal: AbortSignal): Promise<string> {
    const asset = await uploadAsset(file, { signal });
    return asset.assetId;
  }

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
      // Of this chat only: a call's identifier is the model's or the tool's, so another chat's
      // pending review can carry the same one, and the grant would be made on that chat's.
      const reviewed = pendingReviews.data?.find(
        (review) =>
          review.kind === 'tool-approval' &&
          review.sessionId === sessionId &&
          review.approval.callId === result.callId,
      );
      const toolName = reviewed?.kind === 'tool-approval' ? reviewed.approval.toolName : call?.name;
      return {
        toolCallId: result.callId,
        toolName,
        // The Bureau's review for the call, once its pending reviews have been read: the grant for
        // the rest of the chat is made on it, at the round the person was shown.
        review:
          reviewed?.kind === 'tool-approval'
            ? { id: reviewed.id, round: reviewed.round }
            : undefined,
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

  const grant = resolveBureauReviewMutation();

  /**
   * Approves the call and allows its tool for the rest of the chat. Unlike a plain decision, which
   * the controller sends with the next turn, the grant is only made by `bureau.reviews.resolve`
   * (`remember`), so it is sent the way the reviews inbox sends it, on the review at the round the
   * person was shown. The Bureau writes the outcome into the conversation, and the page reads it
   * back the way it reads a decision made in the inbox (see `SeenReviews`).
   */
  function allowForChat(toolCallId: string): void {
    const review = approvalsByCall.get(toolCallId)?.review;
    if (review === undefined) return;
    deciding = true;
    grant.mutate(
      { id: review.id, decision: 'approve', round: review.round, remember: true },
      {
        onSuccess: (resolution) => {
          // The Bureau has written the outcome into the conversation, so the thread is read now and
          // not at the next look at the reviews. A read that cannot be made (a turn is going) is
          // made by that look, which finds the review gone (see `SeenReviews`).
          void session.refresh().catch(() => false);
          if (resolution.receipt === 'superseded') {
            showToast(REVIEWS_COPY.superseded, { variant: 'warning', duration: 0 });
          } else if (resolution.outcomeNotWritten === true) {
            showToast(REVIEWS_COPY.outcomeNotWritten.message, { variant: 'warning', duration: 0 });
          } else if (resolution.remembered === false) {
            showToast(
              `${REVIEWS_COPY.notRemembered.title}. ${REVIEWS_COPY.notRemembered.message}`,
              { variant: 'warning', duration: 0 },
            );
          }
        },
        onError: (error) => {
          showToast(
            isReviewRoundChanged(error)
              ? `${REVIEWS_COPY.roundChanged.title}: ${REVIEWS_COPY.roundChanged.message}`
              : `${REVIEWS_COPY.decisionFailed}: ${faultTreatment(error).message}`,
            { variant: 'danger', duration: 0 },
          );
        },
        onSettled: () => {
          deciding = false;
        },
      },
    );
  }

  onMount(() => {
    // 1 to 9 pick the open question's choices. A key does nothing while the question is held (its
    // buttons are disabled) or when none is open.
    const removals = Array.from({ length: 9 }, (_, index) =>
      shortcuts.register({
        keys: [String(index + 1)],
        label: CHAT_COPY.pickShortcut(index + 1),
        group: CHAT_COPY.shortcutGroup,
        scope: { route: '/chats/:chat' },
        handler: () => {
          if (session.humanRequests.length > 0) pickChoice(questionElement, index + 1);
        },
      }),
    );
    // A new chat has no thread yet, so there is nothing to attach to or to read back.
    if (!untrack(() => isNew)) void session.attach();
    // A branch made to resend an edited message opens with that message to send.
    const edited = untrack(() => (isNew ? undefined : takeEdit(sessionId)));
    if (edited !== undefined) void session.send(edited).catch(() => undefined);
    return () => {
      for (const remove of removals) remove();
      session.dispose();
    };
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
  {#snippet markdownTitle()}<InlineMarkdown text={displayTitle} />{/snippet}
  {#if choosing}
    <PageHeader data-testid="chat-header" title={markdownTitle} headingLevel={1} />
  {:else}
    <PageHeader
      data-testid="chat-header"
      title={markdownTitle}
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
    <div class="weft-chat-question" data-interrupt={request.interruptId}>
      <p class="weft-chat-question__prompt">
        {request.message === '' ? CHAT_COPY.humanRequestFallback : request.message}
      </p>
      <div bind:this={questionElement} data-question-answer-region>
        <ChatQuestion
          {...{ 'data-changes': true }}
          id={`chat-question-${request.interruptId}`}
          schema={request.schema ?? FREE_TEXT_SCHEMA}
          answerInComposer
          busy={session.attaching}
          uploadFile={uploadQuestionFile}
          onSubmit={(value) => void session.answerQuestion(request.interruptId, value)}
        />
      </div>
      {#if pickable}
        <p class="weft-chat-question__hint">{CHAT_COPY.pickHint}</p>
      {/if}
    </div>
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
    <Alert
      variant="danger"
      dismissible
      onDismiss={() => {
        branchFailure = undefined;
        keptEdit = undefined;
      }}
    >
      <p class="weft-chat-approval__message">{branchFailure}</p>
      {#if keptEdit !== undefined}
        <p class="weft-chat-approval__message">{CHAT_COPY.edit.kept}</p>
        <blockquote class="weft-chat-approval__message" data-testid="kept-edit">
          {keptEdit.content}
        </blockquote>
        <Button
          size="sm"
          variant="secondary"
          label={CHAT_COPY.edit.copy}
          onclick={() => void copyKeptEdit()}
        />
        <Button
          data-changes
          size="sm"
          variant="secondary"
          label={CHAT_COPY.edit.tryAgain}
          disabled={branching}
          onclick={() => keptEdit !== undefined && editMessage(keptEdit)}
        />
      {/if}
    </Alert>
  {/if}

  {#if gone}
    <Alert variant="danger" data-testid="chat-gone">
      <p class="weft-chat-approval__title">{CHAT_COPY.gone.title}</p>
      <p class="weft-chat-approval__message">{CHAT_COPY.gone.description}</p>
      <Button
        size="sm"
        variant="secondary"
        label={CHAT_COPY.gone.back}
        onclick={() => router.navigate('/chats')}
      />
    </Alert>
  {/if}

  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="weft-chat-surface" onclick={openNoteLink}>
    <Chat
      bind:this={chat}
      id={`chat-${sessionId}`}
      conversation={shown}
      adapter={session.chatAdapter}
      streaming={session.streaming}
      surfaceMode="transparent"
      disabled={connection.unreachable || session.disconnected || gone}
      streamingStatus={session.stopping ? CHAT_COPY.stopping : ''}
      capabilities={{
        attachments: attachable && !gone,
        // A new chat has no context to branch yet, and a deleted one has none to branch from.
        editing: !session.attaching && !choosing && !gone,
        quote: true,
      }}
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
        {@const replyStep = message.role === 'assistant' ? replyStepOf(message.id) : undefined}
        {#if replyStep !== undefined && !session.streaming}
          <ReplyDetails
            runId={replyStep.runId}
            step={replyStep.step}
            usage={session.usage.get(replyStep.runId)}
          />
        {/if}
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
                  input={argumentEntries(entry.arguments)}
                  onDecide={(choice) => void decide(entry.callId, choice)}
                  onAllowForChat={() => allowForChat(entry.callId)}
                  canAllowForChat={asked.review !== undefined}
                />
              {/if}
            {/snippet}
          </ToolCalls>
          <!-- A group stands in for its rows, so the lines a run left on them are shown with it. -->
          {#each group.messageIds as rowId (rowId)}
            {@const held = session.conversation.messages[rowId]}
            {@const notes = held === undefined ? [] : (resolveMessageNotes(held) ?? [])}
            {#each notes as note (note.id)}
              <ChatNote {note} />
            {/each}
          {/each}
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
