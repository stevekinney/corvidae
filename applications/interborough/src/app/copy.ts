import { formatBytes } from '../lib/format/index.ts';
import type { ViewName } from './views.ts';

/** The words for one state of one view. */
export type ViewStateCopy = {
  readonly title: string;
  readonly description: string;
};

/** The words for a view's empty state, and where to go from there. */
export type ViewEmptyCopy = ViewStateCopy & {
  readonly action?: { readonly label: string; readonly href: string };
};

export type ViewCopy = {
  /** The name of the view in navigation and headings. */
  readonly label: string;
  readonly loading: ViewStateCopy;
  /** Absent for a view that is never empty (`views.ts`, `canBeEmpty`). */
  readonly empty?: ViewEmptyCopy;
  readonly error: ViewStateCopy;
  readonly forbidden: Pick<ViewStateCopy, 'title'>;
  /** Present only for a view that opens one item by its address. */
  readonly notFound?: ViewStateCopy;
  /** The words for a route of the view whose missing thing is not the one `notFound` names. */
  readonly notFoundByPattern?: Readonly<Record<string, ViewStateCopy>>;
  /** The words for a route of the view whose nothing is not the one `empty` names. */
  readonly emptyByPattern?: Readonly<Record<string, ViewEmptyCopy>>;
  /** The words for a route of the view whose loading is not the one `loading` names. */
  readonly loadingByPattern?: Readonly<Record<string, ViewStateCopy>>;
  /** The words for a route of the view whose failure is not the one `error` names. */
  readonly errorByPattern?: Readonly<Record<string, ViewStateCopy>>;
  /**
   * The words for a route of the view whose lock is not a scope the principal lacks: the server
   * said no, and says in these words why.
   */
  readonly forbiddenByPattern?: Readonly<Record<string, ViewStateCopy>>;
};

/** The words the run detail page (`/runs/:run`) uses for its attributes, streams and updates. */
export const RUN_DETAIL_COPY = {
  attributes: {
    heading: 'Search attributes',
    loading: 'Loading search attributes',
    empty: 'This run has no search attributes.',
    engineOwned: 'Set by the system. It cannot be edited here.',
    edit: (key: string): string => `Edit ${key}`,
    save: (key: string): string => `Save ${key}`,
    cancel: (key: string): string => `Cancel editing ${key}`,
    invalidNumber: 'Enter a number.',
    invalidDate: 'Enter a date and time, such as 2026-07-01T09:00:00Z.',
  },
  streams: {
    /** A stream key longer than this is shown cut off, with the whole key in its `title`. */
    keyDisplayLimit: 48,
    viewChunks: (key: string): string => `View chunks of ${key}`,
    heading: 'Stream chunks',
    close: 'Close',
    loading: 'Loading chunks',
    noChunksTitle: 'No chunks yet',
    noChunks: 'This stream has no chunks.',
    sweptTitle: 'Chunks no longer kept',
    swept: 'This run was cancelled or timed out, so its stream chunks are no longer kept.',
    liveNote: 'New chunks appear here every 2 seconds while the run is active.',
    chunkLabel: (sequence: number): string => `Chunk ${sequence}`,
  },
  updates: {
    heading: 'Update history',
    loading: 'Loading updates',
    empty: 'This run has received no updates.',
    awaiting: 'awaiting result',
    neverAnswered: 'never answered',
    resultSwept: 'result no longer kept',
    loadingResult: 'loading result',
    loadMore: 'Load older updates',
    timedOut: (name: string): string =>
      `${name} had not answered when the wait ended. It stays queued, and its result appears here once it is answered.`,
  },
} as const;

/** The words the run page uses for its steps, and for the lines the run logged. */
export const RUN_STEPS_COPY = {
  heading: 'Steps',
  listLabel: 'Steps',
  detailLabel: 'Step',
  filterLabel: 'Show steps',
  count: (shown: number, total: number): string =>
    shown === total ? `${String(total)} steps` : `${String(shown)} of ${String(total)} steps`,
  waterfallLabel: (starts: string, took: string | undefined): string =>
    took === undefined
      ? `Started ${starts} into the run`
      : `Started ${starts} into the run, took ${took}`,
  chooseTitle: 'Choose a step',
  chooseDescription: 'Choose a step to see what went into it, what came out, and what it logged.',
  emptyTitle: 'No steps yet',
  emptyDescription: 'The steps this run takes appear here as it works.',
  filteredTitle: 'No steps match',
  filteredDescription: 'None of this run’s steps is in that state.',
  showAll: 'Show all steps',
  loading: 'Loading the steps',
  loadFailedTitle: 'The steps could not be read',
  startedAfter: (offset: string): string => `started +${offset}`,
  took: (duration: string): string => `took ${duration}`,
  stillGoing: 'still going',
  noStart: 'no start time kept',
  runningDuration: 'running',
  input: 'Input',
  output: 'Output',
  error: 'Error',
  nothingKept: 'Nothing was kept.',
  branches: 'Branches',
  branchesUnreported: 'This step’s branches were not reported.',
  branchOutcome: { won: 'won', lost: 'lost', fulfilled: 'finished', rejected: 'failed' } as const,
  omitted: (count: number): string => `${String(count)} more not listed`,
  eventsFilteredHint: 'The Events section shows only this step’s events.',
  page: (page: number, pages: number): string => `Page ${String(page)} of ${String(pages)}`,
  previous: 'Previous',
  next: 'Next',
  jumpToStep: 'Jump to step',
  go: 'Go',
  paginationLabel: 'Steps pagination',
  awaitingCompletion: 'Awaiting external completion',
  complete: 'Complete…',
  unattachedNote: 'This could not be tied to a single step. Complete it from here.',
  workerProvenanceFor: (label: string): string => `Worker provenance for ${label}`,
} as const;

/** The words for the runs related to one run, in its Details rail and the topology that opens from it. */
export const RUN_RELATED_COPY = {
  heading: 'Related runs',
  parent: 'Started by',
  children: 'Started',
  siblings: 'Started alongside',
  topology: 'Topology',
  topologyTitle: 'Run topology',
  topologyDescription: 'The run that started this one, the runs it started, and its siblings.',
  thisRun: 'This run',
  parentGone: 'No longer kept',
  more: (count: number): string => `${String(count)} more`,
  partial: (shown: number, total: number): string =>
    `Showing ${String(shown)} of ${String(total)}. Filter the workflow list by this run’s parent to see the rest.`,
  revisionTitle: (revision: string): string => `Revision (exact executable artifact): ${revision}`,
  noneTitle: 'No related runs',
  noneDescription: 'No run started this one, and it has not started any.',
  loadFailedTitle: 'Related runs could not be read',
  openRun: (label: string): string => `Open run ${label}`,
} as const;

/** The words for a run's checkpoints: the list, the replay of one, and the fork it can start. */
export const RUN_CHECKPOINTS_COPY = {
  loadFailedTitle: 'Checkpoints could not be read',
  emptyTitle: 'No checkpoint history retained',
  emptyDescription:
    'Checkpoints are not being kept for this run, or none has been recorded for it yet.',
  chooseTitle: 'Select a checkpoint',
  chooseDescription: 'Choose a step to replay or fork from.',
  modeLabel: 'Open the checkpoint as',
  replay: 'Replay',
  fork: 'Fork',
  divergenceLabel: 'Divergence from the forked run',
  divergenceNote:
    'Diverged steps are highlighted. Both runs are identical up to the fork, so they differ only at or after it.',
  nothingToCompareTitle: 'Nothing to compare',
  nothingToCompareDescription: 'Neither run has any steps yet.',
  replayLockedTitle: 'Replay unavailable',
  replayNotice: (step: number): string =>
    `This is a replay of step ${String(step)}. It is read-only and does not change the live run.`,
  nothingStored: 'Nothing was stored at this step.',
  replayNoneTitle: 'No replay available',
  replayNoneDescription: (step: number): string =>
    `No checkpoint is retained at step ${String(step)}.`,
  revisionUnknown:
    'Not known. The original record is gone, it predates revision tracking, or the ID has been reused by a different run.',
  compacted: (sequence: number): string =>
    `Earlier events before sequence ${String(sequence)} were removed by retention.`,
} as const;

/** The words for the lines a run logged, in a step and under the run's Details. */
export const RUN_LOGS_COPY = {
  heading: 'Logs',
  count: (lines: number): string => (lines === 1 ? '1 line' : `${String(lines)} lines`),
  listLabel: 'Log lines',
  truncated: 'Cut short',
  truncatedTitle: 'The message was longer than the log keeps, so the end of it is missing.',
  emptyTitle: 'Nothing was logged',
  emptyDescription:
    'This run has not logged anything. Lines are kept with the run for a limited time, so an old run may have lost them.',
  dropped: (count: number): string =>
    count === 1
      ? '1 older line was removed to stay within the limit.'
      : `${String(count)} older lines were removed to stay within the limit.`,
  loadFailedTitle: 'The logs could not be read',
} as const;

/**
 * The words on a run's page (`/runs/:run`): the sections it is made of, the Details rail's labels,
 * and what each control says. A section a caller may not use says which scope it needs instead of
 * disappearing.
 */
export const RUN_PAGE_COPY = {
  moreActions: 'More actions',
  copyRunId: 'Copy run ID',
  runIdCopied: 'Run ID copied',
  runIdCopyFailed: 'The run ID was not copied',
  restart: 'Restart',
  /** Leaves the confirmation of an action on the workflow without doing it. */
  keep: 'Keep it',
  restartHint: 'Replace this run with a fresh one under the same ID',
  inputOutputHeading: 'Input and output',
  inputHeading: 'Input',
  resultHeading: 'Result',
  inputPayload: 'Input payload',
  resultPayload: 'Result payload',
  activityHeading: 'Activity',
  /** Names the plugin a panel on the run page comes from. */
  panelFromPlugin: (plugin: string) => `From the ${plugin} plugin`,
  eventsHeading: 'Events',
  eventsLockedTitle: 'Events are locked',
  checkpointsHeading: 'Checkpoints',
  lineageHeading: 'Lineage',
  detailsHeading: 'Details',
  attributesAndWorkerLabel: 'Attributes and worker',
  changeHeading: 'Change or ask this run',
  changeIntro: 'Send a message to the run, or read something from it, without leaving the page.',
  signal: { label: 'Send a signal', hint: 'Fire-and-forget message' },
  update: { label: 'Send an update', hint: 'Request / response, awaits a result' },
  query: { label: 'Ask a question', hint: 'Read-only, no workflow change' },
  queryName: 'Query name',
  queryInput: 'Input (JSON, optional)',
  queryRun: 'Run',
  queryRunning: 'Running…',
  queryFailed: 'The query failed.',
  facts: {
    startedBy: 'Started by',
    workflow: 'Workflow',
    agent: 'Agent',
    runId: 'Run ID',
    copyRunId: 'Copy run ID',
    started: 'Started',
    updated: 'Last changed',
    took: 'Took',
    deadline: 'Deadline',
    version: 'Version',
    revision: 'Revision',
    cleanup: 'Cleanup',
    tags: 'Tags',
    session: 'Session',
    finishReason: 'Finish reason',
    message: 'Message',
  },
  deadline: (remaining: string): string => `in ${remaining}`,
  deadlinePassed: 'passed',
  /** Said where a section needs a scope the caller does not hold. */
  lockedSection: (scope: string): string => `Not available to you. Requires ${scope}.`,
  noActivity: 'Nothing has happened in this run yet.',
  confirm: {
    cancel:
      'Cancellation is cooperative: the workflow observes a cancellation signal and unwinds through its own cleanup. This is irreversible from your side.',
    'force-timeout':
      'Forces the workflow into the timed-out state, as if its execution deadline had elapsed. Irreversible.',
    suspend: '',
    resume: '',
  },
} as const;

/**
 * What the application says when the server does not answer: the banner above the page, the title
 * a turned-off control shows, and the page that replaces a view with nothing to show.
 */
export const CONNECTION_COPY = {
  /** The banner's sentence; the age of the data on screen follows it. */
  banner: 'The server is not answering. Changes are turned off until it is back.',
  /** The title of a control that changes something while the server is unreachable. */
  changesOff: 'Turned off while the server is unreachable',
  /** The page of a view that has nothing to show because its first request got no answer. */
  page: {
    title: 'Server unreachable',
    description: 'The server did not answer. Check that Interborough is running, then try again.',
  },
} as const;

/** What precedes the age of the data a view keeps showing after its own request failed. */
export const STALE_DATA_LABEL = 'Showing data from';

/** The label on the control that asks a view to try again. */
export const RETRY_LABEL = 'Try again';

/**
 * What a route says when its code could not be loaded, such as after a rebuild replaced the files
 * an open page still points at. No view is involved, so it is not one of the view states.
 */
export const ROUTE_LOAD_FAILURE_COPY = {
  title: 'This page could not be loaded',
  description:
    'The application could not fetch the code for this page. It may have been rebuilt since you opened it.',
  action: 'Reload the page',
} as const;

/**
 * The words for an address no route matches. It is not one of a view's states: no view owns the
 * address, so the outlet shows this in its own frame (`data-view="not-found"`).
 */
export const NOT_FOUND_ROUTE_COPY = {
  title: 'This page does not exist',
  description: 'That address is not a page in Interborough.',
  action: { label: 'Go to chats', href: '/chats' },
} as const;

/** The words the agent editor uses outside its view states (`/agents/new`, `/agents/:agent/edit`). */
export const AGENT_EDITOR_COPY = {
  createHeading: 'New agent',
  /** The name a copy of an agent starts with. */
  copyName: (name: string): string => `${name} copy`,
  /** Duplicate (`/agents/new?from=`): what the page says about the agent it copies. */
  copy: {
    /** The line under the heading of a form filled from another agent. */
    from: (agent: string): string =>
      `Copied from ${agent}. Nothing is saved until you create the agent: name it, change what you like, then create it.`,
    /** What the page says when the agent to copy cannot be read, or has nothing to copy. */
    sourceFailed: {
      title: 'This agent could not be copied',
      description:
        'The agent could not be read, or it has no usable definition. Check that it exists and its file is valid, then try again.',
    },
    /** The tools of the original the catalog does not offer, so the copy leaves them out. */
    droppedTools: (tools: readonly string[]): string =>
      `${tools.length === 1 ? 'This tool is' : 'These tools are'} not offered by this installation, so the copy leaves ${tools.length === 1 ? 'it' : 'them'} out: ${tools.join(', ')}.`,
  },
  /**
   * Try it (COR-1911): a throwaway chat with the definition as it stands in the form, saved or
   * not. It writes no file and no memory, and ends when the drawer closes or the page is left.
   */
  try: {
    action: 'Try it',
    title: 'Try this agent',
    description:
      'Chat with the agent as the form describes it now. No agent file or memory is saved, and the chat is removed when you close this. Tools are real: a tool that runs without asking really runs, with whatever effect it has.',
    /** Said when the agent names reference documents, which a trial runs without. */
    leftOut: (documents: readonly string[]): string =>
      `This agent reads ${documents.length === 1 ? 'a document' : 'documents'} that ${documents.length === 1 ? 'is' : 'are'} not available in a trial, so the trial runs without ${documents.length === 1 ? 'it' : 'them'}: ${documents.join(', ')}.`,
    /** Said when the agent stopped to ask before a tool, which a trial cannot answer. */
    approvalEnded:
      'The agent stopped to ask before using a tool, and a trial cannot take that answer, so the trial ended. Set the tool to run without asking, or save the agent and chat with it.',
    messageLabel: 'First message',
    messagePlaceholder: 'Say something to the agent',
    send: 'Start chatting',
    chatLabel: 'Trial chat',
    startOver: 'Start over',
    close: 'End trial',
    /** Said when the form has changed since the trial chat started. */
    changed: 'The form changed after this chat started, so the agent here is the earlier version.',
    notRemoved: 'The trial chat could not be removed. It is left out of your chat list.',
    forbidden: 'This installation does not let you try agents.',
    failed: 'The agent could not be tried',
  },
  editHeading: (name: string): string => `Edit ${name}`,
  /** The accessible name of the form. */
  formLabel: 'Agent definition',
  /** The label before the agent's file path. */
  fileLabel: 'File',
  /**
   * The words that differ when the host keeps its state in a bucket (`mode: 'remote'` from
   * `/host/paths`). An agent is an object there, so it is not "a file". Everything not named here
   * is the same in both modes.
   */
  remote: {
    fileLabel: 'Stored in',
    noProvider: {
      configurationStep:
        'Put this in configuration.json in the bucket. If it exists, add the provider’s plugin to its plugins.',
      secretStep:
        'Set the provider’s API key in the environment variable shown, then restart the host.',
    },
  },
  /** The directory under the state directory that holds agent files, when the host does not say where. */
  fallbackDirectory: 'agents',
  /** The titles of the form's four sections. */
  sections: {
    identity: 'Identity',
    model: 'Model',
    instructions: 'Instructions',
    tools: 'Tools',
    limits: 'Guardrails and limits',
  },
  limits: {
    description:
      'What keeps a run in bounds. Leave a spend or tool field empty for no limit; the agent page shows what is set.',
    guardrailsLabel: 'Guardrails',
    guardrailsDescription:
      'Plugin guardrails the agent runs besides the default ones, as plugin:name, one per line.',
    stepLimitLabel: 'Steps per run',
    stepLimitDescription: 'The most steps one run may take. Empty uses the default of 25.',
    spendPerRunLabel: 'Spend per run (USD)',
    spendPerRunDescription: 'A run that reaches this stops.',
    spendPerChatLabel: 'Spend per chat (USD)',
    spendPerChatDescription: 'All the runs of one chat together. Needs a limit per run.',
    toolCallsLabel: 'Tool calls per run',
    toolCallsDescription: 'The most tool calls one run may make.',
    toolSecondsLabel: 'Tool time per run (seconds)',
    toolSecondsDescription: 'How long a run may keep calling tools, counted from its start.',
    errors: {
      guardrails: 'Write each guardrail as plugin:name, one per line.',
      stepLimit: (maximum: number): string => `Use a whole number from 1 to ${String(maximum)}.`,
      spend: (maximum: number): string => `Use an amount above 0, up to ${String(maximum)}.`,
      chatNeedsRun: 'Set a limit per run first: a chat limit sits on top of it.',
      toolCalls: (maximum: number): string => `Use a whole number from 1 to ${String(maximum)}.`,
      toolSeconds: (maximum: number): string =>
        `Use a number of seconds above 0, up to ${String(maximum)}.`,
    },
  },
  /** The line under the heading: when the agent was last saved, and the version that made. */
  saved: 'Saved',
  version: (revision: number): string => `Version ${String(revision)}`,
  /** The keyboard shortcut's group in the `?` map. */
  shortcutGroup: 'Agent editor',
  nameLabel: 'Name',
  nameDescription: 'What people see. It need not be unique.',
  identifierLabel: 'Identifier',
  identifierCreateDescription: 'The file name, without .md. Fixed once saved.',
  identifierEditDescription: 'The file name, without .md. It cannot change.',
  identifierInvalid:
    'Use lowercase letters, digits, and hyphens, starting and ending with a letter or digit, in at most 64 characters.',
  /** `new` is the address of the page that creates an agent, so an agent called `new` could never be opened. */
  identifierReserved:
    'This identifier is reserved: /agents/new is the page that creates an agent, so an agent called new could never be opened. Choose another.',
  identifierTaken: {
    'agent-file-exists': 'This identifier is taken. Another agent’s file already uses it.',
    'shadows-code-agent': 'This identifier is taken. An agent defined in code already uses it.',
  },
  descriptionLabel: 'Description',
  descriptionDescription: 'What the agent does. Optional.',
  modelLabel: 'Model',
  modelDescription: 'The models this installation offers.',
  modelPlaceholder: 'Choose a model',
  /**
   * The model field's words (`agent-editor-model-field.svelte`): models grouped by provider, a
   * provider with no key disabled and pointing to Settings › Models, a model that is not offered
   * disabled with its reason, and the abilities of the chosen one.
   */
  model: {
    /** The option that stands for a provider with no key. */
    notConnected: (provider: string): string => `${provider} is not connected`,
    notConnectedDescription: 'Connect it in Settings › Models to use its models.',
    /** What precedes the link to Settings › Models when a provider is not connected. */
    unconnectedLead: (providers: readonly string[]): string => {
      const names = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(
        providers,
      );
      return providers.length === 1
        ? `${names} is not connected. Connect it in`
        : `${names} are not connected. Connect them in`;
    },
    settingsLink: 'Settings › Models',
    /** Why a model is listed and cannot be chosen. */
    reasons: {
      'provider-denied': 'The model policy does not allow this provider.',
      'model-denied': 'The model policy does not allow this model.',
      'turned-off': 'Turned off in Settings › Models.',
      retired: 'Retired by its provider.',
      'not-in-catalog': 'This installation no longer offers this model.',
    },
    /** What the field says about the agent's own model when it cannot be chosen now. */
    keptNotice: (model: string, reason: string): string =>
      `This agent’s model, ${model}, is not offered now. ${reason} Saving keeps it unless you choose another.`,
    abilitiesLabel: 'Abilities of the chosen model',
    abilities: {
      tools: 'Tools',
      images: 'Images',
      structuredOutput: 'Structured output',
      streaming: 'Streaming',
    },
    textOnly: 'Text only',
    context: (size: string): string => `${size} context window`,
    maxOutput: (size: string): string => `${size} largest answer`,
  },
  /**
   * What the page shows instead of the form when the catalog holds no model: an agent cannot be
   * saved without one, and nothing in the application can add a provider.
   */
  noProvider: {
    title: 'No model provider yet',
    description:
      'Agents run on a model, and this installation has none connected. Connect a provider, then come back: this page shows the form as soon as the installation offers a model.',
    configurationStep:
      'Put this in the configuration file. If the file exists, add the provider’s plugin to its plugins.',
    secretStep: 'Save the provider’s API key in its own file, readable only by you (chmod 600).',
    restartStep: 'Restart the host, then check again.',
    reload: 'Check again',
    snippetLabel: 'Provider configuration',
    /** The action that opens Settings › Models, which returns to the form once a provider is connected. */
    connectAction: 'Connect a provider',
    /** What leads the steps for a person who would rather edit the files. */
    byHand: 'Or set it up by hand:',
  },
  toolsDescription: 'The tools this agent may call.',
  noTools: 'This installation offers no tools.',
  /** The count above the chosen tools, such as `2 of 48 chosen`. */
  toolCount: (chosen: number, offered: number): string =>
    `${String(chosen)} of ${String(offered)} chosen`,
  /** The name of the list of the tools the agent has. */
  chosenToolsLabel: 'Chosen tools',
  /** What the list says when the agent has no tool yet. */
  noToolsChosen: 'No tools chosen. The agent can reply, but it cannot call anything.',
  /** The action that opens the picker. */
  addToolsAction: 'Add tools',
  /** The button that takes one tool away from the agent, and the name a screen reader hears for it. */
  removeAction: 'Remove',
  removeToolLabel: (tool: string): string => `Remove ${tool}`,
  /** The marker on a tool that asks before it runs, and on one that never runs. */
  toolStanding: {
    'asks-first': 'Asks first',
    blocked: 'Blocked',
  },
  /** The tool picker (`Add tools`): a search over every tool the installation offers, grouped by source. */
  toolPicker: {
    title: 'Add tools',
    done: 'Done',
    searchLabel: 'Search tools',
    searchPlaceholder: 'Search by name, description or source',
    /** Announced as the search narrows. */
    resultCount: (count: number): string => (count === 1 ? '1 tool' : `${String(count)} tools`),
    noMatchesTitle: 'No tools match',
    noMatchesDescription: (search: string): string =>
      `Nothing is named or described like “${search}”.`,
    /** The count in a group's heading, such as `2 of 5`. */
    groupCount: (chosen: number, total: number): string => `${String(chosen)} of ${String(total)}`,
    /** The heading of a saved tool source's group; the source is the identifier its tool names start with. */
    savedSource: (source: string): string => source,
  },
  /** The disclosure on a tool row that shows the full text the model is told about the tool. */
  toolDisclosure: 'What the agent is told',
  instructionsLabel: 'Instructions',
  instructionsDescription: 'What the agent should do. This is the body of its file.',
  a2aLabel: 'Available over A2A',
  a2aDescription:
    'Lets other agents and A2A clients find and call this agent. Chats with it work either way.',
  /** The action on the agent list that opens the form for a new agent. */
  newAction: 'New agent',
  /** The action on an agent's page that opens its editor. */
  editAction: 'Edit',
  /** The badge on an agent file the Bureau cannot use, in the agent list. */
  invalidBadge: 'Invalid file',
  forbidden: 'This installation does not let you change agents.',
  createAction: 'Create agent',
  saveAction: 'Save changes',
  cancelAction: 'Cancel',
  deleteAction: 'Delete agent',
  deleteDialog: {
    title: 'Delete this agent?',
    description: (name: string): string =>
      `This removes the file for ${name}. Runs that already happened keep the version they used.`,
    confirm: 'Delete agent',
  },
  saveFailed: 'The agent was not saved',
  deleteFailed: 'The agent was not deleted',
  stale: {
    title: 'This agent changed outside Interborough',
    description:
      'Its file was edited or replaced after this page loaded, so nothing was saved or deleted. Reloading shows what is on disk and discards your unsaved edits.',
    action: 'Reload from disk',
  },
  invalid: {
    title: 'This agent’s file is invalid',
    description: 'Interborough cannot run it until the file is fixed. Edit the file, then reload.',
    action: 'Reload from disk',
    fileLabel: 'File',
  },
  loadFailed: {
    title: 'The agent could not be loaded',
    description: 'The server did not answer. Check that the host is running, then try again.',
  },
  revisions: {
    heading: 'Revision history',
    description: 'The versions of this agent that have run, most recently run first.',
    caption: 'Versions of this agent that have run',
    versionColumn: 'Version',
    lastRunColumn: 'Last run',
    emptyTitle: 'No version has run yet',
    empty: 'A version appears here once the agent runs on it.',
    failedTitle: 'The revision history could not be loaded',
  },
} as const;

/** The words the Workflows area uses outside its view states (`/workflows` and under it). */
export const WORKFLOW_COPY = {
  /** The badge on every workflow the Bureau holds a file for. */
  agentAuthoredBadge: 'Agent-authored',
  /** The badge on a workflow type that code registered. */
  codeBadge: 'Code',
  newAction: 'New workflow',
  /** The badge on a file the Bureau cannot use. */
  invalidBadge: 'Invalid file',
  pausedBadge: 'Paused',
  /** The label on a workflow whose source failed to load, with the category of the failure. */
  sourceFailed: (category: string): string => `Failed to load: ${category}`,
  /** The directory under the state directory that holds workflow files, when the host does not say where. */
  fallbackDirectory: 'workflows',
  fileLabel: 'File',
  /** The words that differ when the host keeps its state in a bucket (`mode: 'remote'`). */
  remote: { fileLabel: 'Stored in' },
  problemLabel: 'Problem',
  issuesLabel: 'Issues',
  stepsLabel: 'Steps',
  /** The link from a workflow's recent runs to all of them. */
  runsAction: 'All runs',
  editAction: 'Edit',
  pauseAction: 'Pause',
  resumeAction: 'Resume',
  deleteAction: 'Delete',
  /** The accessible name of a link to a workflow's page. */
  listLabel: 'Workflows',
  /** The list at `/workflows`. */
  list: {
    /** The link from Workflows to the page of the types the Bureau runs itself. */
    internalWorkflows: (count: number): string => `Internal workflows (${String(count)})`,
    /** How many workflows the page lists, as a sentence. */
    count: (count: number): string => `${String(count)} ${count === 1 ? 'workflow' : 'workflows'}`,
    filtersLabel: 'Filter workflows',
    searchLabel: 'Search workflows',
    searchPlaceholder: 'Search workflows',
    statusLabel: 'Status',
    anyStatus: 'Any status',
    clearAction: 'Clear filters',
    noMatch: {
      title: 'No workflow matches these filters',
      description: 'Change the search or the status to see more workflows.',
    },
    columns: {
      workflow: 'Workflow',
      kind: 'Kind',
      starts: 'Starts',
      runs: 'Runs',
      status: 'Status',
    },
    emptyTitle: 'No workflows yet',
    emptyBeforeTool: 'Chat with an agent that has the',
    emptyTool: 'bureau:workflows-create',
    emptyBeforeDirectory: 'tool, or add a JSON file to',
    schedules: (count: number): string => `${String(count)} schedules`,
    runs: (count: number): string => `${String(count)} ${count === 1 ? 'run' : 'runs'} in 24 hours`,
    running: (count: number): string => `(${String(count)} running)`,
    neverRun: 'No runs yet',
    lastRun: (relative: string): string => `last run ${relative}`,
    onSignal: 'On the signal',
  },
  /** The page of the workflows Interborough runs itself (`/internal-workflows`). */
  internal: {
    title: 'Internal workflows',
    description:
      'Interborough runs these itself to carry out agent runs, goals, and its heartbeat. Nobody starts one by hand.',
    backToWorkflows: 'Workflows',
    count: (count: number): string => `${String(count)} ${count === 1 ? 'workflow' : 'workflows'}`,
    columns: { workflow: 'Workflow', description: 'What it does' },
    caption: 'Internal workflows',
    noDescription: 'No description.',
    empty: {
      title: 'No internal workflows',
      description: 'This installation does not run any workflows of its own.',
    },
    loadFailed: {
      title: 'The internal workflows could not be loaded',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
  },
  /** The page of one workflow. */
  page: {
    /** The status line under the name: the cadence, then whether the workflow is running. */
    statusActive: 'Active',
    statusPaused: 'Paused',
    recentRuns: 'Recent runs',
    runsFailed: 'The runs could not be loaded.',
    runDuration: (milliseconds: string): string => `took ${milliseconds}`,
    trigger: 'Trigger',
    schedulesHeading: 'Schedules',
    schedulesFailed: 'The schedules could not be loaded.',
    scheduleActive: 'Active',
    schedulePaused: 'Paused',
    /** The facts of the Overview tab, each shown only when the workflow has it. */
    signals: 'Accepted signals',
    updates: 'Updates',
    queries: 'Queries',
    /** The tabs of the page, and the name of the list that holds them. */
    tabsLabel: 'Workflow sections',
    tabs: { overview: 'Overview', code: 'Code', runs: 'Runs', history: 'History' },
    startAction: 'Start run',
    /** The Overview tab. */
    overview: {
      inputLabel: 'Input',
      outputLabel: 'Output',
      /** Shown when a workflow declares no schema, instead of an empty list of fields. */
      noSchema: 'Declares no schema.',
      stepsEmptyTitle: 'This workflow has no steps',
      stepsEmptyDescription: 'Add a step to its file and it appears here.',
    },
    /** The Runs tab. */
    runs: {
      emptyTitle: 'Nothing has run this workflow yet',
      emptyDescription: 'A run appears here as soon as one starts.',
      /** A paused file starts nothing, so its empty state says so rather than promising a trigger. */
      emptyDescriptionPaused:
        'This workflow is paused, so its trigger starts nothing. Resume it and a run appears here once one starts.',
      /** A type that code registered is also started by its schedules, so the empty state names no one starter. */
      emptyDescriptionCode: 'A run appears here as soon as something starts one.',
    },
    /** The Code tab. */
    code: {
      fileHeading: 'File source',
      outlineHeading: 'Step outline',
      noOutline: 'The file has no steps to outline.',
      noText: 'The file has no content this page can show.',
      codeHeading: 'Registered contract',
      codeNote:
        'This workflow is defined in code, and the code is not exposed. This is its description and the contract it registered.',
      failedTitle: 'The source could not be loaded',
      failedDescription: 'Try again, or check that you may read workflows.',
      unavailableTitle: 'This workflow has no source to show',
      unavailableDescription: 'It is not defined in code, or you may not read workflows.',
    },
  },
  /** `/workflows/:workflow/run`: one run of the workflow in the path, started now or on a schedule. */
  runSetup: {
    /** The page's entry in the breadcrumb trail. */
    crumb: 'Run',
    title: (name: string): string => `Run ${name}`,
    inputHeading: 'Input',
    inputDescription: 'What the run starts with.',
    /** A workflow that declares no schema takes its input as JSON. */
    jsonLabel: 'Input (JSON)',
    jsonDescription: 'JSON. Leave empty to start with no input.',
    invalidJson: 'The input must be valid JSON, or left empty.',
    whenHeading: 'When',
    whenLabel: 'When to run',
    now: 'Now',
    nowDescription: 'Starts a run as soon as you confirm.',
    schedule: 'On a schedule',
    scheduleDescription: 'Starts a run each time the schedule fires, with this input.',
    /** The schedule choice for a workflow whose schedule is the trigger in its file. */
    scheduleInFile:
      'This workflow is agent-authored, so its schedule is the trigger in its file. Change it in the workflow.',
    scheduleLabel: 'Schedule',
    summaryNow: (name: string): string => `Starts ${name} now with this input.`,
    /** An interval counts elapsed time, so it names no zone. */
    summarySchedule: (name: string, cadence: string, timeZone: string | undefined): string =>
      timeZone === undefined
        ? `Runs ${name}: ${cadence}.`
        : `Runs ${name}: ${cadence}, in ${timeZone}.`,
    startAction: 'Start run',
    scheduleAction: 'Create schedule',
    cancel: 'Cancel',
    startFailed: 'The run was not started',
    scheduleFailed: 'The schedule was not created',
    /** The answer was lost, so the Bureau may have acted: say so, and do not suggest trying again blindly. */
    scheduleInvalid: 'A field in the schedule is not valid. Correct it, then create the schedule.',
    startMaybe: 'The run may have started',
    scheduleMaybe: 'The schedule may have been created',
    lostDescription:
      'The server did not answer. Check before trying again, so it is not done twice.',
    checkRuns: 'Check the runs',
    checkSchedules: 'Check the schedules',
    forbidden: 'You may not start runs or create schedules here.',
    loadFailed: {
      title: 'This workflow could not be loaded',
      description: 'Try again, or check that you may read workflows.',
    },
    /** A workflow that cannot be run from this page, and where to go instead. */
    blocked: {
      openWorkflow: 'Open the workflow',
      engineTitle: 'Interborough starts this workflow itself',
      engineDescription: 'There is nothing to set up here.',
      invalidTitle: 'This workflow cannot run yet',
      invalidDescription: 'Its file has a problem. Fix it in the workflow, and it can run.',
      pausedTitle: 'This workflow is paused',
      pausedDescription: 'Resume it in the workflow, and it can run.',
    },
  },
  /** Choosing the workflow to run, from the runs list. */
  runPicker: {
    title: 'Start a run',
    description: 'Choose the workflow to run. The next page sets up its input and when it runs.',
    listLabel: 'Workflows you can run',
    /** The filter is offered once there are more workflows than fit at a glance. */
    filterLabel: 'Find a workflow',
    noMatchTitle: 'No workflow matches that search',
    noMatchDescription: 'Change the search to see more workflows.',
    cancel: 'Cancel',
    loadFailedTitle: 'The workflows could not be loaded',
    loadFailedDescription: 'Try again, or check that you may read workflows.',
    emptyTitle: 'No workflow can run yet',
    emptyDescription: 'Make a workflow, and it appears here to run.',
    emptyAction: 'New workflow',
  },
  /** `/workflows/new`. */
  creator: {
    heading: 'New workflow',
    textLabel: 'Workflow file',
    textDescription:
      'The file’s JSON. Its name is the workflow’s identifier, and it cannot be changed after the first save.',
    saveAction: 'Create workflow',
    cancelAction: 'Cancel',
    saveFailed: 'The workflow was not created',
    noName: 'Give the workflow a name: a "name" key holding its identifier.',
    invalidName:
      'The name must use lowercase letters, digits, and hyphens, start with a letter, and be at most 64 characters.',
    reservedName:
      'This name is reserved: /workflows/new is the page that creates a workflow, so a workflow called new could never be opened. Choose another.',
    taken: (name: string): string =>
      `A workflow called ${name} already exists. Choose another name.`,
    /** What the editor starts with: a name, a description, a schedule trigger, and one agent step. */
    templateName: 'my-workflow',
    templateDescription: 'Says what this workflow is for in a sentence.',
    templateSpec: '1h',
    templateMessage: 'Say hello.',
  },
  /** The step builder of `/workflows/new` and `/workflows/:workflow/edit`. */
  builder: {
    shortcutGroup: 'Workflow builder',
    tabsLabel: 'How to edit the workflow',
    builderTab: 'Builder',
    jsonTab: 'JSON',
    detailsHeading: 'Details',
    nameLabel: 'Name',
    nameDescription: 'The workflow’s identifier. It cannot be changed after the first save.',
    descriptionLabel: 'Description',
    descriptionDescription: 'What this workflow is for, in a sentence.',
    triggerHeading: 'Trigger',
    triggerKindLabel: 'Starts',
    triggerKinds: { schedule: 'On a schedule', signal: 'When a signal arrives' },
    /** A trigger kind a plugin contributes, named by its `plugin:name`. */
    contributedTrigger: (id: string): string => `When ${id} fires`,
    /** A trigger kind no running plugin contributes (the plugin is off, or the file is wrong). */
    unavailableTrigger: (id: string): string =>
      `No running plugin contributes the trigger ${id}. Change it in the JSON tab.`,
    /** Shown while the plugin trigger kinds load and the file's trigger names one. */
    checkingTrigger: (id: string): string => `Checking the trigger ${id}…`,
    /** The plugin trigger kinds could not be read, so the file's own trigger cannot be checked. */
    triggerKindsFailed: (id: string): string =>
      `The trigger ${id} is kept as the file has it, but the list of plugin triggers did not load, so its settings cannot be shown.`,
    retryTriggerKinds: 'Try again',
    scheduleLabel: 'Schedule',
    scheduleDescription: 'A duration such as 1h, or a cron expression.',
    signalNameLabel: 'Signal name',
    otherTrigger: 'This trigger is edited in the JSON tab.',
    stepsHeading: 'Steps',
    stepsDescription:
      'They run in order. An agent step gets the result of the step before it, except after a wait, which passes nothing on.',
    afterWaitSummary: '(with no result from before the wait)',
    stepsUnreadable:
      'This file’s steps are not a list the builder can read. Fix them in the JSON tab.',
    notAnObject: 'This is not an object',
    otherStepNote: 'The builder cannot edit this step. Change it in the JSON tab.',
    durationDescription: 'A bare number is milliseconds. Or write 30s, 5m, 1h.',
    stepKinds: { agent: 'Agent', wait: 'Wait', signal: 'Signal', other: 'Other' },
    agentLabel: (position: number): string => `Agent for step ${String(position)}`,
    messageLabel: (position: number): string => `Message for step ${String(position)}`,
    durationLabel: (position: number): string => `How long step ${String(position)} waits`,
    signalLabel: (position: number): string => `Signal step ${String(position)} waits for`,
    moveEarlier: (position: number): string => `Move step ${String(position)} earlier`,
    moveLater: (position: number): string => `Move step ${String(position)} later`,
    remove: (position: number): string => `Remove step ${String(position)}`,
    addAgent: 'Add an agent step',
    addWait: 'Add a wait',
    addSignal: 'Add a signal wait',
    noSteps: {
      title: 'No steps yet',
      description: 'A workflow runs its steps in order. Add the first one.',
    },
    summaryLabel: 'In plain words',
    summaryEmpty: 'Nothing is set yet.',
    unreadable: {
      title: 'The builder needs valid JSON',
      description: 'The JSON tab holds text that is not a workflow file yet. Fix it there.',
      action: 'Open the JSON tab',
    },
  },
  revisions: {
    heading: 'Revisions that have run',
    description:
      'The versions of this workflow that have run, most recently run first, each with whether it is compatible with the current one.',
    caption: 'Versions of this workflow that have run',
    versionColumn: 'Version',
    firstRunColumn: 'First run',
    lastRunColumn: 'Last run',
    emptyTitle: 'No version of this workflow has run yet',
    emptyDescription: 'A version appears here after its first run.',
    failed: 'The revision history could not be loaded.',
    /** The verdict against the current revision. */
    verdictColumn: 'Compatibility',
    compatible: 'Compatible',
    incompatible: 'Incompatible',
    noCurrent: 'No current revision',
    noCurrentDescription: 'There is no current revision to compare with.',
    /** Why a revision is not compatible with the current one. */
    reason: (reason: string): string => {
      switch (reason) {
        case 'name-mismatch':
          return 'It is for a different workflow name.';
        case 'manifest-version-unsupported':
          return 'Its manifest uses a schema version this server does not support.';
        case 'contract-hash-mismatch':
          return 'Its payload contract differs from the current revision.';
        case 'workflow-version-incompatible':
          return 'Its workflow version differs from the current revision.';
        case 'artifact-revision-mismatch':
          return 'Its revision identity differs from the current revision.';
        default:
          return `Unknown reason: ${reason}`;
      }
    },
  },
  steps: {
    agent: (agent: string, message: string): string => `Ask the agent ${agent}: ${message}`,
    sleep: (duration: string): string => `Sleep for ${duration}`,
    awaitSignal: (signal: string): string => `Wait for the signal ${signal}`,
    activity: (handler: string): string => `Run the activity ${handler}`,
    unknown: (kind: string): string => `A ${kind} step`,
  },
  triggers: {
    schedule: (spec: string, overlap: string | null): string =>
      overlap === null ? `On a schedule: ${spec}` : `On a schedule: ${spec} (overlap: ${overlap})`,
    signal: (name: string): string => `When the signal ${name} is sent`,
    unknown: (kind: string): string => `A ${kind} trigger`,
  },
  deleteDialog: {
    title: 'Delete this workflow?',
    description: (name: string): string =>
      `This removes the file for ${name} and cancels its schedule. Runs already in progress finish on the version they started on.`,
    confirm: 'Delete workflow',
  },
  stale: {
    title: 'This workflow changed outside Interborough',
    description:
      'Its file was edited or replaced after this page loaded, so nothing was changed. Reloading shows what is on disk and discards your unsaved edits.',
    action: 'Reload from disk',
  },
  /**
   * The Bureau replaced the file and then the engine or the schedule could not follow
   * (`workflow-apply-failed`). The change is on disk, so it is not a failed write.
   */
  applyFailed: {
    title: 'Saved, but the server could not apply it yet',
    description:
      'The file on disk has the change. The server did not follow it, and applies the file again by itself. This page shows what is on disk.',
  },
  pauseFailed: 'The workflow was not paused',
  resumeFailed: 'The workflow was not resumed',
  deleteFailed: 'The workflow was not deleted',
  forbidden: 'This installation does not let you change workflows.',
  loadFailed: {
    title: 'The workflow could not be loaded',
    description: 'The server did not answer. Check that the host is running, then try again.',
  },
  signal: {
    heading: 'Send a signal',
    description:
      'Delivers the signal to every running instance waiting for it, and starts every workflow whose trigger is that signal.',
    nameLabel: 'Signal name',
    payloadLabel: 'Payload',
    payloadDescription: 'JSON. Optional.',
    sendAction: 'Send signal',
    invalidPayload: 'The payload must be valid JSON, or left empty.',
    resultLabel: 'Signal result',
    result: (started: number, delivered: number): string =>
      `Started ${String(started)} ${started === 1 ? 'instance' : 'instances'}, delivered to ${String(delivered)} ${delivered === 1 ? 'instance' : 'instances'}.`,
    failed: 'The signal was not sent',
  },
  editor: {
    heading: (name: string): string => `Edit ${name}`,
    textLabel: 'Workflow file',
    textDescription:
      'The file’s JSON. Its name is the file’s identifier, so it is not sent when you save.',
    saveAction: 'Save changes',
    cancelAction: 'Cancel',
    saveFailed: 'The workflow was not saved',
    notJson: 'This is not valid JSON, so nothing was saved.',
    notObject: 'A workflow is a JSON object, so nothing was saved.',
    invalid: {
      title: 'This workflow’s file is invalid',
      description:
        'Interborough cannot run it until the file is fixed. Edit it below, or fix the file and reload.',
      action: 'Reload from disk',
    },
    unreadable: {
      title: 'This workflow’s file cannot be read',
      description: 'It has no content this page can edit. Fix the file on disk, then reload.',
    },
  },
} as const;

/**
 * What a write that named the revision, or the hash, it had read says when the thing had changed
 * since: nothing was written, and the page has read it again. The schedules and the goals say it.
 */
export const STALE_COPY = {
  title: (id: string): string => `“${id}” changed since you loaded it`,
  description:
    'Someone or something changed it after this page read it, so nothing was changed. It has been reloaded, and what you see is what it is now. Try again if you still want to.',
} as const;

/** The words the schedules area (`/schedules` and under it) uses outside its view states. */
export const SCHEDULE_COPY = {
  /** What a workflow's schedule says it starts; an agent run is said by its agent alone. */
  kind: {
    'workflow-file': 'Agent-authored workflow',
    code: 'Code-defined workflow',
  },
  /** A Bureau schedule the caller may not read the agent of. */
  unnamedAgent: 'An agent',
  /** In a sentence, for a schedule whose agent the caller may not read. */
  anAgent: 'an agent',
  /** The name of a schedule that has no description, by what it starts. */
  nameFor: (target: string): string => `Schedule for ${target}`,
  /** The name of a Bureau schedule that has no description and whose agent the caller may not read. */
  unnamedAgentRun: 'Scheduled agent run',
  title: 'Schedules',
  newAction: 'New schedule',
  filtersLabel: 'Filter schedules',
  statusLabel: 'Status',
  anyStatus: 'Any status',
  agentLabel: 'Agent',
  anyAgent: 'Any agent',
  clearFilters: 'Clear filters',
  loading: 'Loading schedules',
  /** How many schedules the list shows, as a sentence. */
  count: (count: number): string => `${String(count)} ${count === 1 ? 'schedule' : 'schedules'}`,
  /** The caption of the table. */
  caption: 'Schedules, with the workflow each one runs',
  columns: {
    schedule: 'Schedule',
    runs: 'Runs',
    repeats: 'Repeats',
    next: 'Next run',
    last: 'Last run',
    status: 'Status',
    actions: 'Actions',
  },
  noMatch: {
    title: 'No matching schedules',
    description: 'No schedule matches the current filters. Clear a filter to see more.',
  },
  actionsFor: (name: string): string => `Actions for ${name}`,
  copyId: 'Copy ID',
  idCopied: 'Schedule ID copied',
  idCopyFailed: 'The schedule ID was not copied',
  neverFired: 'not fired yet',
  lastSucceeded: 'last run succeeded',
  lastFailed: 'last run did not succeed',
  missed: (count: number): string => `${String(count)} missed`,
  lastMissed: (when: string): string => `last missed ${when}`,
  /** A file's own schedule, which the list shows beside the workflow it is the trigger of. */
  inFile: 'In the workflow’s file',
  /** The cadence of a cron schedule, with the zone it is read in. */
  inZone: (zone: string): string => `in ${zone}`,
  moreActions: 'More actions',
  backToList: 'All schedules',
  /** The action that opens the editor of the workflow whose file holds a schedule's trigger. */
  editWorkflowAction: 'Edit workflow',
  editWorkflowNote:
    'This schedule is the trigger in a workflow’s file, so its cadence, overlap, and the rest are edited in the workflow, and it ends when the workflow is deleted.',
  /** A write that named the revision of the schedule, or the hash of the file, that the caller read. */
  stale: STALE_COPY,
  /** The Bureau changed the workflow’s file, and the engine could not follow yet. */
  unapplied: {
    title: 'Saved, but the server could not apply it yet',
    description:
      'The workflow’s file has the change. The server did not follow it, and applies the file again by itself. This page shows what is on disk.',
  },
  overlayFailed: {
    title: 'The server did not say what these schedules start',
    description:
      'Until it answers, schedules are listed without their agents and cannot be changed. Check that the host is running, then try again.',
  },
  pauseFailed: 'The schedule was not paused',
  resumeFailed: 'The schedule was not resumed',
  cancelFailed: 'The schedule was not cancelled',
  skipFailed: 'The next run was not skipped',
  runNowFailed: 'The schedule was not run',
  cancelDialog: {
    title: 'Cancel this schedule?',
    confirm: 'Cancel schedule',
    description: (name: string): string =>
      `“${name}” will stop firing. This can’t be undone. Create a new schedule to resume this cadence.`,
  },
  /** One schedule's page (`/schedules/:id`). */
  detail: {
    loading: 'Loading schedule',
    loadFailed: 'The schedule could not be loaded',
    locked: { title: 'Schedule is locked' },
    notFound: {
      title: 'Schedule not found',
      description: 'No schedule with this address exists. It may have been cancelled and purged.',
    },
    onSwitch: 'On',
    onSwitchLabel: 'Schedule on',
    runNow: 'Run now',
    edit: 'Edit',
    sends: 'Sends',
    /** The verb and the zone of the sentence under the title. */
    nextRunsHeading: 'Next runs',
    nextRunsCaption: (zone: string): string => `Shown in ${zone}`,
    skipNext: 'Skip the next one',
    skipped: 'Skipped',
    skippedNote: 'This run is skipped. The one after it runs as usual.',
    noNextRuns: {
      title: 'Nothing is coming up',
      description: (status: string): string =>
        `This schedule is ${status}, so it has no next runs. Turn it on to schedule them again.`,
    },
    pastRunsHeading: 'Past runs',
    pastRunsCaption: 'Runs this schedule started, and the fires it missed, newest first',
    pastColumns: { when: 'When', outcome: 'Outcome', took: 'Took' },
    noPastRuns: {
      title: 'No runs yet',
      description: 'This schedule has not fired. Its runs and any fires it missed are listed here.',
    },
    runLink: (when: string): string => `Run ${when}`,
    manual: 'Run now',
    missedOutcome: 'Missed',
    missedReason: {
      late: 'The host was not running, or was too slow, when it was due.',
      'dst-gap': 'The clock skipped this time when it moved forward.',
    },
    missedCount: (count: number): string => `${String(count)} missed`,
    runsFailed: 'Past runs could not be loaded',
    missedFailed: 'Missed fires could not be loaded',
    railHeading: 'Details',
    rail: {
      workflow: 'Workflow',
      agent: 'Agent',
      input: 'Input',
      noInput: 'None',
      repeats: 'Repeats',
      zone: 'Time zone',
      overlap: 'If a run is still going',
      catchUp: 'Catch up after downtime',
      catchUpOn: 'Runs the fires it missed',
      catchUpOff: 'Skips the fires it missed',
      jitter: 'Jitter',
      noJitter: 'None',
      revision: 'Workflow version',
      runningNow: 'Running now',
      queued: 'Queued',
      nothingRunning: 'Nothing is running',
      created: 'Created',
    },
    runNowOutcome: {
      started: 'Started a run.',
      queued: 'A run is going, so this one is queued behind it.',
      skipped: 'A run is still going, so this one was skipped.',
      viewRun: 'View the run',
    },
  },
  /** The cadence editor's page (`/schedules/:id/edit`). */
  edit: {
    title: 'Edit schedule',
    save: 'Save changes',
    cancel: 'Cancel',
    loading: 'Loading schedule',
    startOver: 'Start over from the current schedule',
    invalidCadence: 'The cadence is not valid. Fix the highlighted field, then save.',
    skipPending:
      'The next run is skipped. Saving any change to this schedule restores that run, and it starts as usual.',
    saveFailed: 'The schedule was not saved',
  },
  /** One line that says what happens when a fire is due while a run is still going. */
  overlapLine: {
    skip: 'Skips a fire if the previous run is still going',
    queue: 'Queues a fire if the previous run is still going',
    'cancel-running': 'Cancels the previous run if it is still going when a fire is due',
    allow: 'Starts a fire even if the previous run is still going',
  },
  /** The answer to making a schedule was lost, so it may exist. */
  lost: {
    title: 'The schedule may have been created',
    description:
      'The answer did not come back, so the schedule may exist. Check the list before you create it again.',
    check: 'Check the schedules',
  },
  /** The page that makes a schedule (`/schedules/new`). */
  create: {
    title: 'New schedule',
    description:
      'A schedule runs a workflow on a timer. Choose the workflow, give it its input, then say when.',
    workflowHeading: 'Workflow',
    workflowLabel: 'Workflow',
    workflowPlaceholder: 'Search workflows',
    groups: { builtIn: 'Built in', recent: 'Recent', all: 'All workflows' },
    chat: {
      label: 'Chat with an agent',
      description: 'Sends a message to one of your agents on every run.',
    },
    /** The reason an agent-authored workflow is listed but cannot be chosen. */
    inFile: 'Its schedule is the trigger in its file. Change it in the workflow.',
    noMatch: 'No workflow matches.',
    createOne: 'Create a workflow',
    catalogFailed: {
      title: 'The workflows could not be listed',
      description: 'Only the built-in choice is available until they can. Try again.',
    },
    checking: 'Reading the workflow',
    workflowFailed: 'The workflow’s input could not be read',
    workflowGone:
      'This workflow no longer exists, or cannot be scheduled from here. Choose another.',
    inputHeading: 'Input',
    noInput: 'Takes no input.',
    chatLabel: 'Continue one chat',
    chatDescription:
      'Optional. Every run continues this chat. Without one, each run starts a chat.',
    chatPlaceholder: 'A new chat for each run',
    chatClear: 'Start a new chat each run',
    chatUnavailable: 'Chats could not be listed, so each run starts a new chat.',
    chatUntitled: 'Untitled chat',
    chatAgent: (agent: string): string => `Agent: ${agent}`,
    chatFixesAgent: (agent: string): string => `This chat is with ${agent}, so every run is too.`,
    whenHeading: 'When',
    whenLabel: 'Schedule',
    optionsHeading: 'Options',
    descriptionLabel: 'Description',
    descriptionDescription: 'Optional. It names the schedule in the list.',
    overlapLabel: 'If a run is still going when the next one is due',
    catchUpLabel: 'Run the fires it missed while the host was down',
    startPausedLabel: 'Start turned off',
    startPausedDescription: 'Nothing runs until you turn it on.',
    jitterLabel: 'Jitter',
    jitterDescription: 'A random delay added to each run.',
    jitterPlaceholder: '30s',
    revisionLabel: 'Which version of the workflow each run uses',
    /** An interval counts elapsed time, so it names no zone. */
    summaryChat: (agent: string, cadence: string, timeZone: string | undefined): string => {
      const who = agent === '' ? 'an agent' : agent;
      return timeZone === undefined
        ? `Chats with ${who}: ${cadence}.`
        : `Chats with ${who}: ${cadence}, in ${timeZone}.`;
    },
    summaryNothing: 'Choose a workflow to schedule.',
    submit: 'Create schedule',
    cancel: 'Cancel',
    pauseFailed: 'The schedule was created, but it could not be turned off. It is on.',
    invalidCadence: 'The repeat is not valid. Fix the highlighted field, then create the schedule.',
    noAgents: {
      title: 'No agents to chat with',
      description: 'A scheduled chat runs one of your agents. Make an agent first.',
      action: 'New agent',
    },
    workflowRequired: 'Choose a workflow.',
  },
  form: {
    agentLabel: 'Agent',
    agentPlaceholder: 'Choose an agent',
    agentDescription: 'The agent each fire runs. It must be in this installation’s catalog.',
    agentFreeTextDescription: 'The list of agents is unavailable. Enter the agent’s name.',
    noAgents: 'This installation lists no agents.',
    inputLabel: 'What to send',
    inputDescription: 'The text each fire sends to the agent.',
    sessionWithAllow: 'A schedule that continues a session cannot allow its fires to overlap.',
    skipOverlapLabel: 'Skip a fire if the previous run is still going',
    descriptionLabel: 'Description',
    descriptionDescription:
      'Optional. It names the schedule; without one the schedule is named by its agent.',
    cadenceLabel: 'Cadence',
    exactCadenceDescription:
      'The cadence builder counts in whole minutes at the smallest, so this schedule’s exact timing is kept unless you change it.',
    changeCadenceAction: 'Change cadence',
    agentRequired: 'Choose an agent.',
    descriptionTooLong: (most: number): string =>
      `The description is too long: it can be at most ${String(most)} characters.`,
    inputRequired: 'Enter the text to send.',
    inputTooLong: 'The input is too long.',
    notEditable: 'This schedule cannot be edited here',
  },
} as const;

/** The sections of Settings, in the order its section navigation lists them. */
export const SETTINGS_SECTION_COPY = {
  navigation: 'Settings sections',
  general: 'General',
  models: 'Models',
  modelPolicy: 'Model policy',
  a2a: 'A2A',
  plugins: 'Plugins',
  dataAndRetention: 'Data and retention',
  apiReference: 'API reference',
} as const;

/**
 * The checklist a new installation shows on Chat until it has a provider, an agent, and a chat
 * (`app/first-run-checklist.svelte`). Each step names the page that completes it; the host's own
 * answers say when it is done.
 */
export const FIRST_RUN_COPY = {
  title: 'Get started',
  description: 'Three steps to your first conversation.',
  label: 'Getting started',
  listLabel: 'Steps to get started',
  dismiss: 'Dismiss',
  dismissLabel: 'Dismiss the getting started steps',
  completed: 'Completed',
  steps: {
    provider: {
      title: 'Connect a provider',
      description:
        'An agent runs on a model, and a provider offers models. Save its API key to connect it.',
      action: { label: 'Connect a provider', href: '/settings/models' },
    },
    agent: {
      title: 'Create an agent',
      description: 'Write an agent of your own, or start from one that ships with the host.',
      action: { label: 'New agent', href: '/agents/new' },
    },
    chat: {
      title: 'Say hello',
      description: 'Start a chat with an agent. Your chats are kept here.',
      action: { label: 'New chat', href: '/chats/new' },
    },
  },
} as const;

/**
 * The words of Settings › A2A: the agents that opt in to being found and called by other agents,
 * the address of each one's Agent Card, and (under them) the push-notification settings.
 */
export const A2A_COPY = {
  intro:
    'Other agents and A2A clients can find and call the agents you opt in. Each one publishes an Agent Card at the address below.',
  agentsHeading: 'Agents reachable over A2A',
  agentsDescription:
    'Opt an agent in from its editor, with Available over A2A. Chats with an agent work either way.',
  listLabel: 'Agents reachable over A2A',
  loading: 'Loading the agents reachable over A2A',
  loadFailed: {
    title: 'The agents could not be listed',
    description: 'The host did not answer. Check that it is running, then try again.',
  },
  empty: {
    title: 'No agent is reachable over A2A',
    description: 'Turn on Available over A2A in an agent’s editor and its Agent Card appears here.',
    action: { label: 'Open agents', href: '/agents' },
  },
  cardLabel: 'Agent Card address',
  copyCard: 'Copy address',
  copiedCard: 'Copied',
  editAction: 'Edit',
  editAgent: (name: string): string => `Edit ${name}`,
  fromCode: 'Defined in code',
  needsKey: 'Needs an API key',
  cardLoading: 'Reading the card',
  cardUnavailable: 'Card unavailable',
  cardRetry: 'Try again',
} as const;

/**
 * The words of Settings › API reference: the side list that names the four groups, and the states
 * of the groups that have none of their own (`routes/settings/api-reference.svelte`).
 */
export const API_REFERENCE_COPY = {
  groupsLabel: 'API reference groups',
  groups: {
    operations: 'Operations',
    discovery: 'Discovery documents',
    scopes: 'Your scopes',
    sources: 'Workflow sources',
  },
  /** Said in place of a part the caller's scopes do not reach. */
  notAvailable: (what: string): string => `${what} is not available to you`,
  requiresScope: (scope: string, action: string): string => `Requires ${scope} to ${action}.`,
  loading: {
    operations: 'Loading the operation catalog',
    discovery: 'Loading the discovery document',
    diagnostics: 'Loading the diagnostics',
    refreshSources: 'Loading the refresh sources',
    mcp: 'Loading the MCP discovery document',
  },
  operations: {
    searchLabel: 'Search operations',
    searchPlaceholder: 'Search operations…',
    noMatchTitle: 'No operations match',
    noMatchDescription: (search: string) => `No operation matches "${search}".`,
    clearSearch: 'Show all operations',
  },
  discovery: {
    documentLabel: 'Discovery document',
    rawJson: 'Raw JSON',
    emptyTitle: 'This document lists nothing',
    emptyDescription: 'The server returned the document with no entries to show.',
    scopeNote:
      "These documents don't list the scope each operation needs yet. Your scopes shows what each granted scope unlocks.",
  },
  mcp: {
    unavailableTitle: "MCP discovery isn't available",
    unavailableDescription:
      "This server has no public origin or trusted hosts configured, so it can't safely give out absolute discovery addresses. Set one in the server's configuration to turn it on.",
  },
  sources: {
    noRegistryTitle: 'No workflow types are registered',
    noRegistryDescription:
      'No eagerly registered workflow or activity definitions appear in this server. Dynamic sources never appear here; they are listed above.',
    noActivitiesTitle: 'No activities are registered',
    noActivitiesDescription: 'No activity definitions are registered with this server.',
    staleRegistry: 'Refresh failed. Showing the last registry snapshot.',
    loadingRegistry: 'Loading the registry',
    loadingSources: 'Loading the registered sources',
    sourceListEmptyTitle: 'No dynamic sources registered',
    sourceListEmptyDescription: 'This server has no registered dynamic workflow sources to select.',
    sourcePageEmptyTitle: 'No sources on this page',
    sourcePageEmptyDescription: 'Go back to the previous page or use the manual lookup below.',
    previousPage: 'Previous page',
  },
} as const;

/**
 * The words of Settings › Models: the providers agents call, the models those providers offer, and
 * the models that answer decisions (`routes/settings/models`).
 */
export const MODELS_COPY = {
  title: 'Models',
  intro:
    'Connect the providers your agents call, choose which of their models are on, and set how decisions are made.',
  loading: 'Loading providers and models',
  /** The notice shown when a page sent the person here to connect a provider, with the way back. */
  returnNotice: {
    title: 'Connect a provider to continue',
    description: 'Save a key for one provider, then go back to the agent form.',
    connectedDescription: 'A provider is connected. Go back to the agent form.',
    action: 'Back to the agent form',
  },
  loadFailed: {
    title: 'Providers are unavailable',
    description: 'The host did not answer. Check that it is running, then try again.',
  },
  /** The names of the providers the host can call. A provider not listed here shows its own name. */
  providerNames: { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini' } as Readonly<
    Record<string, string>
  >,
  locked:
    'This host keeps its providers and keys in its deployment, so they cannot be changed here.',
  providers: {
    heading: 'Providers',
    description: 'A provider is connected once its API key is saved on this machine.',
    listLabel: 'Providers',
    connected: 'Connected',
    /** A provider whose plugin is waiting for its key (`needs-setup` in `GET /host/plugins`). */
    needsSetup: 'Needs setup',
    pluginLink: (name: string): string => `Open the ${name} plugin`,
    connect: 'Connect',
    manage: 'Manage',
    connectLabel: (name: string): string => `Connect ${name}`,
    manageLabel: (name: string): string => `Manage ${name}`,
    disconnect: 'Disconnect',
    disconnectLabel: (name: string): string => `Disconnect ${name}`,
    reload: 'Reload from files',
    reloaded: 'Providers read again from the configuration file',
    reloadFailed: 'The configuration could not be read again',
    modelCount: (count: number): string => `${String(count)} ${count === 1 ? 'model' : 'models'}`,
  },
  connectDialog: {
    connectTitle: (name: string): string => `Connect ${name}`,
    manageTitle: (name: string): string => `Manage ${name}`,
    description: (name: string): string =>
      `Saving a key connects ${name} and adds its models without a restart. The key is kept in a file only you can read, and it is never shown again.`,
    keyLabel: 'API key',
    keyDescription: 'Paste the key from the provider. Saving again replaces the key in use.',
    keyRequired: 'Enter the key.',
    connect: 'Connect',
    replace: 'Replace key',
    cancel: 'Cancel',
    connectedToast: (name: string): string => `${name} connected`,
    replacedToast: (name: string): string => `${name} key replaced`,
    failed: 'The key could not be saved.',
    locked: 'This host keeps its keys in its deployment, so it cannot save one.',
    partial: 'The key was stored, but the configuration could not be written.',
  },
  disconnectDialog: {
    title: (name: string): string => `Disconnect ${name}`,
    description: (name: string): string =>
      `Disconnecting removes the saved ${name} key from this machine and takes its models out of the catalog. Connect it again with a key to bring them back.`,
    checking: (name: string): string => `Looking for agents that use ${name} models`,
    invalidHeading: (name: string, count: number): string =>
      `${String(count)} ${count === 1 ? 'agent has' : 'agents have'} a ${name} model as ${count === 1 ? 'its' : 'their'} default`,
    invalidConsequence:
      'Without the provider, they become invalid and move to the Invalid list on the Agents page until you connect it again or give them another default model.',
    trimmedHeading: (name: string, count: number): string =>
      `${String(count)} ${count === 1 ? 'agent lists' : 'agents list'} ${name} models to switch to`,
    trimmedConsequence:
      'They stay ready and lose those models from the ones they can be switched to.',
    embedderNote:
      'If a memory embedder from this provider is selected, memory needs setup again until you connect it or choose another.',
    noAgents: (name: string): string => `No agent names a ${name} model.`,
    agentsUnknown: (name: string): string =>
      `The agents could not be read, so which ones use ${name} models is not known.`,
    confirm: 'Disconnect',
    cancel: 'Cancel',
    toast: (name: string): string => `${name} disconnected`,
    failed: 'The key could not be removed.',
    locked: 'This host keeps its keys in its deployment, so it cannot remove one.',
  },
  models: {
    heading: 'Models',
    description:
      'Every model your connected providers offer. Turn one off to keep it from agents and plans, or correct what a row says.',
    tableLabel: 'Models',
    columns: {
      model: 'Model',
      context: 'Context',
      abilities: 'Abilities',
      price: 'Price per million tokens',
      on: 'On',
      actions: 'Actions',
    },
    onLabel: (model: string): string => `${model} is on`,
    abilities: {
      tools: 'Tools',
      images: 'Images',
      structuredOutput: 'Structured output',
    },
    noAbilities: 'Text only',
    noPrice: 'No price',
    price: (input: string, output: string): string => `${input} in, ${output} out`,
    contextTokens: (count: string): string => `${count} tokens`,
    added: 'Added',
    edit: 'Edit',
    editLabel: (model: string): string => `Edit ${model}`,
    add: 'Add a model',
    save: 'Save models',
    discard: 'Discard model changes',
    saved: 'Models saved',
    unsaved: 'You have unsaved changes to the models.',
    saveFailed: 'The models were not saved',
    /** The catalog changed under a working copy: another tab saved, or the files were edited and read again. */
    changedElsewhere: {
      title: 'The models changed while you were editing',
      description:
        'Another tab, or a change to the configuration file, changed them. Reload to see what they are now. Reloading discards your changes, and saving them would overwrite the change, so Save is held until you reload.',
      action: 'Reload models',
    },
    empty: {
      title: 'No models yet',
      description: 'Connect a provider and the models it offers appear here.',
      action: 'Connect a provider',
    },
  },
  rowDialog: {
    editTitle: (model: string): string => `Edit ${model}`,
    addTitle: 'Add a model',
    addDescription:
      'Add a model the built-in list lacks. It copies the abilities of the model you base it on.',
    provider: 'Provider',
    model: 'Model name',
    modelDescription: 'The name the provider calls it.',
    basedOn: 'Based on',
    basedOnDescription: 'A model of the same provider with the same abilities.',
    contextWindow: 'Context window (tokens)',
    maxOutput: 'Largest answer (tokens)',
    inputPrice: 'Input price per million tokens',
    outputPrice: 'Output price per million tokens',
    apply: 'Apply',
    add: 'Add model',
    cancel: 'Cancel',
    modelRequired: 'Enter the model name.',
    modelExists: 'That provider already lists this model.',
    modelNotAllowed: 'That provider’s model list in the configuration does not include this model.',
    basedOnRequired: 'Choose the model it is based on.',
    wholeNumber: 'Enter a whole number above zero.',
    price: 'Enter a price that is not negative.',
    outputTooLarge: 'The largest answer cannot be bigger than the context window.',
  },
} as const;

/**
 * The words of Settings › Plugins: what Interborough loaded at startup, what each plugin adds and
 * what names it, the choices an owner makes (enabled, configuration, secrets), and the restart that
 * applies them (`routes/settings/plugins`).
 */
export const PLUGINS_COPY = {
  title: 'Plugins',
  intro:
    'What Interborough loaded at startup and what each plugin adds. Plugin code loads when Interborough starts, so most changes wait for a restart.',
  loading: 'Loading plugins',
  loadFailed: {
    title: 'Plugins are unavailable',
    description: 'The host did not answer. Check that it is running, then try again.',
  },
  locked:
    'This host keeps its plugin choices and secrets in its deployment, so they cannot be changed here.',
  listLabel: 'Plugins',
  detailLabel: 'Plugin details',
  count: (total: number): string => `${String(total)} ${total === 1 ? 'plugin' : 'plugins'}`,
  empty: {
    title: 'No plugins loaded',
    description:
      'Interborough loads plugins from the packages its host lists and from the plugins folder in its home, when it starts.',
  },
  emptyDetail: {
    title: 'Pick a plugin',
    description: 'Its status, what it adds and its choices show here.',
  },
  alwaysOn: 'Always on',
  enabled: 'Enabled',
  status: {
    running: 'Running',
    needsSetup: 'Needs setup',
    disabled: 'Disabled',
    notLoaded: 'Not loaded',
    enabledAfterRestart: 'Enabled after restart',
    disabledAfterRestart: 'Disabled after restart',
    changesAfterRestart: 'Changes after restart',
  },
  source: { package: 'Package', folder: 'Folder', builtIn: 'Built in' },
  sourceKind: {
    package: 'Workspace package',
    folder: 'Folder plugin, loaded at startup',
    builtIn: 'Part of Interborough',
  },
  sections: {
    source: 'Source',
    kind: 'Kind',
    adds: 'What it adds',
    nothingAdded: 'Nothing while it is not running.',
    configuration: 'Configuration',
    secrets: 'Secrets',
    inUse: 'In use',
  },
  contributionKinds: {
    tool: 'Tools',
    activity: 'Activities',
    'trigger-kind': 'Triggers',
    validator: 'Validators',
    guardrail: 'Guardrails',
    'run-hooks': 'Run hooks',
    'decision-router': 'Decision routing',
    'hook-action': 'Hook actions',
    provider: 'Model provider',
    embedder: 'Embeddings',
    'memory-detector': 'Memory detectors',
    'eval-judge': 'Evaluation judges',
    'mcp-app': 'MCP apps',
    'event-formatter': 'Event formatters',
    'code-agent': 'Code agents',
  } as Readonly<Record<string, string>>,
  configuration: {
    label: (name: string): string => `Configuration of ${name}`,
    description:
      'The plugin’s own choices, as JSON. The host checks them when it starts, and a plugin that refuses them is not loaded.',
    invalid: 'This is not valid JSON, so it cannot be applied.',
    notAnObject: 'The configuration is an object, such as {}.',
    rejected: (plugin: string, field: string, message: string): string =>
      `The host rejected ${field === '' ? 'the change' : field} for ${plugin}.${message === '' ? '' : ` ${message}`}`,
  },
  secrets: {
    set: 'Set',
    missing: 'Missing',
    add: 'Add',
    replace: 'Replace',
    addLabel: (key: string): string => `Add ${key}`,
    replaceLabel: (key: string): string => `Replace ${key}`,
    dialog: {
      title: (key: string): string => `Save ${key}`,
      description: (plugin: string): string =>
        `The value is stored on this machine, where only you can read it, and ${plugin} uses it at once. No restart is needed.`,
      valueLabel: 'Value',
      valueDescription: 'It is sent once and is never shown again.',
      valueRequired: 'Enter a value to save.',
      cancel: 'Cancel',
      save: 'Save',
      saved: (key: string): string => `${key} saved`,
      locked: 'This host keeps its secrets in its deployment, so one cannot be saved here.',
      failed: 'The secret could not be saved.',
    },
  },
  inUse: {
    disabled: 'Nothing while it is disabled.',
    notRunning: 'Nothing while it is not loaded.',
    nothing: 'Nothing names what it adds yet.',
    some: (parts: readonly string[]): string => `${parts.join(', ')} name what it adds.`,
  },
  counts: {
    agents: (count: number): string => `${String(count)} ${count === 1 ? 'agent' : 'agents'}`,
    schedules: (count: number): string =>
      `${String(count)} ${count === 1 ? 'schedule' : 'schedules'}`,
    waitingRuns: (count: number): string =>
      `${String(count)} waiting ${count === 1 ? 'run' : 'runs'}`,
  },
  banner: {
    changes: (count: number): string =>
      count === 1
        ? '1 change waits for a restart.'
        : `${String(count)} changes wait for a restart.`,
    explanation: 'Plugin code loads when Interborough starts. Runs pick up where they stopped.',
    discard: 'Discard',
    restartNow: 'Restart now',
    invalid: 'Fix the configuration that is not valid before restarting.',
    failed: 'The changes could not be saved, so Interborough was not restarted.',
    rejected: (plugin: string): string =>
      `${plugin} was not saved, so Interborough was not restarted. Open it to see what the host rejected.`,
    saved: 'Saved. The host applied these changes at once, so no restart was needed.',
    refused: 'This host cannot restart itself. Restart it where it runs.',
    unreachable: 'Interborough did not answer, so it was not asked to restart. Try again.',
  },
  disable: {
    title: (name: string): string => `Disable ${name}?`,
    intro: 'Interborough restarts to unload it. These depend on it now:',
    nothing: 'Nothing depends on it now.',
    agents: (count: number, ids: string): string =>
      count === 1 ? `uses ${ids} and shows as unavailable.` : `use ${ids} and show as unavailable.`,
    schedules: (count: number, ids: string): string =>
      `${count === 1 ? 'starts' : 'start'} runs through ${ids}. ${count === 1 ? 'It stays' : 'They stay'} listed and ${count === 1 ? 'does' : 'do'} nothing until it is back.`,
    waitingRuns: (count: number, ids: string): string =>
      count === 1
        ? `waits on ${ids}. It shows as unavailable instead of resuming.`
        : `wait on ${ids}. They show as unavailable instead of resuming.`,
    alsoWrites: 'Restarting also saves these changes, which are waiting:',
    alsoSwitchedOn: 'switched on',
    alsoSwitchedOff: 'switched off',
    alsoConfiguration: 'configuration edited',
    reassurance: 'Nothing is deleted. Enable it again and restart, and it works as before.',
    cancel: 'Cancel',
    confirm: 'Disable and restart',
  },
  restart: {
    title: 'Restarting Interborough',
    steps: {
      saving: 'Saving your changes',
      requesting: 'Asking Interborough to restart',
      stopping: 'Waiting for it to stop',
      starting: 'Waiting for it to start again',
    },
    back: {
      title: 'Interborough is back up',
      summary: (running: number, needSetup: number, disabled: number): string => {
        const parts = [`${String(running)} ${running === 1 ? 'plugin' : 'plugins'} running`];
        if (needSetup > 0)
          parts.push(`${String(needSetup)} ${needSetup === 1 ? 'needs' : 'need'} setup`);
        if (disabled > 0) parts.push(`${String(disabled)} disabled`);
        return `${parts.join(', ')}.`;
      },
      close: 'Close',
    },
    unconfirmed: {
      title: 'Interborough has not restarted',
      description:
        'The host is still answering with the old plugins loaded. It may not be supervised, so restart it where it runs.',
      close: 'Close',
    },
  },
  /**
   * One card per problem code (COR-1895). The table of the first six is the owner's wording
   * (Interborough plugins, boards 26–28); the cards after `developmentSource` are for codes the
   * host added later, in the same voice. A body is a function of the fields its code carries.
   */
  problems: {
    title: 'Needs attention',
    unknown: (code: string): string => `Reported as ${code}.`,
    /** The status of a problem whose code this page has no words for. */
    unknownStatus: 'Not recognised',
    secretMissing: {
      status: 'Needs setup',
      title: 'A secret isn’t saved yet',
      body: (key: string, what: string): string =>
        `${key} isn’t saved, so ${what} is unavailable. Save it and it works at once; no restart.`,
      /** The body when the host lists nothing that waits for the secret. */
      bodyWithoutContributions: (key: string): string =>
        `${key} isn’t saved, so what this plugin adds is unavailable. Save it and it works at once; no restart.`,
      action: 'Add the key',
    },
    configurationInvalid: {
      status: 'Not loaded',
      title: 'A setting is invalid',
      body: (field: string, message: string): string =>
        field === '' ? message : `${field}: ${message}`,
      action: 'Fix the setting',
    },
    /** A provider plugin's `models` allowlist names a model nobody offers: `configuration-invalid` at `models[<index>]`. */
    allowlistInvalid: {
      status: 'Not loaded',
      title: 'A model list names a model nobody offers',
      action: 'Fix the setting',
    },
    referenceUnresolved: {
      status: 'Loaded, 1 file skipped',
      title: 'An agent names something nobody adds',
      body: (file: string, id: string): string =>
        `${file} lists ${id}, which no loaded plugin adds. The agent is unavailable until the name matches.`,
      action: 'Open the file',
    },
    nameClash: {
      status: 'Not loaded',
      title: 'Two plugins share a name',
      body: (first: string, second: string, name: string, loaded: string): string =>
        `${first} and ${second} are both named ${name}. ${loaded} loaded; rename the other.`,
      action: 'Show both',
    },
    pinnedVersionUnavailable: {
      status: 'After a restart',
      title: 'A waiting run needs a version that isn’t loaded',
      body: (id: string, version: string, runs: number): string =>
        runs === 1
          ? `1 waiting run is pinned to ${id}@${version}, so it shows as unavailable. Cancel it, or go back to ${version} and restart.`
          : `${String(runs)} waiting runs are pinned to ${id}@${version}, so they show as unavailable. Cancel them, or go back to ${version} and restart.`,
      action: 'Open the run',
    },
    developmentSource: {
      status: 'Development',
      title: 'Loaded from your working copy',
      body: (path: string): string =>
        `Started with --plugin ${path}. Interborough restarts when its code changes; its agents and workflows reload without one.`,
      action: 'Open the folder',
      /** What the page says once it has put the folder’s path on the clipboard: a browser cannot open a folder. */
      copied: 'The folder’s path is copied.',
      copyFailed: 'The folder’s path could not be copied.',
    },
    /** The host refused a secret the plugin declared; the message names the key and never a value. */
    secretRefused: {
      status: 'Not loaded',
      title: 'A secret can’t be kept here',
      body: (key: string, message: string): string =>
        message === '' ? `${key} can’t be used as this plugin’s secret.` : message,
    },
    /** The plugin’s code did not load from its folder, such as an import nothing provides. */
    loadFailed: {
      status: 'Not loaded',
      title: 'The plugin’s code didn’t load',
      body: (message: string): string => message,
    },
    /** The plugin’s `setup` threw, or returned something that cannot be registered. */
    setupFailed: {
      status: 'Not loaded',
      title: 'The plugin’s setup failed',
      body: (message: string): string => message,
    },
    /** The plugin’s `afterStart` threw; what it adds stays registered. */
    afterStartFailed: {
      status: 'Loaded, a step after startup failed',
      title: 'A step after startup failed',
      body: (message: string): string => message,
    },
    /** A page the plugin contributed could not be built; the plugin and its other parts run. */
    mcpAppFailed: {
      status: 'Loaded, a page was not built',
      title: 'A page the plugin adds did not build',
      body: (app: string, message: string): string => `The page ${app} is not served. ${message}`,
    },
  },
  /** The banner every page shows after a startup where a plugin or a folder did not load. */
  startupBanner: {
    /** The accessible name of the region. */
    label: 'Plugins that did not load',
    message: (count: number): string =>
      count === 1
        ? '1 plugin didn’t load at startup. Agents and workflows that use it show as unavailable.'
        : `${String(count)} plugins didn’t load at startup. Agents and workflows that use them show as unavailable.`,
    action: 'Open Plugins',
  },
  unloaded: {
    heading: 'Folders that did not load',
    description: 'These folders hold no plugin Interborough could use.',
  },
} as const;

/** The words of the diagnostics the Health page carries below the engine overview. */
export const HEALTH_DIAGNOSTICS_COPY = {
  title: 'Diagnostics',
  sections: 'Diagnostic sections',
} as const;

/** The words of the Health overview: its health line, its four counts, and the recent-activity window. */
export const HEALTH_OVERVIEW_COPY = {
  /** The accessible name of the four counts. */
  countsLabel: 'Health counts',
  workingNow: 'Working now',
  needsYou: 'Needs you',
  failedIn24Hours: 'Failed in 24h',
  schedules: 'Schedules',
  /** The value of a count that could not be read. */
  unavailable: '—',
  /** The health line when nothing needs attention. */
  allClear: 'All clear. Nothing needs attention.',
  /**
   * The health line when a read it depends on failed and nothing it could read needs attention:
   * the line cannot say all is clear about what it never saw.
   */
  lineUnavailable:
    'Health could not be fully read. Nothing was reported, but that is not all clear.',
  /** The note beside the chips when one of the line's reads failed. */
  lineReadFailed: 'Some checks could not be read',
  /** The health line when something does: how many things, and each one below it. */
  needsAttention: (count: number): string =>
    count === 1 ? '1 thing needs attention' : `${String(count)} things need attention`,
  activity: {
    title: 'Recent activity',
    /** What the empty window says: the engine has not reported anything yet. */
    emptyTitle: 'Nothing has happened yet',
    emptyDescription: 'Events from runs, schedules and reviews appear here as they happen.',
    /** The footer link to the whole trail. */
    auditLink: 'Open the audit log',
    /** The accessible name of the live window. */
    windowLabel: 'Recent activity. Updates pause while you are reading.',
    /** A line that stands for several in a row, such as `Workflow completed ×3`. */
    repeated: (title: string, count: number): string => `${title} ×${String(count)}`,
  },
} as const;

/** The words of Settings › Model policy: which models may be used, and the caller's own preferences. */
export const MODEL_POLICY_COPY = {
  intro:
    'Choose which providers and models agents may use. Everything not ruled out here stays allowed.',
  allowedModels: {
    title: 'Allowed models',
    description:
      'Nothing listed here can be used by any agent or plan, whoever starts it. Leave a list empty to allow everything in it.',
  },
  yourPreferences: {
    title: 'Your preferences',
    description:
      'What your own chats and plans should choose from, among what is allowed above. Anything left empty makes no choice for you.',
  },
  lockedNote: 'The host sets the model policy, and it cannot be changed here.',
  /** Said under a list of providers when a name is not the form a provider takes. */
  providerName: 'A provider is lowercase letters, numbers and hyphens, such as anthropic.',
  /** Said while a list holds text that has not been added, which Save would leave out. */
  pendingEntry: 'Press Enter to add the text you typed to its list, or clear it, before saving.',
  notRequired: 'Not required',
  noPreference: 'No preference',
  fields: {
    deniedProviders: 'Providers not allowed',
    deniedModels: 'Models not allowed',
    deniedRoutes: 'Routes not allowed',
    deniedRegions: 'Regions not allowed',
    requireDataPolicy: 'Data retention required',
    allowedProviders: 'Only these providers',
    preferredDeniedProviders: 'Never these providers',
    allowedModels: 'Only these models',
    preferredDeniedModels: 'Never these models',
    dataPolicy: 'Data retention',
    defaultEffort: 'Default effort',
    costPreference: 'Cost',
    latencyPreference: 'Speed',
    effortFallbackMode: 'When the effort is not available',
  },
  options: {
    dataPolicy: {
      'no-retention': 'No retention',
      'zero-day-retention': 'Zero-day retention',
      standard: 'Standard',
    },
    effort: { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' },
    cost: { 'lowest-cost': 'Lowest cost', balanced: 'Balanced', 'no-preference': 'No preference' },
    latency: {
      'lowest-latency': 'Fastest',
      balanced: 'Balanced',
      'no-preference': 'No preference',
    },
    effortFallback: { reject: 'Refuse the request', degrade: 'Use a lower effort' },
  },
} as const;

/** The words the settings page (`/settings`) uses outside its view states. */
export const SETTINGS_COPY = {
  /** What the A2A section asks before it saves. */
  confirmA2a: {
    title: 'Save the A2A settings?',
    description:
      'Push notifications make this host send requests to servers other people run. The change applies when the host restarts.',
    confirm: 'Save settings',
  },
  intro:
    'These apply to the whole deployment. A setting that applies live takes effect at its next use, and one that needs a restart is kept and applies when the host starts again.',
  /** The accessible name of the form that holds every setting. */
  formLabel: 'Settings',
  saveAction: 'Save changes',
  discardAction: 'Discard changes',
  reloadAction: 'Reload settings',
  /** The words under a switch or a field whose key has no value, so the code default applies. */
  unset: 'Not set. The code default applies.',
  /** What a setting with no value reads, and the option of a select that chooses none. */
  notSet: 'Not set',
  /** Reveals the fields of a setting that has no value. */
  setAction: 'Set a value',
  /** Puts a setting whose fields were revealed back to having no value, before it is saved. */
  unsetAction: 'Not set',
  /** The label of the JSON editor under a switch whose options are free-form JSON. */
  optionsLabel: 'Options (JSON)',
  /** Only a setting that needs a restart says how it applies; a live one says nothing. */
  apply: { restart: 'Needs a restart' },
  /** The heading of the settings shortcuts in the `?` map. */
  shortcutGroup: 'Settings',
  /** What the Bureau refused about a value, when it names nothing. */
  invalidValue: 'This value is not one the setting takes.',
  /** The page-level summary of the settings that wait for the host to start again. */
  restartSummary: (keys: readonly string[]): string =>
    keys.length === 1
      ? `1 setting applies when the host starts again: ${keys.join(', ')}.`
      : `${String(keys.length)} settings apply when the host starts again: ${keys.join(', ')}.`,
  pendingRestart: 'Restart pending',
  locked: 'Locked',
  /** Why a locked key cannot be changed, by the reason the Bureau reports. */
  lockedNote: {
    deployment: 'The deployment sets this one, and it cannot be changed here.',
    'shared-storage':
      'Every host on this shared storage has to run the same value, so it is set by the deployment and cannot be changed here.',
  },
  notPersisted:
    'This server does not keep its settings. They go back to the code defaults when the host stops.',
  saved: {
    title: 'Settings saved',
    description: 'The changes apply live where a setting allows it.',
  },
  /** A save the Bureau refused because the settings changed since the page read them. */
  stale: {
    title: 'The settings changed since you loaded them',
    description:
      'Someone or something changed them after this page read them, so nothing was saved. Reload to see what they are now. Reloading discards your changes.',
  },
  /** The page found the settings changed while it held edits. */
  changedElsewhere: {
    title: 'The settings changed while you were editing',
    description:
      'Reload to see what they are now. Reloading discards your changes, and saving them first would overwrite the change.',
  },
  /** The settings could not be read again while the page already holds them. */
  refreshFailed: {
    title: 'The settings could not be refreshed',
    description: 'What you see may be out of date. Your edits are kept.',
  },
  saveFailed: 'The settings were not saved',
  forbidden: 'You may read the settings but not change them.',
  hostPaths: {
    title: 'Where the host keeps its files',
    description: 'These are set by the host and cannot be changed here.',
    agents: 'Agent files',
    workflows: 'Workflow files',
    configuration: 'Configuration file',
    providers: 'Provider key files',
    unavailable: 'The host did not say where it keeps its files.',
  },
  /** The words that differ when the host keeps its state in a bucket (`mode: 'remote'`). */
  remote: {
    hostPaths: {
      title: 'Where the host keeps its state',
      agents: 'Agents',
      workflows: 'Workflows',
      configuration: 'Configuration',
      providers: 'Provider key variables',
    },
  },
} as const;

/** The words the goals (`/goals`) use outside its view states. */
export const GOALS_COPY = {
  newAction: 'New goal',
  loadMore: 'Load more',
  /** The accessible name of the filter bar. */
  filtersLabel: 'Filter goals',
  anyStatus: 'Any status',
  anyAgent: 'Any agent',
  clearAction: 'Clear filters',
  /** How many goals the page lists, as a sentence. */
  count: (count: number): string => `${String(count)} ${count === 1 ? 'goal' : 'goals'}`,
  /** A filter that matches none of the goals read. */
  noMatch: {
    title: 'No goal matches these filters',
    description: 'Change the filters to see more goals.',
  },
  /** The goal's own page, which lists its attempts. */
  detail: {
    title: (id: string): string => `Goal ${id}`,
    backToList: 'All goals',
    agentFact: 'Agent',
    statusFact: 'Status',
    attemptsFact: 'Attempts',
    createdFact: 'Created',
    updatedFact: 'Updated',
    endedFact: 'Ended',
    reasonFact: 'Why it ended',
    attemptsHeading: 'Attempts',
    attemptsCaption: 'Attempts of this goal, in the order they ran',
    noAttempts: {
      title: 'No attempts yet',
      description: 'The goal has not started an attempt. Its attempts are listed here as they run.',
    },
    attemptColumn: 'Attempt',
    runColumn: 'Run',
    statusColumn: 'Status',
    startedColumn: 'Started',
    tookColumn: 'Took',
    finishColumn: 'Finish reason',
    attemptLabel: (index: number): string => `Attempt ${String(index + 1)}`,
    loadFailed: {
      title: 'The goal could not be loaded',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
  },
  /** The caption of the table. */
  caption: 'Goals, oldest first',
  goalColumn: 'Goal',
  agentColumn: 'Agent',
  statusColumn: 'Status',
  attemptsColumn: 'Attempts',
  createdColumn: 'Created',
  actionsColumn: 'Actions',
  /** The words for attempts used, of the most the goal may make. */
  attempts: (used: number, most: number): string => `${String(used)} of ${String(most)}`,
  cancelAction: 'Cancel',
  /** A goal that has been asked to stop, and has not yet. */
  cancelRequested: 'Cancel requested',
  cancelDialog: {
    title: 'Cancel this goal?',
    description: (id: string): string =>
      `“${id}” stops: its controller and its attempt’s run are stopped, and it ends as canceled. This can’t be undone.`,
    confirm: 'Cancel goal',
  },
  cancelFailed: 'The goal was not cancelled',
  /** The Bureau answered a cancel with how far it got. */
  cancelPending: 'The cancellation is recorded and will finish. The goal ends as canceled.',
  form: {
    title: 'New goal',
    description: 'Run an agent on a prompt until a validator passes, within the bounds you set.',
    agentLabel: 'Agent',
    agentPlaceholder: 'Choose an agent',
    agentDescription: 'The agent that runs each attempt.',
    agentUnavailableDescription: 'The agents could not be listed. Reload the page to try again.',
    noAgents: {
      title: 'No agents to run a goal',
      description: 'A goal runs an agent, and this installation lists none. Create an agent first.',
    },
    promptLabel: 'Prompt',
    promptDescription:
      'What the agent is asked to do. The goal runs it until the validator passes.',
    identityNameLabel: 'Identity name',
    identityVersionLabel: 'Identity version',
    identityDescription: 'Names this goal, with a version, for the people who read about it.',
    validatorNameLabel: 'Validator name',
    validatorVersionLabel: 'Validator version',
    validatorDescription:
      'The exact name and version of a validator this server was configured with. One it lacks is refused.',
    maximumAttemptsLabel: 'Maximum attempts',
    maximumAttemptsDescription: 'The most attempts the goal makes before it ends as exhausted.',
    maximumAttemptsInvalid: 'Enter a whole number of attempts, one or more.',
    maximumTotalStepsLabel: 'Maximum total steps',
    maximumTotalStepsDescription:
      'The most steps the goal takes across all its attempts. Interborough needs a bound on the attempts together, and this is it.',
    maximumTotalStepsInvalid: 'Enter a whole number of steps, one or more.',
    createAction: 'Create goal',
    cancelAction: 'Cancel',
    /** What Cancel is called once the goal exists, so there is nothing left to cancel. */
    closeAction: 'Close',
    failed: 'The goal was not created',
    /** The goal was committed, and the Bureau could not start its controller: it stays pending until recovery. */
    startFailedTitle: 'Goal created, but it did not start',
    startFailedGoal: (id: string): string => `Goal ${id}`,
  },
} as const;

/** The words the audit trail (`/health/audit`) uses outside its view states. */
export const AUDIT_COPY = {
  /** The line under the page's title. */
  description: 'Who changed what, and when.',
  /** The accessible name of the search form. */
  searchLabel: 'Search the audit trail',
  sinceLabel: 'Since',
  /** Shown in the time field while it is empty, so the field names what it narrows without a label above it. */
  sincePlaceholder: 'Any time',
  typeLabel: 'Type',
  /** The select's first option: no narrowing by type. */
  anyType: 'Any type',
  /** The select's last option, which brings a field for a type the trail has not shown yet. */
  otherType: 'Other…',
  otherTypeLabel: 'Other type',
  otherTypePlaceholder: 'Type, such as run.completed',
  resourceLabel: 'Resource',
  /** The first option of the resource picker: no narrowing by what a record is about. */
  anyResource: 'Any resource',
  resourceIdLabel: 'Resource ID',
  resourceIdPlaceholder: 'ID',
  searchAction: 'Search',
  clearAction: 'Clear',
  loadMore: 'Load more',
  /** The name of the list of records, which also says how it is ordered. */
  caption: 'Audit records, oldest first',
  /** The name of the open record's pane. */
  detailLabel: 'Record',
  whoLabel: 'Who',
  /** The Who select's first option: no narrowing by actor. */
  anyone: 'Anyone',
  noActor: 'None',
  /** The small heading above a record's raw JSON. */
  rawRecord: 'Raw record',
  emptyDetailTitle: 'Choose a record',
  emptyDetailDescription: 'Pick one from the list to see what changed, who did it, and when.',
  /** How many records are loaded, as a sentence. */
  count: (count: number, more: boolean): string =>
    `${String(count)} ${count === 1 ? 'record' : 'records'}${more ? ' so far' : ''}`,
  /** The facts of one record. */
  fact: {
    what: 'What',
    when: 'When',
    who: 'Who',
    about: 'About',
    details: 'Details',
    before: 'Before',
    after: 'After',
    beforeAfter: 'Before and after',
  },
  /** The link to the thing a record is about. */
  openResource: (resource: string): string => `Open ${resource}`,
  exportAction: 'Export JSON Lines',
  exporting: 'Exporting…',
  exported: (count: number): string =>
    `Exported ${String(count)} ${count === 1 ? 'record' : 'records'}`,
  nothingToExport: 'There is nothing to export for these filters.',
  exportFailed: {
    title: 'The export failed',
    description:
      'The server did not answer. Check that the host is running, then try the export again.',
  },
  loadingLabel: 'Loading the audit log',
  noMatches: {
    title: 'No records match',
    description: 'Nothing in the trail matches this search. Change or clear a filter to see more.',
    clear: 'Clear filters',
  },
  /** An address that names a record the page could not show: the bounded read of the trail did not reach it. */
  recordNotFound: {
    more: 'That record was not found in the recent trail. Load more to keep looking.',
    end: 'That record is not in the trail.',
  },
  /** A list with more pages to read, where none of the records read so far matches the search. */
  noLoadedMatches: {
    title: 'No loaded record matches',
    description:
      'None of the records read so far matches this search, and the trail has more. Load more to keep looking, or change or clear a filter.',
    clear: 'Clear filters',
  },
  failed: {
    title: 'The search failed',
    description:
      'The server did not answer this search. Check that the host is running, then try again.',
  },
} as const;

/**
 * The words the agent list and an agent's page use for what an agent is and has: its model, its
 * tools, and how much it has been used. Where an agent is defined is a fact for the developer, so
 * it is not worded.
 */
export const AGENTS_COPY = {
  modelLabel: 'Model',
  toolsLabel: 'Tools',
  skillsLabel: 'Skills',
  noTools: 'No tools',
  toolCount: (count: number): string => (count === 1 ? '1 tool' : `${count} tools`),
  chatCount: (count: number): string => (count === 1 ? '1 chat' : `${count} chats`),
  noChats: 'No chats yet',
  /** The marker on an agent with a chat that waits on the person. */
  needsYou: 'Needs you',
  /** How many agents the page lists, as a sentence. */
  count: (count: number): string => `${String(count)} ${count === 1 ? 'agent' : 'agents'}`,
  filtersLabel: 'Filter agents',
  searchLabel: 'Search agents',
  searchPlaceholder: 'Search agents',
  clearAction: 'Clear filters',
  noMatch: {
    title: 'No agent matches this search',
    description: 'Change the search to see more agents.',
  },
  empty: {
    title: 'No agents yet',
    description: 'An agent is a model with instructions and tools. Create one to chat with it.',
  },
  /** The accessible name of the list of agent files the Bureau cannot use. */
  invalidListLabel: 'Agent files with a problem',
  lastChat: (when: string): string => `Last chat ${when}`,
  /** The Memory action with the agent's memory count; `more` is true when pages of it are unread. */
  memoryWithCount: (shown: number, more: boolean): string => `Memory (${shown}${more ? '+' : ''})`,
  fileVersion: 'File version',
  history: 'History',
} as const;

/** The words of an agent's page: its tabs, the controls over its chats, its instructions and its settings. */
export const AGENT_PAGE_COPY = {
  tabsLabel: 'Sections of this agent',
  tabs: { chats: 'Chats', instructions: 'Instructions', access: 'Access', settings: 'Settings' },
  chats: {
    stateLabel: 'Show chats that are',
    states: { all: 'All', 'needs-you': 'Needs you', running: 'Running' },
    searchLabel: 'Search chats by title',
    searchPlaceholder: 'Search chats',
    startedByLabel: 'Started by',
    startedBy: { any: 'Anyone', chat: 'You', schedule: 'A schedule', goal: 'A goal' },
    sortLabel: 'Sort by',
    sorts: { updated: 'Last activity', newest: 'Newest', oldest: 'Oldest' },
    loadFailed: 'These chats could not be loaded.',
    emptyTitle: 'No chats with this agent yet',
    emptyDescription: 'A chat you start with it is listed here.',
    filteredTitle: 'No chats match',
    filteredDescription: 'None of this agent’s chats match these filters.',
    clearFilters: 'Clear filters',
  },
  /**
   * Duplicate on an agent defined in code or kept in a file: opens the form for a new agent filled
   * from it. The copy is named there, so nothing exists until it is created.
   */
  duplicate: 'Duplicate',
  /** A plugin's agent: read-only, with Duplicate to make a copy the owner can edit (COR-1873). */
  plugin: {
    duplicate: 'Duplicate',
    note: (plugin: string): string =>
      `The ${plugin} plugin ships this agent, so it is read-only. Duplicate it to make a copy you can edit.`,
    exists: (name: string): string =>
      `You already have an agent named ${name}. Open it, or rename or delete it to duplicate this one again.`,
    notLoaded: 'This agent is not loaded now, so it cannot be duplicated.',
    forbidden: 'You may not add agents.',
    failed: 'The agent could not be duplicated.',
  },
  instructions: {
    heading: 'Instructions',
    builtIn: 'This agent is built in, so its instructions cannot be edited here.',
    emptyTitle: 'No instructions',
    emptyDescription: 'This agent has no instructions of its own.',
    emptyAction: 'Add instructions',
    referencesHeading: 'Reference documents',
    referencesDescription: 'Documents the agent reads, as paths beside its file.',
    noReferencesTitle: 'No reference documents',
    noReferencesDescription: 'This agent reads no documents besides its instructions.',
    loadFailed: 'The instructions could not be loaded.',
  },
  access: {
    heading: 'Access',
    builtIn: 'This agent is built in, so its access cannot be changed here.',
    loadFailed: 'The access settings could not be loaded.',
    invalid: 'This agent’s file has a problem, so its access cannot be changed until it is fixed.',
    saveAction: 'Save access',
    saveFailed: 'The access settings could not be saved.',
    stale:
      'This agent’s file changed after the page loaded, so nothing was saved. Your unsaved changes are still here; reloading shows the file as it is now and discards them.',
    reload: 'Reload from disk',
    forbidden: 'You may not change this agent.',
    toolsHeading: 'Tools',
    toolsDescription:
      'Allow the tools this agent may call, and choose when each asks you first. A chat’s permission mode can change this: it can ask on every call, refuse tools that change things, or skip the asks On changes would raise.',
    toolCount: (allowed: number, total: number): string =>
      `${String(allowed)} of ${String(total)} allowed`,
    toolsListLabel: 'Tools',
    asksFirstLabel: (tool: string): string => `Asks first for ${tool}`,
    approvals: {
      never: 'Never',
      'on-changes': 'On changes',
      always: 'Always',
      blocked: 'Blocked',
    },
    approvalHints: {
      never: 'Runs without asking, unless the chat’s permission mode or the tool itself asks.',
      'on-changes': 'Asks before it changes something, and runs a read without asking.',
      always: 'Asks before every call.',
      blocked: 'Never runs. The model is told it was refused.',
    },
    /** Under `never`, for a tool that declares no tier: Armorer still asks about a call it cannot classify. */
    neverUnclassifiedHint:
      'This tool declares no tier, so it still asks before every call, even here.',
    notInCatalog: 'Not offered by this host any more',
    noToolsTitle: 'This host offers no tools',
    noToolsDescription: 'Tools come from the host’s plugins and saved tool sources.',
    skillsHeading: 'Skills',
    skillsDescription:
      'Executable skills the host found. Every skill from a trusted source is available to every agent; a skill from a source the host does not trust is refused, and cannot be granted here.',
    skillsListLabel: 'Skills',
    skillsLoadFailed: 'The skills could not be loaded.',
    noSkillsTitle: 'No skills found',
    noSkillsDescription: 'Skills are discovered from the host’s skill sources.',
    noSkillsAction: 'Open skills',
    guardrailsHeading: 'Guardrails',
    guardrailsDescription:
      'Every agent runs the default guardrails: prompt-injection detection on the input and a PII check on the reply. They cannot be turned off. Add plugin guardrails below.',
    budgetsHeading: 'Budgets',
    budgetsDescription:
      'A run that reaches a limit stops, and says which one. Leave a field empty for no limit.',
  },
  settings: {
    heading: 'Settings',
    modelLabel: 'Model',
    modelsLabel: 'Models it can be switched to',
    stepLimitLabel: 'Step limit',
    /** The step limit of an agent whose file sets none: Operative's default applies. */
    stepLimitDefault: (steps: number): string => `Default (${String(steps)} steps)`,
    none: 'No limit',
    notSet: 'Not set',
    builtIn: 'This agent is built in, so its settings cannot be changed here.',
    loadFailed: 'The settings could not be loaded.',
    deleteAction: 'Delete agent',
    deleteFailed: 'The agent could not be deleted.',
    deleteDialog: {
      title: 'Delete this agent?',
      description: (name: string): string =>
        `${name} is removed along with its file. Chats already held with it stay.`,
      confirm: 'Delete',
    },
    stale: 'This agent changed after the page loaded. Reload to see its current settings.',
    forbidden: 'You may not change this agent.',
  },
  versions: {
    heading: 'Versions',
    description:
      'Every save of this agent, newest first. Restoring writes an old version as a new one.',
    revision: (revision: number): string => `Version ${String(revision)}`,
    changed: 'Changed',
    savedByHand: 'Edited in the file',
    firstVersion: 'First version',
    nothingChanged: 'Saved with no change to the settings',
    restoreAction: 'Restore',
    restoreLabel: (revision: number): string => `Restore version ${String(revision)}`,
    current: 'Current',
    restoreFailed: 'That version could not be restored.',
    restoreStale:
      'This agent changed after the page loaded. The versions below are up to date; restore again if you still want that version.',
    loadFailed: 'The versions could not be loaded.',
    emptyTitle: 'No saved versions',
    emptyDescription: 'A version is kept each time this agent is saved.',
  },
} as const;

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
  agentPlaceholder: 'Search agents',
  sessionsTitle: 'Chats',
  /** The headings the list of chats is cut under; "Needs you" is the run states' word for waiting on a person. */
  groups: {
    'needs-you': 'Needs you',
    today: 'Today',
    yesterday: 'Yesterday',
    earlier: 'Earlier',
  },
  /** What the chat says when its live connection to the run could not be restored. */
  disconnected: {
    title: 'Disconnected',
    description: 'The connection to this chat dropped and could not be restored.',
    reconnect: 'Reconnect',
  },
  /** What a new chat shows where its transcript will be. */
  newChatWelcome: {
    /** Said before the name of the agent the chat is with. */
    greeting: 'Chat with',
    /** Said before the agents' identifiers under the welcome of a fresh Interborough. */
    agentsLine: 'Agents:',
    promptsLabel: 'Example prompts',
    otherAgents: 'Or start with another agent',
    chooseAgent: 'Choose an agent to start with',
  },
  /** The chat list beside the open chat. */
  list: {
    /** The accessible name of the pane that holds the open chat. */
    detailLabel: 'Open chat',
    emptyTitle: 'No chats yet',
    emptyDescription: 'A chat you start is listed here.',
    pickTitle: 'Pick a chat',
    pickDescription: 'Choose a chat from the list, or start a new one.',
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
  /** The tool calls of a turn. */
  tools: {
    show: 'Show',
    hide: 'Hide',
    details: 'Details',
    running: 'Running',
    waitingForApproval: 'Waiting for your approval',
    resultPrefix: 'Result:',
    /** A call the person refused reads Denied: it did not fail. */
    denied: 'Denied',
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
    /** The header's summary of the settings. */
    summaryLabel: 'Chat settings',
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
    /** The modes, in the order of how much they ask. */
    permissionOptions: [
      { value: 'always', label: 'Always ask' },
      { value: 'on-changes', label: 'Ask on changes' },
      { value: 'allow-all', label: 'Allow all' },
      { value: 'read-only', label: 'Read-only' },
    ],
    /** What each mode does, as `bureau.contexts.steer` defines it. */
    permissionDescriptions: {
      'on-changes': 'Tools ask as each tool’s own setting says.',
      always: 'Every tool call asks first.',
      'allow-all':
        'Skips the asks that Ask on changes would raise. A tool set to always ask still asks, a tool that declares no setting of its own still asks, a blocked tool is still refused, and a child agent keeps its own stricter mode.',
      'read-only': 'Every tool that is not read-only is denied.',
    },
    /** When a change takes effect. A mode is read at each tool call; the model and effort at each step. */
    applies: {
      step: 'Applies from the run’s next step.',
      toolCall: 'Applies from the run’s next tool call.',
      nextRun: 'Applies to the next run.',
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
  /** Branching a chat from one of an agent's replies. */
  branch: {
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
  gone: {
    title: 'This chat was deleted',
    description: 'It no longer exists, so nothing more can be sent here.',
    back: 'Back to chats',
  },
  /** Editing a message you sent: the chat is branched before it and the edited text is sent there. */
  edit: {
    /** Said when the message follows no finished reply, so there is nowhere to branch before it. */
    unavailable:
      'That message was sent while a run was going, so it cannot be edited. Edit one that follows a finished reply.',
    /** Said when the message carries files, which an edited copy would leave behind. */
    withFiles:
      'That message has files attached, so it cannot be edited. Send a new message instead.',
    /** Any other fault; the chat the person is in is untouched. */
    fault: 'The message could not be edited. You are still in this chat.',
    /** Heads the edited text kept after an edit that did not branch. */
    kept: 'Your edited text is kept here:',
    copy: 'Copy text',
    copied: 'Copied.',
    copyFailed: 'The text could not be copied. Select it and copy it by hand.',
    tryAgain: 'Try again',
  },
  /** The names of the files a row carries: attached by the person, or returned by the agent. */
  assets: {
    listLabel: 'Files',
    image: (position: number) => `Image ${position}`,
    audio: (position: number) => `Audio ${position}`,
    video: (position: number) => `Video ${position}`,
    download: (mediaType: string) => `Download file (${mediaType})`,
  },
  /**
   * What a person is told when a file cannot be attached or sent. An upload fault shows on the
   * attachment's `error` state; a run fault shows in the failure alert. Neither shows a raw
   * message, which can name an asset or an upload.
   */
  attachments: {
    /** The file is over the limit the selected agent's model states. */
    tooLarge: (limit: number) =>
      `This file is larger than the ${formatBytes(limit)} this agent accepts.`,
    /** The file is of a type the selected agent's model does not take. */
    typeNotAccepted: 'This agent does not accept that type of file.',
    /** The upload did not finish, for a reason the person cannot act on beyond trying again. */
    uploadFailed: 'The file could not be uploaded. Remove it and attach it again.',
    /** The Bureau looked at the bytes and refused them: a safety gate flagged the file, or it is not the type it says. */
    rejected: 'The server would not accept this file. Its content was refused.',
    /** The upload session was gone before the file finished arriving. */
    expired: 'The upload expired before it finished. Remove the file and attach it again.',
    /** The run was refused because the model could not take an attachment. */
    modelRefusedMedia:
      'The agent’s model could not take an attached file. Send again without the file.',
  },
} as const;

/** The deletion states `bureau.memory.forget` answers with, in the receipt's own vocabulary. */
export type MemoryDeletionState = 'completed' | 'pending' | 'exempt' | 'failed' | 'unknown';

/**
 * The words the Memory page uses outside its view states (`/agents/:agent/memories`): the list, the
 * search, one memory's lineage, and what forgetting and correcting answer. The page's loading,
 * empty, error, forbidden, and not-found states are the Agents view's (`VIEW_COPY.agents`).
 */
export const MEMORY_COPY = {
  /** The link on an agent's page that opens its memory. */
  link: 'Memory',
  heading: 'Memories',
  listLabel: 'What this agent remembers',
  searchLabel: 'Search this agent’s memory',
  searchPlaceholder: 'Search memory…',
  clearSearch: 'Clear search',
  loadMore: 'Load more',
  loading: 'Loading memories',
  listFailed: 'The memories could not be loaded.',
  /** Under an open memory the list or search does not hold, which the list leads with. */
  pinnedNote: 'Open now, not in this list',
  noContent: 'This memory has no text.',
  relevance: 'Relevance',
  /** How many memories the agent has; `more` is true when the list has pages left to load. */
  count: (shown: number, more: boolean): string =>
    `${shown}${more ? '+' : ''} ${shown === 1 && !more ? 'memory' : 'memories'}`,
  /**
   * What a search found. The server ranks every memory the agent has and has no score floor, so a
   * memory matches when it holds a word of the query, and its relevance only orders the matches.
   * `total` is the agent's memory count when every page of it has been read, and `more` says the
   * search filled its page, so more may match than are shown, unless every memory already does.
   */
  matchCount: (matched: number, total: number | undefined, more: boolean): string => {
    const plus = more && matched !== total ? '+' : '';
    return total !== undefined
      ? `${matched}${plus} of ${total} ${total === 1 ? 'memory matches' : 'memories match'}`
      : `${matched}${plus} ${matched === 1 && plus === '' ? 'memory matches' : 'memories match'}`;
  },
  /** The list is empty because the agent forgot its last memory while the page was open. */
  nothing: {
    title: 'This agent remembers nothing',
    description:
      'A memory is saved when the agent answers in a chat, and you can add one in your own words.',
  },
  /** The list is empty because a search matched nothing. */
  noMatch: {
    title: (query: string): string => `No memory matches “${query}”`,
    description: 'Try other words, or show every memory.',
  },
  /** The list is empty because no loaded memory is of the kind chosen. */
  noKind: {
    title: 'No loaded memory is of this kind',
    description: 'Show every kind to see the memories again.',
  },
  /** The action under an empty search that lists everything again. */
  clearMatch: 'Show all memories',
  /** The Back button above the open memory where it replaces the list. */
  backToList: 'Back to memories',
  /** What the empty detail says while no memory is open. */
  nothingOpen: {
    title: 'No memory open',
    description: 'Choose a memory to read it, correct it, forget it or see where it came from.',
  },
  /**
   * The kind filter, in plain names. It filters the memories loaded so far, not every memory the
   * agent has, and says so.
   */
  filter: {
    label: 'Kind',
    all: 'All kinds',
    facts: 'Facts',
    chats: 'From chats',
    howTo: 'How-to',
    you: 'From you',
    /** The line under the count while a kind is chosen: it works over the loaded pages only. */
    note: (shown: number, loaded: number, more: boolean): string =>
      `${shown} of the ${loaded}${more ? ' loaded so far' : ''} ${loaded === 1 ? 'memory is' : 'memories are'} of this kind.${
        more ? ' Load more to look further.' : ''
      }`,
  },
  /** The kind chip on a row, in plain words; the detail names the engine's own term. */
  plainKind: {
    facts: 'Facts',
    chats: 'From chats',
    howTo: 'How-to',
    you: 'From you',
  },
  /** The kind in the engine's own terms, with a sentence for the person who did not choose it. */
  kind: {
    operator: { label: 'Operator', description: 'Operator: words you wrote' },
    working: {
      label: 'Working',
      description: 'Working: a note the agent keeps while it works on something',
    },
    episodic: {
      label: 'Episodic',
      description: 'Episodic: something the agent learned from a chat',
    },
    semantic: { label: 'Semantic', description: 'Semantic: a fact the agent knows' },
    procedural: {
      label: 'Procedural',
      description: 'Procedural: a way of doing something that the agent has learned',
    },
    identity: { label: 'Identity', description: 'Identity: what the agent knows about itself' },
    resource: {
      label: 'Resource',
      description: 'Resource: reference material the agent can look up',
    },
    /** For a kind the server added that this page has no words for. */
    unknown: (kind: string): string => `${kind}: a kind of memory this page has no description for`,
  },
  detail: {
    heading: 'Memory details',
    loading: 'Loading this memory',
    failed: 'This memory could not be loaded.',
    notFound: {
      title: 'This memory was not found',
      description: 'It may have been forgotten, or it may not be yours.',
    },
    content: 'Memory',
    /** The three columns of facts below the text. */
    groups: {
      origin: 'Where it came from',
      standing: 'Trust and time',
      history: 'Correction history',
    },
    fields: {
      source: 'Source',
      session: 'Chat',
      run: 'Run',
      trust: 'Trust',
      kind: 'Kind',
      created: 'Created',
      legalHold: 'Legal hold',
      corrects: 'Corrects',
      correctedBy: 'Corrected by',
    },
    /** What an origin field says when nothing recorded it. */
    notRecorded: 'Not recorded',
    /** What a history field says when the memory was never part of a correction. */
    noHistory: 'None',
    /** The legal hold is shown only once it is known: from a hold, a release, or a refused forget. */
    legalHold: {
      held: 'Held: this memory stays stored',
      free: 'Not held',
    },
    openChat: 'Open chat',
    openMemory: 'Open that memory',
  },
  source: {
    conversation: 'An agent’s answer in a chat',
    'model-tool': 'A tool the model called',
    'tool-result': 'A tool’s result',
    'ingested-document': 'An ingested document',
    derived: 'Derived from other memories',
    operator: 'Written by a person',
    system: 'Written by the system',
  },
  trust: {
    untrusted: 'Untrusted',
    verified: 'Verified',
    system: 'System',
  },
  memoryClass: {
    working: 'Working',
    episodic: 'Episodic',
    semantic: 'Semantic',
    procedural: 'Procedural',
    identity: 'Identity',
    resource: 'Resource',
  },
  forget: {
    action: 'Forget',
    /** The name of the icon button that forgets the open memory. */
    iconLabel: 'Forget this memory',
    dialog: {
      title: 'Forget this memory?',
      description: (excerpt: string): string =>
        `The agent stops recalling “${excerpt}”, and it leaves this list and search. A copy of it that a chat already saved is not scrubbed.`,
      confirm: 'Forget memory',
    },
    /** The words for each state the deletion can answer with. */
    outcome: {
      completed: {
        title: 'Memory forgotten',
        description:
          'It no longer appears in this list, in search, or in what the agent recalls. A copy of it that a chat already saved is not scrubbed.',
      },
      exempt: {
        title: 'This memory is under a legal hold',
        description: 'It stays stored and listed. Forgetting it resumes when the hold is released.',
      },
      pending: {
        title: 'Forgetting has not finished',
        description:
          'The server started removing this memory and has not confirmed it. Check again shortly.',
      },
      failed: {
        title: 'The memory was not removed',
        description:
          'The step that removes it failed, so it is still stored. Forget it again to retry.',
      },
      unknown: {
        title: 'The result could not be confirmed',
        description:
          'The server could not say whether this memory was removed. Check the list, and forget it again if it is still there.',
      },
    } satisfies Record<MemoryDeletionState, { title: string; description: string }>,
    receiptLabel: 'What the deletion reached',
    targets: {
      'source-evidence': 'The memory itself',
      'canonical-projections': 'Projections of it',
      'identity-views': 'Identity views',
      'managed-asset-record': 'Managed asset record',
      indexes: 'The search index',
      caches: 'Caches',
      summaries: 'Summaries made from it',
      'managed-asset-bytes': 'Managed asset files',
      'durable-snapshots': 'Chats that saved a copy',
      exports: 'Exports',
      'external-processors': 'Outside processors',
    },
    targetStatus: {
      completed: 'Done',
      pending: 'Waiting',
      exempt: 'Held',
      failed: 'Failed',
      unknown: 'Unknown',
    } satisfies Record<MemoryDeletionState, string>,
    failed: 'The memory was not forgotten',
  },
  add: {
    action: 'Add a memory',
    dialog: {
      title: 'Add a memory',
      description:
        'Your words are kept until you correct or forget them, and the agent recalls them in its chats with you.',
      label: 'What the agent should remember',
      submit: 'Save memory',
      cancel: 'Cancel',
    },
    saved: {
      title: 'Memory added',
      description: 'The agent recalls it in its chats with you.',
    },
    /** The title of a refusal the Bureau gave its own words for. */
    notSaved: 'The memory was not saved',
    refusal: {
      'not-admitted': {
        title: 'The memory was not accepted',
        description:
          'Interborough’s content rules or this agent’s memory limit refused it, so nothing was saved. Reword it and try again.',
      },
      quarantined: {
        title: 'The memory was set aside',
        description:
          'Interborough’s content rules flagged it, so it is kept for inspection and the agent will not recall it. Reword it to save it.',
      },
      'not-found': {
        title: 'This agent was not found',
        description: 'It may have been deleted, or it may not be yours to change.',
      },
    },
  },
  correct: {
    action: 'Correct',
    /** The name of the icon button that edits the open memory in place. */
    iconLabel: 'Correct this memory',
    edit: {
      description:
        'Your words become a new memory that replaces this one. The agent recalls only the correction; this one is kept in its history.',
      label: 'Corrected memory',
      submit: 'Save correction',
      cancel: 'Cancel',
    },
    /** The page-level report of a correction that was refused: its title leads, then the words the person wrote. */
    notSaved: {
      title: 'The correction was not saved',
      draftLabel: 'What you wrote',
      editAgain: 'Edit it again',
    },
    saved: {
      title: 'Memory corrected',
      description:
        'The agent now recalls your correction in place of the old memory. The old one is kept in its history.',
    },
    refusal: {
      superseded: {
        title: 'This memory was already corrected',
        description: 'Open its correction from the list to change it again.',
      },
      'successor-not-admitted': {
        title: 'The correction was not accepted',
        description:
          'Interborough’s content rules or this agent’s memory limit refused it, so nothing changed. Reword it and try again.',
      },
      forbidden: {
        title: 'Changing memory is locked',
        description:
          'Adding, correcting or forgetting a memory needs the bureau.memory:write scope.',
      },
      'not-found': {
        title: 'This memory was not found',
        description: 'It may have been forgotten, or it may not be yours.',
      },
      other: { title: 'The correction was not saved', description: '' },
    },
  },
  /** Sharing, holding, quarantining and exporting: each is recorded in the memory ledger. */
  govern: {
    heading: 'Sharing and governance',
    recorded: 'The memory ledger records this.',
    share: {
      action: 'Share',
      dialog: {
        title: 'Share this memory',
        description: (excerpt: string): string =>
          `Another owner you name can read “${excerpt}”, and nothing else of it: they cannot list, search, correct, forget or share it again.`,
        label: 'Owner to share with',
        submit: 'Share memory',
        revoke: 'Stop sharing',
        cancel: 'Cancel',
      },
      outcome: {
        granted: {
          title: 'Memory shared',
          description: (owner: string): string => `${owner} can now read it.`,
        },
        alreadyGranted: {
          title: 'Already shared',
          description: (owner: string): string => `${owner} could already read it.`,
        },
        revoked: {
          title: 'Sharing stopped',
          description: (owner: string): string => `${owner} can no longer read it.`,
        },
        notShared: {
          title: 'It was not shared',
          description: (owner: string): string => `${owner} could not read it, so nothing changed.`,
        },
      },
    },
    hold: {
      place: 'Place legal hold',
      release: 'Release legal hold',
      outcome: {
        placed: {
          title: 'Legal hold placed',
          description:
            'Forgetting this memory, and the retention sweep, leave it stored until the hold is released.',
        },
        alreadyPlaced: {
          title: 'Already on legal hold',
          description: 'It stays stored until the hold is released.',
        },
        released: {
          title: 'Legal hold released',
          description: 'A forget that was waiting on the hold now goes ahead.',
        },
        notHeld: {
          title: 'It was not on legal hold',
          description: 'Nothing changed.',
        },
      },
    },
    quarantine: {
      action: 'Quarantine',
      dialog: {
        title: 'Quarantine this memory?',
        description: (excerpt: string): string =>
          `“${excerpt}” and anything derived from it is taken out of use: it is no longer listed, searched, read or recalled. This cannot be undone. It stays stored for inspection, and forgetting it still removes it.`,
        reasonLabel: 'Why is it quarantined?',
        confirm: 'Quarantine memory',
        cancel: 'Cancel',
      },
      outcome: {
        done: {
          title: 'Memory quarantined',
          description: (affected: number): string =>
            `${affected} ${affected === 1 ? 'record was' : 'records were'} taken out of use.`,
        },
        already: {
          title: 'Already quarantined',
          description: 'Nothing changed.',
        },
      },
    },
    export: {
      action: 'Export',
      /** The name of the file the export saves. */
      fileName: (agent: string): string => `${agent}-memories.json`,
      outcome: {
        title: 'Memories exported',
        description: (count: number, exportId: string | null): string =>
          `${count} ${count === 1 ? 'memory was' : 'memories were'} saved to a file${
            exportId === null ? '' : ` (export ${exportId})`
          }. A memory forgotten later is scrubbed from the export’s record.`,
      },
    },
    failed: 'That change was not made',
    refusal: {
      forbidden: {
        title: 'This is locked',
        description:
          'Sharing and quarantine need the bureau.memory:write scope, and a legal hold needs bureau.memory:govern.',
      },
      'invalid-grantee': {
        title: 'That owner cannot be shared with',
        description: 'Name another owner: not this memory’s own owner, and not nobody.',
      },
      'not-found': {
        title: 'This memory was not found',
        description: 'It may have been forgotten, or it may not be yours.',
      },
    },
  },
} as const;

/** The words the Tasks view uses outside its states. */
export const TASK_COPY = {
  listHeading: 'Runs',
  filtersLabel: 'Filter runs',
  agentLabel: 'Agent',
  statusLabel: 'Status',
  startedByLabel: 'Started by',
  sinceLabel: 'When',
  anyAgent: 'Any agent',
  anyOrigin: 'Anything',
  anyTime: 'Any time',
  loading: 'Loading runs',
  loadFailed: {
    title: 'The runs could not be loaded',
    description: 'The server did not answer. Check that the host is running, then try again.',
  },
  empty: {
    title: 'No runs yet',
    description: 'A run is one go of an agent. Start a chat and its runs are listed here.',
  },
  unknownAgent: 'An agent',
  untitledChat: 'Untitled chat',
  goal: 'goal',
  schedule: 'schedule',
  agent: 'agent',
  workflow: 'workflow',
  /** Under Started by, for a run recorded before the origin of a run was kept. */
  originUnrecorded: 'Not recorded',
  /** How a person started a run outside a chat, after "A person". */
  personSurface: {
    web: 'in the web app',
    palette: 'from the command palette',
    api: 'through the API',
  },
  /** After "A schedule", when a person fired it by hand instead of its cadence. */
  firedByHand: 'fired by hand',
  sessionLabel: 'Session',
  anyStatus: 'Any status',
  filterAction: 'Filter',
  clearAction: 'Clear filters',
  noMatch: {
    title: 'No run matches these filters',
    description: 'Change the filters to see more runs.',
  },
  loadMore: 'Load more',
  /** The runs table's column headings: one per filter, then how long a run took. */
  listColumns: {
    agent: 'Agent',
    startedBy: 'Started by',
    status: 'Status',
    when: 'When',
    took: 'Took',
  },
  /** How many runs the page lists, as a sentence. */
  count: (count: number): string => `${String(count)} ${count === 1 ? 'run' : 'runs'}`,
  /** The primary action of the runs page, which opens the form that starts one. */
  startRun: 'Start run',
  columns: {
    status: 'Status',
    agent: 'Agent',
    task: 'Task',
    session: 'Session',
    updated: 'Updated',
  },
  /** What a run that needs a person is waiting for. */
  waiting: {
    approval: 'Waiting for your approval',
    answer: 'Waiting for your answer',
  },
  openWaits: (count: number): string => `${String(count)} open ${count === 1 ? 'wait' : 'waits'}`,
  /** What each state a task can be in is called. */
  states: {
    submitted: 'Working',
    working: 'Working',
    'input-required': 'Needs you',
    completed: 'Done',
    failed: 'Failed',
    canceled: 'Canceled',
  },
  detailTitle: (agent: string | null): string => (agent === null ? 'Task' : `${agent} task`),
  idLabel: 'Task identifier',
  statusFact: 'Status',
  agentFact: 'Agent',
  sessionFact: 'Session',
  finishReasonFact: 'Finish reason',
  statusMessageFact: 'Status message',
  createdFact: 'Started',
  updatedFact: 'Updated',
  openChat: 'Open chat',
  /** The link to the session of a run a goal or a schedule's fire started, which is no chat. */
  openSession: 'Open the session',
  /** The link on a run's page to the task the run is, when it is one. */
  viewTask: 'View the task',
  answerHeading: 'Answer',
  noAnswer: 'The agent finished without a written answer.',
  noAnswerYet: 'The agent has not answered yet.',
  toolCallsHeading: 'Tool calls',
  noToolCalls: 'The agent has not used a tool.',
  toolCallsLoadFailed: {
    title: 'The tool calls could not be loaded',
    description: 'The server did not answer. Check that the host is running, then try again.',
  },
  runTitle: 'Run',
  /** The Bureau's side of a run is shown, and the workflow engine's could not be read. */
  engineReadFailed: 'The workflow’s record could not be read',
  goalAttemptNote:
    'A goal made this run, so there is no task for it. The sections below show what the workflow recorded.',
  /** The same, for a caller who may not read the workflow, so there is nothing recorded to point to. */
  goalAttemptNoteBureauOnly: 'A goal made this run, so there is no task for it.',
  /** A run the Bureau does not know, to a caller who may not read the engine either. */
  notFound: {
    title: 'This run was not found',
    description:
      'It may have been removed, or it may belong to someone else. Open a run from the list.',
  },
  engineOnlyNote:
    'There is no task for this run. The sections below show what the workflow recorded.',
  answerTruncated: 'The answer was cut short.',
  followUnavailable:
    'This server cannot follow a task live, so its answer and live updates are not shown here.',
  followReconnecting: 'The connection dropped. Reconnecting.',
  waitsHeading: 'Waiting on you',
  /** The heading once everything the run asked has been answered. */
  waitsAnsweredHeading: 'Answered',
  readingWait: 'Reading what the run is waiting on.',
  /** The answer is on its way and the wait has already closed. */
  sendingAnswer: 'Sending your answer.',
  waitGone: 'This wait is no longer open.',
  waitLoadFailed: 'The wait could not be read.',
  humanWaitFallback: 'The agent is waiting for your answer.',
  approvalHeading: 'Tool approval',
  approvalReason: 'Reason',
  approvalMessage: 'Message',
  decideInReviews: 'Decide in Reviews',
  answerLabel: 'Your answer',
  sendAnswer: 'Send answer',
  respondFailed: 'The answer was not sent',
  cancelHeading: 'Cancellation',
  cancelAction: 'Cancel run',
  cancelFailed: 'The run was not canceled',
  cancelConfirm: {
    title: 'Cancel this run?',
    description: 'The agent stops where it is. What it already did is not undone.',
    keep: 'Keep running',
  },
  /**
   * How often the page reads a task again while its stream has ended and the task has not. A task
   * the Bureau started with `bureau.run()` streams one snapshot and ends, so its state is read.
   */
  endedPollMilliseconds: 5_000,
  /** How often the page reads a task again while its cancellation is still being carried out. */
  cleanupPollMilliseconds: 1_000,
  /** What each answer to a cancel says. A receipt is one of the states a cleanup can be in, or `rejected`. */
  cancel: {
    'cancel-requested': 'Cancellation requested. The task has not stopped yet.',
    canceled: 'Canceled. The task stopped, and reported no cleanup to wait for.',
    'cleanup-pending': 'Canceled. Cleanup is still running.',
    'cleaned-up': 'Canceled and cleaned up.',
    'cleanup-failed': 'Canceled, but cleanup failed.',
    'cleanup-unresolved':
      'Canceled, but cleanup could not be confirmed and may still be running. Nothing is promised about its effects outside this system.',
    'unknown-outcome': 'An effect outside this system may or may not have happened.',
    rejected: 'Not canceled. The task had already finished.',
  },
  /** The record of a workflow run the engine behind the console does not hold, read from the Bureau. */
  runRecord: {
    label: 'Run record',
    workflow: 'Workflow',
    status: 'Status',
    started: 'Started',
    changed: 'Last changed',
    startedBy: 'Started by',
    input: 'Input',
    result: 'Result',
    error: 'Error',
    inputPayload: 'Input payload',
    resultPayload: 'Result payload',
    loading: 'Loading the run',
    failed: {
      title: 'The run could not be loaded',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
  },
  /** What a refused cancel says when the run belongs to something else, which is the one to stop. */
  cancelOwned: {
    'owned-by-goal':
      'Not canceled. This run is an attempt of a goal, and cancelling the goal stops it.',
    'owned-by-workflow':
      'Not canceled. This run is a step of a workflow, and it is not canceled on its own.',
  },
} as const;

/** The words `/reviews` uses outside its states. */
export const REVIEWS_COPY = {
  heading: 'Reviews',
  description: 'Questions, tool approvals and workflow reviews that are waiting on you.',
  tabsLabel: 'Reviews by state',
  tabs: { waiting: 'Waiting', done: 'Done' },
  /** The accessible name of each list. */
  listLabel: { waiting: 'Waiting on you', done: 'Decided' },
  detailLabel: 'Review',
  /** What the list tab says, with the count waiting. */
  waitingTab: (count: number): string => (count === 0 ? 'Waiting' : `Waiting (${String(count)})`),
  /** The status of the list while it is read. */
  loading: 'Loading reviews',
  /** What a person sees under the heading of a list that holds more than a page. */
  loadMore: 'Load more',
  workflowReview: 'Workflow review',
  /** The label for a review that asks to approve a tool call. */
  toolApproval: 'Tool approval',
  /** The label for a review that asks a question. */
  humanWait: 'Question',
  openChat: 'Open chat',
  unknownAgent: 'An agent',
  untitledChat: 'Untitled chat',
  questionFallback: 'It is waiting for your answer.',
  waiting: (count: number): string => `${String(count)} waiting on you`,
  approve: 'Approve',
  deny: 'Deny',
  reject: 'Reject',
  reasonLabel: 'Reason (required to reject)',
  reasonDescription: 'Sent with the decision. A rejection cannot be sent without one.',
  answerLabel: 'Your answer',
  /** Said once under an answer field: what the agent does with the answer. */
  answerHint: 'The agent continues with your answer.',
  /** The optional note sent with a denial, which the agent reads. */
  noteLabel: 'Note to the agent (optional)',
  toolLabel: 'Tool',
  argumentsLabel: 'Arguments',
  /** The labels on the parts of what an approval would run. */
  operation: {
    command: 'Command',
    diff: 'Changes',
    filesTouched: 'Files touched',
    showWholeDiff: 'Show the whole diff',
  },
  reasonFact: 'Reason',
  messageFact: 'Message',
  riskFact: 'Risk',
  requestedFact: 'Requested',
  agentFact: 'Agent',
  noReviewSelected: 'No review selected',
  chooseReview: 'Choose a review from the list.',
  allCaughtUp: 'All caught up',
  nothingWaiting: 'No reviews are waiting on a decision.',
  nothingDecided: 'Nothing decided yet',
  nothingDecidedDescription: 'Reviews you approve, deny or answer are listed here.',
  /** The source line under a question: who asked, where, and since when. */
  source: {
    askedBy: 'Asked by',
    in: 'in',
    waitingSince: 'waiting since',
    askedAt: 'asked',
    thisRun: 'this run',
    unknownWorkflow: 'a workflow',
  },
  /** The ways a review left the queue, in a word. */
  decided: {
    waiting: 'Waiting',
    approved: 'Approved',
    denied: 'Denied',
    rejected: 'Rejected',
    needsChanges: 'Changes requested',
    answered: 'Answered',
    closed: 'Closed',
  },
  /** Between what became of a review and who did it. */
  by: 'by',
  reasonIs: 'Reason',
  artifactLabel: 'What the workflow asks you to review',
  answerRecorded: 'The answer was sent to the agent.',
  allowForChat: 'Allow for the rest of this chat',
  notRemembered: {
    title: 'Approved, but not remembered',
    message: 'The tool will ask again in this chat.',
  },
  /** Said under a question that is picked from choices: the number keys. */
  pickHint: 'Press 1 to 9 to pick a choice.',
  /** What the open approval would run, and what it was given. */
  inputLabel: 'Input',
  noInput: 'This call was given no input.',
  /** The shortcuts the `?` map lists for this page. */
  shortcutGroup: 'Reviews',
  approveShortcut: 'Approve the open review',
  denyShortcut: 'Deny the open review',
  pickShortcut: (position: number): string => `Pick choice ${String(position)}`,
  decisionFailed: 'The decision was not recorded',
  /**
   * The Bureau's answer when a decision took effect and only its write into the conversation
   * failed (`APPROVAL_OUTCOME_NOT_WRITTEN`). It is not a lost race, so it does not say the decision
   * was not recorded.
   */
  outcomeNotWritten: {
    title: 'The decision took effect',
    message:
      'The tool ran or was refused as you decided, but its outcome could not be written into the conversation. The chat may show the approval as pending until it is reloaded. Do not decide it again.',
  },
  /**
   * The Bureau's answer when the approval was gated again after the row showed it
   * (`REVIEW_ROUND_CHANGED`): it keeps its id, so the decision would have answered a request the
   * person never read, and nothing was decided.
   */
  roundChanged: {
    title: 'This review changed while you read it',
    message: 'it was not decided. Read it again before deciding.',
  },
  answerFailed: 'The answer was not sent',
  superseded:
    'The approval was gated again, so the tool did not run. A replacement approval is waiting.',
} as const;

/** The words of the ⌘K palette. */
export const PALETTE_COPY = {
  label: 'Command palette',
  placeholder: 'Search everything, > for actions, @ for agents',
  untitledChat: CHAT_COPY.untitled,
  emptyTitle: 'Search the console',
  emptyDescription: 'Type the name of a chat or an agent, or an ID, to jump to it.',
  noMatchesTitle: 'No matches',
  noMatchesDescription: (query: string): string => `Nothing matched "${query}".`,
  /** Said when a search could not read some of what it searches, so what is missing is not taken for "no matches". */
  searchFailedTitle: 'The search did not finish',
  searchFailedDescription: (domains: readonly string[]): string =>
    `Could not read ${domains.join(', ').toLowerCase()}. Matches there may be missing; try the search again.`,
  /** The heading of each kind of result, in the order the palette lists them. */
  groups: {
    waiting: 'Waiting on you',
    chats: 'Chats',
    workflows: 'Workflows',
    runs: 'Runs',
    schedules: 'Schedules',
    workers: 'Workers',
    reviews: 'Reviews',
    agents: 'Agents',
    tools: 'Tools',
    actions: 'Actions',
  },
  /** What reads between a shortcut's keys when they are pressed one after the other. */
  keysThen: ' then ',
} as const;

/**
 * The words of the notification bell: what needs the person, and what finished. Each sentence
 * names the agent and is followed by the chat or schedule it is about, never a run.
 */
export const NOTIFICATION_COPY = {
  panelTitle: 'Notifications',
  markAllRead: 'Mark all read',
  /** The empty list: everything that needed the person is done. */
  empty: {
    title: 'Nothing needs you right now',
    description: 'Approvals, questions, failures and missed schedules show up here.',
  },
  /** The list could not be read, so it must not read as empty. */
  loadFailed: {
    title: 'Notifications could not be loaded',
    description: 'What is shown may be out of date. Nothing here says that nothing needs you.',
  },
  /** A mark-as-read the Bureau refused: the items are unread again, here and in every browser. */
  readFailed: 'The notifications could not be marked as read. They are unread again.',
  /** Where email or webhooks are set up, and where the bell's own settings are. */
  linksLabel: 'Where notifications are set up',
  settingsLink: 'Notification settings',
  hooksLink: 'Hooks for email or webhooks',
  /** What the bell button is called; the count says how many items need the person. */
  bellLabel: (count: number): string =>
    count === 0 ? 'Notifications' : `Notifications, ${count} need${count === 1 ? 's' : ''} you`,
  needsApproval: (agent: string): string => `${agent} needs your approval`,
  askedQuestion: (agent: string): string => `${agent} asked a question`,
  answered: (agent: string): string => `${agent} answered`,
  failed: (subject: string): string => `${subject} failed`,
  budgetExceeded: (subject: string): string => `${subject} exceeded its budget`,
  missedFire: (subject: string): string => `${subject} missed a run`,
  /** Why a schedule did not fire: the host was down or too slow to start it, or its time did not exist on the clock. */
  missedLate: 'The host was down or too slow to start it',
  missedClockGap: 'Its time was skipped by a clock change',
  /** What an agent is called when the Bureau names none. */
  unnamedAgent: 'An agent',
  /** Read between a sentence and the chat it is about, by a screen reader only. */
  inJoiner: ' in ',
  /** Read between a failed schedule and the first line of its error. */
  errorJoiner: ': ',
  noErrorText: 'No reason was given',
} as const;

/** The words of the navigation and the top bar, and what the engine status says. */
export const NAVIGATION_COPY = {
  /** The accessible name of the sidebar's list of destinations. */
  destinations: 'Views',
  /** The accessible name of the top bar's breadcrumb trail. */
  breadcrumb: 'Breadcrumb',
  /** What the Health page's links to the engine's other pages are called. */
  healthSections: 'Health sections',
  /** What the link to the audit trail is called among the Health page's links. */
  auditLog: 'Audit log',
  /** The button that folds the sidebar to its icon rail, and opens it again. */
  collapseSidebar: 'Collapse sidebar',
  expandSidebar: 'Expand sidebar',
  /** What the engine status dot says, by the state of the live feed. */
  engineStatus: {
    connecting: 'Server connecting',
    live: 'Server healthy',
    reconnecting: 'Server reconnecting',
    polling: 'Server healthy (polling)',
    stale: 'Server status stale',
    closed: 'Server unreachable',
  },
} as const;

/** The words of the keyboard shortcuts and their map, opened with `?`. */
export const SHORTCUT_COPY = {
  mapTitle: 'Keyboard shortcuts',
  openMap: 'Show keyboard shortcuts',
  openSearch: 'Search everything',
  generalGroup: 'General',
  navigationGroup: 'Go to',
  chatGroup: 'Chat',
  newChat: 'New chat',
  listGroup: 'Lists',
  goTo: (label: string): string => `Go to ${label}`,
} as const;

/** The words of the quick settings popover in the top bar: personal preferences for this browser. */
export const QUICK_SETTINGS_COPY = {
  trigger: 'Quick settings',
  theme: 'Theme',
  density: 'Density',
  comfortable: 'Comfortable',
  compact: 'Compact',
  sidebar: 'Sidebar',
  collapsed: 'Collapse to icons',
  allSettings: 'All settings',
} as const;

/**
 * The words of the Capabilities page (`/capabilities`): the tools and skills agents can use, with
 * what each does, how it is approved by default, where it came from, and which agents use it.
 */
export const CAPABILITIES_COPY = {
  title: 'Capabilities',
  description: 'The tools and skills your agents can use, and who is allowed to use them.',
  tabsLabel: 'Capability kinds',
  tabs: { tools: 'Tools', skills: 'Skills', sources: 'Sources' },
  filterLabel: { tools: 'Filter tools', skills: 'Filter skills', sources: 'Filter sources' },
  filterPlaceholder: 'Filter by name',
  listLabel: { tools: 'Tools', skills: 'Skills', sources: 'Sources' },
  count: (shown: number, total: number): string =>
    shown === total ? String(total) : `${String(shown)} of ${String(total)}`,
  detailLabel: { tools: 'Tool details', skills: 'Skill details', sources: 'Source details' },
  emptyDetailTitle: 'Choose a capability',
  emptyDetailDescription: 'Pick one from the list to see what it does and who uses it.',
  tool: {
    loading: 'Loading tools',
    empty: {
      title: 'No tools yet',
      description: 'Agents have no tools to call until the host provides some.',
    },
    filtered: {
      title: 'No tools match',
      description: 'No tool name contains what you typed.',
      clear: 'Clear filter',
    },
    whatItDoes: 'What it does',
    safety: 'What it may do',
    approval: 'By default',
    source: 'Where it comes from',
    inputs: 'Inputs',
    inputsLabel: (name: string): string => `Inputs of ${name}`,
    noInputs: 'This tool takes no inputs.',
    noSchema: 'This tool does not describe its inputs.',
    users: 'Used by',
    noUsers: {
      title: 'No agent uses this tool',
      description: 'Add it to an agent in the agent editor to put it to work.',
      action: { label: 'Open agents', href: '/agents' },
    },
    tier: {
      'read-only': 'Reads only',
      mutating: 'Changes things',
      dangerous: 'Dangerous',
      unclassified: 'Not classified',
    },
    tierDescription: {
      'read-only': 'It looks at things and changes nothing.',
      mutating: 'It changes things.',
      dangerous: 'It can do damage that is hard to undo.',
      unclassified: 'It does not say what it does, so it is treated as one that changes things.',
    },
    approvals: {
      allow: 'Runs without asking',
      ask: 'Asks you first',
    },
    /** Where a tool comes from; the host passes Interborough's MCP servers' tools, so its are an MCP server's. */
    sources: {
      host: 'MCP server',
      bureau: 'Built in',
      plugin: (plugin: string): string => `Plugin ${plugin}`,
    },
    loadFailed: {
      title: 'The tools could not be read',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
  },
  skill: {
    loading: 'Loading skills',
    empty: {
      title: 'No skills yet',
      description:
        'Skills are folders with a SKILL.md file. Add a skills directory to the host configuration to see them here.',
    },
    emptySources: {
      title: 'No skills found',
      description:
        'The host looked in the skills directories it is configured with and found no folder with a SKILL.md file.',
    },
    unavailableBadge: 'Unavailable',
    filtered: {
      title: 'No skills match',
      description: 'No skill name contains what you typed.',
      clear: 'Clear filter',
    },
    whatItDoes: 'What it does',
    trust: 'Trust',
    source: 'Where it comes from',
    allowedTools: 'Asks to keep these tools',
    users: 'Used by',
    noUsers: {
      title: 'No agent uses this skill',
      description: 'An agent defined in code can name a skill to use it.',
      action: { label: 'Open agents', href: '/agents' },
    },
    notAvailable: 'An agent cannot use this skill yet.',
    untrustedBadge: 'Not trusted',
    trustLabel: {
      trusted: 'Trusted',
      untrusted: 'Not trusted',
      revoked: 'Trust revoked',
    },
    unavailable: {
      'source-untrusted': 'Its source is not trusted, so agents are refused it.',
      'source-revoked': 'Trust in its source was revoked, so agents are refused it.',
      shadowed: 'Another skill with the same name takes its place.',
      invalid: 'Its SKILL.md file is not valid.',
      unreadable: 'The host could not read its files.',
    },
    sourceKinds: {
      project: 'Project',
      user: 'User',
      'built-in': 'Built in',
      remote: 'Remote',
      storage: 'Storage',
      plugin: 'Plugin',
    },
    loadFailed: {
      title: 'The skills could not be read',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    usersFailed: 'Which agents use each skill could not be read.',
  },
  source: {
    loading: 'Loading tool sources',
    empty: {
      title: 'No tool sources yet',
      description:
        'A tool source is an MCP server or an OpenAPI service whose tools agents can call. The ones this host saved are listed here.',
    },
    filtered: {
      title: 'No sources match',
      description: 'No source name contains what you typed.',
      clear: 'Clear filter',
    },
    loadFailed: {
      title: 'The tool sources could not be read',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    kinds: { mcp: 'MCP server', openapi: 'OpenAPI service' },
    states: {
      loaded: 'Connected',
      failed: 'Failed',
      'needs-authorization': 'Needs sign-in',
      'pending-restart': 'Starts next time',
    },
    stateDescriptions: {
      loaded: 'Its tools are in Capabilities and agents can be given them on Access.',
      failed: 'It did not load, so its tools are not available.',
      'needs-authorization': 'Sign in to the server so it can list its tools.',
      'pending-restart': 'It is saved. Its tools are listed when Interborough starts again.',
    },
    facts: {
      kind: 'Kind',
      credentials: 'Stored credentials',
      noCredentials: 'None',
      localCommand: 'Runs a command on this machine',
      localCommandYes: 'Yes',
    },
    signIn: {
      action: 'Sign in',
      opened:
        'Finish signing in in the tab that opened, then restart Interborough to list the tools.',
      already: 'Already signed in. Restart Interborough to list the tools.',
      signedIn: 'Signed in. Restart Interborough to list the tools.',
      rejected:
        'The sign-in this source had stored no longer works, so restarting will not list its tools. Sign in again.',
      failed: 'Signing in could not be started',
      blocked: 'The sign-in tab was blocked. Allow pop-ups for this page and try again.',
    },
    tools: {
      heading: 'Tools',
      empty: {
        title: 'No tools listed yet',
        description: 'A source lists its tools once it has connected.',
      },
      open: (name: string): string => `Open ${name} in Tools`,
      standing: { 'asks-first': 'Asks you first', runs: 'Runs without asking', blocked: 'Blocked' },
      standingLabel: 'By default',
      acceptsSecrets: 'Accepts secrets',
      acceptsSecretsLabel: (tool: string): string => `Accepts secrets: ${tool}`,
      acceptsSecretsHelp:
        'A tool that accepts secrets may receive the plaintext of an answer a person marks secret. Leave it off unless the tool needs the secret.',
      takesEffect: 'Takes effect when Interborough starts again',
      saveFailed: 'The setting could not be saved',
      locked: 'This host keeps its configuration in its deployment, so it cannot be changed here.',
    },
    /** What a refusal says when the host sent no words of its own. */
    refusal: {
      locked: 'This host keeps its configuration in its deployment, so it cannot be changed here.',
      'owner-only': 'Only the owner can do this.',
      'not-found': 'The host has no such source.',
      invalid: 'The host did not accept the value.',
      partial: 'The host made only part of the change.',
      failed: 'The host could not make the change.',
    },
    skipped: {
      heading: 'Tools the host does not list',
      reason: (tool: string, reason: string): string => `${tool}: ${reason}`,
    },
    unmatched: {
      heading: 'Settings that reach no tool',
      description:
        'These saved settings name a tool the server does not list. Nothing is applied to a different tool.',
    },
    remove: {
      action: 'Remove source',
      title: (id: string): string => `Remove ${id}?`,
      intro:
        'Its credentials are cleared and it leaves the list at once. Its tools stop running now, and leave Capabilities when Interborough starts again.',
      agentsHeading: 'Agents that name its tools',
      agentsIntro:
        'These agent files are not edited. Each reads invalid until the tool is taken out of it.',
      noAgents: 'No agent names its tools.',
      previewFailed: 'Which agents use its tools could not be read.',
      confirm: 'Remove',
      cancel: 'Keep it',
      removed: (id: string, agents: readonly string[]): string =>
        agents.length === 0
          ? `Removed ${id}. It is gone from the list, and its tools stop running now.`
          : `Removed ${id}. It is gone from the list, and its tools stop running now. Agents that still name them (${agents.join(', ')}) read invalid until you take them out.`,
      partial: 'The source was removed, but its cleanup was not finished',
      failed: 'The source could not be removed',
      agentTools: (tools: readonly string[]): string => tools.join(', '),
    },
  },
} as const;

/**
 * The words every view's states use. A view's state title and description live here and
 * nowhere else, so a change to the voice of the product is one edit and a test can name every
 * string a state can show.
 *
 * The forbidden description is not here: it names the scope the principal is missing, so the view
 * frame writes it from the scopes the view requires.
 */
export const VIEW_COPY: Readonly<Record<ViewName, ViewCopy>> = {
  chat: {
    label: 'Chat',
    loading: {
      title: 'Loading chat',
      description: 'Checking that the server is ready to take messages.',
    },
    empty: {
      title: 'Start a chat',
      description:
        'Pick an agent and say what you need. Your chats are kept here, and anything an agent needs from you shows in Reviews.',
      action: { label: 'New chat', href: '/chats/new' },
    },
    error: {
      title: 'Chat is unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Chat is locked' },
    notFound: {
      title: 'This conversation was not found',
      description:
        'It may have been deleted, or it may belong to someone else. Open a conversation from the list.',
    },
    // A new chat is for an agent, and it is the agent that is missing.
    notFoundByPattern: {
      '/chats/new': {
        title: 'This agent was not found',
        description: 'It may have been deleted. Choose an agent from the list to start a chat.',
      },
    },
    // A new chat with no `?agent=` starts with the first agent that can run; with none, there is
    // nothing to start it with.
    emptyByPattern: {
      '/chats/new': {
        title: 'No agent is ready to chat',
        description:
          'This host has no agent that can take a message yet. Turn on a plugin that adds agents, or finish setting one up, then start a chat.',
        action: { label: 'Open plugins', href: '/settings/plugins' },
      },
    },
  },
  agents: {
    label: 'Agents',
    loading: {
      title: 'Loading agents',
      description: 'Asking the server which agents it has.',
    },
    empty: {
      title: 'No agents to show',
      description: 'No agents are defined yet. Add one as a Markdown file in the agents directory.',
    },
    error: {
      title: 'Agents are unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Agents are locked' },
    notFound: {
      title: 'This agent was not found',
      description: 'It may have been deleted. Open one from the list.',
    },
    // An agent's memory page (`/agents/:agent/memories`) asks the Bureau for what the agent remembers.
    loadingByPattern: {
      '/agents/:agent/memories': {
        title: 'Loading memory',
        description: 'Asking the server what this agent remembers of your chats.',
      },
    },
    errorByPattern: {
      '/agents/:agent/memories': {
        title: 'Memory is unavailable',
        description:
          'The server did not answer, or it keeps no memory. Check that the host is running, then try again.',
      },
    },
    forbiddenByPattern: {
      '/agents/:agent/memories': {
        title: 'Memory is locked',
        description:
          'Reading what an agent remembers needs the bureau.memory:read scope, even for your own chats. Ask whoever runs this installation to grant it.',
      },
    },
  },
  'agent-editor': {
    label: 'Agent editor',
    loading: {
      title: 'Loading the agent editor',
      description: 'Reading the agent’s file and the models and tools an agent may use.',
    },
    error: {
      title: 'The agent editor is unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'The agent editor is locked' },
    notFound: {
      title: 'This agent was not found',
      description:
        'There is no agent with this identifier that you can edit. It may have been deleted, or it may be defined in code, which cannot be edited here.',
    },
  },
  workflows: {
    label: 'Workflows',
    loading: {
      title: 'Loading workflows',
      description: 'Reading the workflow definitions and their files.',
    },
    empty: {
      title: 'No workflows yet',
      description:
        'Chat with an agent that has the bureau:workflows-create tool, or add a JSON file to the workflows directory.',
      action: { label: 'New workflow', href: '/workflows/new' },
    },
    error: {
      title: 'Workflows are unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Workflows are locked' },
    notFound: {
      title: 'This workflow was not found',
      description:
        'It may have been deleted, or its file may be gone. Open a workflow from the list.',
    },
    notFoundByPattern: {
      '/workflows/:workflow/edit': {
        title: 'This workflow was not found',
        description:
          'There is no workflow file with this name that you can edit. It may have been deleted, or it may be defined in code, which cannot be edited here.',
      },
    },
    emptyByPattern: {
      '/workflows/:workflow/runs': {
        title: 'This workflow has no runs yet',
        description: 'Nothing has run it. Its runs are listed here once it starts.',
      },
    },
  },
  runs: {
    label: 'Runs',
    loading: { title: 'Loading runs', description: 'Reading what your agents have run.' },
    empty: {
      title: 'No runs yet',
      description: 'Nothing has run yet. Start a chat to see its runs here.',
      action: { label: 'Start a chat', href: '/chats/new' },
    },
    error: {
      title: 'Runs are unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Runs are locked' },
  },
  schedules: {
    label: 'Schedules',
    loading: { title: 'Loading schedules', description: 'Reading the schedules.' },
    empty: {
      title: 'No schedules yet',
      description: 'Create a schedule to start a workflow on a timetable.',
      action: { label: 'Create a schedule', href: '/schedules/new' },
    },
    error: {
      title: 'Schedules are unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Schedules are locked' },
  },
  reviews: {
    label: 'Reviews',
    loading: {
      title: 'Loading reviews',
      description: 'Reading what is waiting for your decision.',
    },
    error: {
      title: 'Reviews are unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Reviews are locked' },
  },
  workers: {
    label: 'Workers',
    loading: {
      title: 'Loading workers',
      description: 'Reading the connected workers.',
    },
    error: {
      title: 'Workers are unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Workers are locked' },
  },
  storage: {
    label: 'Storage',
    loading: {
      title: 'Loading storage',
      description: 'Checking what the storage can do.',
    },
    error: {
      title: 'Storage is unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Storage is locked' },
  },
  audit: {
    label: 'Audit log',
    loading: {
      title: 'Loading the audit trail',
      description: 'Reading the record of what changed.',
    },
    empty: {
      title: 'No audit entries yet',
      description: 'The record of who changed what appears here once something has been done.',
    },
    error: {
      title: 'The audit trail is unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'The audit trail is locked' },
  },
  settings: {
    label: 'Settings',
    loading: {
      title: 'Loading settings',
      description: 'Reading the settings in use.',
    },
    error: {
      title: 'Settings are unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Settings are locked' },
  },
  capabilities: {
    label: 'Capabilities',
    loading: {
      title: 'Loading capabilities',
      description: 'Reading the tools and skills agents can use.',
    },
    error: {
      title: 'Capabilities are unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Capabilities are locked' },
  },
  goals: {
    label: 'Goals',
    loading: { title: 'Loading goals', description: 'Reading the running goals.' },
    empty: {
      title: 'No goals yet',
      description:
        'A goal runs an agent on a prompt until a validator passes. Create one to see it here.',
      action: { label: 'Create a goal', href: '/goals/new' },
    },
    error: {
      title: 'Goals are unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Goals are locked' },
    notFound: {
      title: 'This goal was not found',
      description: 'It may belong to someone else. Open a goal from the list.',
    },
  },
  hooks: {
    label: 'Hooks',
    loading: { title: 'Loading hooks', description: 'Reading the hooks you have written.' },
    empty: {
      title: 'No hooks yet',
      description:
        'A hook does something when an event happens: it sends a signed message, starts a workflow, or notifies you.',
      action: { label: 'New hook', href: '/hooks/new' },
    },
    error: {
      title: 'Hooks are unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Hooks are locked' },
    notFound: {
      title: 'This hook was not found',
      description: 'It may belong to someone else, or it was deleted. Open a hook from the list.',
    },
  },
  health: {
    label: 'Health',
    loading: { title: 'Loading health', description: 'Reading the health overview.' },
    error: {
      title: 'The server is unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'The health overview is locked' },
  },
};

/** Said where a write is confirmed when the storage cannot check that the value is unchanged. */
const UNCHECKED_WRITE_NOTE =
  ' This storage cannot check that the value is unchanged first, so it overwrites whatever the key holds now.';

/** The words the storage explorer (`/health/storage`) uses outside its view states. */
export const STORAGE_COPY = {
  title: 'Storage',
  description: 'The keys this installation stores, and the value of each.',
  /** The accessible name of the group and search controls. */
  filtersLabel: 'Find a key',
  groupLabel: 'Group',
  allGroups: 'All groups',
  searchLabel: 'Search keys',
  searchPlaceholder: 'Search keys',
  /** The accessible name of the table of keys. */
  tableLabel: 'Keys',
  columns: { key: 'Key', group: 'Group', size: 'Size' },
  /** A key that is in no group, because its name has no prefix. */
  noGroup: 'None',
  /** How many keys are loaded, as a sentence. */
  count: (count: number, more: boolean): string =>
    `${String(count)} ${count === 1 ? 'key' : 'keys'}${more ? ' so far' : ''}`,
  loadMore: 'Load more',
  loadingLabel: 'Loading keys',
  empty: {
    title: 'No keys stored yet',
    description: 'Keys appear here once the application stores something.',
  },
  noMatches: {
    title: 'No keys match',
    description: 'Nothing here contains this text. Choose another group or clear the search.',
    clear: 'Clear filters',
  },
  /** A search that has read keys and found none yet, with more to read. */
  keepSearching: {
    title: 'No match among the keys read so far',
    description: (scanned: number): string =>
      `${String(scanned)} ${scanned === 1 ? 'key was' : 'keys were'} read and none contains this text. Load more to keep looking.`,
  },
  failed: {
    title: 'The keys could not be read',
    description: 'The server did not answer. Check that the host is running, then try again.',
  },
  /** The marker on a key the application manages. */
  managedBadge: 'Managed',
  detail: {
    label: 'Selected key',
    emptyTitle: 'Choose a key',
    emptyDescription: 'Pick a key from the table to see its value.',
    group: 'Group',
    size: 'Size',
    key: 'Key',
    copyKey: 'Copy key',
    copyValue: 'Copy value',
    edit: 'Edit',
    delete: 'Delete',
    save: 'Save',
    cancel: 'Cancel',
    jsonSwitch: 'JSON',
    valueLabel: 'Value',
    editLabel: 'Edit the value',
    /** Why a key has no Edit or Delete. */
    managedNote: (prefix: string): string =>
      `The application manages keys that start with ${prefix}, so this one cannot be edited or deleted here.`,
    /** Why no key has Edit or Delete while the managed prefixes are not known. */
    unknownManaged:
      'The application could not say which keys it manages, so no key can be edited or deleted here.',
    binaryNote: 'This value is not text, so it cannot be edited here.',
    notJson: 'The value was JSON and this is not, so it cannot be saved.',
    saveFailed: 'The value was not saved.',
    capabilityUnknown:
      'The storage has not said whether it can check that a value is unchanged, so nothing was written. Try again in a moment.',
    changedUnderYou:
      'The value changed after it was opened, so nothing was written. Open the key again to see what it holds now.',
    deleteFailed: 'The key was not deleted.',
    saved: (key: string): string => `Saved ${key}`,
    deleted: (key: string): string => `Deleted ${key}`,
  },
  confirmSave: {
    title: 'Save this value?',
    description: (key: string, unchecked = false): string =>
      `This replaces the value of ${key}.${unchecked ? UNCHECKED_WRITE_NOTE : ''}`,
    confirm: 'Save',
  },
  confirmDelete: {
    title: 'Delete this key?',
    description: (key: string, unchecked = false): string =>
      `This removes ${key} from storage. It cannot be undone.${unchecked ? UNCHECKED_WRITE_NOTE : ''}`,
    confirm: 'Delete',
  },
  backend: {
    sqlite: 'SQLite',
    postgres: 'Postgres and S3',
    unknown: 'Storage',
    /** The storage line under the title: the backend, then where it is. */
    line: (backend: string, where: string | undefined): string =>
      where === undefined ? backend : `${backend} · ${where}`,
    popoverLabel: 'What the storage can do',
    popoverHint: 'Storage details',
  },
} as const;

/** What plugins add to hooks and workflows (COR-1893). */
export const PLUGIN_KINDS_COPY = {
  /** The fields of a contributed kind, shown by a form drawn from its schema. */
  fieldsHeading: 'Settings',
  /** A contributed kind whose configuration takes no fields. */
  noFields: 'This takes no settings.',
  /** A contributed kind whose schema the form cannot draw. */
  fieldsUnavailable: 'The settings of this kind cannot be shown here.',
  /** The hook editor's choice for a contributed action: what it does, then the plugin. */
  hookAction: (plugin: string, kind: string): string => `Run ${kind} from ${plugin}`,
} as const;
