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
    noChunks: 'This stream has no chunks.',
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
  timelineHeading: 'Timeline',
  eventsHeading: 'Events',
  checkpointsHeading: 'Checkpoints',
  logsHeading: 'Logs',
  relatedHeading: 'Related runs',
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
        'Put this in configuration.json in the bucket. If it exists, add the provider to its providers.',
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
   * What the page shows instead of the form when the catalog holds no model: an agent cannot be
   * saved without one, and nothing in the application can add a provider.
   */
  noProvider: {
    title: 'No model provider yet',
    description:
      'Agents run on a model, and this installation has none connected. Connect a provider, then come back: this page shows the form as soon as the installation offers a model.',
    configurationStep:
      'Put this in the configuration file. If the file exists, add the provider to its providers.',
    secretStep: 'Save the provider’s API key in its own file, readable only by you (chmod 600).',
    restartStep: 'Restart the host, then check again.',
    reload: 'Check again',
    snippetLabel: 'Provider configuration',
  },
  toolsDescription: 'The tools this agent may call.',
  noTools: 'This installation offers no tools.',
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
    emptyTool: 'workflows-create',
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
      /** A code-defined type has no Start action on this page (COR-1855), so something else starts it. */
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
  /** Starting a run from the page's header. */
  startDialog: {
    title: 'Start a run',
    description: (name: string): string => `Starts one run of ${name}.`,
    inputLabel: 'Input',
    inputDescription: 'JSON. Leave empty to start with no input.',
    invalidInput: 'The input must be valid JSON, or left empty.',
    confirm: 'Start run',
    cancel: 'Cancel',
    failed: 'The run was not started',
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
  anyStatus: 'All statuses',
  agentLabel: 'Agent',
  anyAgent: 'All agents',
  loading: 'Loading schedules',
  empty: { title: 'No schedules', description: 'Create one to run an agent on a cadence.' },
  noMatch: {
    title: 'No matching schedules',
    description: 'No schedule matches the current filters. Clear a filter to see more.',
  },
  actionsFor: (name: string): string => `Actions for ${name}`,
  copyId: 'Copy ID',
  idCopied: 'Schedule ID copied',
  idCopyFailed: 'The schedule ID was not copied',
  next: (when: string): string => `next ${when}`,
  neverFired: 'not fired yet',
  lastSucceeded: 'last run succeeded',
  lastFailed: 'last run did not succeed',
  missed: (count: number): string => `${String(count)} missed`,
  lastMissed: (when: string): string => `last missed ${when}`,
  missedWindows: 'Missed fires',
  missedWindow: (range: string, count: number): string => `${range} · ${String(count)} missed`,
  sends: 'Sends',
  nextFires: 'Next fires',
  recentRuns: 'Recent runs',
  noRuns: 'No runs yet. This schedule has not fired.',
  notScheduled: (status: string): string => `Not scheduled. This schedule is ${status}.`,
  engine: 'Advanced',
  engineRows: {
    cron: 'Cron',
    interval: 'Interval',
    jitter: 'Jitter',
    revisionPolicy: 'Revision policy',
  },
  runningNow: 'Running now',
  queuedRuns: 'Queued runs',
  noActiveRuns: 'No active or queued runs.',
  /** The one line that says what happens when a fire is due while a run is still going. */
  overlapLine: {
    skip: 'Skips a fire if the previous run is still going',
    queue: 'Queues a fire if the previous run is still going',
    'cancel-running': 'Cancels the previous run if it is still going when a fire is due',
    allow: 'Starts a fire even if the previous run is still going',
  },
  moreActions: 'More actions',
  backToList: 'Back to schedules',
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
  form: {
    agentLabel: 'Agent',
    agentPlaceholder: 'Choose an agent',
    agentDescription: 'The agent each fire runs. It must be in this installation’s catalog.',
    agentFreeTextDescription: 'The list of agents is unavailable. Enter the agent’s name.',
    noAgents: 'This installation lists no agents.',
    inputLabel: 'What to send',
    inputDescription: 'The text each fire sends to the agent.',
    sessionLabel: 'Session',
    sessionDescription:
      'Optional. Each fire continues this session. Without one, every fire is a new session.',
    sessionWithAllow: 'A schedule that continues a session cannot allow its fires to overlap.',
    overlapLabel: 'If a run is still going when the next fire is due',
    skipOverlapLabel: 'Skip a fire if the previous run is still going',
    advancedLabel: 'Advanced',
    advancedWorkflowLabel: 'Advanced: start a code-defined workflow',
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
    reservedAgentRun:
      'Agent runs are scheduled by choosing an agent, which checks the agent and its owner.',
    reservedBureauWorkflow:
      'Interborough starts this workflow itself, with checks a schedule made here would skip.',
    reservedAgentAuthored:
      'This workflow is agent-authored. Its schedule is the trigger in its file, so change it in the workflow.',
    allTypesReserved:
      'Every registered workflow type here is started from its own screen or by Interborough itself, so none is offered. Enter the name of another workflow type.',
    registryNote:
      'Only workflows defined in code are listed. An agent-authored workflow is scheduled by the trigger in its file.',
    overlayLoading: 'Checking which workflows are agent-authored.',
    notEditable: 'This schedule cannot be edited here',
  },
} as const;

/** The sections of Settings, in the order its section navigation lists them. */
export const SETTINGS_SECTION_COPY = {
  navigation: 'Settings sections',
  general: 'General',
  modelPolicy: 'Model policy',
  dataAndRetention: 'Data and retention',
  apiReference: 'API reference',
} as const;

/** The words of the diagnostics the Health page carries below the engine overview. */
export const HEALTH_DIAGNOSTICS_COPY = {
  title: 'Diagnostics',
  sections: 'Diagnostic sections',
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
  /** The caption of the table, which also says how it is ordered. */
  caption: 'Audit records, oldest first',
  timeColumn: 'Time',
  typeColumn: 'Type',
  resourceColumn: 'Resource',
  actorColumn: 'Actor',
  detailColumn: 'Details',
  noActor: 'None',
  /** The small heading above a record's raw JSON, under the disclosure each row opens. */
  rawRecord: 'Raw record',
  noMatches: {
    title: 'No records match',
    description: 'Nothing in the trail matches this search. Change or clear a filter to see more.',
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
  tabs: { chats: 'Chats', instructions: 'Instructions', settings: 'Settings' },
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
  settings: {
    heading: 'Settings',
    modelLabel: 'Model',
    modelsLabel: 'Models it can be switched to',
    guardrailsLabel: 'Guardrails',
    stepLimitLabel: 'Step limit',
    spendLimitLabel: 'Spend limit per run',
    chatSpendLimitLabel: 'Spend limit per chat',
    toolCallLimitLabel: 'Tool calls per run',
    toolTimeLimitLabel: 'Tool time per run',
    none: 'No limit',
    notSet: 'Not set',
    seconds: (count: number): string => `${String(count)} ${count === 1 ? 'second' : 'seconds'}`,
    usd: (amount: number): string => `$${amount.toFixed(2)}`,
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
  /** What a session with no title is called, in the header and in lists. */
  untitled: 'New chat',
  newChat: 'New chat',
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
  /** What a session with no message in it says in place of its transcript. */
  noMessages: 'No messages yet',
  /** What the chat says when its live connection to the run could not be restored. */
  disconnected: {
    title: 'Disconnected',
    description: 'The connection to this chat dropped and could not be restored.',
    reconnect: 'Reconnect',
  },
  /** What a new chat shows where its transcript will be. */
  newChatWelcome: {
    try: 'Try',
    /** Said before the agents' identifiers under the welcome of a fresh Interborough. */
    agentsLine: 'Agents:',
    promptsLabel: 'Example prompts',
    otherAgents: 'Or start with another agent',
    chooseAgent: 'Choose an agent to start with',
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
  humanRequestTitle: 'The agent is asking',
  humanRequestFallback: 'The agent is waiting for your answer.',
  humanRequestHint: 'Your next message answers it.',
  /** Said while a message waits for the answers sent before it to be applied. */
  answersNotApplied:
    'Your earlier answers have not been applied yet. Your message was not sent; send it again in a moment.',
  /** The typing indicator's label from a Stop until the turn has ended. */
  stopping: 'Stopping…',
  approve: 'Approve',
  deny: 'Deny',
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
  heading: 'Memory',
  backToAgent: (name: string): string => `Back to ${name}`,
  listLabel: 'What this agent remembers',
  searchLabel: 'Search this agent’s memory',
  searchPlaceholder: 'Search memory…',
  searchAction: 'Search',
  clearSearch: 'Clear search',
  loadMore: 'Load more',
  loading: 'Loading memories',
  /** Shown when forgetting leaves the agent with nothing, while the receipt is still on the screen. */
  nothingLeft: 'This agent remembers nothing now.',
  listFailed: 'The memories could not be loaded.',
  noContent: 'This memory has no text.',
  relevance: 'Relevance',
  /** How many memories the agent has; `more` is true when the list has pages left to load. */
  count: (shown: number, more: boolean): string =>
    `${shown}${more ? '+' : ''} ${shown === 1 && !more ? 'memory' : 'memories'}`,
  /**
   * What a search found. The Bureau ranks every memory the agent has and has no score floor, so a
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
  noMatch: (query: string): string => `No memory matches “${query}”`,
  /** The action under an empty search that lists everything again. */
  clearMatch: 'Show all memories',
  /** The kind chip on a row: a short name, and a sentence for the person who did not choose it. */
  kind: {
    operator: { label: 'Operator', description: 'Operator: a correction you wrote' },
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
    /** For a kind the Bureau added that this page has no words for. */
    unknown: (kind: string): string => `${kind}: a kind of memory this page has no description for`,
  },
  /** The names of a row's actions: the memory is named so each row's buttons are told apart. */
  rowAction: {
    forget: (excerpt: string, when: string): string => `Forget: ${excerpt} (${when})`,
    correct: (excerpt: string, when: string): string => `Correct: ${excerpt} (${when})`,
  },
  detail: {
    heading: 'Memory details',
    loading: 'Loading this memory',
    failed: 'This memory could not be loaded.',
    notFound: {
      title: 'This memory was not found',
      description: 'It may have been forgotten, or it may not be yours.',
    },
    close: 'Close details',
    lineage: 'Where this memory came from',
    content: 'Memory',
    fields: {
      source: 'Source',
      trust: 'Trust',
      memoryClass: 'Class',
      created: 'Created',
      session: 'Chat',
      run: 'Run',
      corrects: 'Corrects',
      correctedBy: 'Corrected by',
      legalHold: 'Legal hold',
    },
    /** What a field says when the Bureau recorded nothing for it. */
    notRecorded: 'Not recorded',
    /** The legal hold is learned only from a forget attempt: no read says it. */
    legalHold: {
      unknown: 'Not known until you try to forget this memory',
      held: 'Held: this memory stays stored',
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
    dialog: {
      title: 'Forget this memory?',
      description:
        'The agent stops recalling it, and it leaves this list and search. A copy of it that a chat already saved is not scrubbed.',
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
  correct: {
    action: 'Correct',
    dialog: {
      title: 'Correct this memory',
      description:
        'Your words become a new memory that replaces this one. The agent recalls only the correction; this one is kept and linked from it.',
      label: 'Corrected memory',
      submit: 'Save correction',
      cancel: 'Cancel',
    },
    saved: {
      title: 'Memory corrected',
      description: 'The agent now recalls your correction in place of the old memory.',
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
        description: 'Correcting or forgetting a memory needs the bureau.memory:write scope.',
      },
      'not-found': {
        title: 'This memory was not found',
        description: 'It may have been forgotten, or it may not be yours.',
      },
      other: { title: 'The correction was not saved', description: '' },
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
  readingWait: 'Reading what the run is waiting on.',
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
  /** The label for a review that asks to approve a tool call. */
  toolApproval: 'Tool approval',
  /** The label for a review that asks a question. */
  humanWait: 'Question',
  openChat: 'Open chat',
  openRun: 'Open run',
  unknownAgent: 'An agent',
  untitledChat: 'Untitled chat',
  asks: 'asks:',
  details: 'Details',
  questionFallback: 'It is waiting for your answer.',
  waiting: (count: number): string => `${String(count)} waiting on you`,
  engineHeading: 'Workflow reviews',
  approve: 'Approve',
  deny: 'Deny',
  reject: 'Reject',
  reasonLabel: 'Reason (required to reject)',
  reasonDescription: 'Sent with the decision. A rejection cannot be sent without one.',
  answerLabel: 'Your answer',
  sendAnswer: 'Send answer',
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
  placeholder: 'Search everything',
  untitledChat: CHAT_COPY.untitled,
  emptyTitle: 'Search the console',
  emptyDescription: 'Type the name of a chat or an agent, or an ID, to jump to it.',
  noMatchesTitle: 'No matches',
  noMatchesDescription: (query: string): string => `Nothing matched "${query}".`,
} as const;

/**
 * The words of the notification bell: what needs the person, and what finished. Each sentence
 * names the agent and is followed by the chat or schedule it is about, never a run.
 */
export const NOTIFICATION_COPY = {
  panelTitle: 'Notifications',
  markAllRead: 'Mark all read',
  empty: 'Nothing needs you right now.',
  /** What the bell button is called; the count says how many items need the person. */
  bellLabel: (count: number): string =>
    count === 0 ? 'Notifications' : `Notifications, ${count} need${count === 1 ? 's' : ''} you`,
  needsApproval: (agent: string): string => `${agent} needs your approval`,
  askedQuestion: (agent: string): string => `${agent} asked a question`,
  answered: (agent: string): string => `${agent} answered`,
  failed: (subject: string): string => `${subject} failed`,
  budgetExceeded: (subject: string): string => `${subject} exceeded its budget`,
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
  generalGroup: 'General',
  navigationGroup: 'Go to',
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
  tabs: { tools: 'Tools', skills: 'Skills' },
  filterLabel: { tools: 'Filter tools', skills: 'Filter skills' },
  filterPlaceholder: 'Filter by name',
  listLabel: { tools: 'Tools', skills: 'Skills' },
  count: (shown: number, total: number): string =>
    shown === total ? String(total) : `${String(shown)} of ${String(total)}`,
  detailLabel: { tools: 'Tool details', skills: 'Skill details' },
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
    sources: {
      host: 'Provided by this host',
      bureau: 'Built into Interborough',
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
    emptyByPattern: {
      '/agents/:agent/memories': {
        title: 'This agent remembers nothing yet',
        description:
          'A memory is saved when the agent answers in a chat. Start a chat with it, then come back.',
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
        'Chat with an agent that has the workflows-create tool, or add a JSON file to the workflows directory.',
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
      action: { label: 'Create a schedule', href: '/schedules?create=1' },
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
    label: 'Audit',
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
