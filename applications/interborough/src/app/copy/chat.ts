import { formatBytes } from '../../lib/format/index.ts';

/** The words the chat view uses outside its states. */
export const CHAT_COPY = {
  /**
   * Why a chat's last run stopped, under its last message when the page opens on the chat again.
   * The task's own message wins; these are the words for a stop that left none.
   */
  stopReasons: {
    error: 'The run failed.',
    tripwire: 'A guardrail stopped the run.',
    'maximum-steps': 'The run reached its step limit.',
    'elicitation-denied': 'A question was declined, so the run stopped.',
    'budget-exceeded': 'The run reached its budget.',
    aborted: 'The run was stopped.',
    canceled: 'The run was stopped.',
    failed: 'The run failed.',
  },
  /** What a session with no title is called, in the header and in lists. */
  untitled: 'New chat',
  newChat: 'New chat',
  /** The empty chat page's second action, to the agents a chat can start with. */
  browseAgents: 'Browse agents',
  agentLabel: 'Agent',
  agentPlaceholder: 'Choose an agent',
  /** The agent select at the top of a new chat's composer. */
  agentSelect: {
    /** Said under an agent that runs on a model while no provider is connected. */
    needsProvider: 'Needs a provider',
    /** Said, muted, beside the name of an agent that has no description (the greeting then has no sentence either). */
    noDescription: 'no description',
  },
  sessionsTitle: 'Chats',
  /** The list's heading on a phone, where the list is a screen of its own under the page's name. */
  sessionsTitlePhone: 'Chat',
  /** What the chat says when its live connection to the run could not be restored. */
  disconnected: {
    title: 'Disconnected',
    description: 'The connection to this chat dropped and could not be restored.',
    reconnect: 'Reconnect',
  },
  /** What a new chat shows where its transcript will be. */
  newChatWelcome: {
    /** The page's one title: asks what the agent the chat is with should do, by the name a person reads. */
    greeting: (agentName: string): string => `What should ${agentName} do?`,
    /** The lead of the row of the agent's example prompts, and the name of that group. */
    promptsLead: 'Try',
    promptsLabel: 'Example prompts',
    /** The lead of the row of the other agents to start with, and the name of that group. */
    otherAgents: 'Or chat with',
    chooseAgent: 'Choose an agent to start with',
    /** What Send reads while the first message is on its way and the chat page has not opened. */
    starting: 'Starting chat…',
    /** The chip above the composer of a chat started from the Workflows page. */
    fromWorkflows: 'Starting from Workflows',
    /** What the composer holds for a chat started from Workflows, ready for the person to finish: ends in a space, with no ellipsis. */
    workflowPrefill: 'Help me build a workflow that ',
    /** The accessible name of the placeholders drawn while the agents are read, and what their status line says when that is slow. */
    loadingLabel: 'Loading agents',
    /** The placeholder of the composer drawn while the agents are read, before there is an agent to name. */
    loadingPlaceholder: 'Message…',
    stillLoading: 'Still loading agents. This is taking longer than usual.',
    /**
     * What sits under the composer when the first message could not be sent: what happened, that the
     * typed text is still in the box, and the way to send it again. With no word from the server
     * the cause is that Interborough did not answer; any other refusal is said as the server said it.
     */
    startFailed: {
      lead: 'Couldn’t start the chat.',
      unanswered: 'Interborough didn’t answer.',
      kept: 'Your text is kept.',
      retry: 'Retry',
    },
  },
  /** The chat list beside the open chat. */
  list: {
    /** The accessible name of the pane that holds the open chat. */
    detailLabel: 'Open chat',
    /** The toggle that hides the list beside the open chat, and shows it again (COR-2327). */
    hideList: 'Hide chats',
    showList: 'Show chats',
    /** The day bands: today and yesterday by their names, any other day by its date. */
    today: 'Today',
    yesterday: 'Yesterday',
    earlier: 'Earlier',
    /** The field that narrows the list by what a chat says. */
    searchLabel: 'Search chats',
    searchPlaceholder: 'Search chats',
    /** The status segments over the list; the count is part of each one's accessible name. */
    segmentsLabel: 'Status',
    segments: { all: 'All', waiting: 'Waiting on you', done: 'Done', archived: 'Archived' },
    /** First use: no chat has been started, and the one primary New chat is here. */
    emptyTitle: 'No chats yet',
    emptyDescription: 'Start one with an agent.',
    /** A search that matched nothing says what was searched. */
    noMatchTitle: (search: string): string => `No chats match “${search}”`,
    noMatchDescription: 'Check the spelling or try another word.',
    clearSearch: 'Clear search',
    /** A status segment with no chat in it, and the way back to every chat. */
    segmentEmpty: {
      waiting: {
        title: 'Nothing is waiting on you',
        description: 'Chats that ask for an approval or an answer are listed here.',
      },
      done: {
        title: 'No finished chats yet',
        description: 'A chat is done once its latest reply is in.',
      },
      archived: {
        title: 'No archived chats',
        description: 'Archive a chat from its menu to put it away here.',
      },
    },
    showAll: 'Show all chats',
    /**
     * What line two says of a chat that ended, in place of its last message: why it ended. The host
     * stopping it is the one reason that ends a chat.
     */
    endedBecause: 'The server restarted before I finished.',
    /** The list could not be read: the error stays in the list and the page stays live. */
    failedTitle: 'Couldn’t load chats',
    failedDescription: 'Interborough didn’t send them back.',
    pickTitle: 'Pick a chat',
    pickDescription: 'Choose a chat from the list, or start a new one.',
    /** What the open pane says when there is no chat to pick, so the list's one primary stays alone. */
    noChatTitle: 'No chat open',
    noChatDescription: 'A chat you start opens here.',
  },
  /** What a chat with no message says in place of its transcript. */
  emptyTranscript: {
    title: 'No messages yet',
    description: 'Say what you need to start the conversation.',
  },
  /** What a chat with no message to show says it holds. */
  messageCount: (count: number): string =>
    count === 1 ? '1 message' : `${String(count)} messages`,
  loadMore: 'Load more',
  loadingSessions: 'Loading chats',
  agentsTitle: 'Agents',
  tasksTitle: 'Tasks in this chat',
  agentSessions: 'Chats with this agent',
  approvalTitle: 'Needs your approval',
  /** The approval row under a tool call in the transcript. */
  approval: {
    /** What "Allow <tool> for …" ends with. */
    rememberScope: 'the rest of this chat',
    /** Written above Deny and Approve while Interborough cannot be reached; both name it as their description. */
    unreachable: 'Approving is off until Interborough is reachable',
    /**
     * Written under a held approval of an agent whose plugin is disabled: nobody can answer it
     * now, and it comes back when the plugin is enabled.
     */
    unavailable: (agent: string, plugin: string): string =>
      `${agent} is unavailable, so this can’t be answered now. It returns when the ${plugin} plugin is enabled.`,
    /**
     * Written under a waiting approval while no model provider is connected: the decision is
     * recorded, and the run resumes once a provider is.
     */
    continuesOnProvider: (agent: string): string =>
      `${agent} continues once a provider is connected.`,
  },
  /** The tool calls of a turn. */
  tools: {
    /** The accessible name of the rail of one turn's calls. */
    railLabel: 'Tool calls',
    /** The words of the arguments and result a chosen call opens. */
    resultPrefix: 'Result:',
    /** Where a call falls in its turn, written in its panel's header after how long it took. */
    position: (number: number, total: number) => `call ${String(number)} of ${String(total)}`,
    /** A call the person refused reads Denied: it did not fail. */
    denied: 'Denied',
    /**
     * A call the run ended on. A tool that only reads can say it did not finish; one that changes
     * things, or that nothing classifies, may have run, and a line that says nothing changed would
     * be a guess.
     */
    interruptedReads: 'Interrupted, didn’t finish',
    interruptedChanges: 'Interrupted, may have run',
    /** The terminal rail result for an approval whose durable deadline elapsed. */
    expiredBeforeDecision: 'Expired before a decision was made.',
    /** The rail's end state for a turn that ended on a tool call, so it does not look hung. */
    runFinishedNoReply: 'Run finished, no reply',
    /**
     * How a decided approval is worded on the rail and under the call: "Approved by you 10:33 AM",
     * and, for one decided on a page that is not this one, "Approved by you in Reviews 10:46 AM".
     */
    decided: {
      approved: 'Approved',
      denied: 'Denied',
      /** Who decided, when it was the chat's own person. */
      you: 'you',
      /** Where a decision made away from the chat was made. */
      elsewhere: 'Reviews',
      /** Said on the rail in place of the result while the run a decision made in Reviews continues is going. */
      running: 'running…',
      /** The words of the rail's result for a decided call: `place` is absent for a decision made here. */
      line: (
        outcome: 'Approved' | 'Denied',
        who: string,
        place: string | undefined,
        time: string,
        after: string,
      ): string =>
        `${outcome} by ${who}${place === undefined ? '' : ` in ${place}`} ${time}${after === '' ? '' : `, ${after}`}`,
      /**
       * Said, politely, when the approval the person was looking at is decided away from the chat.
       * `question` is what the approval asked, such as "Refund order 4471 for $42.00?", which is
       * said as a statement: "Approved in Reviews. Refund order 4471 for $42.00.".
       */
      announcement: (outcome: 'Approved' | 'Denied', place: string, question: string): string =>
        `${outcome} in ${place}. ${question.replace(/\?$/, '.')}`,
    },
  },
  /**
   * The status line under a reply that stopped, in danger text with a Retry beside it. It is the
   * product speaking, not the agent. `cause` is why the run stopped, without its full stop.
   */
  stopLine: {
    partway: (cause: string): string => `The reply stopped partway: ${cause}.`,
    whileRunning: (tool: string, cause: string): string =>
      `The reply stopped while ${tool} was running: ${cause}.`,
    /** Added for an interrupted tool that only reads. */
    didNotFinish: (tool: string): string => `${tool} didn’t finish and nothing was changed.`,
    /**
     * Added for an interrupted tool that changes things, or that nothing classifies. `subject` is
     * what the call acted on ("order", from an `orderId` argument); a call that names none says
     * "result".
     */
    mayHaveRun: (tool: string, subject: string = 'result'): string =>
      `${tool} may have run. Check the ${subject} before retrying. Retry goes back through the approval.`,
    retry: 'Retry',
    /**
     * The notice under the last reply of a chat the server stopped when it restarted: what arrived
     * is kept, and the chat is over. The product speaking, with an info glyph, not a failure.
     */
    ended:
      'The server restarted before this reply finished. What arrived is kept; the chat can’t continue.',
    /**
     * Said when Retry could not put the interrupted tool back behind its approval, so it sent
     * nothing rather than let the call run again unasked.
     */
    retryFailed:
      'Retry could not ask for the tool’s approval again, so nothing was sent. Try again.',
    /**
     * Said when Stop, pressed while the page was reconnecting, could not reach the run to cancel
     * it: the run may still be going, and Reconnect shows what it is doing.
     */
    stopFailed: 'The run could not be stopped, and it may still be going. Reconnect to check.',
  },
  /** The host-owned answer replacement action. */
  regeneration: {
    action: 'Regenerate',
    running: 'Regenerating…',
    failed: 'Regeneration failed. Try again.',
    readbackFailed: 'The regenerated answer was not available after the operation completed.',
  },
  /** The chat's header and its strip of runs. */
  strip: {
    waiting: (count: number): string =>
      `${String(count)} ${count === 1 ? 'run is' : 'runs are'} waiting on you`,
    working: (count: number): string =>
      `${String(count)} ${count === 1 ? 'run is' : 'runs are'} working`,
    finished: 'Run finished',
    failed: (failed: number, total: number): string =>
      `${String(total)} runs, ${String(failed)} failed`,
    failedOne: 'Run failed',
    canceledOne: 'Run canceled',
  },
  humanRequestFallback: 'The agent is waiting for your answer.',
  /** The label of a question that declares no schema, which takes free text. */
  questionAnswerLabel: 'Answer',
  /** Said under a question that is picked from choices: the number keys. */
  pickHint: 'Press 1 to 9 to pick a choice.',
  /** The shortcuts the `?` map lists for this page. */
  shortcutGroup: 'Chat',
  pickShortcut: (position: number): string => `Pick choice ${String(position)}`,
  /** Said while a message waits for the answers sent before it to be applied. */
  answersNotApplied:
    'Your earlier answers have not been applied yet. Your message was not sent; send it again in a moment.',
  /** Said when an answer chosen in a control could not be applied, and the question is asked again. */
  answerNotSent: 'Your answer was not applied. Answer the question again.',
  /** The typing indicator's label from a Stop until the turn has ended. */
  stopping: 'Stopping…',
  approve: 'Approve',
  deny: 'Deny',
  /** The icon button that opens what the call would be given, on an approval. */
  showInput: 'Show input',
  hideInput: 'Hide input',
  failureTitle: 'The agent did not answer',
  dismiss: 'Dismiss',
  /** The accessible name of the transcript and composer region. */
  regionLabel: 'Conversation',
  /** The model picker in the composer, and what it says when a switch does not take. */
  modelPicker: {
    label: 'Model',
    /** The picker's choice when the session has no model of its own and the agent names no default. */
    agentDefault: 'Agent default',
    /** The Bureau's own count of the chat's changes was behind: the chat was switched somewhere else. */
    staleRevision: 'This chat changed elsewhere. Showing the model it uses now.',
    /** The agent does not allow that model (any more). */
    modelNotAllowed: 'This agent does not allow that model. The chat keeps its current model.',
    /** The label added to a model the agent's cost budget cannot count, which the picker shows disabled. */
    unpriced: 'no price',
    /** The label added to a model the deployment's model policy forbids, which the picker shows disabled. */
    policyDenied: 'not allowed',
    /** The chat is over, so it takes no other model. */
    sessionTerminal: 'This chat has ended, so its model cannot be changed.',
    /** The agent cannot be switched to another model. */
    unsupportedCapability: 'This agent cannot be switched to another model.',
    /** Anything else the Bureau answered without switching, such as a Bureau that is closing. */
    notSwitched: 'The model was not changed. The chat keeps its current model.',
    /** The request itself failed, so nobody knows whether the Bureau took it; the chat is read again. */
    fault: 'The model may not have been changed. Showing the model the chat uses now.',
  },
  /**
   * The chat's settings, shown in its header and changed from its composer: the model (its own
   * picker, `modelPicker`), the reasoning effort and the permission mode.
   */
  settings: {
    model: 'Model',
    effort: 'Effort',
    permission: 'Permissions',
    /** What the model or the effort says when the chat has none of its own. */
    agentDefault: 'Agent default',
    effortOptions: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
      { value: 'max', label: 'Max' },
    ],
    /** The modes, in the order of how much they ask, each with the help line under its option. */
    permissionOptions: [
      { value: 'always', label: 'Always asks', description: 'Every tool call asks first.' },
      {
        value: 'on-changes',
        label: 'On changes asks',
        description: 'Tools set to On changes ask before they run.',
      },
      {
        value: 'allow-all',
        label: 'Allow all',
        description:
          'Skips the On changes asks for this chat. Tools set to Always still ask; Blocked tools stay blocked.',
      },
      {
        value: 'read-only',
        label: 'Read-only',
        description: 'Every tool that is not read-only is denied.',
      },
    ],
    /**
     * The line under the composer after a change, saying when it takes effect: a mode is read at each
     * tool call, the model and the effort at each step, and with no run going, at the next run.
     */
    applies: {
      step: (setting: string, value: string): string =>
        `${setting} ${value} applies from the next step.`,
      toolCall: (setting: string, value: string): string =>
        `${setting} ${value} applies from the next tool call.`,
      nextRun: (setting: string, value: string): string =>
        `${setting} ${value} applies to the next run.`,
    },
    /** Why the controls are disabled for a chat this principal did not start. */
    notYours: 'Only the person who started this chat can change its settings.',
    /**
     * Said when an effort could not be changed. An effort the catalog holds is accepted for any
     * model, and the provider then clamps it or leaves it out for a model that lacks it.
     */
    effortNotices: {
      staleRevision: 'This chat changed elsewhere. Showing its settings now.',
      denied: 'This deployment’s model catalog does not hold that effort.',
      sessionTerminal: 'This chat has ended, so its effort cannot be changed.',
      unsupportedCapability: 'This agent cannot change its effort.',
      notChanged: 'The effort was not changed. The chat keeps its current effort.',
      fault: 'The effort may not have been changed. Showing the effort the chat uses now.',
    },
    /** Said when a permission mode could not be changed. */
    permissionNotices: {
      staleRevision: 'This chat changed elsewhere. Showing its settings now.',
      denied: 'This chat cannot use that mode.',
      sessionTerminal: 'This chat has ended, so its permissions cannot be changed.',
      unsupportedCapability: 'This agent cannot change its permissions.',
      notChanged: 'The permission mode was not changed. The chat keeps its current mode.',
      fault: 'The permission mode may not have been changed. Showing the mode the chat uses now.',
    },
  },
  /**
   * The popover on an agent's reply (COR-1983): why the reply ran on its model and what the model
   * saw, read from `bureau.tasks.inspect`, and the tokens its run used, from the run's terminal
   * event. It says what those two sources carry and nothing else.
   */
  replyDetails: {
    action: 'Reply details',
    loading: 'Reading the reply details',
    failed: {
      title: 'Reply details are unavailable',
      description: 'The host did not answer. Try again.',
    },
    retry: 'Try again',
    empty: {
      title: 'No details were recorded',
      description: 'The host kept no model plan and no context for this reply.',
    },
    why: 'Why this model',
    planReasons: {
      cost: 'Lowest cost',
      latency: 'Fastest',
      capability: 'Only model with the abilities needed',
      policy: 'Model policy',
      pinned: 'Named, not ranked',
      fallback: 'Fallback',
    },
    passedOver: 'Passed over',
    passedOverReasons: {
      capability: 'lacks an ability the request needs',
      policy: 'not allowed by the model policy',
      fallback: 'unavailable',
    },
    rejection: (provider: string, model: string, reason: string) =>
      `${provider}/${model}: ${reason}`,
    saw: 'What the model saw',
    messages: (count: number) => `${String(count)} ${count === 1 ? 'message' : 'messages'}`,
    truncated: 'Older messages were left out to keep the record small.',
    sources: 'Sources',
    dispositions: { included: 'included', excluded: 'left out' },
    source: (sourceId: string, disposition: string, reason: string | undefined) =>
      reason === undefined || reason === ''
        ? `${sourceId}: ${disposition}`
        : `${sourceId}: ${disposition} (${reason})`,
    usage: 'Tokens this run used',
    usageNote: 'Counted across every step of the run, not this reply alone.',
    usageKinds: { input: 'Input', output: 'Output', total: 'Total' },
  },
  /** The ring in the header that says how full the chat's context window is. */
  contextWindow: {
    label: 'Context window',
    /** The trigger's accessible name; `percent` is `null` when the model's window is not known. */
    trigger: (percent: number | null, used: string, max: string | null) =>
      percent === null || max === null
        ? `Context window: about ${used} tokens in use, window size unknown. Opens the breakdown`
        : `Context window: ${String(percent)}% used, about ${used} of ${max} tokens. Opens the breakdown`,
    /** The visible reading beside the ring. */
    reading: (percent: number | null, used: string) =>
      percent === null ? `${used} tokens` : `${String(percent)}%`,
    summary: (used: string, max: string | null) =>
      max === null
        ? `About ${used} tokens, in a window of unknown size.`
        : `About ${used} of ${max} tokens.`,
    estimate: 'An estimate of the next prompt this chat would send.',
    reported: (tokens: string) =>
      `The provider counted ${tokens} input tokens for the latest step.`,
    notReported: 'The provider has not reported a count for this chat yet.',
    breakdown: 'What fills it',
    categories: {
      system: 'Instructions',
      tools: 'Tools',
      messages: 'Messages',
      memory: 'Memory',
      attachments: 'Attachments',
    },
    category: (name: string, tokens: string) => `${name}: ${tokens} tokens`,
    unavailable: 'Context window unavailable',
  },
  /**
   * An open chat while it is read, and when it cannot be (design rows 17c to 17e, 17j, 17y), drawn
   * by Chat's `availability` states (COR-2285 V2 and V3) in these words.
   */
  load: {
    /** The status line while the chat is read; Chat counts the seconds after it. */
    loading: 'Loading this chat…',
    /** The status line once the read is taking long, with the elapsed time and Cancel. */
    stillLoading: 'Still loading this chat…',
    /** The title after the person canceled a slow read. */
    canceledTitle: 'Loading was canceled',
    /** The sentence under that title. */
    canceledDescription: 'The chat was not loaded. Nothing was lost.',
    /** The visible line in place of the composer's hint after a canceled read. */
    canceledComposer: 'Loading this chat stopped.',
    /** Why Send is off after a canceled read. */
    sendBlocked: 'Load the chat to send messages.',
    /** The breadcrumb's last entry while the chat is not read yet or cannot be read, in place of its identifier. */
    crumb: 'This chat',
    errorTitle: 'This chat couldn’t be loaded',
    errorDescription:
      'Interborough didn’t send it back. Nothing was lost; the messages are stored with the chat.',
    tryAgain: 'Try again',
    /** The way back to the list from a chat that cannot be shown (Availability board, row V3). */
    allConversations: 'All conversations',
    /** What the composer's placeholder calls the agent before the list has said which it is. */
    unnamedAgent: 'the agent',
  },
  /** What the composer says in place of its text box, and the line under it. */
  composer: {
    /** The placeholder of a chat with an agent, which `{name}` fills with the agent's name. */
    placeholder: (agent: string): string => `Message ${agent}…`,
    unreachable: 'Sending is off until Interborough is reachable',
    restarting: 'Sending resumes when Interborough is back.',
    pluginDisabled: (agent: string, plugin: string): string =>
      `${agent} isn’t available. Enable the ${plugin} plugin to continue.`,
    enableAndRestart: 'Enable and restart',
    /** The confirmation that enables the plugin: what it does to work that is running. */
    enableDialog: {
      title: (plugin: string): string => `Enable the ${plugin} plugin and restart?`,
      description: 'Running work picks up where it stopped; reviews stay waiting.',
      confirm: 'Enable and restart',
    },
    ended: 'This chat has ended. The server stopped it when it restarted.',
    newChat: 'New chat',
    /** The primary action of an archived chat's bar, which brings the composer back. */
    unarchive: 'Unarchive',
    /** The composer's placeholder while a question that draws choices waits. */
    answerPlaceholder: 'Choose an answer above, or type your own…',
    noProvider: 'Connect a model provider to chat',
    connectProvider: 'Connect a provider',
    useAssistant: 'Use Assistant',
    /** Said in the blocked row of a chat started from Workflows when no agent has the tool. */
    noWorkflowAgent:
      'No agent can create workflows. Add the Create workflow tool to an agent’s Access tab.',
    openAgents: 'Open Agents',
    /**
     * The one control that holds Model, Effort and Permissions when the composer is too narrow for
     * them side by side. Its name lists what it holds.
     */
    settings: {
      word: 'Settings',
      label: 'Settings: Model, Effort and Permissions',
    },
  },
  /** The context meter in the composer: a bar and a reading of how full the window is. */
  contextMeter: {
    /** The meter's accessible name; `percent` is `null` when the model's window is not known. */
    label: (percent: number | null, used: string) =>
      percent === null ? `Context ${used} tokens` : `Context ${String(percent)}%`,
    /** The visible reading beside the bar. */
    reading: (percent: number | null, used: string) =>
      percent === null ? used : `${String(percent)}%`,
    /** The tooltip: tokens in use of the window, as short numbers. */
    tooltip: (used: string, max: string | null) =>
      max === null ? `About ${used} tokens` : `${used} of ${max} tokens`,
    unavailable: 'Context unavailable',
  },
  /** Branching a chat from one of an agent's replies. */
  /** What a message that was not sent says in the popover its red icon opens. */
  notSent: {
    online: 'Not sent. Interborough couldn’t deliver this message. Your message is kept.',
    unreachable: 'Not sent. Interborough can’t be reached. Your message is kept.',
    retryNote: 'Retries when you’re back online.',
  },
  /** The chat's status beside its title. */
  status: {
    waiting: 'Waiting on you',
    running: 'Running',
    failed: 'Failed',
    ended: 'Ended',
    done: 'Done',
  },
  /**
   * The details popover the last breadcrumb opens (board ChatPage frame b): the session, its agent,
   * when it started, and what the chat ran with.
   */
  details: {
    /** The popover's accessible name, before the chat's title. */
    label: 'Chat details',
    sessionId: 'Session ID',
    copySessionId: 'Copy session ID',
    agent: 'Agent',
    started: 'Started',
    /** What follows when the chat started, naming the last time it changed. */
    lastActive: (when: string): string => `last active ${when}`,
    /** The group of what the chat ran with. */
    asRun: 'As run',
    model: 'Model',
    effort: 'Effort',
    permissions: 'Permissions',
  },
  branch: {
    /** The visible words of the action on a message, which is named `action` for assistive technology. */
    short: 'Branch',
    /** The name of Branch on a message the person sent, which branches from just before it. */
    before: 'Branch before this message',
    /** The action on a reply that ends a completed turn. */
    action: 'Branch from here',
    /** What a branch's header says, before the link to the chat it came from. */
    branchedFrom: 'Branched from',
    /** What it says when that chat has been deleted, with no link. */
    parentDeleted: 'a chat that was deleted',
    /** Said under the chat when a branch could not be made, by the reason the Bureau gave. */
    refused: {
      'not-a-branch-point': 'Only the last reply of a finished turn can be branched.',
      'branch-with-pending-approval':
        'That turn is waiting for an approval, so it cannot be branched.',
      'branch-with-unresolved-tool-call':
        'That turn has a tool call without a result, so it cannot be branched.',
      'command-conflict': 'That branch could not be made. Try again.',
    },
    /** The reply no longer exists in the chat, and any other fault. */
    fault: 'The chat could not be branched. You are still in this chat.',
  },
  /** The chat header's More menu: rename, branch, export and delete the chat. */
  more: {
    /** The menu button's name; the button is an icon. */
    label: 'More actions',
    rename: 'Rename',
    branch: 'Branch from the last reply',
    /** Said as the hint on Branch when there is no finished reply to branch from. */
    noBranchPoint: 'There is no finished reply to branch from yet.',
    /** Said as the hint on Branch while a run is going. */
    branchWhileRunning: 'Wait for the run to finish, then branch from its last reply.',
    export: 'Export as Markdown',
    /** Said as the hint on Export when the chat has no messages. */
    nothingToExport: 'There is nothing in this chat to export yet.',
    exportFault: 'The chat could not be exported.',
    /** Archive puts the chat away, out of the list, until it is unarchived; an archived chat's menu offers Unarchive. */
    archive: 'Archive',
    unarchive: 'Unarchive',
    /** What archiving or unarchiving says when it did not happen. */
    archiving: {
      /** The chat is working or waiting on an approval or an answer, so it was not archived. */
      busy: 'This chat is still working or waiting on an answer. Stop it or answer it, then archive it.',
      /** A goal writes to its own chat, so that chat cannot be archived. */
      notArchivable: 'This chat belongs to a goal, so it can’t be archived.',
      archiveFault: 'The chat could not be archived.',
      unarchiveFault: 'The chat could not be unarchived.',
      /** The Bureau answered not-found, and a read of the chat shows it is still there. */
      refused: 'The chat was not changed: the change was refused.',
      gone: 'This chat no longer exists.',
    },
    delete: 'Delete',
    /** The rename dialog. */
    renameDialog: {
      title: 'Rename this chat',
      label: 'Title',
      description:
        'Up to 200 characters. Leave it empty to use the title taken from the first message.',
      save: 'Save',
      cancel: 'Cancel',
      /** Shown when the title changed on the Bureau while the person had typed a different one. */
      changed: 'This chat was renamed somewhere else while you were typing.',
      reload: 'Use the new title',
      tooLong: 'The title is over 200 characters.',
      renamed: 'Chat renamed.',
      fault: 'The chat could not be renamed.',
      /** The Bureau answered not-found, and a read of the chat shows it is still there: the change was refused. */
      refused: 'The chat could not be renamed: the change was refused.',
      /** The Bureau answered not-found, and a read of the chat says it is gone. */
      gone: 'This chat no longer exists.',
    },
    /** The delete confirmation: what is lost, and what happens to a run that is going. */
    deleteDialog: {
      title: (chat: string) => `Delete “${chat}”?`,
      /** What is lost, and what happens to a run that is going; chats branched from it keep their own copy. */
      description: (runGoing: boolean) =>
        `The chat and its messages are removed for good, and this cannot be undone. ${
          runGoing ? 'Its run is going now, and deleting the chat stops it. ' : ''
        }Chats branched from it keep their own copy of the history.`,
      confirm: 'Delete chat',
      cancel: 'Cancel',
      deleted: 'Chat deleted.',
      /** The chat is gone, but stopping its run did not finish cleanly. */
      deletedRunning: 'Chat deleted. Its run may take a moment to stop.',
      refused: 'The server is shutting down, so the chat was not deleted.',
      fault: 'The chat could not be deleted.',
      alreadyGone: 'This chat was already deleted.',
      /** The Bureau answered not-found, and a read of the chat shows it is still there. */
      notAllowed: 'The chat was not deleted: the change was refused.',
    },
  },
  /** Shown when the chat on screen has been deleted: nothing more can be sent to it. */
  /** A chat deleted while its page is open, drawn by Chat's `deleted` availability state. */
  gone: {
    title: 'This chat was deleted',
    description: 'It no longer exists, so nothing more can be sent here.',
  },
  /** The names of the files a row carries: attached by the person, or returned by the agent. */
  assets: {
    listLabel: 'Files',
    image: (position: number) => `Image ${position}`,
    audio: (position: number) => `Audio ${position}`,
    video: (position: number) => `Video ${position}`,
    /** A file's name and size ("settings-page.png, 182 KB"), or "Download file" when the row carries neither; never its media type. */
    download: (name?: string, size?: number): string => {
      const facts = [name, size === undefined ? undefined : formatBytes(size)].filter(
        (fact): fact is string => fact !== undefined && fact !== '',
      );
      if (name !== undefined && name !== '') return facts.join(', ');
      return facts.length === 0 ? 'Download file' : `Download file, ${facts.join(', ')}`;
    },
  },
  /**
   * What a person is told when a file cannot be attached or sent. An upload fault shows on the
   * attachment's `error` state; a run fault shows in the failure alert. Neither shows a raw
   * message, which can name an asset or an upload.
   */
  attachments: {
    /** The file is over the limit its own type has, which the selected agent's model states. */
    tooLarge: (size: number, limit: number) =>
      `Can’t attach: ${formatBytes(size)} is over the ${formatBytes(limit)} limit.`,
    /**
     * The file is of a type the selected agent's model does not take. `kind` names the file's type
     * (`TIFF`), and `accepted` the types the agent does take (`PNG, JPG, PDF or text`).
     */
    typeNotAccepted: (kind: string, accepted: string) =>
      `Can’t attach: ${kind} files aren’t supported. Use ${accepted}.`,
    /** The selected agent takes no file at all, so whatever was attached is refused. */
    noFiles: 'Can’t attach: this agent does not take files.',
    /** The upload did not finish, for a reason the person cannot act on beyond trying again. */
    uploadFailed: 'Upload failed. Try again, or remove it.',
    /** The Bureau looked at the bytes and refused them: a safety gate flagged the file, or it is not the type it says. */
    rejected: 'Can’t attach: the server would not accept this file’s content.',
    /** The upload session was gone before the file finished arriving. */
    expired: 'The upload expired. Try again, or remove it.',
    /** The run was refused because the model could not take an attachment. */
    modelRefusedMedia:
      'The agent’s model could not take an attached file. Send again without the file.',
  },
} as const;
