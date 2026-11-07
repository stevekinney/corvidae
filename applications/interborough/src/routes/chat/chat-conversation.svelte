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
   * exports and deletes the chat. A message the person sent offers Branch and Copy, and Branch
   * (`edit-fork.ts` finds where) opens a branch from just before it, where the person types again.
   * A chat deleted while its page is open closes the composer and says so, with a way back to the
   * list: the Bureau would start it again if it were sent to.
   *
   * A new chat (`isNew`, at `/chats/new`) has no session yet. The client names the thread, the agent
   * is chosen from the pill in the composer, the transcript's place shows a greeting, the prompts
   * the agent suggests and the other agents (`new-chat-welcome.svelte`; a prompt fills the composer
   * and sends nothing), and the first message
   * starts the run. Home's Start a chat hands it a message, which is sent as that first message
   * (`new-chat-handoff.ts`). When the run has started
   * the address becomes `/chats/:chat` by replacing the history entry, with this page kept
   * mounted (`router.navigate`'s `keep`), and the agent is fixed from then on.
   */
  import { onMount, tick, untrack } from 'svelte';
  import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge';

  import {
    Alert,
    Button,
    ConfirmDialog,
    EmptyState,
    PageHeader,
    StatusDot,
    ToolCallPanel,
    VisuallyHidden,
    type ApprovalResolution,
  } from '@lostgradient/cinder';
  import {
    Chat,
    ChatNote,
    ChatQuestion,
    McpApp,
    resolveMessageNotes,
    type MessageNoteInfo,
  } from '@lostgradient/chat';
  import { CircleHelp, GitBranch } from '@lucide/svelte';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { CHAT_COPY, REVIEWS_COPY } from '../../app/copy.ts';
  import { usePageDetails, usePageLabel } from '../../app/breadcrumbs.svelte.ts';
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
    type Effort,
    type PermissionMode,
  } from '../../lib/bureau-client.ts';
  import {
    attachmentSettings,
    chatAttachmentErrorMessage,
    createAttachmentUpload,
  } from '../../lib/chat-attachments.ts';
  import { getAgentCatalog, getAgentDefinition } from '../../lib/agent-definitions.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import { getPlugins } from '../../lib/host-plugins.ts';
  import { getProviders } from '../../lib/host-providers.ts';
  import { answerUndoMilliseconds } from '../../lib/answer-undo.ts';
  import { uploadAsset } from '../../lib/bureau-assets.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { createPendingCommandKey } from '../../lib/pending-command-key.ts';
  import { isRunning, listTasks } from '../../lib/bureau-tasks.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { readMcpHostContext } from '../../lib/mcp-host-context.ts';
  import { getMcpApps, loadPluginApp, pluginToolCaller } from '../../lib/host-mcp-apps.ts';
  import { approvalQuestion, declaredSummary } from '../../lib/tool-text.ts';
  import { listBureauReviews } from '../../lib/bureau-reviews.ts';
  import InlineMarkdown from '../../lib/inline-markdown.svelte';
  import { invalidateReviewQueries } from '../../lib/review-queries.ts';
  import { getPrincipalStore, hasPrincipalStore } from '../../lib/scopes.svelte.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { shortcuts } from '../../lib/shortcuts.ts';
  import { downloadText } from '../audit/audit-export.ts';
  import { useMinuteClock } from '../home/home-clock.svelte.ts';
  import { modelInUse } from './agent-model.ts';
  import BranchOrigin from './branch-origin.svelte';
  import ChatApproval from './chat-approval.svelte';
  import { branchPointIds } from './branch-points.ts';
  import { choiceButtons, pickChoice } from '../reviews/choice-buttons.ts';
  import ChatAssets from './chat-assets.svelte';
  import {
    CHAT_EXPORT_TYPE,
    chatExportFilename,
    chatMarkdown,
    hasExportableText,
  } from './chat-export.ts';
  import ChatDetails from './chat-details.svelte';
  import ChatMoreMenu from './chat-more-menu.svelte';
  import { takeFirstMessage } from './new-chat-handoff.ts';
  import AgentSelect from './agent-select.svelte';
  import ComposerSettings from './composer-settings.svelte';
  import ContextMeter from './context-meter.svelte';
  import ContextWindowRing from './context-window-ring.svelte';
  import SettingSelect from './setting-select.svelte';
  import RestartDialog from '../../app/restart/restart-dialog.svelte';
  import { RestartFlow } from '../settings/plugins/restart-flow.svelte.ts';
  import { withTypedAnswers } from './answer-rows.ts';
  import { assetsOf, hasContent, withoutAssetParts } from './chat-assets.ts';
  import { ChatSessionState } from './chat-session.svelte.ts';
  import type { GrantNotLoosened } from './run-wiring.ts';
  import { decidedKey, SeenReviews } from './decided-elsewhere.ts';
  import type { DecisionContext } from './approval-decision-words.ts';
  import { editForkPoint, lastBranchPoint } from './edit-fork.ts';
  import { composerStatusOf } from './composer-state.ts';
  import { changeSetting, type SteerNotices } from './steer-change.ts';
  import ModelPicker from './model-picker.svelte';
  import NewChatWelcome from './new-chat-welcome.svelte';
  import ReplyDetails from './reply-details.svelte';
  import { replyModelLabel, replyModelOf } from './reply-model.ts';
  import { replyStepOf } from './reply-details.ts';
  import {
    formatCallDuration,
    railCall,
    toolGroups,
    type ToolCallEntry,
    type ToolInfo,
  } from './tool-activity.ts';
  import { failedStopNoteId, withStopLine } from './stop-line.ts';
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
    /**
     * For a new chat started from Workflows: no agent has the Create workflow tool, so the
     * composer says so in its blocked row, with the way to Agents, and keeps what was typed.
     */
    noWorkflowAgent?: boolean;
  }

  let {
    sessionId,
    title,
    agentName,
    isNew = false,
    agentChosen = false,
    noWorkflowAgent = false,
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
    // A deleted chat is sent nothing, and a not-found is checked against a read of the chat.
    closed: () => gone,
    onNotFound: () => void context.refetch(),
    onGrantNotLoosened: (notice) => grantNotLoosened(notice),
    onRunStarted: () => {
      if (!choosing) return;
      choosing = false;
      // The session exists now. Its address replaces the new chat's, so Back returns to where the
      // person came from, and this page stays mounted so the run carries on.
      router.navigate(chatSessionPath(sessionId), { replace: true, keep: true });
      void queryClient.invalidateQueries({ queryKey: ['contexts'] });
      void applyDraft();
    },
  });

  const agents = createQuery(
    () => ({
      queryKey: queryKeys.agents.list(),
      queryFn: ({ signal }) => listAgents({ signal }),
    }),
    undefined,
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
  const clock = useMinuteClock();
  /** The model that wrote the chat's latest reply, which names the chat's model when nothing else does. */
  const lastReplyModel = $derived.by(() => {
    const { ids, messages } = session.conversation;
    for (let index = ids.length - 1; index >= 0; index -= 1) {
      const row = messages[ids[index] ?? ''];
      const recorded = row?.role === 'assistant' ? replyModelOf(row.metadata) : undefined;
      if (recorded !== undefined) return recorded;
    }
    return undefined;
  });
  /** A Bureau timestamp as epoch milliseconds, or `null` when it cannot be read. */
  function epochOf(timestamp: string): number | null {
    const milliseconds = Date.parse(timestamp);
    return Number.isNaN(milliseconds) ? null : milliseconds;
  }
  // The last breadcrumb names the chat and opens its details (`chat-details.svelte`). A new chat has
  // no session to name yet, and a chat that is gone has no details to give.
  const crumbPath = $derived(chatSessionPath(sessionId));
  const hasCrumb = $derived(!choosing && !gone);
  usePageLabel(() => ({ path: crumbPath, label: hasCrumb ? displayTitle : undefined }));
  usePageDetails(() => ({ path: crumbPath, content: hasCrumb ? detailsPopover : undefined }));

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
  // The agents are read once and then known; until then the composer holds Model and Effort back, so
  // a scripted agent's composer never shows them for a moment, and no provider is asked for.
  // Whether the agent runs on a model, which is what needs a provider and what Model and Effort
  // change. A scripted agent names none (`media` is null) and offers no model to switch to, so its
  // composer has Permissions only.
  const agentSummary = $derived(agents.data?.find((entry) => entry.name === agent));
  const agentKnown = $derived(!agents.isPending);
  const usesModel = $derived(
    agentKnown &&
      (agentSummary === undefined ||
        agentSummary.media !== null ||
        (models.data?.models.length ?? 0) > 0),
  );
  // Whether any provider holds a key, the rule the first-run checklist states. Until the host has
  // answered, the composer is not blocked.
  const providers = createQuery(
    () => ({
      queryKey: queryKeys.hostProviders(),
      queryFn: ({ signal }) => getProviders({ signal }),
      retry: false,
    }),
    undefined,
  );
  const noProvider = $derived(
    usesModel &&
      providers.data !== undefined &&
      !providers.data.providers.some((provider) => provider.hasKey),
  );

  // An agent that a disabled plugin ships (`plugin:name`) cannot run, and the composer says so with
  // the way back: enable the plugin and restart the host.
  const definition = createQuery(
    () => ({
      queryKey: queryKeys.agents.definition(agent),
      queryFn: ({ signal }) => getAgentDefinition(agent, { signal }),
      enabled: !choosing && agent.includes(':'),
      retry: false,
    }),
    undefined,
  );
  const agentUnavailable = $derived(definition.data?.state === 'unavailable');
  // What the catalog says of each tool, for its name as a person reads it and for what an
  // interrupted call may have done. A catalog that cannot be read leaves the identifiers as names and
  // treats every tool as one that may change things.
  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.agents.catalog(),
      queryFn: ({ signal }) => getAgentCatalog({ signal }),
      enabled: !choosing,
      retry: false,
    }),
    undefined,
  );
  const toolInfo = $derived(
    new Map<string, ToolInfo>(
      (catalog.data?.tools ?? []).map(
        (tool) => [tool.name, { title: tool.title, tier: tool.tier }] as const,
      ),
    ),
  );
  const plugins = createQuery(
    () => ({
      queryKey: queryKeys.hostPlugins(),
      queryFn: ({ signal }) => getPlugins({ signal }),
      enabled: agentUnavailable,
      retry: false,
    }),
    undefined,
  );
  const pluginName = $derived(agent.split(':')[0] ?? agent);
  const pluginTitle = $derived(
    plugins.data?.plugins.find((entry) => entry.descriptor.name === pluginName)?.descriptor.title ??
      /^Plugin (.+) is disabled$/.exec(definition.data?.unavailable?.message ?? '')?.[1] ??
      pluginName,
  );
  const restart = new RestartFlow();
  let confirmingEnable = $state(false);
  // Once the host answers again the plugin is on, so the agent is available and the chat reads the
  // host again.
  $effect(() => {
    if (restart.phase !== 'back') return;
    untrack(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definition(agent) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.hostPlugins() });
    });
  });

  // The settings share one revision, so while one is being changed the others wait for it.
  let steering = $state(false);
  // When the change the person made takes effect, as the line under the composer says it: which
  // setting, which value, and from when, which depends on whether a run is going.
  let appliesNote = $state<string | undefined>(undefined);
  // How many rows the transcript held when the note was made. A step of the run adds rows, and
  // the note is out of date once the next one does.
  let notedRows = 0;
  const rowCount = $derived(Object.keys(session.conversation.messages).length);
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
  $effect(() => {
    // ...and once the next step has started, which adds to the transcript.
    const rows = rowCount;
    untrack(() => {
      if (appliesNote !== undefined && rows > notedRows) appliesNote = undefined;
    });
  });
  function noted(setting: 'step' | 'toolCall', name: string, value: string): void {
    notedRows = untrack(() => rowCount);
    appliesNote = runGoing
      ? SETTINGS.applies[setting](name, value)
      : SETTINGS.applies.nextRun(name, value);
  }

  // Assistant is the scripted agent a chat can fall back on without a provider: the host's own
  // (`assistant`) or the Demo plugin's copy (`demo:assistant`).
  const assistantName = $derived(
    (
      agents.data?.find((entry) => entry.name === 'assistant') ??
      agents.data?.find((entry) => entry.name.endsWith(':assistant'))
    )?.name,
  );
  const composerStatus = $derived(
    composerStatusOf({
      unreachable: connection.unreachable,
      restarting: restart.running,
      unavailable: agentUnavailable
        ? {
            agent: definition.data?.name ?? agent,
            plugin: pluginTitle,
            enable: () => (confirmingEnable = true),
          }
        : undefined,
      ended: context.data?.endReason === 'host-stopped',
      noProvider,
      noWorkflowAgent: choosing && noWorkflowAgent,
      agentsHref: router.href('/agents'),
      connectHref: router.href('/settings/models'),
      useAssistant:
        choosing && assistantName !== undefined && agent !== assistantName
          ? () => chooseAgent(assistantName)
          : undefined,
      newChatHref: router.href('/chats/new'),
      reconnectAttempt: session.reconnectAttempt,
      queuedFollowUps: session.queuedFollowUps,
      note: appliesNote,
      working: session.streaming,
    }),
  );

  // What the person chose in the composer before the chat had a session. A session is what the
  // Bureau steers, so the choices wait here and are applied, one after the other, as soon as the
  // first message has started it (`applyDraft`); they take effect from the run's next step.
  let draftModel = $state<{ provider: string; model: string; displayName: string } | undefined>();
  let draftEffort = $state<string | undefined>();
  let draftPermission = $state<string | undefined>();
  const settingNotices = {
    model: {
      staleRevision: CHAT_COPY.modelPicker.staleRevision,
      denied: CHAT_COPY.modelPicker.modelNotAllowed,
      sessionTerminal: CHAT_COPY.modelPicker.sessionTerminal,
      unsupportedCapability: CHAT_COPY.modelPicker.unsupportedCapability,
      notChanged: CHAT_COPY.modelPicker.notSwitched,
      fault: CHAT_COPY.modelPicker.fault,
    },
    effort: SETTINGS.effortNotices,
    permission: SETTINGS.permissionNotices,
  } satisfies Record<string, SteerNotices>;

  /** Applies what was chosen before the session existed, each change under the revision the last left. */
  async function applyDraft(): Promise<void> {
    const model = draftModel;
    const effort = draftEffort;
    const permission = draftPermission;
    draftModel = draftEffort = draftPermission = undefined;
    if (model === undefined && effort === undefined && permission === undefined) return;
    const commands = createPendingCommandKey();
    const first = await context.refetch();
    let revision = first.data?.configVersion;
    const changes = [
      ...(model === undefined
        ? []
        : [
            {
              name: SETTINGS.model,
              label: model.displayName,
              kind: 'step' as const,
              notices: settingNotices.model,
              request: (commandId: string, expectedRevision: number) =>
                steerContext({
                  contextId: sessionId,
                  commandId,
                  expectedRevision,
                  override: { provider: model.provider, model: model.model },
                }),
            },
          ]),
      ...(effort === undefined
        ? []
        : [
            {
              name: SETTINGS.effort,
              label:
                SETTINGS.effortOptions.find((entry) => entry.value === effort)?.label ?? effort,
              kind: 'step' as const,
              notices: settingNotices.effort,
              request: (commandId: string, expectedRevision: number) =>
                steerContext({
                  contextId: sessionId,
                  commandId,
                  expectedRevision,
                  effort: effort as Effort,
                }),
            },
          ]),
      ...(permission === undefined
        ? []
        : [
            {
              name: SETTINGS.permission,
              label:
                SETTINGS.permissionOptions.find((entry) => entry.value === permission)?.label ??
                permission,
              kind: 'toolCall' as const,
              notices: settingNotices.permission,
              request: (commandId: string, expectedRevision: number) =>
                steerContext({
                  contextId: sessionId,
                  commandId,
                  expectedRevision,
                  permissionMode: permission as PermissionMode,
                }),
            },
          ]),
    ];
    for (const change of changes) {
      if (revision === undefined) {
        appliesNote = change.notices.fault;
        return;
      }
      const expected = revision;
      const result = await changeSetting({
        commands,
        scope: sessionId,
        content: `${change.name}:${change.label}`,
        send: (commandId) => change.request(commandId, expected),
        reload: reloadContext,
        notices: change.notices,
      });
      if (!result.applied) {
        appliesNote = result.notice ?? change.notices.notChanged;
        return;
      }
      revision = context.data?.configVersion;
      noted(change.kind, change.name, change.label);
    }
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

  let route = $state<HTMLElement | undefined>();
  /** The frames to wait for the approval's row to be drawn before giving up on bringing the person to it. */
  const ARRIVAL_FRAMES = 20;
  /**
   * Whether the chat has opened on a run it joined and the page has not yet seen whether that run is
   * waiting on an approval. The approvals arrive with the run's own events, after the join.
   */
  let arriving = $state(false);

  // Opening a chat that is waiting on an approval brings the person to it (board ChatPage frame a):
  // the row scrolls into view and takes focus, which reads its question, and nothing is answered.
  // It happens once, as the chat opens: an approval that arrives while the person is in the
  // conversation never takes their focus, so the question is settled when the joined run stops.
  $effect(() => {
    if (!arriving) return;
    if (session.approvals.length > 0) {
      untrack(() => {
        arriving = false;
        void focusApproval();
      });
    } else if (!session.streaming && !session.attaching) {
      untrack(() => (arriving = false));
    }
  });

  /** Scrolls the first approval's row into view and focuses it, once it is drawn. */
  async function focusApproval(): Promise<void> {
    for (let frame = 0; frame < ARRIVAL_FRAMES; frame += 1) {
      await tick();
      const row = route?.querySelector<HTMLElement>('[data-approval-decision]');
      if (row !== null && row !== undefined) {
        row.scrollIntoView?.({ block: 'center' });
        row.focus({ preventScroll: true });
        return;
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
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
  // The status line under a reply that stopped is worded here, from what the run was in the middle
  // of, so it is drawn on the row it belongs to (`withStopLine`).
  const shown = $derived(
    withoutAssetParts(
      withTypedAnswers(
        withStopLine(session.conversation, { tools: toolInfo }),
        session.schemaOfAnswer,
      ),
    ),
  );

  // The status line Retry is offered beside: the last turn's, when its run failed. A failed attempt
  // of an earlier turn keeps its line (row 20b) with nothing beside it, since Retry runs the last
  // turn again.
  const retryNoteId = $derived(failedStopNoteId(shown));

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
  const retryCommands = createPendingCommandKey();

  /**
   * Runs the last turn again (Retry on the status line under a reply that stopped), after the
   * failed attempt, which stays on record. A call the run was interrupted on that may change things
   * goes back through its approval, so a chat set to Allow all is set to On changes first, and the
   * composer says so (the chat's "Allow for the rest of this chat" grant for the tool is forgotten,
   * `ChatSessionState.retryTurn`). When the setting cannot be changed, nothing is sent: the call
   * would otherwise run unasked.
   */
  async function retryTurn(): Promise<void> {
    const changing = session.interruptedCallsThatMayChange(toolInfo);
    const data = context.data;
    if (changing.length > 0 && data?.permissionMode === 'allow-all') {
      const result = await changeSetting({
        commands: retryCommands,
        scope: sessionId,
        content: 'on-changes',
        send: (commandId) =>
          steerContext({
            contextId: sessionId,
            commandId,
            expectedRevision: data.configVersion,
            permissionMode: 'on-changes',
          }),
        reload: reloadContext,
        notices: SETTINGS.permissionNotices,
      });
      if (!result.applied) {
        showToast(result.notice ?? SETTINGS.permissionNotices.notChanged, {
          variant: 'warning',
          duration: 0,
        });
        return;
      }
      const onChanges = SETTINGS.permissionOptions.find((entry) => entry.value === 'on-changes');
      noted('toolCall', SETTINGS.permission, onChanges?.label ?? 'On changes asks');
    }
    await session.retryTurn({ tools: toolInfo });
  }

  let branching = $state(false);
  let branchFailure = $state<string | undefined>(undefined);
  const branchCommands = createPendingCommandKey();
  // The reply the More menu's Branch branches from: the last one a branch can be made from.
  const lastBranchTarget = $derived(lastBranchPoint(session.conversation, branchPoints));

  /**
   * Where Branch on a message branches: a reply branches from itself, and a message the person sent
   * from just before it. `undefined` where the Bureau offers no branch (a run is going, or the
   * message follows no finished reply).
   */
  function branchTargetOf(message: { readonly id: string; readonly role: string }) {
    if (choosing || gone) return undefined;
    if (message.role === 'assistant') {
      return branchPoints.has(message.id) ? { messageId: message.id } : undefined;
    }
    if (message.role !== 'user') return undefined;
    const before = editForkPoint(session.conversation, message.id, branchPoints);
    return before === undefined ? undefined : { messageId: before };
  }

  /**
   * The model a reply was written by, by its name for a person: the one the Bureau recorded on the
   * reply's row, never the one the chat runs on now. `undefined` for a reply that records none.
   */
  function replyModelName(metadata: Readonly<Record<string, unknown>>): string | undefined {
    const replyModel = replyModelOf(metadata);
    return replyModel === undefined
      ? undefined
      : replyModelLabel(replyModel, models.data?.models ?? []);
  }

  /** What a refused or failed branch says: the Bureau's reason when it gave one, else `fault`. */
  function branchFailureText(error: unknown, fault: string): string {
    const reason = forkRefusalReason(error);
    const refused: Readonly<Record<string, string>> = CHAT_COPY.branch.refused;
    return (reason === undefined ? undefined : refused[reason]) ?? fault;
  }

  /**
   * Branches the chat through `messageId`, or before its first message when that is `null`, and
   * opens the branch. The original chat keeps what it had.
   */
  async function branchThrough(messageId: string | null): Promise<void> {
    branching = true;
    branchFailure = undefined;
    try {
      const branchId = await forkContext({
        contextId: sessionId,
        commandId: branchCommands.keyFor(sessionId, messageId ?? ''),
        throughMessageId: messageId,
      });
      branchCommands.confirmed();
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
      branchFailure = branchFailureText(error, CHAT_COPY.branch.fault);
    } finally {
      branching = false;
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
  /**
   * The last answer this page sent: while it is on its way, and while the run it continues streams,
   * the row says which one (Approving… or Denying…) and holds both buttons.
   */
  let decidingAs = $state<'approve' | 'deny' | undefined>();
  /** The calls this page decided itself, which are not "decided elsewhere" when their approval leaves the Bureau's list. */
  const decidedHere = new Set<string>();
  /**
   * Whether this page decided an approval since the thread was last read. The run it continues
   * streams the call's result, which carries no record of who decided; reading the thread when that
   * run stops shows the decision as it is kept (the denied row and its note), as a reload would.
   */
  let ownDecisionUnread = false;
  let wasStreaming = false;
  $effect(() => {
    const streaming = session.streaming;
    const stopped = wasStreaming && !streaming;
    wasStreaming = streaming;
    if (stopped && ownDecisionUnread) {
      ownDecisionUnread = false;
      void untrack(() => session.refresh()).catch(() => false);
    }
  });
  /** The calls whose approval was decided on another page while this one showed it waiting (`/reviews`). */
  let decidedAway = $state<ReadonlySet<string>>(new Set());
  /** What a polite live region says about a decision made on another page: said once, then left. */
  let announcement = $state('');
  /** The words of a decided approval depend on who the person is to this chat and where it was decided. */
  const decisionContext = $derived<DecisionContext>({
    owner: context.data?.owner,
    elsewhere: decidedAway,
  });

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

  /** Whether an answer is held for its Undo window, which keeps the composer from taking a second. */
  let answerHeld = $state(false);
  // The composer answers while a question waits (or its answer is held for the Undo window): it reads
  // the choices above when the question draws some, and Answer when it takes free text.
  const answering = $derived(
    (session.humanRequests.length > 0 && !session.streaming) || answerHeld,
  );
  /** The question whose answer was just sent, kept on show as "You answered" while the run goes on. */
  let sentRequest = $state.raw<(typeof session.humanRequests)[number] | undefined>();
  // The run reports a question as it parks, a moment before the turn that carried it is over; a
  // message sent in between would be a follow-up, so the question waits for the turn's end. Once its
  // answer is sent the question stays, answered, while the run continues.
  const shownRequests = $derived.by(() => {
    if (!session.streaming) return session.humanRequests.slice(0, 1);
    return sentRequest === undefined ? [] : [sentRequest];
  });
  $effect(() => {
    // A question that is open again, or none at all, is not the one that was sent.
    if (!session.streaming && sentRequest !== undefined) {
      const open = session.humanRequests[0];
      if (open?.interruptId !== sentRequest.interruptId) sentRequest = undefined;
    }
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
        requestedAt: reviewed?.requestedAt,
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
  // A call with no answer that nothing is working on any more was interrupted.
  // A failure the transcript already says, on the row it belongs to, is not said again above it: a
  // message that never got an answer is marked "Not sent".
  const failureShownInTranscript = $derived(
    session.failureWasTransport &&
      Object.values(session.conversation.messages).some(
        (row) => row.metadata['_deliveryStatus'] === 'failed',
      ),
  );
  const lastRowId = $derived(
    shown.ids.findLast((rowId) => shown.messages[rowId]?.hidden === false),
  );
  /** Whether a group of calls is the end of a turn that finished with no reply, so its rail closes with the run's end state. */
  function endsTheTurn(group: {
    readonly entries: readonly { readonly state: string }[];
    readonly messageIds: readonly string[];
  }): boolean {
    return (
      !runGoing &&
      approvals.length === 0 &&
      shownRequests.length === 0 &&
      session.failure === undefined &&
      group.messageIds.at(-1) === lastRowId &&
      group.entries.every((entry) => entry.state === 'done' || entry.state === 'denied')
    );
  }
  // The chat's state beside its title, in the shared status words: a person's turn first, then a
  // run going, then how the last one ended. A new chat, and one with nothing said yet, has none.
  const chatStatus = $derived.by(() => {
    if (choosing || Object.keys(session.conversation.messages).length === 0) return undefined;
    if (context.data?.endReason === 'host-stopped') return CHAT_COPY.status.ended;
    if (
      approvals.length > 0 ||
      shownRequests.length > 0 ||
      context.data?.activity === 'awaiting-input'
    ) {
      return CHAT_COPY.status.waiting;
    }
    if (runGoing) return CHAT_COPY.status.running;
    if (retryNoteId !== undefined) return CHAT_COPY.status.failed;
    return CHAT_COPY.status.done;
  });
  // The Bureau's time, which a running call's duration counts to. It moves only while a call runs,
  // a tenth of a second at a time, which is the precision the rail prints.
  const RUNNING_CALL_TICK_MILLISECONDS = 100;
  let bureauNow = $state(session.clock.now());
  const activity = $derived(
    toolGroups(session.conversation, {
      runActive: runGoing,
      tools: toolInfo,
      timing: {
        now: bureauNow,
        callStarts: session.callStarts,
        callEnds: session.callEnds,
        ...(session.stoppedAt === undefined ? {} : { stoppedAt: session.stoppedAt }),
      },
    }),
  );
  // The call whose panel is open, with where it falls in its turn. A call that is gone (the page
  // moved to another chat, or the turn was read again without it) has no panel.
  let selectedCallId = $state<string | undefined>();
  const selectedCall = $derived.by(() => {
    if (selectedCallId === undefined) return undefined;
    for (const group of activity.groups.values()) {
      const index = group.entries.findIndex((entry) => entry.callId === selectedCallId);
      const entry = group.entries[index];
      if (entry !== undefined) return { entry, number: index + 1, total: group.entries.length };
    }
    return undefined;
  });
  function selectCall(callId: string): void {
    selectedCallId = selectedCallId === callId ? undefined : callId;
  }
  // Closing the panel hands focus back to the row that opened it.
  async function focusCallRow(callId: string): Promise<void> {
    await tick();
    for (const row of route?.querySelectorAll<HTMLElement>('[data-cinder-tool-call-row]') ?? []) {
      if (row.dataset['cinderToolCallRow'] === callId) {
        row.focus();
        return;
      }
    }
  }
  function closeCallPanel(): void {
    const callId = selectedCallId;
    selectedCallId = undefined;
    if (callId !== undefined) void focusCallRow(callId);
  }
  const callRunning = $derived(
    [...activity.groups.values()].some((group) =>
      group.entries.some((entry) => entry.state === 'running'),
    ),
  );
  $effect(() => {
    if (!callRunning) return;
    bureauNow = untrack(() => session.clock.now());
    // poll-reason: clock
    const timer = setInterval(() => {
      bureauNow = session.clock.now();
    }, RUNNING_CALL_TICK_MILLISECONDS);
    return () => clearInterval(timer);
  });
  const mcpApps = createQuery(
    () => ({
      queryKey: queryKeys.hostMcpApps(),
      queryFn: ({ signal }) => getMcpApps({ signal }),
      retry: false,
    }),
    undefined,
  );
  // Host context is sent through postMessage; keep it raw so the bridge receives a structured-
  // cloneable object rather than a deeply proxied Svelte state value.
  let mcpHostContext = $state.raw<McpUiHostContext>({ theme: 'light' });

  onMount(() => {
    const root = document.documentElement;
    const update = (): void => {
      mcpHostContext = readMcpHostContext(root);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  });
  const workflowRevisionPanels = $derived(
    (mcpApps.data ?? []).filter(
      (panel) => panel.opensFromAgentTool === 'bureau:workflows-propose-update',
    ),
  );
  const revisionProposalText = (entry: ToolCallEntry): string | undefined => {
    const serialized =
      typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result);
    if (serialized === undefined) return undefined;
    try {
      const parsed = JSON.parse(serialized) as unknown;
      return typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        Reflect.get(parsed, 'status') === 'ok' &&
        typeof Reflect.get(parsed, 'id') === 'string' &&
        typeof Reflect.get(parsed, 'baseHash') === 'string' &&
        typeof Reflect.get(parsed, 'proposedText') === 'string'
        ? serialized
        : undefined;
    } catch {
      return undefined;
    }
  };

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
  // A stream that gave up while Interborough could not be reached is joined again once it answers,
  // so the person is not left to press Reconnect for a drop the banner already explained.
  let wasUnreachable = false;
  $effect(() => {
    const unreachable = connection.unreachable;
    const recovered = wasUnreachable && !unreachable;
    wasUnreachable = unreachable;
    if (recovered && untrack(() => session.disconnected)) void untrack(() => session.reconnect());
  });
  let rereadFor = '';
  /**
   * Says, for the approvals that were waiting here and were decided on another page, what became of
   * them: the row collapses to the decision (`decidedAway`) and a polite live region announces it
   * once. Only a call whose thread now carries the Bureau's record of the decision is spoken for: an
   * approval that was gated again, or whose outcome the Bureau could not write, was not decided.
   */
  function sayDecidedAway(calls: readonly string[], questions: ReadonlyMap<string, string>): void {
    const entries = [...activity.groups.values()].flatMap((group) => group.entries);
    const away = calls.flatMap((callId) => {
      const entry = entries.find((candidate) => candidate.callId === callId);
      return decidedHere.has(callId) || entry?.decision === undefined ? [] : [entry];
    });
    if (away.length === 0) return;
    decidedAway = new Set([...decidedAway, ...away.map((entry) => entry.callId)]);
    announcement = away
      .map((entry) =>
        CHAT_COPY.tools.decided.announcement(
          entry.decision?.outcome === 'denied'
            ? CHAT_COPY.tools.decided.denied
            : CHAT_COPY.tools.decided.approved,
          CHAT_COPY.tools.decided.elsewhere,
          questions.get(entry.callId) ??
            approvalQuestion({
              toolName: entry.name,
              arguments: entry.arguments,
              summary: entry.decision?.asked,
            }),
        ),
      )
      .join(' ');
  }
  /**
   * Whether a decision made on another page settled what the chat waited on and the page has not yet
   * joined the run that continues it. `bureau.reviews.resolve` starts that run once the last
   * approval of the chat's run is decided (COR-2016), just after the decision itself is announced, so
   * the read of the thread the announcement causes can come before it. The chat's newest runs are
   * read until one is going, and the page joins it: the chat shows Running, Stop takes Send's place,
   * and a message steers the run. They are read again whenever `bureau.events` reports a run, and
   * every few seconds while that feed is not live. The wait ends when the page joins a run, when the
   * person sends, or when the chat waits on a person again.
   */
  let awaitingContinuation = $state(false);
  const latestRuns = createQuery(
    () => ({
      queryKey: queryKeys.bureauTasks.sessionLatest(sessionId),
      queryFn: ({ signal }) => listTasks({ contextId: sessionId, limit: 5 }, { signal }),
      enabled: awaitingContinuation && !session.streaming && !session.attaching,
      // poll-reason: fallback
      refetchInterval: bureauLive() ? false : REREAD_POLL_MILLISECONDS,
      retry: false,
    }),
    undefined,
  );
  $effect(() => {
    if (!awaitingContinuation) return;
    if (session.streaming || waitingOnPerson) {
      untrack(() => (awaitingContinuation = false));
      return;
    }
    const going = latestRuns.data?.tasks.some(isRunning) === true;
    if (!going || session.attaching) return;
    untrack(() => void joinContinuation());
  });
  /**
   * Joins the run the chat's runs show going, and stops waiting for one once it has. The chat is
   * read again then: what was read while it waited on the approval says it still does, and the
   * header reads Running from the Bureau's own record of the chat (design row 18j).
   */
  async function joinContinuation(): Promise<void> {
    if (!(await session.attach())) return;
    awaitingContinuation = false;
    void queryClient.invalidateQueries({ queryKey: queryKeys.contexts.detail(sessionId) });
  }
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
        const questions = new Map(approvals.map((entry) => [entry.toolCallId, entry.question]));
        const read = await session.refresh().catch(() => false);
        if (read) {
          // The thread now says what is decided, so these reviews are not watched for any longer.
          seen.forget(decided);
          sayDecidedAway(decided.calls, questions);
          // An approval decided there continues the chat with a run of its own, which the read
          // may have come too early to join.
          if (decided.calls.length > 0 && !session.streaming) awaitingContinuation = true;
        } else if (rereadFor === key) {
          rereadFor = '';
        }
      })();
      // The strip of runs under the header reads the same decision.
      void queryClient.invalidateQueries({ queryKey: ['bureau-tasks'] });
    });
  });

  /**
   * Sends the person's decision on one approval: Approve or Deny, with the note they left (a refusal
   * carries it to the agent as the reason) and, on an approval, whether to allow the tool for the
   * rest of the chat. The grant rides the same resume Approve sends, so the turn continues the same
   * way and a refused round or a superseded approval is reported the same way (COR-1990).
   */
  async function resolveApproval(
    toolCallId: string,
    resolution: ApprovalResolution,
  ): Promise<void> {
    deciding = true;
    decidingAs = resolution.decision === 'deny' ? 'deny' : 'approve';
    decidedHere.add(toolCallId);
    ownDecisionUnread = true;
    try {
      await session.controller.adapter.resolveToolApproval?.(toolCallId, resolution);
    } catch {
      // The controller reported it, and the approval is still pending for another try.
      decidedHere.delete(toolCallId);
    } finally {
      deciding = false;
      // Whether it took effect or not, the approval is not what `/reviews` last listed, so the
      // inbox and the count in the navigation read again at once and do not wait for their poll.
      void invalidateReviewQueries(queryClient);
    }
  }

  /** Said when the Bureau took the approval but the grant did not loosen the tool. */
  function grantNotLoosened(notice: GrantNotLoosened): void {
    showToast(
      notice.remembered
        ? `${REVIEWS_COPY.notLoosened.title}. ${REVIEWS_COPY.notLoosened.message(notice.toolName)}`
        : `${REVIEWS_COPY.notRemembered.title}. ${REVIEWS_COPY.notRemembered.message}`,
      { variant: 'warning', duration: 0 },
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
    if (!untrack(() => isNew)) void session.attach().then((joined) => (arriving = joined));
    // "New chat about <topic>" in the palette (`?about=`) opens with the topic in the box, for the
    // person to send or change. It sends nothing.
    const about = untrack(() => (isNew ? router.current.search.get('about') : null));
    if (about !== null && about.trim() !== '') void tick().then(() => fillComposer(about));
    // Home's Start a chat hands the new chat a message (`new-chat-handoff.ts`), sent once as the
    // chat's first. It is not in the address, so no link can start a run.
    const first = untrack(() => (isNew ? takeFirstMessage(agent) : undefined));
    if (first !== undefined) void session.send(first);
    return () => {
      for (const remove of removals) remove();
      restart.dispose();
      session.dispose();
    };
  });
</script>

{#snippet details()}
  {#if context.data?.parentContextId}
    <BranchOrigin parentId={context.data.parentContextId} />
  {/if}
{/snippet}

<!-- The popover the last breadcrumb opens. The top bar renders it, so it holds only what the page
     read; the session's own facts are left out until the session has been read. -->
{#snippet detailsPopover()}
  <ChatDetails
    {sessionId}
    {agent}
    agentLabel={agentLabel(agent, agents.data)}
    agentHref={router.href(agentPath(agent))}
    onOpenAgent={(event) => openAgent(event, agent)}
    startedAt={context.data === undefined ? null : epochOf(context.data.createdAt)}
    lastActiveAt={context.data === undefined ? null : epochOf(context.data.updatedAt)}
    now={clock()}
    asRun={context.data === undefined
      ? undefined
      : {
          model: modelInUse(context.data.model, models.data, lastReplyModel),
          effort: context.data.effort,
          permissionMode: context.data.permissionMode,
        }}
  />
{/snippet}

{#snippet headerStatus()}
  {#if chatStatus !== undefined}
    <StatusDot word={chatStatus} />
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

<div class="ib-chat-frame">
  <section
    class="weft-chat-route"
    aria-label={CHAT_COPY.regionLabel}
    data-session={sessionId}
    bind:this={route}
  >
    {#snippet markdownTitle()}<InlineMarkdown text={displayTitle} />{/snippet}
    {#if choosing}
      <PageHeader data-testid="chat-header" title={markdownTitle} headingLevel={1} />
    {:else}
      <PageHeader
        data-testid="chat-header"
        title={markdownTitle}
        headingLevel={1}
        {...context.data?.parentContextId ? { description: details } : {}}
        actions={headerActions}
        status={headerStatus}
        statusPlacement="inline"
      />
    {/if}
    {#if !choosing}
      <SessionTasks {sessionId} streaming={session.streaming} />
    {/if}

    {#if session.failure !== undefined && !failureShownInTranscript}
      <Alert variant="danger" dismissible onDismiss={() => session.dismissFailure()}>
        <p class="weft-chat-approval__title">{CHAT_COPY.failureTitle}</p>
        <p class="weft-chat-approval__message">{session.failure}</p>
      </Alert>
    {/if}

    <!-- While Interborough cannot be reached the shell's banner is the one account of it: a dropped
       stream gets no banner of its own (design row 18e). -->
    {#if session.disconnected && !connection.unreachable}
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
        }}
      >
        <p class="weft-chat-approval__message">{branchFailure}</p>
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

    <!-- A decision made on another page, said once to a screen reader; the row itself changes in place. -->
    <VisuallyHidden role="status" aria-live="polite" data-testid="chat-decision-announcement">
      {announcement}
    </VisuallyHidden>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="weft-chat-surface" onclick={openNoteLink}>
      <Chat
        bind:this={chat}
        id={`chat-${sessionId}`}
        conversation={shown}
        adapter={session.chatAdapter}
        streaming={session.streaming}
        surfaceMode="transparent"
        variant="transcript"
        notSent={connection.unreachable
          ? {
              summary: CHAT_COPY.notSent.unreachable,
              retryDisabled: true,
              retryNote: CHAT_COPY.notSent.retryNote,
            }
          : { summary: CHAT_COPY.notSent.online }}
        disabled={session.disconnected || gone || answerHeld}
        composerPlaceholder={answering
          ? pickable
            ? CHAT_COPY.composer.answerPlaceholder
            : CHAT_COPY.questionAnswerLabel
          : CHAT_COPY.composer.placeholder(agentSummary?.displayName ?? agent)}
        {composerStatus}
        composerHeader={choosing ? newChatHeader : undefined}
        composerFormattingToolbar
        composerAnswering={answering}
        streamingStatus={session.stopping ? CHAT_COPY.stopping : ''}
        capabilities={{
          attachments: attachable && !gone,
          // The transcript offers Branch on a message and no Edit: editing a sent message is a
          // fork, which Branch on that message is.
          editing: false,
          quote: true,
        }}
        uploadAttachment={upload}
        acceptedTypes={settings?.acceptedTypes ?? []}
        maxFileSize={settings?.maxFileSize}
        formatAttachmentError={chatAttachmentErrorMessage}
      >
        {#snippet trailing()}
          {#each shownRequests as request (request.interruptId)}
            <div class="weft-chat-question" data-interrupt={request.interruptId}>
              <p class="weft-chat-question__prompt">
                <CircleHelp class="weft-chat-question__glyph" size={16} aria-hidden="true" />
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
                  undoMilliseconds={answerUndoMilliseconds()}
                  onHoldChange={(held) => (answerHeld = held)}
                  onSubmit={async (value) => {
                    sentRequest = request;
                    const taken = await session.answerQuestion(request.interruptId, value);
                    // An answer the session did not take leaves the question open, not "answered".
                    if (!taken) sentRequest = undefined;
                    return taken;
                  }}
                />
              </div>
              {#if pickable}
                <p class="weft-chat-question__hint">{CHAT_COPY.pickHint}</p>
              {/if}
            </div>
          {/each}
        {/snippet}
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
        {#snippet composerControls({ folded })}
          {#if folded}
            <ComposerSettings>{@render settingControls()}</ComposerSettings>
          {:else}
            {@render settingControls()}
          {/if}
        {/snippet}
        {#snippet composerActions()}
          {#if !choosing && usesModel}
            <ContextMeter report={contextWindow.data} failed={contextWindow.isError} />
          {/if}
        {/snippet}
        {#snippet messageActions({ message })}
          {@const replyStep = message.role === 'assistant' ? replyStepOf(message.id) : undefined}
          {@const branchAt = branchTargetOf(message)}
          {#if replyStep !== undefined && !session.streaming}
            {@const replyModel = replyModelName(message.metadata)}
            {#if replyModel !== undefined}
              <span class="weft-chat-model">· {replyModel}</span>
            {/if}
            <ReplyDetails
              runId={replyStep.runId}
              step={replyStep.step}
              usage={session.usage.get(replyStep.runId)}
            />
          {/if}
          {#if branchAt !== undefined}
            <Button
              data-changes
              type="button"
              class="chat-message-action-button"
              size="xs"
              variant="ghost"
              aria-label={message.role === 'user'
                ? CHAT_COPY.branch.before
                : CHAT_COPY.branch.action}
              disabled={branching}
              onclick={() => void branchThrough(branchAt.messageId)}
            >
              <GitBranch class="cinder-icon-xs" />
              {CHAT_COPY.branch.short}
            </Button>
          {/if}
        {/snippet}
        {#snippet noteAction(note: MessageNoteInfo)}
          {#if note.id === retryNoteId}
            <Button
              data-changes
              type="button"
              size="sm"
              variant="secondary"
              disabled={!session.canRetryTurn}
              onclick={() => void retryTurn()}
            >
              {CHAT_COPY.stopLine.retry}
            </Button>
          {/if}
        {/snippet}
        {#snippet row({ message }, renderDefault)}
          {@const group = activity.groups.get(message.id)}
          {@const assets = assetsOf(session.conversation.messages[message.id] ?? message)}
          {#if group !== undefined}
            <ToolCalls
              id={`tools-${message.id}`}
              entries={group.entries}
              decided={decisionContext}
              selectedId={selectedCallId}
              onSelect={selectCall}
              endLabel={endsTheTurn(group) ? CHAT_COPY.tools.runFinishedNoReply : undefined}
              duration={group.durationMilliseconds === undefined
                ? undefined
                : formatCallDuration(group.durationMilliseconds)}
            >
              {#snippet decision(entry)}
                {@const asked = approvalsByCall.get(entry.callId)}
                {#if entry.decision !== undefined || asked !== undefined}
                  <ChatApproval
                    id={`tools-${message.id}-${entry.callId}`}
                    {entry}
                    question={asked?.question ?? ''}
                    source={agentSummary?.displayName ?? agent}
                    requestedAt={asked?.requestedAt}
                    context={decisionContext}
                    unreachable={connection.unreachable}
                    resolving={deciding || session.streaming
                      ? (decidingAs ?? 'approve')
                      : undefined}
                    onResolve={(resolution) => void resolveApproval(entry.callId, resolution)}
                  />
                {/if}
              {/snippet}
              {#snippet mcpApp(entry)}
                {@const panel = workflowRevisionPanels.find(
                  (candidate) =>
                    candidate.opensFromAgentTool === entry.name ||
                    candidate.opensFromAgentTool === entry.name.replace('__', ':'),
                )}
                {@const proposalText = revisionProposalText(entry)}
                {#if panel !== undefined && entry.state === 'done' && proposalText !== undefined}
                  {@const loadResource = () => loadPluginApp(panel.plugin, panel.app)}
                  {@const onToolCall = pluginToolCaller(panel.plugin, panel.app)}
                  <McpApp
                    resourceUri={panel.uri}
                    title={panel.title}
                    {loadResource}
                    {onToolCall}
                    hostContext={mcpHostContext}
                    maxHeight={560}
                    toolInput={{ arguments: entry.arguments as Record<string, unknown> }}
                    toolResult={{
                      content: [],
                      structuredContent: proposalText,
                    }}
                  />
                {/if}
              {/snippet}
            </ToolCalls>
            <!-- A group stands in for its rows, so the lines a run left on them are shown with it. -->
            {#each group.messageIds as rowId (rowId)}
              {@const held = shown.messages[rowId]}
              {@const notes = held === undefined ? [] : (resolveMessageNotes(held) ?? [])}
              {#each notes as note (note.id)}
                <ChatNote
                  {note}
                  action={note.kind === 'stopped' && note.id === retryNoteId
                    ? noteAction
                    : undefined}
                />
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
    <!-- Model, Effort and Permissions: the live session's, or, on a new chat, the person's choices
       before it has a session (applied once the first message has started it). Rendered once, in
       the row or folded into the one Settings control. -->
    {#snippet settingControls()}
      {#if usesModel}
        <ModelPicker
          {sessionId}
          agentName={agent}
          current={choosing
            ? draftModel === undefined
              ? null
              : { provider: draftModel.provider, model: draftModel.model }
            : context.data?.model}
          revision={context.data?.configVersion}
          reload={reloadContext}
          locked={steering}
          unavailable={cannotSteer}
          onBusyChange={(busy) => (steering = busy)}
          onApplied={(value) => noted('step', SETTINGS.model, value)}
          draft={choosing}
          onDraft={(choice) => (draftModel = choice)}
        />
        <SettingSelect
          {sessionId}
          id="weft-chat-effort"
          label={SETTINGS.effort}
          options={SETTINGS.effortOptions}
          current={choosing ? (draftEffort ?? null) : context.data?.effort}
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
          onApplied={(value) => noted('step', SETTINGS.effort, value)}
          draft={choosing}
          onDraft={(value) => (draftEffort = value)}
        />
      {/if}
      <SettingSelect
        {sessionId}
        id="weft-chat-permission"
        label={SETTINGS.permission}
        options={SETTINGS.permissionOptions}
        current={choosing ? (draftPermission ?? 'on-changes') : context.data?.permissionMode}
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
        onApplied={(value) => noted('toolCall', SETTINGS.permission, value)}
        draft={choosing}
        onDraft={(value) => (draftPermission = value)}
      />
    {/snippet}

    <!-- The agent a new chat is with, at the top of the composer. -->
    {#snippet newChatHeader()}
      <AgentSelect
        agents={agents.data ?? []}
        value={agent}
        providerConnected={providers.data?.providers.some((provider) => provider.hasKey)}
        onChange={chooseAgent}
      />
    {/snippet}
    <ConfirmDialog
      bind:open={confirmingEnable}
      title={CHAT_COPY.composer.enableDialog.title(pluginTitle)}
      description={CHAT_COPY.composer.enableDialog.description}
      confirmLabel={CHAT_COPY.composer.enableDialog.confirm}
      onConfirm={() =>
        void restart.run([{ name: pluginName, enabled: true }], false, { changes: [pluginTitle] })}
    />
    <RestartDialog flow={restart} />
  </section>
  {#if selectedCall !== undefined}
    {@const call = selectedCall.entry}
    <ToolCallPanel
      class="ib-chat-panel"
      name={call.title ?? call.name}
      identifier={call.name}
      status={railCall(call, false, decisionContext).status}
      duration={call.durationMilliseconds === undefined
        ? undefined
        : formatCallDuration(call.durationMilliseconds)}
      position={selectedCall.total > 1
        ? CHAT_COPY.tools.position(selectedCall.number, selectedCall.total)
        : undefined}
      input={call.arguments}
      result={call.state === 'done' || call.state === 'denied' ? call.result : undefined}
      error={call.state === 'failed' ? (call.failure ?? { message: call.summary }) : undefined}
      onClose={closeCallPanel}
    />
  {/if}
</div>
