import { formatBytes } from '../lib/format/index.ts';
import { HOOKS_COPY } from '../routes/hooks/hook-copy.ts';
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

/** The words for a view's forbidden page: its title, and the scope that opens it when it is known. */
export type ViewForbiddenCopy = {
  readonly title: string;
  readonly requirement?: string;
};

/** A link to a page of the application, with the words on it. */
export type ViewLink = { readonly label: string; readonly href: string };

/**
 * The words for a view's not-found page. A view whose missing thing has a natural next step names
 * it: `create` is a primary button that starts the thing again, and `back` the way back to the list
 * in the view's own words ("Back to chats"). Without them the page is the shared one: two secondary
 * buttons, back to the view's list and Search everything.
 */
export type ViewNotFoundCopy = ViewStateCopy & {
  readonly create?: ViewLink;
  readonly back?: ViewLink;
  /** Leaves out the "Search everything" button, for a page whose only way out is back to its list. */
  readonly searchHidden?: boolean;
};

export type ViewCopy = {
  /** The name of the view in navigation and headings. */
  readonly label: string;
  readonly loading: ViewStateCopy;
  /** Absent for a view that is never empty (`views.ts`, `canBeEmpty`). */
  readonly empty?: ViewEmptyCopy;
  readonly error: ViewStateCopy;
  /**
   * The words for a locked view: the title ("Your sign-in can’t open Hooks") and, when the missing
   * scope is known, the scope that opens it, which the page shows small and monospaced as
   * "requires bureau.hooks:read".
   */
  readonly forbidden: ViewForbiddenCopy;
  /** Present only for a view that opens one item by its address. */
  readonly notFound?: ViewNotFoundCopy;
  /** The words for a route of the view whose missing thing is not the one `notFound` names. */
  readonly notFoundByPattern?: Readonly<Record<string, ViewNotFoundCopy>>;
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
  readonly forbiddenByPattern?: Readonly<Record<string, ViewForbiddenCopy>>;
};

/** The words the run page uses for its steps, and for the lines the run logged. */
export const RUN_STEPS_COPY = {
  heading: 'Steps',
  listLabel: 'Steps',
  detailLabel: 'Step',
  filterLabel: 'Show steps',
  count: (shown: number, total: number): string =>
    shown === total
      ? `${String(total)} ${total === 1 ? 'step' : 'steps'}`
      : `${String(shown)} of ${String(total)} steps`,
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
  logs: 'Logs',
  logsListLabel: 'Log lines of this step',
  logsBeforeFirstListLabel: 'Log lines from before the first step',
  logsBeforeFirst: (lines: number): string =>
    `Logged before the first step, ${lines === 1 ? '1 line' : `${String(lines)} lines`}`,
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
  /** Said under the heading when no run started this one and it has not started any. */
  none: 'No other runs yet.',
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
 * The words a run's page uses beyond its sections: the attributes, streams and updates of a run the
 * workflow engine holds, and what the redesign of its layout added (COR-2017): the names of the
 * workflows Interborough runs itself, and the lines of the finished, failed, canceled and
 * schedule-started runs. Kept apart from `RUN_PAGE_COPY`, so the slices that change the page's
 * other states do not edit the same block.
 */
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
  /**
   * What a person calls each workflow type Interborough registers (the names the design records),
   * set in the interface font; the type's identifier follows it, small, with `builtIn`. A type this
   * table does not name is shown by its identifier in words.
   */
  workflowNames: {
    agentRun: 'Chat with an agent',
    goalRun: 'Work on a goal',
    durableHeartbeatTick: 'Agent heartbeat',
  },
  /** Said after the identifier of a workflow Interborough runs itself. */
  builtIn: '(built in)',
  /** The disclosure under what happened, for what only an operator reads. */
  howItRan: { heading: 'How it ran', caption: 'For operators', rawPayloads: 'Raw payloads' },
  /** Related runs in the rail of a run that is only the Bureau's: the other runs of its chat. */
  related: {
    heading: 'Related runs',
    noneInChat: 'No other runs came from this chat.',
  },
  /** Labels the Details rail adds for a run a goal made, and what its Version reads for a built-in workflow. */
  facts: { goal: 'Goal', builtInVersion: 'Built in' },
  /** The last row of the Started by chain: the run itself, one level in from what started it. */
  lineage: { run: 'Run', thisRun: 'This run' },
  /**
   * The parts of the status line after the day and the time, for a run that has not ended: how long
   * it has run, what a person has to do for it to go on, the signal it waits for, and which attempt
   * of its goal it is. Parts are joined by commas, never a middle dot.
   */
  status: {
    /** How long a run still going has run, after the time it started. */
    soFar: (duration: string): string => `${duration} so far`,
    /** How long a run has waited on a person. */
    waiting: (duration: string): string => `waiting ${duration}`,
    /** What the person does for a run waiting on a question, and for one waiting on an approval. */
    needsAnswer: 'needs an answer to continue',
    needsApproval: 'needs your approval to continue',
    /** The run waits for a signal, which is named after this, in code. */
    waitingForSignal: 'waiting for signal',
    /** Which attempt of its goal a run is, and how long the agent took inside it. */
    attempt: (number: number, of: number): string => `attempt ${String(number)} of ${String(of)}`,
    agentTook: (duration: string): string => `Agent took ${duration}`,
  },
  /** The heading of a page whose run is not yet known: the run's identifier names it. */
  runHeading: (runId: string): string => `Run ${runId}`,
  /** What a run page says while it, or what it needs, is slow to arrive or was left unread. */
  states: {
    /** Under the placeholders after ten seconds, as Cinder's skeleton writes it. */
    stillLoading: 'Still loading this run. This is taking longer than usual.',
    /** What replaces the page's sections after Cancel on a slow read. */
    loadingCanceled: {
      title: 'Loading canceled',
      description: 'This run didn’t finish loading. Nothing is missing; it just wasn’t fetched.',
    },
    /** The accessible name of the placeholders under What happened. */
    loadingHappened: 'Loading what happened',
  },
  /** What a run page says it is waiting for, and what it has not yet got. */
  waits: {
    /** The line under What you can do: how many questions and approvals the run waits on. */
    summary: (questions: number, approvals: number): string => {
      const parts: string[] = [];
      if (questions > 0) {
        parts.push(questions === 1 ? 'one question' : `${String(questions)} questions`);
      }
      if (approvals > 0) {
        parts.push(approvals === 1 ? 'one approval' : `${String(approvals)} approvals`);
      }
      return `This run is waiting on ${parts.join(' and ')}.`;
    },
  },
  /** What happened: the section of what the run did, in order, with the time since it started. */
  happened: {
    heading: 'What happened',
    /** The accessible name of the list of entries. */
    listLabel: 'What happened, in order',
    /** The first entry, with the clock time the run started. */
    started: (clock: string): string => `Started ${clock}`,
    /** Under Started: what set the run going, when the message in is known. */
    startedByMessage: (clock: string): string => `You sent a message in the chat at ${clock}`,
    /** The entry of a run waiting for a person, and what it waits for. */
    askedApproval: 'Asked for approval',
    askedAnswer: 'Asked a question',
    waitingForApproval: 'Waiting for your approval',
    waitingForAnswer: 'Waiting for your answer',
    /** The entry that says what comes after a wait. */
    nextSteps: 'Next steps',
    nextApprovalWords: 'Continue once you’ve approved or denied',
    nextAnswerWords: 'Continue once you’ve answered',
    /** The last entry of a run that is still going and has not replied. */
    replied: 'Replied',
    notRun: 'Not run yet',
    /** Under a tool call: how long it ran. */
    ranIn: (name: string, duration: string): string => `${name}, ran in ${duration}`,
  },
  /** The header's links to the goal or the schedule a run belongs to, and to set up another run. */
  openGoal: 'Open goal',
  openSchedule: 'Open schedule',
  runAgain: 'Run again',
  /** The Input and output section: what each card is called, and the sentence under the heading. */
  io: {
    /** Under the heading of a run that answered a chat message. */
    chatDescription:
      'The message that started the run, what it answered, and the steps in between.',
    /** Under the heading of a run of a workflow: its input and what it produced. */
    workflowDescription: 'What this run was started with, and what it produced.',
    /** Under the heading of a run a schedule started, which has no chat. */
    scheduleDescription:
      'A schedule run has no chat, so the schedule’s prompt is the input and the result is the output.',
    input: 'Input',
    output: 'Output',
    /** The card of the message that started a chat run, and who it is from. */
    messageIn: 'Message in',
    fromYou: 'From you',
    /** The card of what the agent answered, and who it is from. */
    replyOut: 'Reply out',
    fromAgent: (agent: string): string => `From ${agent}`,
    /** The card of a schedule run's prompt and result. */
    prompt: 'Prompt',
    fromSchedule: 'From the schedule',
    result: 'Result',
    /** Under the message in: where and when it was sent. */
    sentInChat: (when: string): string => `Sent in the chat, ${when}`,
    /** Under the reply out, with the link that opens the raw payloads. */
    deliveredToChat: 'Delivered to the chat',
    showRawPayloads: 'Show raw payloads',
    /** Said while the chat's thread is read for the message in. */
    loadingMessage: 'Loading the message',
    /** The message in could not be found in the chat's thread. */
    noMessageIn: 'The message that started this run is not kept in the chat.',
    /** The reply out of a run that waits on a person: what it waits for, in place of an answer. */
    noReplyWaitingAnswer: 'No reply yet. It’s waiting for your answer.',
    noReplyWaitingApproval: 'No reply yet. It’s waiting for your approval.',
    /** The output of a workflow run still going. */
    appearsWhenFinished: 'Appears when the run finishes.',
    /** The output of a run that failed. */
    noOutputFailed: 'No output. The run failed, so it never produced one.',
    /** The output of a run that ended without one. */
    noOutputEnded: (how: string): string => `No output. The run ${how}.`,
    /** A long reply held to a few lines, and the control that opens it. */
    showAll: 'Show all',
    showLess: 'Show less',
    /** Said in a polite live region when the Fields or JSON choice changes, for every card at once. */
    viewAnnouncement: {
      fields: 'All payloads now show Fields.',
      json: 'All payloads now show JSON.',
    },
  },
} as const;

/**
 * What the application says when the server does not answer: the title a turned-off control shows,
 * and the page that replaces a view with nothing to show. The banner's own words come from Cinder's
 * `offline`, `unreachable` and `stopped` presets, so no page words them differently.
 */
export const CONNECTION_COPY = {
  /**
   * The reason a control that changes something is off while the server is unreachable: its title,
   * and the visible text beside a composer's Send.
   */
  changesOff: 'Off until it’s back',
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
 * The words every not-found page shares (design rows 12x and 12y): the sentence under the title,
 * the breadcrumb that replaces the missing thing's name, and the two secondary buttons. The title
 * names the thing ("This run doesn’t exist") and is each view's own.
 */
export const NOT_FOUND_COPY = {
  description: 'It may have been deleted. The address might also be mistyped.',
  /** The last part of the breadcrumb, in words: Runs › Not found. */
  breadcrumb: 'Not found',
  /** The name of the button that returns to the list the missing thing belonged to. */
  back: (label: string): string => `Back to ${label}`,
  search: 'Search everything',
} as const;

/**
 * The words for an address no route matches. It is not one of a view's states: no view owns the
 * address, so the outlet shows this in its own frame (`data-view="not-found"`), and it leads back
 * to Home.
 */
export const NOT_FOUND_ROUTE_COPY = {
  title: 'This page doesn’t exist',
  description: NOT_FOUND_COPY.description,
} as const;

/**
 * The words every forbidden page shares (design rows 12z and 13a): the sentence under the title,
 * which points at the page that shows what the session may do, and the two secondary buttons.
 * There is no request-access button, because single-user v1 has no such flow.
 */
export const FORBIDDEN_COPY = {
  /** The title of a view that is locked: "Your sign-in can’t open Hooks". */
  title: (label: string): string => `Your sign-in can’t open ${label}`,
  description: 'Settings › API reference › Your scopes shows what it can do.',
  scopes: { label: 'See your scopes', href: '/settings/api-reference?group=scopes' },
  home: 'Back to Home',
} as const;

/** The words for a reasoning effort, from least to most: the agent editor, the agent page and Model policy say them alike. */
export const EFFORT_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Maximum',
} as const;

/** The words the agent editor uses outside its view states (`/agents/new`, `/agents/:agent/edit`). */
export const AGENT_EDITOR_COPY = {
  createHeading: 'New agent',
  /**
   * The New agent form (`/agents/new`, board PageAgentEditor): the line under the heading, the
   * identifier the name sets and the field that changes it, what a submit says at a field, the
   * tools table and its Asks selects, the question before leaving with unsaved changes, and what
   * the form says while a save is in flight, when it fails, and when it is not answered.
   */
  newAgent: {
    /** The line under the heading (row 41a). */
    subtitle:
      'An agent is a model with instructions and tools. Try it beside the form before you save.',
    /** The icon button beside the file path (row 41c), and what it says once it has copied. */
    copyFilePath: 'Copy the file path',
    copiedFilePath: 'File path copied',
    /** What follows the identifier while it follows the name (row 41e). */
    setFromName: ', set from the name',
    /** The link that turns the identifier into a field (rows 41e, 42x), and its accessible name. */
    changeIdentifier: 'Change',
    changeIdentifierLabel: 'Change the ID',
    /** The hint under the identifier field once it can be changed (row 42x). */
    identifierHint:
      'Lowercase letters, numbers and hyphens. It appears in URLs and wherever you type the agent’s name.',
    /** The action that puts the identifier back to the one the name sets (row 42x). */
    resetIdentifier: (identifier: string): string => `Reset to ${identifier}`,
    /** The message at Name after a submit with no name (row 42m). */
    nameRequired: 'Enter a name. It becomes the agent’s ID.',
    /** The message at Name when it holds no letter or digit an identifier could be made of. */
    nameNeedsLetters: 'Use letters or numbers in the name. It becomes the agent’s ID.',
    /** The message at Name when the identifier it sets is taken (rows 42n, 14u). */
    nameTaken: (name: string): string =>
      `An agent named ${name} already exists. Pick another name.`,
    /** The message at Model after a submit with no model, or one that cannot be saved (row 42m). */
    modelRequired: 'Choose a model so the agent can answer.',
    /** What leads the link to Settings › Models under the abilities (row 41h). */
    notListed: 'Not listed? Connect a provider in',
    /** The model field when the catalog did not load (row 42v): a failure, so a danger callout. */
    modelsFailed: {
      placeholder: 'No models to show',
      title: 'Couldn’t load models',
      description: 'The provider list didn’t load. You can keep editing.',
      retry: 'Try again',
    },
    /** The Tools section while the catalog has not loaded: its tools come with its models. */
    toolsWaitOnModels: 'The tools load with the models.',
    /** The counter at the right of the Instructions label (row 41i), as two words. */
    instructionsFormat: 'Markdown',
    wordCount: (count: number): string => (count === 1 ? '1 word' : `${String(count)} words`),
    /** The count beside the Tools title (row 41k), such as `3 of 9`. */
    toolCount: (chosen: number, offered: number): string =>
      `${String(chosen)} of ${String(offered)}`,
    /** The tools table (rows 41k, 41l): its caption and columns. */
    toolsCaption: 'The tools this agent may call',
    columns: { tool: 'Tool', risk: 'Risk', asks: 'Asks' },
    /** The accessible name of a row's Asks select. */
    asksLabel: (tool: string): string => `When ${tool} asks first`,
    /** An Asks option; the tool's own default says so (row 41l). */
    asksOption: (level: string, isDefault: boolean): string =>
      isDefault ? `${level} (default)` : level,
    /** The note under the tools table (row 41m). */
    asksNote:
      'Each Asks level starts at the tool’s default and is set here with one select per row while the agent is new; once it is saved, the Access tab owns the levels and every change there saves a version.',
    /** The sticky bar's status while a save is in flight (rows 43j, 14w). */
    saving: 'Saving…',
    /** The banner's text when the server failed a save (row 42w), or did not answer at all. */
    serverError: (status: number | undefined): string =>
      status === undefined
        ? 'Interborough didn’t answer. Nothing was changed. What you typed is still here.'
        : `The server answered with an error (${String(status)}). Nothing was changed. What you typed is still here.`,
    /** What the form says when a save has had no answer for 15 seconds (row 14x). */
    timedOut: 'Couldn’t confirm the save. Your changes are still here.',
    tryAgain: 'Try again',
    /** The question before leaving a form that differs from what was saved (rows 42o, 42p). */
    leave: {
      title: 'Leave without saving?',
      description: (changed: readonly string[]): string =>
        `This agent has changes that aren’t saved: ${nameList(changed)}. Leaving discards them.`,
      keep: 'Keep editing',
      discard: 'Discard and leave',
    },
  },
  /**
   * The Edit agent form (`/agents/:agent/edit`, board PageAgentEditor, rows 41q to 43k): the line
   * under the heading, the read-only lines that stand for what the Settings and Access tabs own (the
   * model, the tools, the guardrails and the spend limit), the reference documents, the block that
   * holds the delete, the sticky bar's saved status, and what the form says while the agent loads.
   * Every separator is a comma or a full stop, never a middle dot.
   */
  edit: {
    /** The line under the heading (row 41q). */
    subtitle:
      'Changes are saved as a new version. Running chats keep the version they started with.',
    /** The same line while a save is in flight, naming the version it makes (row 43k). */
    subtitleSaving: (revision: number): string =>
      `Changes are saved as a new version (Version ${String(revision)} once this finishes).`,
    /** The message at Name when a saved agent's name is emptied and Save is pressed (row 41s). */
    nameRequired: 'Enter a name.',
    /** The label before the saved identifier, which is shown small and monospaced (row 41s). */
    idLabel: 'ID',
    /** The sticky bar's status for the version the agent is at (row 41y). */
    saved: (revision: number): string => `Saved, Version ${String(revision)}`,
    /** What the form announces and the sticky summary reads while the agent loads (rows 43h, 43i). */
    loading: 'Loading agent',
    /**
     * The model of a saved agent (row 41u): read-only text, with where to change it. The model is
     * saved on the Settings tab, so a person who cannot save here because of it is sent there.
     */
    model: {
      /** The model's name and its provider's, as one line. */
      value: (model: string, provider: string): string => `${model}, ${provider}`,
      /** The note under the model: a link on "Settings tab" sits between these two halves. */
      changeLead: 'Change it on the ',
      settingsTab: 'Settings tab',
      changeTail: '; a saved agent’s model is saved there.',
      /** The notice when the agent's own model is only turned off: a save keeps it. */
      keptNotice: (model: string, reason: string): string =>
        `This agent’s model, ${model}, is not offered now. ${reason} Saving keeps it.`,
      /** The notice when the model policy forbids it: a save is refused and a run fails. */
      refusedNotice: (model: string, reason: string): string =>
        `This agent’s model, ${model}, is not offered now. ${reason} Saving is refused and a run fails until another model is chosen on the Settings tab.`,
      /** The notice when the model is retired or gone from the catalog: a save is refused. */
      replacementNotice: (model: string, reason: string): string =>
        `This agent’s model, ${model}, is not offered now. ${reason} Saving is refused until another model is chosen on the Settings tab.`,
    },
    /** The tools line (row 41v): the count, then a link on "Access tab" between these two halves. */
    tools: {
      count: (count: number): string => (count === 1 ? '1 tool.' : `${String(count)} tools.`),
      changeLead: 'Change on the ',
      accessTab: 'Access tab',
      changeTail: '.',
    },
    /** The guardrails and spend line (row 41w), then a link on "Access tab" and what a change there does. */
    guardrails: {
      summary: (guardrails: readonly string[], spendLimit: string | null): string =>
        `Guardrails: ${guardrails.length === 0 ? 'none' : guardrails.join(', ')}. Spend limit: ${spendLimit ?? 'none'}.`,
      spendPerRun: (usd: string): string => `$${usd} per run`,
      changeLead: 'Change on the ',
      accessTab: 'Access tab',
      changeTail: '. Changes there save a version on their own.',
    },
    /** The reference documents the file reads (row 41t); each can be removed with the next save. */
    references: {
      heading: 'Reference documents',
      note: 'Read with every chat',
      none: 'No reference documents',
      removeLabel: (path: string): string => `Remove ${path}`,
    },
    /** The demoted block at the foot of the form that holds the delete (row 41x). */
    deleteBlock: {
      title: 'Delete this agent',
      description: (name: string): string =>
        `${name} is an agent you created, so it can be deleted. Chats that already happened keep the version they used.`,
    },
  },
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
    /** The header button that opens Try it below 1024px (rows 43t, 44a). */
    action: 'Try it',
    /** The title of the panel beside the form, and of the sheet (rows 41n, 43x). */
    title: 'Try it',
    /** Said when the agent names reference documents, which a trial runs without. */
    leftOut: (documents: readonly string[]): string =>
      `This agent reads ${documents.length === 1 ? 'a document' : 'documents'} that ${documents.length === 1 ? 'is' : 'are'} not available in a trial, so the trial runs without ${documents.length === 1 ? 'it' : 'them'}: ${documents.join(', ')}.`,
    /** The line under the title: what the trial runs on. */
    usesChanges: 'Uses your unsaved changes',
    /** Said beside `usesChanges` once the host reports a model provider with a key (rows 43g, 43x). */
    providerConnected: 'Provider connected',
    /** The line above an approval the test run is parked on (row 43d). */
    waitingOn: (tool: string): string => `Waiting on you for ${tool}`,
    /** The context line of an approval inside Try it: answering it runs the tool for real (row 43e). */
    testChat: 'Test chat, this runs for real',
    /** The accessible name of the sheet's Close control, which keeps the transcript (rows 43x, 43z). */
    closeSheet: 'Close',
    /** The page's subtitle on a tablet, where Try it opens from the header (row 44a). */
    subtitleTablet: 'An agent is a model with instructions and tools. Try it before you save.',
    /** The page's subtitle on a phone (row 43u). */
    subtitlePhone: 'An agent is a model with instructions and tools.',
    /** The new agent form's sticky status while nothing is saved yet (rows 43w, 44b). */
    notSavedYet: 'Not saved yet',
    messagePlaceholder: 'Send a test message',
    /** The line under the composer, said while no other status is. */
    hint: 'Tools run for real, under this agent’s approval rules. Test chats aren’t saved and leave no memories.',
    chatLabel: 'Trial chat',
    /** Ends the chat and starts a fresh one with the form as it is now. */
    startOver: 'Reset',
    /** The title of a test answer that failed, and what it adds to the reason: the trial saves nothing. */
    failureTitle: 'Couldn’t get an answer',
    nothingSaved: 'Nothing was saved.',
    tryAgain: 'Try again',
    /** The name of a tool call that is running, "Using Lookup order…", and one that finished. */
    usingTool: 'Using',
    usedTool: 'Used',
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
      description:
        'An agent needs a model to answer. This installation keeps its provider keys in its deployment, so connect one there, then check again.',
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
  /** The keyboard shortcut's group in the `?` map. */
  shortcutGroup: 'Agent editor',
  nameLabel: 'Name',
  nameDescription: 'What people see.',
  identifierLabel: 'Identifier',
  identifierCreateDescription: 'The file name, without .md. Fixed once saved.',
  /** What an identifier that is not a file name gets at its field on submit (row 42y). */
  identifierInvalid: 'Use lowercase letters, numbers and hyphens, for example order-helper.',
  /** `new` is the address of the page that creates an agent, so an agent called `new` could never be opened. */
  identifierReserved:
    'This identifier is reserved: /agents/new is the page that creates an agent, so an agent called new could never be opened. Choose another.',
  /**
   * What a typed identifier the Bureau refused gets at its field (row 42y), whether a file or an
   * agent defined in code holds it. An identifier the name set says so at the name instead
   * (`newAgent.nameTaken`).
   */
  identifierTaken: (identifier: string): string =>
    `An agent with the ID ${identifier} already exists. Pick another ID.`,
  descriptionLabel: 'Description',
  /** The helper under Description (row 41f). */
  descriptionDescription: 'Shown in the agent list and when picking an agent.',
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
   * The default effort field (`agent-editor-effort-field.svelte`): the reasoning effort a chat of
   * the agent starts at, limited to what the chosen model supports.
   */
  effort: {
    label: 'Default effort',
    description:
      'How hard a chat of this agent thinks until the person changes it in the chat. None leaves the provider’s own default.',
    /** The option that leaves the file without an effort. */
    none: 'None',
    /** The select's note for a model that has no effort control. */
    notSupportedByModel: 'This model does not support a default effort.',
    /** What the field says when a change of model dropped an effort the new model cannot do. */
    cleared: (effort: string, model: string): string =>
      `${effort} effort is not supported by ${model}, so the default effort was cleared. Choose another, or leave it as None.`,
    /** Why the effort the file holds cannot be saved with the file's own model. */
    unsupported: (effort: string, model: string): string =>
      `${model} does not support ${effort} effort. Choose another effort or None, or choose another model.`,
  },
  /**
   * What the page shows instead of the form when the catalog holds no model: an agent cannot be
   * saved without one, and nothing in the application can add a provider.
   */
  noProvider: {
    title: 'No model provider yet',
    /** What the card says under its title (row 42b). */
    description:
      'An agent needs a model to answer. Connect a provider in Settings › Models; you return to this form afterwards.',
    /** The line under Connect a provider (row 42b). */
    blocked: 'Nothing else on this form works until then.',
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
  noTools: 'This installation offers no tools.',
  /** What the list says when the agent has no tool yet. */
  noToolsChosen: 'No tools chosen. The agent can reply, but it cannot call anything.',
  /** The action that opens the picker. */
  addToolsAction: 'Add tools',
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
  /** Save on the New agent form (row 42n): the sticky bar reads Cancel, then Save. */
  createAction: 'Save',
  saveAction: 'Save changes',
  cancelAction: 'Cancel',
  deleteAction: 'Delete agent',
  deleteDialog: {
    title: 'Delete this agent?',
    description: (name: string): string =>
      `This removes the file for ${name}. Runs that already happened keep the version they used.`,
    confirm: 'Delete agent',
  },
  /** The title of the banner above the form when a save failed (row 42w). */
  saveFailed: 'Couldn’t save the agent',
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
    /** The line under the heading. */
    subtitle: 'Repeatable sequences of steps you built.',
    /** The segments above the rows, and the name of the group they form. */
    segmentsLabel: 'Show workflows',
    segments: { all: 'All', paused: 'Paused', problems: 'Problems' },
    /** The accessible name of the rows. */
    rowsLabel: 'Workflows',
    clearAction: 'Clear filters',
    noMatch: {
      title: 'No workflow matches this filter',
      description: 'Choose another segment to see more workflows.',
    },
    /** The words in the status column: only a workflow that is paused or cannot load has one. */
    statusCantLoad: "Can't load",
    statusPaused: 'Paused',
    /** The right edge of a row that has not run. */
    neverRun: 'Never run',
    /** The right edge of a row with a run in progress: when that run began. */
    started: (time: string): string => `Started ${time}`,
    /** The line under a title: the steps of the file, then how many runs began lately. */
    steps: (count: number): string => `${String(count)} ${count === 1 ? 'step' : 'steps'}`,
    runs: (count: number): string => `${String(count)} ${count === 1 ? 'run' : 'runs'} in 24 hours`,
    /** The run in progress, in the line under a title. */
    runningNow: 'Running',
    /** A file the Bureau cannot use, named by its file. */
    fileName: (id: string): string => `${id}.json`,
    schedules: (count: number): string => `${String(count)} schedules`,
    onSignal: 'On the signal',
    /** The card under the rows that leads to the types Interborough runs itself. */
    internalCard: {
      title: 'Internal workflows',
      count: (count: number): string =>
        `${String(count)} ${count === 1 ? 'workflow' : 'workflows'}`,
      description:
        'Interborough runs these for chats, goals and schedules. You can watch their runs but not change them.',
    },
    /** First use: the empty state is the page. */
    empty: {
      title: 'No workflows yet',
      description:
        'A workflow is a set of steps that agents and tools run in order. Build one yourself, or, once a provider is connected, describe it and an agent drafts it.',
      askAction: 'Ask an agent to write one',
      hintBefore: 'Or add a file to',
      /** Where the files are when the host does not say. */
      hintDirectory: '~/.interborough/workflows',
    },
  },
  /** The page of the workflows Interborough runs itself (`/internal-workflows`). */
  internal: {
    title: 'Internal workflows',
    /** The page's entry in the breadcrumb trail, after Workflows. */
    crumb: 'Internal',
    description:
      'Interborough starts these itself to carry out chats, goals and schedules. You can watch their runs, but not start, edit or pause them.',
    columns: {
      workflow: 'Workflow',
      description: 'What it does',
      runs: 'Runs',
      lastRun: 'Last run',
    },
    caption: 'Internal workflows',
    noDescription: 'No description.',
    /** The last run of a type that has not run. */
    neverRun: 'Never run',
    /**
     * What a person calls each type Interborough registers, and what it does. A type this table
     * does not name is shown by its identifier in words and the engine's own description.
     */
    types: {
      agentRun: {
        title: 'Chat with an agent',
        description:
          'Runs an agent for a chat or a schedule: the agent reads the conversation, calls its tools and replies.',
      },
      goalRun: {
        title: 'Goal attempts',
        description:
          'Runs an agent again and again until a goal check passes, up to the goal attempt limit.',
      },
      durableHeartbeatTick: {
        title: 'Schedule tick',
        description: 'Wakes up on a timer and starts any schedule that has come due.',
      },
      scheduleTick: {
        title: 'Schedule record',
        description: 'Records what the scheduler did each time a schedule came due.',
      },
    },
    /** There is nothing to list because the engine has registered none: said as the environment, not as a promise. */
    empty: {
      title: 'No internal workflows registered',
      description:
        'The engine this host talks to has not registered the workflows Interborough runs for chats, goals and schedules. They are listed here once it does, which happens when Interborough is started against its own engine.',
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
    /** The header of a workflow's page: the lines under the title, in the order they are read. */
    header: {
      /** "Starts every Friday at 11:00 AM": what starts the workflow, read from its trigger. */
      starts: (when: string): string => `Starts ${when}`,
      /** The words around a signal's identifier, which is set in monospace between them. */
      startsOnSignal: { before: 'Starts when a signal arrives (', after: ')' },
      /** Several schedules start a type that code registered. */
      startsFromMany: (count: number): string => `Starts from ${String(count)} schedules`,
      startYourself: 'you can also start it yourself',
      runsAs: (agent: string): string => `runs as ${agent}`,
      /** "Last run" and the date, which is a link to the run, follow each other. */
      lastRunLabel: 'Last run',
      lastRun: (when: string): string => `Last run ${when}`,
      /** The last run of a type Interborough runs itself, said as the day it began. */
      lastRunToday: (clock: string): string => `Last run today, ${clock}`,
      neverRun: 'Never run',
      /** "file" and the file's name, which is set in monospace, follow each other. */
      fileLabel: 'file',
      /** The schedule the file defines, with its name as a link between these. */
      scheduleDefined: { before: 'Schedule: ', after: ', defined in this file.' },
      /** A schedule that starts the workflow without being defined in the file. */
      alsoStartedBy: { before: 'Also started by the ', after: ' schedule' },
      alsoStartedByMany: (count: number): string => `Also started by ${String(count)} schedules.`,
      /** After "Also started by the X schedule": its state, or its cadence when it is active. */
      schedulePaused: 'paused',
      scheduleNote: (note: string): string => ` (${note}).`,
      scheduleEnd: '.',
      /** An internal workflow's line: built in, its identifier, what starts it, and when it last ran. */
      builtIn: 'Built in',
      /** What starts each internal type, after the words "Started by". */
      startedBy: {
        agentRun: 'chats and schedules',
        goalRun: 'goals',
        durableHeartbeatTick: 'a timer',
        scheduleTick: 'schedules',
      },
      startedByPrefix: (who: string): string => `Started by ${who}`,
    },
    /** The tab names with a count after the label, once the count is known. */
    tabWithCount: (label: string, count: number): string => `${label} ${String(count)}`,
    /** What the offline banner says it is showing, and the name of the body while it loads. */
    offlineSubject: 'this workflow',
    loadingLabel: 'Loading this workflow',
    /** The button on an internal workflow's page that leads to the rest of them. */
    seeInternal: 'See all internal workflows',
    /**
     * The header's "⋯" menu (board PageWorkflow, "More menu, and Delete" and "More menu on an
     * active workflow"), and the dialog its Send a signal item opens. Resume is the header's own
     * action on a paused workflow, so the menu never repeats it.
     */
    menu: {
      label: 'More actions',
      sendSignal: 'Send a signal…',
      /** The footer button that ends the dialog; the dialog's own corner button is also named "Close". */
      closeSignal: 'Done',
      duplicate: 'Duplicate',
      pause: 'Pause',
      /** The line under Pause: what pausing does to the runs in flight and to the ones to come. */
      pauseDescription:
        'Runs in flight finish. No new runs start, from schedules, signals or Start run, until you resume it.',
      /** Red, and it opens the delete dialog, so it ends with an ellipsis. */
      delete: 'Delete…',
      /** The title the copy a Duplicate writes takes, from the workflow's own. */
      copyTitle: (title: string): string => `${title} copy`,
      duplicateFailed: 'The workflow was not duplicated',
      /** Every identifier a copy could take is in use. */
      duplicateTaken: (id: string): string =>
        `Every name for a copy of ${id} is taken. Rename or delete a copy, then duplicate it again.`,
    },
    /** The body of an internal workflow's Overview. */
    internalOverview:
      'Interborough starts this workflow itself each time it is needed. You can watch its runs, but not start, edit or pause it.',
    /** The one sentence under the title of an internal workflow, where the page says it shorter than the list does. */
    internalSummaryByType: {
      agentRun: 'Runs an agent for a chat or a schedule.',
    },
    /** The body of the Overview of Chat with an agent, the one internal type whose use is known. */
    internalOverviewByType: {
      agentRun:
        'Interborough starts this workflow itself each time an agent answers in a chat or a schedule fires. You can watch its runs, but not start, edit or pause it.',
    },
    /** The steps of a file, as numbered rows. */
    steps: {
      kindAgent: (agent: string): string => `Ask an agent, ${agent}`,
      kindAgentUnnamed: 'Ask an agent',
      kindSignal: 'Wait for a signal',
      kindPerson: 'Wait for a person',
      kindSleep: (duration: string): string => `Wait ${duration}`,
      waitingForSignal: 'The run reads Waiting until the signal arrives.',
      waitingForPerson: 'Shows in Reviews until someone approves or denies.',
      /** The title of a step the file does not name. */
      untitled: (position: number): string => `Step ${String(position)}`,
      /** A long list shows its first step, and this row opens the rest. */
      more: (count: number): string => `${String(count)} more ${count === 1 ? 'step' : 'steps'}`,
      fewer: 'Show fewer steps',
    },
    /** The "View JSON Schema" link beside Input and Output. */
    schemaRawLabel: 'View JSON Schema',
    /** The Overview tab. */
    overview: {
      inputLabel: 'Input',
      outputLabel: 'Output',
      /** Shown when a workflow declares no schema, instead of an empty list of fields. */
      noSchema: 'Declares no schema.',
      stepsEmptyTitle: 'This workflow has no steps',
      stepsEmptyDescription: 'Add a step to its file and it appears here.',
    },
    /**
     * The Runs tab: the Runs list's rows and filters, limited to this workflow (board PageWorkflow,
     * "Runs tab"), and the compact empty state when it has none ("Runs tab, empty").
     */
    runs: {
      /** The accessible names of the filter bar and of the rows. */
      filtersLabel: 'Filter this workflow’s runs',
      rowsLabel: 'Runs of this workflow, newest first',
      emptyTitle: 'No runs of this workflow yet',
      emptyDescription: 'Start one and it shows up here with its steps and result.',
      /** The plain hint under the sentence, which names the header's action. */
      emptyHint: 'Press Start run to try it.',
      /** A paused file starts nothing, so its empty state says why rather than promising a run. */
      emptyDescriptionPaused:
        'This workflow is paused, so nothing starts it. Its runs show up here once you resume it.',
      emptyHintPaused: 'Press Resume to start it again.',
      /** A type that code registered is also started by its schedules, so the empty state names no one starter. */
      emptyDescriptionCode: 'A run shows up here as soon as something starts one.',
      /** Filters that leave none of this workflow's runs. */
      noMatchTitle: 'No run of this workflow matches these filters',
      noMatchDescription: 'Choose All, or remove Started by, to see its other runs.',
    },
    /** The Code tab. */
    code: {
      /** The line above the file: what it is, where it is, and that it cannot be edited here. */
      caption: { before: 'JSON, ', after: ', read-only' },
      /** The outline beside the file, and the select that stands in for it on a phone. */
      outlineTitle: 'Outline',
      outlineSelect: 'Jump to',
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
    /** A file the Bureau cannot read: the banner under the tabs, and the line the problem is marked on. */
    problem: {
      /** The sentence that names the file, and the line when the page can find it. */
      located: (file: string, line: number, reason: string): string =>
        `${file}, line ${String(line)}: ${reason}.`,
      unlocated: (file: string, message: string): string => `${file}: ${message}`,
      startOff: 'Start run is off until the file is fixed. Runs that already started keep going.',
      openCode: 'Open Code',
      editAsJson: 'Edit as JSON',
      /** The note drawn under the marked line. */
      missingComma: (stoppedAt: number): string =>
        `Missing comma at the end of this line. The parser stopped at line ${String(stoppedAt)}.`,
      stopped: (stoppedAt: number): string => `The parser stopped at line ${String(stoppedAt)}.`,
      expectedComma: 'expected a comma',
    },
    /** The page when nothing says it exists: the words the frame shows too (`VIEW_COPY.workflows`). */
    notFound: {
      title: 'Workflow not found',
      description:
        'This workflow doesn’t exist, or its file was removed. Check the link, or go back to the list.',
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
    description: 'Choose what to run. Next you’ll set its input and when it starts.',
    /** The field's label. The required dot after it is Cinder's, never the word. */
    fieldLabel: 'Workflow',
    fieldPlaceholder: 'Choose a workflow',
    /** Why a listed workflow cannot be picked: said beside its name, which stays in the list. */
    pausedReason: 'paused',
    invalidReason: 'can’t load',
    /** Said under the field when Continue is pressed with nothing picked. */
    pickError: 'Pick a workflow to continue.',
    cancel: 'Cancel',
    continue: 'Continue',
    loadFailedTitle: 'The workflows could not be loaded',
    loadFailedDescription: 'Try again, or check that you may read workflows.',
    emptyTitle: 'No workflow can run yet',
    emptyDescription: 'Make a workflow, and it appears here to run.',
    emptyAction: 'New workflow',
  },
  /** `/workflows/new` (board PageWorkflowBuilder, "New workflow"). */
  creator: {
    heading: 'New workflow',
    description: 'Say when it starts and what it does. The builder and the JSON file stay in sync.',
    textLabel: 'Workflow file',
    /** The note under the JSON tab's editor (board PageWorkflowBuilder, "JSON tab"). */
    textDescription:
      'The file the builder writes; while it is valid JSON it is the same as the builder. It uses the extended workflow file format: timezone and catchUp on a schedule trigger, a manual trigger kind, and a title on the workflow and on each step. Bureau strips title before Weft sees the document. Keys the builder doesn’t show are saved exactly as written.',
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
  },
  /**
   * The builder of `/workflows/new` and `/workflows/:workflow/edit` (board PageWorkflowBuilder):
   * Title and ID, Description, Starts, the steps as numbered cards, Input and Output, and the
   * read-back sentence in the footer.
   */
  builder: {
    shortcutGroup: 'Workflow builder',
    tabsLabel: 'How to edit the workflow',
    builderTab: 'Builder',
    jsonTab: 'JSON',
    /** The workflow's `title`, the name a person reads. */
    titleLabel: 'Title (optional)',
    titlePlaceholder: 'e.g. Morning briefing',
    /** The workflow's identifier, the file's `name`. */
    idLabel: 'ID',
    idPlaceholder: 'e.g. morning-briefing',
    /** Under the ID while no title makes it (board PageWorkflowBuilder, "Pristine"). */
    idDescription:
      'Letters, numbers and dashes. It becomes the file name, and it can’t be changed after you create the workflow. Type a title and the ID is made from it.',
    /** Under the ID opened with Change; the file path between the two parts is set in monospace. */
    idChangedDescription: {
      before: 'It becomes the file name,',
      after: ', and can’t be changed after you create the workflow.',
    },
    /** The file a new workflow's ID names, relative to the home directory. */
    idFile: (id: string): string => `workflows/${id}.json`,
    idChange: 'Change',
    /** Beside the ID a title made: it is fixed once the workflow is created. */
    idFixedOnCreate: 'Can’t be changed after you create it.',
    /** Beside an existing workflow's ID. */
    idFixed: 'Can’t be changed',
    useDerivedId: 'Use the ID made from the title',
    descriptionLabel: 'Description',
    descriptionPlaceholder: 'What does this workflow do?',
    startsHeading: 'Starts',
    triggerKindLabel: 'Starts',
    triggers: {
      manual: 'When you run it',
      schedule: 'On a schedule',
      signal: 'When a signal arrives',
    },
    /** Under Starts while it is "When you run it". */
    manualHint: 'A run starts when you press Start run.',
    /** A trigger kind a plugin contributes, named by its `plugin:name`. */
    contributedTrigger: (id: string): string => `When ${id} fires`,
    /** A trigger kind no running plugin contributes (the plugin is off, or the file is wrong). */
    unavailableTrigger: (id: string): string =>
      `No running plugin contributes the trigger ${id}. Change it in the JSON tab.`,
    /** Shown while the plugin trigger kinds load and the file's trigger names one. */
    checkingTrigger: (id: string): string => `Checking the trigger ${id}…`,
    /** The plugin trigger kinds could not be read, so the file's own trigger cannot be checked. */
    triggersFailed: (id: string): string =>
      `The trigger ${id} is kept as the file has it, but the list of plugin triggers did not load, so its settings cannot be shown.`,
    retryTriggers: 'Try again',
    scheduleLabel: 'Schedule',
    scheduleDescription: 'A duration such as 1h, or a cron expression.',
    signalNameLabel: 'Signal name',
    /** Under the signal a "When a signal arrives" start waits for (board PageWorkflowBuilder, "Signal start"). */
    signalNameDescription:
      'A run starts each time this signal is sent, from an agent or the Start run page.',
    otherTrigger: 'This trigger is edited in the JSON tab.',
    stepsHeading: 'Steps',
    stepsDescription: 'Steps run in order. Each agent step also gets the previous step’s result.',
    stepsUnreadable:
      'This file’s steps are not a list the builder can read. Fix them in the JSON tab.',
    notAnObject: 'This is not an object',
    otherStepNote: 'The builder cannot edit this step. Change it in the JSON tab.',
    /** What each card is, at its top beside its number. */
    stepKinds: {
      agent: 'Ask an agent',
      person: 'Wait for a person',
      signal: 'Wait for a signal',
      wait: 'Wait',
      other: 'Another kind of step',
    },
    /** A step's optional name, its `title`; empty, its placeholder is the step's kind. */
    stepNameLabel: 'Step name',
    stepName: (position: number): string => `Name of step ${String(position)}`,
    agentFieldLabel: 'Agent',
    agentPlaceholder: 'Choose an agent',
    agentLabel: (position: number): string => `Agent for step ${String(position)}`,
    /** Under an agent that needs a model while no provider is connected. The workflow still saves. */
    needsProvider: 'Won’t run until a provider is connected.',
    messageFieldLabel: 'Message',
    messagePlaceholder: 'What should the agent do?',
    messageLabel: (position: number): string => `Message for step ${String(position)}`,
    /** The one line a "Wait for a person" card shows under its name. */
    personDescription:
      'It shows in Reviews while it waits, titled with the step name, and the run reads Waiting on you.',
    signalFieldLabel: 'Until someone sends',
    signalPlaceholder: 'Signal name',
    signalDescription:
      'The run reads Waiting, with this signal named, until it arrives. It doesn’t show in Reviews.',
    signalLabel: (position: number): string => `Signal step ${String(position)} waits for`,
    amountFieldLabel: 'For',
    unitFieldLabel: 'Unit',
    unitLabel: (position: number): string => `Unit of the wait in step ${String(position)}`,
    units: { seconds: 'seconds', minutes: 'minutes', hours: 'hours', days: 'days' },
    /** A wait whose duration For and Unit cannot say, such as a bare number of milliseconds. */
    durationFieldLabel: 'How long',
    durationDescription: 'A bare number is milliseconds. Or write 30s, 5m, 1h.',
    /** The wait's For field, or its How long field when For and Unit cannot say its duration. */
    durationLabel: (position: number): string => `How long step ${String(position)} waits`,
    moveEarlier: (position: number): string => `Move step ${String(position)} earlier`,
    moveLater: (position: number): string => `Move step ${String(position)} later`,
    remove: (position: number): string => `Remove step ${String(position)}`,
    /** The row of buttons under the steps, one per kind of step. */
    addLabel: 'Add a step',
    add: {
      agent: 'Ask an agent',
      person: 'Wait for a person',
      signal: 'Wait for a signal',
      wait: 'Wait',
    },
    noSteps: 'Add at least one step.',
    inputHeading: 'Input',
    inputDescription:
      'What a run asks for when it starts. The Start run page draws its form from this.',
    inputEmpty: 'No input. A run starts without asking for anything.',
    outputHeading: 'Output',
    outputDescription: 'What a finished run hands back.',
    outputEmpty: 'No output. The run records its steps but hands nothing back.',
    addField: 'Add a field',
    schemaUnreadable: 'This schema isn’t a JSON object, so it is edited in the JSON tab.',
    /**
     * The footer's sentence that reads the whole workflow back: what starts it, then each step
     * ("On weekdays at 9:00 AM CST, ask Assistant to summarize what happened yesterday, then wait
     * 15 minutes.").
     */
    readBack: {
      label: 'In plain words',
      noSteps: 'Add a step to see what this workflow does.',
      fillIn: (position: number): string =>
        `Fill in step ${String(position)} to see what this workflow does.`,
      manual: 'Run it when you press Start run',
      signal: (name: string): string => `Each time ${name} is sent`,
      anySignal: 'Each time a signal is sent',
      contributed: (id: string): string => `When ${id} fires`,
      everyDay: (at: string): string => `Every day at ${at}`,
      weekdays: (at: string): string => `On weekdays at ${at}`,
      weekends: (at: string): string => `On weekends at ${at}`,
      weekly: (day: string, at: string): string => `Every ${day} at ${at}`,
      /** An interval: "Every hour", "Every 15 minutes". */
      every: (interval: string): string => `Every ${interval}`,
      onSchedule: (spec: string): string => `On the schedule ${spec}`,
      anySchedule: 'On a schedule',
      ask: (agent: string, task: string): string =>
        task === '' ? `ask ${agent}` : `ask ${agent} to ${task}`,
      anAgent: 'an agent',
      person: 'wait for a person to review it',
      waitForSignal: (signal: string): string => `wait for ${signal}`,
      anySignalWait: 'wait for a signal',
      wait: (duration: string): string => `wait ${duration}`,
      other: 'run a step the builder can’t describe',
      then: 'then',
    },
    /** Below 640 pixels the builder is read-only (board ResponsiveAndDark, row 05n). */
    phone: {
      message: 'Open on a larger screen',
      backToWorkflow: 'Back to the workflow',
      backToWorkflows: 'Back to Workflows',
    },
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
    /** One row's title: "Version 1.3.0, current version". */
    versionTitle: (version: string, current: boolean): string =>
      `Version ${version}, ${current ? 'current version' : 'older version'}`,
    /** When the version last ran, after its verdict: "last run Thu, Oct 29, 9:15 AM". */
    lastRun: (when: string): string => `last run ${when}`,
    /** The footnote under the list. */
    footnote:
      'Compatibility says whether a run started on one version can continue after the next is saved. Scheduled and chat runs always start on the current version.',
    versionColumn: 'Version',
    firstRunColumn: 'First run',
    lastRunColumn: 'Last run',
    emptyTitle: 'No version of this workflow has run yet',
    emptyDescription: 'A version appears here after its first run.',
    failed: 'The revision history could not be loaded.',
    /** The verdict against the current revision. */
    verdictColumn: 'Compatibility',
    compatible: 'Compatible',
    incompatible: 'Breaking',
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
  /**
   * The workflow page's delete dialog (board PageWorkflow, "More menu, and Delete" and "Delete, with
   * the schedule checked"). A schedule the file defines goes with the file; one that only runs the
   * workflow is named, with a checkbox that deletes it too and a confirm label that says so.
   */
  deleteDialog: {
    title: (name: string): string => `Delete ${name}?`,
    /** The sentence that names the schedule that runs the workflow, before the rest. */
    scheduleRuns: (schedule: string, paused: boolean): string =>
      `The ${schedule} schedule${paused ? ' (paused)' : ''} runs this workflow. `,
    schedulesRun: (count: number): string => `${String(count)} schedules run this workflow. `,
    pastRuns: 'Its past runs stay on Runs. ',
    /** "The file", its name and its directory, both set in monospace, follow each other. */
    file: { before: 'The file ', middle: ' is removed from ', after: '.' },
    alsoDeleteSchedule: (schedule: string): string => `Also delete the ${schedule} schedule`,
    alsoDeleteSchedules: (count: number): string =>
      `Also delete the ${String(count)} schedules that run it`,
    /** The helper under the checkbox: what each choice leaves behind. */
    alsoDeleteHelp: (paused: boolean): string =>
      `Checked, the schedule is deleted with it. Unchecked, the schedule stays${paused ? ' paused' : ''} and shows “Can’t find workflow”.`,
    alsoDeleteHelpMany:
      'Checked, the schedules are deleted with it. Unchecked, they stay and show “Can’t find workflow”.',
    confirm: 'Delete workflow',
    confirmWithSchedule: 'Delete workflow and schedule',
    confirmWithSchedules: 'Delete workflow and schedules',
    busy: 'Deleting…',
    failedTitle: 'Couldn’t delete the workflow.',
    /** The workflow is gone, and a schedule it was asked to take with it is not. */
    scheduleLeft: (schedule: string): string =>
      `The workflow was deleted, but the ${schedule} schedule was not. Delete it from its page.`,
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
  /** The line under the heading; the zone is the viewer's, as "Central time". */
  subtitle: (zone: string): string => `Runs that start on a timetable. Times are in ${zone}.`,
  newAction: 'New schedule',
  /** The segments of the filter bar, which partition the list. */
  segments: { all: 'All', active: 'Active', paused: 'Paused' },
  /** The chip beside the segments that narrows to schedules that missed runs, which are also Active. */
  missedRunsFilter: 'Missed runs',
  workflowLabel: 'Workflow',
  /** The accessible name of the list of schedules. */
  rowsLabel: 'Schedules',
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
  /** Nothing has been scheduled yet: the empty state that is the whole page. */
  empty: {
    title: 'No schedules yet',
    description:
      'A schedule starts a chat or a workflow on a timetable, such as every weekday at 9:00 AM. Create one and its next runs show here.',
  },
  /** The schedules could not be read, and there are none from before to show. */
  loadFailed: {
    title: 'Couldn’t load schedules',
    description:
      'Interborough didn’t answer, so nothing changed. Schedules keep their timetable while Interborough is off, and missed runs are listed when it returns. New schedule is off until it answers.',
  },
  noMatch: { title: 'No schedules match these filters' },
  /** Why the header's "+" does nothing while the list could not be read at all. */
  newActionOffReason: 'New schedule is off until Interborough answers.',
  /** The status line under the placeholders when the list is slow to load. */
  stillLoading: 'Still loading schedules. This is taking longer than usual.',
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
  skipFailed: 'The run was not skipped',
  unskipFailed: 'The skip was not undone',
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
      title: 'This schedule doesn’t exist',
      description: NOT_FOUND_COPY.description,
    },
    /** The switch's visible label; its accessible name adds the schedule after it ("Active, Daily summary schedule"). */
    onSwitch: 'Active',
    onSwitchName: (name: string): string => `${name} schedule`,
    /** Why flipping the switch of a schedule whose workflow is paused would not start anything. */
    pausedWorkflowSwitch: (workflow: string): string =>
      `Resuming this schedule would schedule runs that won’t start, because ${workflow} is paused. Resume workflow, beside the status, resumes it.`,
    /** The line under the heading of a schedule whose workflow is paused, and the link that resumes the workflow. */
    workflowPaused: {
      text: (workflow: string): string => `${workflow} is paused, so this schedule won’t run it.`,
      resume: 'Resume workflow',
      failed: 'The workflow was not resumed',
    },
    /** The sentence under the heading: what the schedule runs, with which agent, and when. */
    sentence: { runs: 'Runs', with: 'with' },
    /** The line that says when it runs next and when it last ran. */
    summary: {
      next: (day: string, relative: string): string => `Next ${day} (${relative})`,
      due: (day: string, relative: string): string => `Due ${day} (${relative})`,
      /** The same lines while the page shows old data: no relative time, which would be a claim it cannot keep. */
      nextStale: (day: string): string => `Next ${day}`,
      dueStale: (day: string): string => `Due ${day}`,
      wontStart: 'won’t start',
      pausedNext: 'No next run while paused',
      noNext: 'No next run',
      neverRun: 'Never run',
      /** The start of the line while a run is going, in the info tone, then when it started and a link to it. */
      runningNow: 'Running now',
      startedAgo: (ago: string): string => `: started ${ago}`,
      /** The summary line's own words for how the last run ended, with the step a failed run stopped at. */
      failedAtStep: (step: number): string => `, failed at step ${String(step)}`,
    },
    /** The chip under the sentence of a schedule that is the trigger in a workflow's file. */
    definedIn: 'Defined in',
    /** Said beside Run now while a run is going, because Run now then starts a second one. */
    runNowSecond: 'Another run is going; this starts a second one.',
    runsHeading: 'Runs',
    runsNote: (zone: string): string => `Upcoming above, past below, times in ${zone}`,
    /** The Runs list: upcoming runs, the Now marker, the missed runs, and what the schedule started. */
    runs: {
      label: 'Runs',
      skip: 'Skip',
      skipLabel: (when: string): string => `Skip ${when}`,
      skipped: 'Skipped',
      undo: 'Undo',
      undoLabel: (when: string): string => `Undo skipping ${when}`,
      now: 'Now',
      wontStart: 'won’t start',
      noteCannotLoad: (workflow: string): string => `${workflow} can’t load`,
      noteDeleted: (workflow: string): string => `${workflow} was deleted`,
      noteProvider: 'no provider',
      pausedNote: 'No upcoming runs while the schedule is paused.',
      soFar: (duration: string): string => `${duration} so far`,
      missedTitle: (count: number, since: string): string =>
        count === 1 ? `Missed once on ${since}` : `Missed ${String(count)} times since ${since}`,
      /** Why a fire was missed, in the short words the band and each row say. */
      missedReason: {
        late: 'Interborough was off',
        'dst-gap': 'The clock skipped this time',
      },
      missedRow: (count: number, reason: string): string =>
        count > 1 ? `Missed ${String(count)} times, ${reason}` : `Missed, ${reason}`,
      showEach: 'Show each',
      hide: 'Hide',
      runOnce: 'Run once now',
      dstEnded: (day: string): string => `Daylight saving time ended ${day}`,
      dstStarted: (day: string): string => `Daylight saving time started ${day}`,
      startedWith: (how: string): string => `Started with ${how}`,
      failedAtStep: (step: number): string => `Failed at step ${String(step)}`,
      stepsLabel: (step: number): string => `Step ${String(step)}`,
      loadFailed: 'The runs could not be loaded',
      /** The compact empty state below Now when the schedule has not run. */
      empty: {
        title: 'No runs yet.',
        blocked: (reasons: string): string => `It won’t start until ${reasons}.`,
        loads: (workflow: string): string => `${workflow} loads`,
        workflowBack: 'its workflow is back',
        providerConnected: 'a provider is connected',
        first: (when: string): string => `The first run starts ${when}.`,
        paused: 'It runs again when the schedule is turned on.',
      },
      /** Why the schedule will not start, as the card above the summary line lists it. */
      blockers: {
        label: 'Why this schedule will not start',
        cannotLoad: (workflow: string): string => `${workflow} can’t load`,
        deleted: (workflow: string): string => `${workflow} was deleted`,
        openWorkflow: 'Open workflow',
        provider: 'No model provider is connected.',
        connectProvider: 'Connect a provider',
        providersPath: '/settings/models',
      },
    },
    /** Why Run now is off, said as the description of the disabled button. */
    runNowOff: {
      cannotLoad: (workflow: string): string => `${workflow} can’t load.`,
      deleted: (workflow: string): string => `${workflow} was deleted.`,
      provider: 'No model provider is connected.',
    },
    openFile: 'Open file',
    deleteAction: 'Delete schedule',
    /** Why Delete schedule is off for a schedule that is the trigger in a workflow's file. */
    deleteInFile: 'This schedule is the trigger in its workflow’s file. Remove the trigger there.',
    deleteDialog: {
      title: (name: string): string => `Delete ${name}?`,
      description:
        'It stops running and its upcoming runs are removed. Past runs stay on Runs. This can’t be undone.',
      confirm: 'Delete schedule',
    },
    runNowStarted: (name: string): string => `Started ${name}.`,
    openRun: 'Open run',
    /** The details card beside the runs. */
    card: {
      label: 'Schedule details',
      whatRuns: 'What runs',
      workflow: 'Workflow',
      builtIn: '(built in)',
      agent: 'Agent',
      agents: 'Agents',
      input: 'Input',
      inputView: 'Input view',
      fields: 'Fields',
      json: 'JSON',
      copyInput: 'Copy input',
      messageLabel: 'Message',
      when: 'When',
      whenEdit: 'Edit',
      viewerClock: (time: string, zone: string): string => `That is ${time} in ${zone}.`,
      behaviour: 'Behaviour',
      overlap: 'If a run is still going',
      /** What each policy is called, as the New schedule form words it. */
      overlapValue: {
        skip: 'Skip this one',
        queue: 'Queue this one',
        'cancel-running': 'Cancel the run that is going',
        allow: 'Start another run',
      },
      catchUp: 'If Interborough was off',
      catchUpOn: 'Catch up on missed runs',
      catchUpOff: 'Don’t catch up on missed runs',
      revision: 'Workflow version',
      revisionLatest: 'Latest',
      revisionPinned: (revision: string): string => `Pinned to ${revision}`,
      revisionInfoLabel: 'About the workflow version',
      revisionInfo:
        'Scheduled runs start on the latest version of the workflow. A run that is already going keeps the version it started on.',
      revisionInfoPinned:
        'Every scheduled run starts on the version this schedule was pinned to. A run that is already going keeps the version it started on.',
      runningNow: 'Running now',
      queued: 'Queued',
      created: (date: string): string => `Created ${date}`,
    },
    runNow: 'Run now',
    edit: 'Edit',
    sends: 'Sends',
    runsFailed: 'Past runs could not be loaded',
    missedFailed: 'Missed fires could not be loaded',
    runNowOutcome: {
      started: 'Started a run.',
      queued: 'A run is going, so this one is queued behind it.',
      skipped: 'A run is still going, so this one was skipped.',
      viewRun: 'View the run',
    },
  },
  /**
   * The page that edits a schedule (`/schedules/:id/edit`; COR-2018, rows 74r, 74t, 75p, 75q): the
   * form that makes one, opened on the schedule as it is.
   */
  edit: {
    /** The label of the region while the page loads or fails, before the schedule has a name. */
    title: 'Edit schedule',
    heading: (name: string): string => `Edit ${name}`,
    /** The note under the heading: where the page is opened from and where focus lands. */
    description:
      'Opened from When › Edit on the schedule page. Focus lands on Repeats, the first field in that group, and the page scrolls to it.',
    save: 'Save changes',
    saving: 'Saving…',
    cancel: 'Cancel',
    loading: 'Loading schedule',
    startOver: 'Start over from the current schedule',
    skipPending:
      'An upcoming run is skipped. After this change to the cadence or time zone, a skip stays only on a run the new cadence still has.',
    /** The footer line: what the page does, then what it is doing. */
    footer: {
      saves: (name: string): string => `Saves changes to ${name}.`,
      saving: 'Saving the changes…',
      slow: 'Taking longer than usual.',
      cancelStops: 'Cancel stops the request and keeps the form.',
      /** Said while a field shows a problem, so the person knows what pressing Save does. */
      stillEnabled: (field: string): string =>
        `Save changes stays enabled; on submit, focus moves to ${field}.`,
    },
    /** Said under the builder of a schedule that runs more often than a minute, which the builder shows rounded. */
    exactCadence: (cadence: string): string =>
      `This schedule runs ${cadence.toLowerCase()}, which the builder counts in whole minutes. Saving without changing Repeats keeps it exactly.`,
    /** A schedule starts the workflow it was made for: the Bureau and the engine keep that fixed. */
    fixedInput: 'Set when the schedule was made, and kept as it was.',
    /** The Workflow field of a schedule whose workflow was deleted. */
    workflowGone: {
      option: (name: string): string => `${name}, can’t find this workflow`,
      message:
        'That workflow was deleted. Pick another to keep this schedule; it stays paused until then.',
      /** Said when another workflow is picked, because a schedule cannot be moved to one. */
      cannotChange:
        'A schedule keeps the workflow it was made for, so this one cannot be moved to another. Make a new schedule for it.',
    },
    failed: {
      title: 'Couldn’t save the changes.',
      message: 'Interborough didn’t answer. What you changed is still here.',
    },
    discard: {
      title: 'Discard these changes?',
      description: 'You have changed this schedule. If you leave now, what you changed is lost.',
    },
  },
  /** The answer to making a schedule was lost, so it may exist. */
  lost: {
    title: 'The schedule may have been created',
    description:
      'The answer did not come back, so the schedule may exist. Check the list before you create it again.',
    check: 'Check the schedules',
  },
  /**
   * The page that makes a schedule (`/schedules/new`; COR-2018, rows 74a–75o, 06i–06k). It asks in
   * the order the sentence does: what runs, its input, when, the two policy selects, then a name.
   */
  create: {
    title: 'New schedule',
    /** The subtitle names the zone the next runs are shown in (the viewer's), as the list's does. */
    description: (zone: string): string =>
      `Pick what runs, then when, then name it. Next runs show in ${zone} before you save.`,
    whatRunsHeading: 'What runs',
    workflowLabel: 'Workflow',
    workflowPlaceholder: 'Pick a workflow',
    workflowSearchPlaceholder: 'Search workflows',
    workflowLoading: 'Loading workflows…',
    groups: { builtIn: 'Built in', recent: 'Recent', all: 'All workflows' },
    chat: {
      label: 'Chat with an agent',
      description: 'Send a message to an agent each time it runs.',
    },
    /** The reason a workflow is listed but cannot be chosen: its file does not load, or it is paused. */
    cannotLoad: 'Can’t load this workflow',
    paused: 'Paused. Resume it to schedule it.',
    /** The list's text when a search finds nothing, which keeps the footer's link. */
    noMatch: (query: string): string => `No workflows match “${query}”.`,
    noMatchFooter: 'No match?',
    createOne: 'Create one',
    catalogFailed: {
      title: 'Couldn’t load workflows.',
      description: 'Interborough didn’t answer. Chat with an agent is built in and still works.',
    },
    required: 'Choose a workflow.',
    checking: 'Reading the workflow',
    workflowFailed: 'The workflow’s input could not be read',
    workflowGone:
      'This workflow no longer exists, or cannot be scheduled from here. Choose another.',
    inputHeading: 'Input',
    /** The lead under the Input heading, which names the workflow. */
    inputLead: (name: string): string => `What ${name} needs each time it runs.`,
    noInput: (name: string): string => `${name} takes no input.`,
    messageLabel: 'Message',
    messageDescription: 'Sent as the first message of each run.',
    continueLabel: 'Continue one chat',
    continueDescription:
      'Each run adds to the same chat, so the agent remembers earlier runs. Off: every run starts a new chat.',
    /** Shown in place of the description when another agent is chosen for a schedule that keeps continuing its chat. */
    continueNewChatDescription:
      'Another agent cannot continue the chat the first one began, so saving starts a new chat. Earlier runs stay in the old one.',
    noAgents: {
      title: 'No agents to chat with',
      description: 'A scheduled chat runs one of your agents. Make an agent first.',
      action: 'New agent',
    },
    /** The agent needs a model and no provider is connected: the warning, then the link that fixes it. */
    needsProvider: 'Won’t run until a provider is connected,',
    connectProvider: 'Connect a provider',
    whenHeading: 'When',
    whenLabel: 'Schedule',
    catchUpLabel: 'If Interborough was off',
    nameLabel: 'Name',
    namePlaceholder: 'For example, Daily summary',
    nameDescription:
      'Starts as the workflow’s name (the agent’s name for Chat with an agent); change it if you like. Shown in Schedules and on every run it starts.',
    nameRequired: 'Give the schedule a name.',
    nameTooLong: (most: number): string =>
      `The name is too long: it can be at most ${String(most)} characters.`,
    nameTaken: 'A schedule with this name already exists.',
    openSchedule: (name: string): string => `Open ${name}`,
    /** The footer line, by what the page is waiting for or what it will do. */
    footer: {
      nothing: 'Pick a workflow to see what it will start.',
      chat: (agent: string): string =>
        `Creates a schedule that starts a chat with ${agent === '' ? 'an agent' : agent}.`,
      workflow: (workflow: string): string => `Creates a schedule that starts ${workflow}.`,
      waitingForWorkflows: 'Waiting for the workflow list',
      waitingForInput: 'Waiting for the workflow’s input fields',
      blocked: 'Won’t run until a provider is connected.',
      creating: 'Creating the schedule…',
      slow: 'Taking longer than usual.',
      cancelStops: 'Cancel stops the request and keeps the form.',
      /** Said while a field shows a problem, so the person knows what pressing Create does. */
      stillEnabled: (field: string): string =>
        `Create schedule stays enabled; on submit, focus moves to ${field}.`,
    },
    submit: 'Create schedule',
    creating: 'Creating…',
    cancel: 'Cancel',
    failed: {
      title: 'Couldn’t create the schedule.',
      message: 'Interborough didn’t answer. What you typed is still here.',
    },
    pauseFailed: 'The schedule was created, but it could not be turned off. It is on.',
    invalidCadence: 'The repeat is not valid. Fix the highlighted field, then create the schedule.',
    discard: {
      title: 'Discard this schedule?',
      description: 'You have started a schedule. If you leave now, what you typed is lost.',
      keep: 'Keep editing',
      confirm: 'Discard and leave',
    },
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
  modelPolicy: 'Allowed models',
  a2a: 'A2A',
  plugins: 'Plugins',
  dataAndRetention: 'Data and retention',
  apiReference: 'API reference',
} as const;

/** The numbers a sentence about the agents says in words; a larger count says its digits. */
const COUNT_WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
] as const;

/**
 * The words of Settings › Data and retention: how long each kind of record is kept, and how much
 * space the records take (board PageSettingsSections, "Data and retention"; rows 50d to 50g).
 */
export const DATA_RETENTION_COPY = {
  title: 'Data and retention',
  intro: 'How long Interborough keeps what it records. Settings save as you leave a field.',
  /** The status at the right of the heading once any row has saved. */
  saved: 'Saved just now',
  /** The names of the four retention rows; the raw key sits small beside each. */
  labels: {
    'retention.audit': 'Audit records',
    'retention.runs': 'Run history',
    'retention.chats': 'Chats',
    'retention.memory': 'Memory',
  } as Readonly<Record<string, string>>,
  retention: {
    heading: 'Retention',
    keepForever: 'Keep forever',
    deleteAfter: 'Delete after',
    days: 'days',
    /** The accessible name of a row's choice between keeping and deleting. */
    choiceLabel: (name: string): string => `${name}: how long to keep`,
    /** The accessible name of a row's days field. */
    daysLabel: (name: string): string => `${name}: days before deleting`,
    daysProblem: 'Enter a number from 1 to 3650.',
  },
  /** The section of the retention windows the board draws no row for: events, tasks, receipts and the rest. */
  otherRetention: {
    heading: 'Other retention',
    description: 'How long the rest of what Interborough records is kept.',
  },
  storage: {
    heading: 'Storage',
    label: 'Space used',
    description: 'What Interborough’s records take up on this machine.',
    firingDescription: 'Health lists this under Needs attention.',
    openHealth: 'Open Health',
    overWarning: (size: string): string => `Storage is over its warning level, ${size}`,
    notReported: 'Not reported yet',
  },
  /** The Clean-up section: the nightly removal of expired records, and "Clean up now" (rows 50h and 50j). */
  cleanUp: {
    heading: 'Clean-up',
    label: 'Remove expired records',
    action: 'Clean up now',
    /** The row's description: when it happens each night, in the host's zone. */
    schedule: (time: string, zone: string): string =>
      `Interborough does this every night at ${time} ${zone}.`,
    /** When it last ran, said after the schedule; `when` already names the day ("Sun Nov 1, 3:00 AM"). */
    last: (when: string): string => `Last cleaned up ${when}.`,
    /** A night it did not run, said after the schedule; `day` is "today" or a day and time. */
    skipped: (day: string): string => `Skipped ${day} while Interborough was off.`,
    working: 'Cleaning up…',
    /** What a clean-up that finished says on the row, with how many records it removed. */
    done: (removed: number): string =>
      removed === 0
        ? 'Cleaned up just now. Nothing was past its retention window.'
        : `Cleaned up just now. Removed ${String(removed)} ${removed === 1 ? 'record' : 'records'}.`,
    /** A clean-up that finished but could not remove some kinds of record; `kinds` names them. */
    partial: (removed: number, kinds: string): string =>
      `Cleaned up just now, but ${kinds} could not be removed. Removed ${String(removed)} ${removed === 1 ? 'record' : 'records'}.`,
    failed: 'Couldn’t clean up. Nothing was removed.',
    retry: 'Try again',
    /** The kinds of record a clean-up removes, as a sentence names them. */
    kinds: {
      audit: 'audit records',
      reviews: 'reviews',
      memories: 'memories',
      logs: 'logs',
      notifications: 'notifications',
      hookDeliveries: 'hook deliveries',
      chats: 'chats',
    } as Readonly<Record<string, string>>,
  },
} as const;

/**
 * The words of Settings › A2A (board PageSettingsSections, "A2A, /settings/a2a" and "A2A with
 * Accept A2A calls off"): the switch that accepts remote calls, the address of the agent card, the
 * agents that answer, push notifications, and the calls that were made. The rows save as they are
 * left, like the rest of Settings.
 */
export const A2A_COPY = {
  intro:
    'Let other agents and tools call yours over the Agent2Agent protocol. Settings save as you leave a field.',
  heading: 'Agent2Agent',
  enabled: {
    label: 'Accept A2A calls',
    description: 'Let other agents and tools call your agents over the Agent2Agent protocol.',
    /** Said under the switch while it is off and nothing waits for a restart. */
    off: 'Off. No remote call is answered. Turning it on applies after a restart.',
  },
  cardUrl: {
    label: 'Agent card URL',
    description: 'Share this address with a caller so it can discover which agents you offer.',
    copy: 'Copy the agent card URL',
    copied: 'Copied',
    unavailable: 'Not known yet',
  },
  agents: {
    label: 'Shared agents',
    /** The row's words: how many agents it lists, and where else the same choice is made. */
    description: (count: number): string => {
      const listed =
        count === 0
          ? 'Agents you add are listed here'
          : count === 1
            ? 'The one agent is listed'
            : `All ${COUNT_WORDS[count] ?? String(count)} agents are listed`;
      return `${listed}; only the ones you turn on here answer remote calls. You can also set this on each agent’s Settings tab.`;
    },
    listLabel: 'Agents that answer remote calls',
    loading: 'Loading the agents',
    loadFailed: 'The agents could not be listed.',
    retry: 'Try again',
    none: 'No agents yet.',
  },
  pushNotifications: {
    label: 'Push notifications',
    description: 'Let a remote caller register a webhook to be told when its task finishes.',
  },
  /** The line under the rows while Accept A2A calls is off. */
  readOnly: 'Agent card URL, Shared agents and Push notifications are read-only while this is off.',
  recent: {
    heading: 'Recent calls',
    empty: {
      title: 'No remote calls yet',
      description:
        'When another agent or tool calls yours, each call appears here with who made it and which agent answered.',
    },
    /** Who made a call: the name the caller gave itself, else its principal, else nothing to name. */
    caller: (call: {
      readonly callerName: string | undefined;
      readonly principal: string | undefined;
    }): string => {
      const name = call.callerName ?? call.principal;
      return name === undefined ? 'Remote agent' : `Remote agent “${name}”`;
    },
    /** Which agent answered, named as the Agents list names it. */
    answeredBy: (agent: string): string => `answered by ${agent}`,
    loading: 'Loading the recent calls',
    loadFailed: {
      title: 'The recent calls could not be loaded',
      description: 'The host did not answer. Check that it is running, then try again.',
    },
    retry: 'Try again',
  },
} as const;

/**
 * The words of Settings › API reference: the tabs that name the four groups, what each tab says,
 * and the states a tab with nothing to show is in (`routes/settings/api-reference`).
 */
export const API_REFERENCE_COPY = {
  title: 'API reference',
  intro: 'What other programs can do with Interborough, and what this session may do.',
  /** The tab row's accessible name. */
  tabsLabel: 'API reference',
  groups: {
    operations: 'Operations',
    discovery: 'Discovery documents',
    scopes: 'Your scopes',
    sources: 'Workflow sources',
  },
  /** The loading rule every page shares (board PageSettingsSections, "API reference loading"). */
  loading: {
    label: 'Loading the API reference',
    stillLoading: 'Still loading. This is taking longer than usual.',
    canceled: 'Loading was canceled.',
    tryAgain: 'Try again',
  },
  /** A read that failed with nothing to show; `status` is the HTTP status the server answered, if it answered. */
  loadFailed: {
    title: 'Couldn’t load the API reference.',
    description: (status: number | undefined): string =>
      status === undefined
        ? 'Interborough didn’t answer.'
        : `The server answered with an error (${String(status)}).`,
  },
  operations: {
    groupLabel: 'Group',
    allGroups: 'All groups',
    count: (count: number): string =>
      `${String(count)} ${count === 1 ? 'operation' : 'operations'}`,
    caption: 'Operations',
    columns: {
      method: 'Method',
      path: 'Path',
      summary: 'What it does',
      scope: 'Scope',
      /** The column of the button that opens a row, named for a screen reader only. */
      details: 'Details',
    },
    /** The accessible name of the button that opens a row's request and response. */
    toggleLabel: (method: string, path: string): string =>
      `Request and response for ${method} ${path}`,
    requestBody: 'Request body',
    noRequestBody: 'No request body.',
    response: (status: string): string => `Response, ${status}`,
    noResponseBody: 'No response body.',
    noScope: 'Any caller',
    empty: 'The server lists no operations.',
  },
  discovery: {
    documents: {
      openapi: {
        title: 'OpenAPI description',
        description: 'Every operation, for generating a client.',
      },
      agentCard: {
        title: 'Agent card',
        description: 'How other agents discover yours (A2A).',
      },
      tools: { title: 'Tool server', description: 'The same tools, over MCP.' },
    },
    copy: (title: string): string => `Copy ${title}`,
    copied: (title: string): string => `Copied ${title}`,
  },
  scopes: {
    intro:
      'This session can do the following. Interborough is single-user for now, so these are the scopes of the person at the keyboard, including everything this page’s own boards do: create schedules, edit agents and hooks, and change settings.',
    listLabel: 'Scopes this session holds',
    none: 'This session holds no scopes.',
  },
  sources: {
    intro:
      'Where Interborough reads workflow files from. Edit a workflow in its file; changes load on the next start or reload.',
    listLabel: 'Workflow files',
    workflows: (count: number): string =>
      `${String(count)} ${count === 1 ? 'workflow' : 'workflows'}`,
    schedules: (count: number): string =>
      `${String(count)} ${count === 1 ? 'schedule' : 'schedules'}`,
    empty: 'No workflow files yet. Add one to the workflows folder and it loads on the next start.',
  },
} as const;

/**
 * The words of Settings › Models: the providers agents call, the models those providers offer, and
 * the models that answer decisions (`routes/settings/models`).
 */
export const MODELS_COPY = {
  title: 'Models',
  intro: 'Agents run on a model. Connect a provider to make its models available.',
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
  /** What each provider's models are called, under its name. A provider not listed here shows nothing. */
  providerTaglines: {
    anthropic: 'Claude models',
    openai: 'GPT models',
    gemini: 'Gemini models',
  } as Readonly<Record<string, string>>,
  /** The order the providers are listed in; one the host adds follows them. */
  providerOrder: ['anthropic', 'openai', 'gemini'] as readonly string[],
  locked:
    'This host keeps its providers and keys in its deployment, so they cannot be changed here.',
  providers: {
    heading: 'Providers',
    /** The reason there is no provider banner: while none is connected this says why agents can't answer. */
    description:
      'Agents can’t answer until one is connected. Connect one to make its models available.',
    connectedDescription: 'Connected providers show Manage.',
    listLabel: 'Providers',
    connected: 'Connected',
    connect: 'Connect',
    manage: 'Manage',
    connectLabel: (name: string): string => `Connect ${name}`,
    manageLabel: (name: string): string => `Manage ${name}`,
  },
  /** Connect (board SettingsShell, "Connect, empty", "testing", "invalid key" and "connected"). */
  connectDialog: {
    title: (name: string): string => `Connect ${name}`,
    /** The line under the title, which says where the dialog is. */
    subtitle: {
      idle: 'Paste an API key, then test it.',
      testing: 'Testing the key.',
      failed: 'The test failed.',
      tested: 'The key works.',
      saveFailed: 'The key could not be saved.',
      connected: 'Connected.',
    },
    keyLabel: 'API key',
    keyPlaceholder: 'Paste your API key',
    keyHelp: 'Saved to ~/.interborough/secrets when you connect, readable only by you.',
    getKey: 'Where do I get one?',
    keyRequired: 'Enter the key.',
    /** Under the field while Connect, or Test, asks the provider. */
    testing: 'Testing the connection…',
    test: 'Test',
    connect: 'Connect',
    /** The primary button while it tests, disabled. */
    connecting: 'Testing…',
    cancel: 'Cancel',
    done: 'Done',
    /** The success banner: after Connect, and after Test on its own. */
    connectedTitle: 'Connected',
    testedTitle: 'The key works',
    models: (count: number): string =>
      count === 1 ? '1 model is available.' : `${String(count)} models are available.`,
    locked: 'This host keeps its keys in its deployment, so it cannot save one.',
    partial: 'The key was stored, but the configuration could not be written.',
    saveFailed: 'The key could not be saved.',
  },
  /** Why a test did not pass, worded at the field. Never carries the key. */
  keyTest: {
    rejected: (provider: string, status: number | undefined): string =>
      `${provider} didn’t accept this key${status === undefined ? '' : ` (${String(status)})`}. Check that you copied all of it.`,
    unfinished: (provider: string, status: number | undefined): string =>
      `Couldn’t finish testing the key with ${provider}${status === undefined ? '' : ` (${String(status)})`}. Check your connection and try again.`,
    failed: 'The key could not be tested.',
  },
  /** Replace key (board SettingsShell, "Replace key, in progress"). */
  replaceDialog: {
    title: (name: string): string => `Replace the ${name === '' ? 'provider' : name} key`,
    subtitle: 'The old key stays in use until the new one passes.',
    keyLabel: 'New API key',
    testing: 'Testing the new key…',
    replace: 'Replace key',
    cancel: 'Cancel',
    toast: (name: string): string => `${name} key replaced`,
  },
  /** Manage (board SettingsShell, "Manage, a connected provider"). The saved key is never shown. */
  manageDialog: {
    /** The title while no provider is chosen, which a closed dialog still carries. */
    fallbackTitle: 'Provider',
    subtitle: 'Connected',
    connected: 'Connected',
    models: (count: number): string => `${String(count)} ${count === 1 ? 'model' : 'models'}`,
    removeKey: 'Remove key',
    replaceKey: 'Replace key',
    done: 'Done',
  },
  /** Remove key (board SettingsShell, "Remove key, confirm"). */
  removeDialog: {
    title: (name: string): string => `Remove the ${name} key?`,
    /** Names the agents that stop answering. Run now on their schedules is disabled with them. */
    description: (agents: readonly string[]): string =>
      `${nameList(agents)} ${agents.length === 1 ? 'stops' : 'stop'} answering until you add a key. Run now on ${agents.length === 1 ? 'its' : 'their'} schedules is disabled too. Chats and runs stay.`,
    /** When no agent uses the provider's models, so nothing stops answering. */
    descriptionNoAgents: (name: string): string =>
      `No agent uses ${name} models, so none stops answering. Chats and runs stay.`,
    checking: (name: string): string => `Looking for agents that use ${name} models…`,
    agentsUnknown: (name: string): string =>
      `The agents could not be read, so which ones use ${name} models is not known. Chats and runs stay.`,
    trimmedNote: (agents: readonly string[], name: string): string =>
      `${nameList(agents)} still ${agents.length === 1 ? 'answers' : 'answer'}, but ${agents.length === 1 ? 'loses' : 'lose'} ${name} models from the ones ${agents.length === 1 ? 'it' : 'they'} can be switched to.`,
    embedderNote:
      'If a memory embedder from this provider is selected, memory needs setup again until you connect it or choose another.',
    confirm: 'Remove key',
    busy: 'Removing…',
    cancel: 'Cancel',
    toast: (name: string): string => `${name} key removed`,
    failedTitle: 'Couldn’t remove the key.',
    failed: 'The key is still saved.',
    locked: 'This host keeps its keys in its deployment, so it cannot remove one.',
  },
  /** The catalog (board SettingsShell, "Models, /settings/models" and "Models, provider connected"). */
  models: {
    heading: 'Models',
    /** With no model to list, the catalog says only what it is. */
    emptyDescription: 'Every model your connected providers offer.',
    description:
      'Every model your connected providers offer. Which models agents may use is set under Allowed models.',
    tableLabel: 'Models',
    columns: {
      model: 'Model',
      abilities: 'Abilities',
      context: 'Context',
      allowed: 'Allowed',
    },
    allowed: 'Allowed',
    notAllowed: 'Not allowed',
    empty: {
      title: 'No models yet',
      description: 'Models appear here once you connect a provider.',
      action: 'Go to Providers',
    },
    /** The catalog failed to load after the key was saved: the error sits here, not on the provider row. */
    loadFailed: {
      title: 'Couldn’t load the models',
      description: (providers: readonly string[], status: number | undefined): string => {
        const code = status === undefined ? '' : ` (${String(status)})`;
        if (providers.length === 0) return `The model list didn’t come back${code}.`;
        const subject =
          providers.length === 1
            ? `${providers.join('')} is connected, but its model list`
            : `${nameList(providers)} are connected, but their model lists`;
        return `${subject} didn’t come back${code}.`;
      },
      retry: 'Try again',
    },
  },
  /** The Decisions section (board SettingsShell, "Models, /settings/models"). */
  decisions: {
    heading: 'Decisions',
    description:
      'The model that makes quick judgments for the app, apart from the models agents chat with.',
    model: {
      label: 'Decision model',
      description:
        'TypeSafe answers yes-or-no and classification questions for Interborough. It isn’t a chat provider.',
      connect: 'Connect TypeSafe',
    },
    fallbackModel: {
      label: 'Fallback model',
      description: 'Used when the decision model can’t answer.',
      connectFirst: 'Connect TypeSafe first',
    },
    maximumPerTask: {
      label: 'Maximum per task',
      description: 'The most decision calls one task may make.',
      connectFirst: 'The most decision calls one task may make. Connect TypeSafe first.',
    },
  },
} as const;

/** "1 change" or "3 changes". */
function changeCount(count: number): string {
  return `${String(count)} ${count === 1 ? 'change' : 'changes'}`;
}

/** Names joined as a person says them: "A", "A and B", "A, B and C". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

/**
 * The words of the restart the shell shows (`app/restart`, board SettingsShell "Restart" frames):
 * the question before it, the dialog while the host stops and starts, how it ends when the host
 * never answers, and the banner that says what applied once it is back. Running work always picks up
 * where it stopped and reviews wait, so nothing here says that nothing is running.
 */
export const RESTART_COPY = {
  confirm: {
    title: 'Restart Interborough now?',
    description: (changes: number): string =>
      `Interborough stops and starts again to apply ${changeCount(Math.max(changes, 1))}. Running work picks up where it stopped; reviews stay waiting.`,
    confirm: 'Restart now',
    cancel: 'Cancel',
  },
  /** The steps of the restarting dialog, in order. */
  steps: ['Saved your choice', 'Stopped the server', 'Starting Interborough', 'Checking plugins'],
  restarting: {
    description: 'This takes a few seconds. Your changes are saved.',
    unloading: (plugin: string): string =>
      `Unloading ${plugin}. Running work picks up where it stopped; reviews stay waiting.`,
  },
  failed: {
    check:
      'That Interborough is still running on this machine, and that its address is reachable from this browser.',
    /** What was saved before the host stopped, which is what applies once it starts. */
    description: (changes: number, disabling: string | undefined): string => {
      const answered = 'It didn’t answer after 8 tries.';
      if (disabling !== undefined) {
        return `${answered} Your choice to disable ${disabling} was saved before it stopped, so it applies once Interborough starts.`;
      }
      return changes > 1
        ? `${answered} Your changes were saved before it stopped, so they apply once it starts.`
        : `${answered} Your change was saved before it stopped, so they apply once it starts.`;
    },
  },
  unconfirmed: {
    title: 'Interborough has not restarted',
    description:
      'The host is still answering as it did before, so the change has not applied. It may not be supervised, so restart it where it runs.',
    dismiss: 'Dismiss',
  },
  /** Why a restart did not begin. */
  refusal: {
    locked: 'This host keeps its configuration in its deployment, so it cannot be restarted here.',
    refused: 'This host cannot restart itself. Restart it where it runs.',
    unreachable: 'Interborough did not answer, so it was not asked to restart. Try again.',
  },
  back: {
    title: 'Back up',
    dismiss: 'Dismiss',
    /** The lead of a restart that unloaded one plugin: "Back up. Web search is disabled." */
    disabled: (plugin: string): string => `Back up. ${plugin} is disabled.`,
    /** What applied and what became of the work in flight. */
    applied: (changes: readonly string[]): string =>
      `${changeCount(Math.max(changes.length, 1))} applied${changes.length === 0 ? '' : `: ${changes.join(', ')}`}. Running work picked up where it stopped; reviews stayed waiting.`,
    /** The plugins by standing, such as "1 plugin running (Files); Anthropic and OpenAI need setup." */
    standing: (
      running: readonly string[],
      needSetup: readonly string[],
      disabled: readonly string[],
      notLoaded: readonly string[],
    ): string => {
      const parts: string[] = [];
      if (running.length > 0) {
        parts.push(
          `${String(running.length)} ${running.length === 1 ? 'plugin' : 'plugins'} running (${nameList(running)})`,
        );
      }
      if (needSetup.length > 0) {
        parts.push(`${nameList(needSetup)} ${needSetup.length === 1 ? 'needs' : 'need'} setup`);
      }
      if (disabled.length > 0) {
        parts.push(`${nameList(disabled)} ${disabled.length === 1 ? 'is' : 'are'} disabled`);
      }
      if (notLoaded.length > 0) {
        parts.push(`${nameList(notLoaded)} did not load`);
      }
      return parts.length === 0 ? '' : `${parts.join('; ')}.`;
    },
    /** What stopped working because a plugin was turned off, or that nothing did. */
    unavailable: (plugin: string, unavailable: string | undefined): string =>
      unavailable === undefined
        ? `Nothing used ${plugin}, so nothing became unavailable.`
        : `${unavailable} used ${plugin} and now show as unavailable.`,
    enableAgain: 'Enable it again at any time.',
  },
} as const;

/**
 * The words of Settings › Plugins: what Interborough loaded at startup, what each plugin adds and
 * what names it, the choices an owner makes (enabled, configuration, secrets), and the restart that
 * applies them (`routes/settings/plugins`).
 */
export const PLUGINS_COPY = {
  title: 'Plugins',
  intro: 'Code that adds tools, agents and workflows. Plugins load at startup.',
  /** The loading rule every page shares: skeleton rows after 300 ms, then a status line with a Cancel (board PageSettingsSections, "Plugins loading"). */
  loading: {
    label: 'Loading plugins',
    stillLoading: 'Still loading. This is taking longer than usual.',
    cancel: 'Cancel',
    canceled: 'Loading was canceled.',
    tryAgain: 'Try again',
  },
  /** A read that failed with nothing to show; `status` is the HTTP status the host answered, if it answered. */
  loadFailed: {
    title: 'Couldn’t load plugins.',
    description: (status: number | undefined): string =>
      status === undefined
        ? 'Interborough didn’t answer. Nothing you did caused it.'
        : `The server answered with an error (${String(status)}). Nothing you did caused it.`,
    openHealth: 'Open Health',
  },
  locked:
    'This host keeps its plugin choices and secrets in its deployment, so they cannot be changed here.',
  listLabel: 'Plugins',
  detailLabel: 'Plugin details',
  /** The list's header: the word, the number of plugins beside it, and a link to how a plugin is written. */
  listHeader: {
    heading: 'Plugins',
    howToAdd: 'How to add one',
    howToAddHref:
      'https://github.com/stevekinney/corvidae/blob/main/packages/interborough-plugin/README.md#where-a-plugin-lives',
  },
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
  /** The switch's label tracks its state, so a disabled plugin's switch reads Disabled. */
  enabled: 'Enabled',
  disabled: 'Disabled',
  /** Under a disabled plugin's switch: turning it on is a restart. */
  enableNote: 'Enabling it asks to restart, because plugins load at startup.',
  /** What a disabled plugin holds back: the agents it ships, unavailable until it is on. */
  holdingBack: {
    lead: 'Holding back.',
    body: (names: readonly string[], title: string): string =>
      `${nameList(names)} ${names.length === 1 ? 'is' : 'are'} unavailable until ${title} is enabled.`,
  },
  /** A status word. Needs setup is neutral: amber is for what waits on the person (a restart, an attention). */
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
    package: 'Package plugin, loaded at startup',
    folder: 'Folder plugin, loaded at startup',
    builtIn: 'Part of Interborough, loaded at startup',
  },
  sections: {
    source: 'Source',
    adds: 'What it adds',
    configuration: 'Configuration',
    secrets: 'Secrets',
  },
  contributionKinds: {
    tool: 'Tools',
    activity: 'Activities',
    skill: 'Skills',
    trigger: 'Triggers',
    validator: 'Validators',
    guardrail: 'Guardrails',
    interceptor: 'Interceptors',
    'decision-router': 'Decision routing',
    reaction: 'Hook actions',
    provider: 'Model provider',
    embedder: 'Embeddings',
    'memory-detector': 'Memory detectors',
    scorer: 'Scorers',
    panel: 'Panels',
    formatter: 'Formatters',
    agent: 'Agents',
  } as Readonly<Record<string, string>>,
  /** The configuration form, built from the plugin's own schema. */
  configuration: {
    description: 'These fields come from the plugin’s own schema.',
    save: 'Save configuration',
    saving: 'Saving',
    /** Beside Save: what saving does and does not do. */
    note: 'Applies after restart. Saving doesn’t restart.',
    saved: 'Saved. Applies after restart.',
    savedNow: 'Saved. It applies at once.',
    /** The bold lead of a failed save; what follows says why. */
    failureLead: 'Couldn’t save the configuration.',
    failed: 'Interborough didn’t answer.',
    rejected: (message: string): string => (message === '' ? 'The host refused it.' : message),
    locked:
      'This host keeps its plugin choices in its deployment, so the configuration cannot be saved here.',
    notSet: 'Not set',
    addTag: 'Add a value',
    tagsLabel: (label: string): string => label,
    json: (label: string): string => `${label}, as JSON`,
    invalidJson: 'This is not valid JSON.',
  },
  secrets: {
    set: 'Set',
    missing: 'Missing',
    add: 'Add the key',
    replace: 'Replace',
    addLabel: (key: string): string => `Add the key for ${key}`,
    replaceLabel: (key: string): string => `Replace ${key}`,
    /** Under a missing key: where it is saved, and what happens once it is. */
    note: (directory: string, title: string, provider: boolean): string =>
      provider
        ? `Saved to ${directory}, readable only by you. The models appear as soon as the key passes a test.`
        : `Saved to ${directory}, readable only by you. ${title} works as soon as the key is saved; no restart.`,
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
  /** The line at the foot of a running plugin: what uses it. */
  inUse: {
    lead: 'In use.',
    nothing: (title: string): string => `Nothing uses ${title} yet.`,
    some: (title: string, parts: readonly string[], singular: boolean): string =>
      `${nameList(parts)} ${singular ? 'uses' : 'use'} ${title}.`,
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
    failed: 'The changes could not be saved, so Interborough was not restarted.',
    rejected: (plugin: string): string =>
      `${plugin} was not saved, so Interborough was not restarted. Open it to see what the host rejected.`,
    saved: 'Saved. The host applied these changes at once, so no restart was needed.',
    refused: 'This host cannot restart itself. Restart it where it runs.',
    unreachable: 'Interborough did not answer, so it was not asked to restart. Try again.',
  },
  /** The question before a plugin is turned off (row 49x): a Cinder confirm dialog that lists what depends on it. */
  disable: {
    title: (name: string): string => `Disable ${name}?`,
    intro: 'Interborough restarts to unload it. What depends on it:',
    /** The bold word that leads the sentence when nothing depends on the plugin. */
    nothingLead: 'Nothing',
    nothing: (title: string): string => ` uses ${title} yet, so nothing becomes unavailable.`,
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
    reassurance: 'Nothing is deleted. Enable it again and restart, and it works as before.',
    cancel: 'Cancel',
    confirm: 'Disable and restart',
  },
  /** The question before a disabled plugin is turned on (row 51b): what becomes available again, and that it restarts. */
  enable: {
    title: (name: string): string => `Enable ${name}?`,
    /** The sentence before what comes back; with nothing to name, it stands alone. */
    intro: 'Interborough restarts to load it.',
    /** What the plugin's agents do once it is on: "Release helper and Changelog writer become available again." */
    available: (names: readonly string[]): string =>
      `${nameList(names)} ${names.length === 1 ? 'becomes' : 'become'} available again.`,
    /** What a restart does to running work, which every restart says. */
    work: 'Running work picks up where it stopped; reviews stay waiting.',
    alsoWrites: 'Restarting also saves these changes, which are waiting:',
    cancel: 'Cancel',
    confirm: 'Enable and restart',
  },
  /**
   * One card per problem code (COR-1895). The table of the first six is the owner's wording
   * (Interborough plugins, boards 26–28); the cards after `developmentSource` are for codes the
   * host added later, in the same voice. A body is a function of the fields its code carries.
   */
  problems: {
    /** The accessible name of the list the Plugins page opens with after a startup with problems. */
    listLabel: 'Plugins that need attention',
    title: 'Needs attention',
    unknown: (code: string): string => `Reported as ${code}.`,
    /** The status of a problem whose code this page has no words for. */
    unknownStatus: 'Not recognised',
    secretMissing: {
      status: 'Needs setup',
      title: 'A secret isn’t saved yet',
      /** `plural` is whether what waits reads as more than one thing ("Gemini models and embeddings"). */
      body: (key: string, what: string, plural: boolean): string =>
        plural
          ? `${key} isn’t saved, so ${what} are unavailable. Save it and they work at once, with no restart.`
          : `${key} isn’t saved, so ${what} is unavailable. Save it and it works at once, with no restart.`,
      /** The body when the host lists nothing that waits for the secret. */
      bodyWithoutContributions: (key: string): string =>
        `${key} isn’t saved, so what this plugin adds is unavailable. Save it and it works at once, with no restart.`,
      action: 'Add the key',
    },
    configurationInvalid: {
      status: 'Not loaded',
      title: 'A setting is invalid',
      /** `label` is the field as a person reads it ("Grounding threshold"), never its key; `message` is what the plugin said. */
      body: (label: string, message: string): string =>
        label === '' ? message : `${label}: ${message}`,
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
    /** The plugin’s `start` threw; what it adds stays registered. */
    startFailed: {
      status: 'Loaded, a step after startup failed',
      title: 'A step after startup failed',
      body: (message: string): string => message,
    },
    /** A panel the plugin contributed could not be built; the plugin and its other parts run. */
    panelFailed: {
      status: 'Loaded, a panel was not built',
      title: 'A panel the plugin adds did not build',
      body: (panel: string, message: string): string =>
        `The panel ${panel} is not served. ${message}`,
    },
  },
  /** The banner every page shows after a startup where a plugin or a folder did not load. */
  startupBanner: {
    /** The accessible name of the region. */
    label: 'Plugins that did not load',
    message: (count: number): string =>
      count === 1
        ? '1 plugin needs attention after a startup with problems'
        : `${String(count)} plugins need attention after a startup with problems`,
    /** The second line, which says what the problems mean for the work that uses the plugins. */
    consequence: (count: number): string =>
      count === 1
        ? 'Agents and workflows that use it show as unavailable.'
        : 'Agents and workflows that use them show as unavailable.',
    action: 'Open Plugins',
  },
  unloaded: {
    heading: 'Folders that did not load',
    description: 'These folders hold no plugin Interborough could use.',
  },
} as const;

/**
 * The words of Home (`/`): the date line, the four counts, what needs you, what needs attention,
 * the box that starts a chat, and the chats you were last in. The four counts use the labels and
 * windows the agreed design gives Health and Home both; Health says them in its own batch.
 */
export const HOME_COPY = {
  /** The screen-reader heading; the breadcrumb already says Home, so none is drawn. */
  heading: 'Home',
  /** The accessible name of the four counts. */
  countsLabel: 'Home counts',
  counts: {
    running: 'Running now',
    needsYou: 'Needs you',
    failed: 'Failed in 24 hours',
    missed: 'Missed schedule runs (7 days)',
  },
  /** The value of a count that could not be read. */
  unavailable: '—',
  /** The words of a row's link to where the rest lives, such as "Open Reviews". */
  needsYou: {
    title: 'Needs you',
    link: 'Open Reviews',
    /** The accessible name of the list of reviews waiting on the person. */
    listLabel: 'Reviews waiting on you',
    empty: {
      title: 'Nothing is waiting on you',
      description: 'Approvals and questions from your agents show up here.',
    },
    answer: 'Answer',
    review: 'Review',
    kind: { approval: 'Approval', question: 'Question', workflow: 'Workflow review' },
    cantBeUndone: 'Can’t be undone',
    /** The line under the rows when more wait than Home lists. */
    more: (count: number): string => `${String(count)} more in Reviews`,
  },
  attention: {
    title: 'Needs attention',
    link: 'Open Health',
    listLabel: 'System problems',
    /** The one line that stands for the card when nothing needs attention. */
    clear: {
      title: 'Nothing needs attention',
      description: 'Storage, schedules, providers and hooks are fine.',
    },
    storage: {
      title: 'Storage is over its warning level',
      detail: (size: string): string => `${size} used`,
      action: 'Review storage',
    },
    failureRate: {
      title: 'Workflow failure rate is over its warning level',
      detail: (rate: string): string => `${rate} of recent runs failed`,
      action: 'Review health',
    },
    slowSteps: {
      title: 'Slowest steps are over their warning level',
      detail: (duration: string): string => `Slowest steps take ${duration}`,
      action: 'Review health',
    },
    otherAlert: {
      title: (metric: string): string => `${metric} is over its warning level`,
      action: 'Review health',
    },
    missedRuns: {
      title: (name: string, count: number, since: string): string =>
        `${name} missed ${String(count)} ${count === 1 ? 'run' : 'runs'} since ${since}`,
      /** What a schedule with no description of its own is called. */
      unnamed: 'A schedule',
      kind: 'Schedule',
      action: 'View schedule',
    },
    hookFailed: {
      title: (name: string, gaveUp: boolean): string =>
        `${name}’s ${gaveUp ? 'delivery gave up' : 'last delivery failed'}`,
      /** What a hook with no name of its own is called. */
      unnamed: 'A hook',
      action: 'View hook',
    },
    pluginNotLoaded: {
      title: (plugin: string): string => `${plugin} did not load`,
      action: 'View plugins',
    },
    noProvider: {
      title: 'No model provider connected',
      detail: 'Model agents can’t answer until one is connected. Assistant works now.',
      action: 'Connect a provider',
    },
  },
  startChat: {
    title: 'Start a chat',
    messageLabel: 'Message',
    placeholder: 'Ask an agent to do something',
    agentLabel: 'Agent',
    send: 'Send',
    /** The note beside the agent while the server is off, and Send is disabled with it. */
    offNote: 'Off until it’s back',
    /** What the card says when the agents it offers could not be read. */
    failed: 'Couldn’t load agents.',
  },
  recent: {
    title: 'Recent chats',
    link: 'All chats',
    listLabel: 'Recent chats',
    /** What the card says before the person has sent a first message. */
    empty: {
      title: 'No chats yet',
      description: 'Your chats appear here once you send a first message.',
    },
  },
  /**
   * What Home says while it loads and when a read fails: one card that cannot be read says so in
   * its own place and the rest stay live, a load that takes long can be canceled, and a server
   * that does not answer with nothing loaded yet is the full error state.
   */
  states: {
    /** The words of the status line under the loading placeholders, and its button. */
    stillLoading: 'Still loading Home. This is taking longer than usual.',
    /** The line that names the loading region for assistive technology. */
    loadingLabel: 'Loading Home',
    /** What the page says after the person canceled a slow load, with Try again beside it. */
    canceled: {
      title: 'Loading canceled',
      description: 'Home stopped loading. Try again when you’re ready.',
    },
    /** The sentence that ends every card's own failure: the other cards are fine. */
    restIsLive: 'The rest of Home is live.',
    /** What each card says it could not load; the card's title is already above it. */
    cardFailed: {
      needsYou: 'Couldn’t load what needs you.',
      attention: 'Couldn’t load system problems.',
      recent: 'Couldn’t load recent chats.',
    },
  },
  /** The Running now card, which sits under Needs you while any run is going. */
  running: {
    title: 'Running now',
    link: 'Open Runs',
    listLabel: 'Runs running now',
    /** The button at the end of a row, which opens the run. */
    viewRun: 'View run',
    /** The word that leads line two, in Cinder's status table. */
    status: 'Running',
    /** What a run reads when no title can be found for it: its agent, else this. */
    untitled: 'A run',
    startedAt: (time: string): string => `started ${time}`,
    /** What started the run, as line two says it: one word, kind first. */
    startedBy: {
      chat: 'Chat',
      person: 'Person',
      schedule: 'Schedule',
      api: 'API',
      agent: 'Agent',
      'agent-run': 'Agent',
      goal: 'Goal',
      parent: 'Workflow',
      system: 'Interborough',
    },
    /** The line under the rows when more run than Home lists. */
    more: (count: number): string => `${String(count)} more in Runs`,
  },
  /**
   * The checklist a new installation shows in place of the overview (rows 01y to 02b), until the
   * person has had a chat. The words lead the page in place of the date line.
   */
  firstRun: {
    /** The accessible name of the checklist, and its title. */
    title: 'Get started',
    /** The line that leads the page, from how many of the three steps are still open. */
    lead: (stepsLeft: number): string =>
      stepsLeft >= 3
        ? 'Welcome. Three steps to your first chat.'
        : stepsLeft === 2
          ? 'Welcome. Two steps left.'
          : 'Welcome. One step left.',
    provider: {
      title: 'Connect a provider',
      description: 'Agents need a model provider before they can answer.',
      /** What a connected step says: the providers that hold a key, by name. */
      done: (providers: readonly string[]): string =>
        `${nameList(providers)} ${providers.length === 1 ? 'is' : 'are'} connected.`,
      action: 'Connect a provider',
      href: '/settings/models',
    },
    agent: {
      title: 'Create an agent, or start from Assistant',
      description: 'Assistant works now; other agents need a provider.',
      /** The title and the sentence of a host that lists no Assistant, where Assistant is not offered or named. */
      titleWithoutAssistant: 'Create an agent',
      descriptionWithoutAssistant: 'An agent is a model with instructions and tools.',
      /** What a done step says: the agent that is ready, such as "Assistant", or "An agent" when none is named. */
      done: (agent: string): string => `${agent} is ready to use.`,
      /** Who is ready when the host lists no agent to name. */
      anAgent: 'An agent',
      /** The quiet link that takes Assistant as the agent to start from. */
      useAssistant: 'Use Assistant',
      action: 'Create an agent',
      href: '/agents/new',
    },
    chat: {
      title: 'Say hello',
      description: 'Send a first message to see a chat run end to end.',
      action: 'Start a chat',
    },
  },
} as const;

/**
 * The words of Settings › Allowed models (board PageSettingsSections, "Allowed models,
 * /settings/allowed-models"): which models agents may use, and the caller's own preferences among
 * them. Saving is explicit, because it raises the policy revision.
 */
export const ALLOWED_MODELS_COPY = {
  intro: 'Which models agents may use, and what to prefer among them.',
  models: {
    title: 'Models',
    description:
      'Every model your connected providers offer; untick one to keep agents from using it.',
    empty: 'No models yet. Connect a provider and its models appear here to allow.',
    goToProviders: 'Go to Providers',
    /** The name of a provider's group of models. */
    groupLabel: (provider: string): string => `${provider} models`,
    loading: 'Loading models…',
    loadFailed: 'Couldn’t load the models.',
    tryAgain: 'Try again',
    /** Said under a model whose whole provider the policy keeps agents from using. */
    providerDenied: 'Its provider is not allowed by the host.',
    /** What a model that has none of the abilities below says in their place. */
    noAbilities: 'Text only',
    abilities: { tools: 'tools', images: 'images' },
  },
  preferences: {
    title: 'Preferences',
    description: 'Cost, speed and effort, among the models allowed above.',
    prefer: {
      label: 'Prefer',
      identifier: 'preferences.prefer',
      description: 'Which to favour when more than one allowed model fits.',
      options: {
        neither: 'Neither',
        cost: 'Lowest cost',
        speed: 'Fastest',
        both: 'Lowest cost and fastest',
      },
    },
    effort: {
      label: 'Default effort',
      identifier: 'preferences.effort',
      description: 'How hard a model thinks when an agent doesn’t say.',
      notSet: 'Not set',
    },
  },
  /** The effect of saving, under the preferences and beside the buttons. */
  note: 'Saving raises the policy revision, so plans made under the old policy are re-checked.',
  effect: 'Saving raises the policy revision.',
  reset: 'Reset to default',
  save: 'Save',
  saveFailed: {
    title: 'Couldn’t save.',
    didNotAnswer: 'Interborough didn’t answer.',
    stillHere: 'Your choices are still here.',
  },
  lockedNote: 'The host sets the model policy, and it cannot be changed here.',
} as const;

/** The words the settings page (`/settings`) uses outside its view states. */
export const SETTINGS_COPY = {
  /** The General page (board SettingsShell, "General, /settings"). */
  general: {
    intro: 'Tools, runs and your own preferences. Settings save as you leave a field.',
    /** The heading narrow widths show over the section select, which names the section. */
    narrowTitle: 'Settings',
    sections: {
      tools: { title: 'Tools' },
      runs: {
        title: 'Runs',
        description: 'Settings that apply after a restart say so, and a saved one waits for it.',
      },
      storage: { title: 'Storage' },
      remote: { title: 'Remote deployment' },
      preferences: {
        title: 'Your preferences',
        description:
          'Only you see these. They live in this browser and in quick settings, apart from the settings above that belong to this installation.',
      },
    },
    /** The row of the storage backend, which the host reports rather than the Bureau holding a setting. */
    storageBackend: {
      label: 'Storage backend',
      identifier: 'storage.backend',
      description: 'Where Interborough keeps runs, chats and memories. Chosen when it was set up.',
      remoteDescription: 'Where Interborough keeps runs, chats and memories.',
      local: 'SQLite, on this machine',
      remote: 'Postgres and S3',
      setByDeployment: 'Set by the deployment',
    },
    preferences: {
      theme: {
        label: 'Theme',
        identifier: 'theme',
        description: 'Matches your system by default.',
        options: { system: 'System', light: 'Light', dark: 'Dark' },
      },
      sidebar: {
        label: 'Sidebar',
        identifier: 'sidebar',
        description: 'Whether the sidebar starts expanded on this browser.',
        options: { expanded: 'Expanded', collapsed: 'Collapsed' },
      },
      defaultAgent: {
        label: 'Default agent for new chats',
        identifier: 'chat.defaultAgent',
        description: 'The agent a new chat starts with.',
        none: 'First agent that can run',
      },
      singleKey: {
        label: 'Use single-key shortcuts',
        identifier: 'shortcuts.singleKey',
        description:
          'Press G then a letter to go somewhere, or C for a new chat. They never act while you type in a field.',
      },
    },
    /** The sticky banner over the page while saved settings wait for a restart. */
    restartBanner: {
      title: (count: number): string =>
        count === 1
          ? '1 change waits for a restart'
          : `${String(count)} changes wait for a restart`,
      detail: (names: readonly string[]): string =>
        `${names.join(', ')}. Running work picks up where it stopped; reviews stay waiting.`,
      /** Puts every waiting setting back to the value the host runs now (board SettingsShell, "More states"). */
      revert: (count: number): string =>
        count === 1 ? 'Revert 1 change' : `Revert ${String(count)} changes`,
    },
    /** The Undo toast after Revert, and what the page says when Revert or Undo does not go through. */
    reverted: {
      toast: (count: number): string =>
        `Reverted ${count === 1 ? '1 change' : `${String(count)} changes`}. Nothing needs a restart.`,
      revertFailed: 'Couldn’t revert. The changes still wait for a restart.',
      undoFailed: 'Couldn’t undo. The settings stay reverted.',
    },
    /**
     * A setting's own words where the Remote deployment card shows it, in place of the Bureau's
     * description (board SettingsShell, "Locked settings, remote mode"): a remote deployment's
     * runs are not on this machine.
     */
    remoteDescriptions: {
      'engine.maxConcurrentRuns': 'The most workflow runs that execute at the same time.',
    } as Readonly<Record<string, string>>,
    /** The status of a row a restart just applied. */
    inEffectSince: (time: string): string => `In effect since ${time}`,
    /** Loading, and giving up on it. */
    loading: {
      label: 'Loading settings',
      stillLoading: 'Still loading. This is taking longer than usual.',
      canceled: 'Loading was canceled.',
      tryAgain: 'Try again',
    },
  },
  /** The label of the section select that replaces the navigation below 640px. */
  sectionSelect: 'Section',
  /** A value that failed its check was not saved. */
  nothingSaved: 'Nothing was saved.',
  /** A save that did not go through; the typed value is still in the field. */
  couldNotSave: 'Couldn’t save. Your value is still in the field.',
  /** A locked setting (board SettingsShell, "Locked settings, remote mode"). */
  lockedMessage:
    'Locked by your deployment (remote mode). Change it in the deployment’s configuration.',
  /**
   * The keyboard preference on the General page (design row 03f): it lives in this browser, so it is
   * not one of the deployment's settings above it.
   */
  keyboard: {
    title: 'Keyboard',
    singleKeyLabel: 'Use single-key shortcuts',
    singleKeyDescription:
      'Press G then a letter to go somewhere, or C for a new chat. They never act while you type in a field. Shortcuts held with ⌘ and the ? map always work. This applies to this browser only.',
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
  /**
   * The settings could not be read again while the page already holds them: the banner over the old
   * values (board PageSettingsSections, "Error, old data on screen"). Cinder's `refresh-failed`
   * preset writes the rest: when what is shown loaded, and the way to try again.
   */
  refreshFailed: { title: 'Couldn’t refresh these settings.' },
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

/**
 * The words the goals list (`/goals`) uses. The list draws its own empty, loading and failed states
 * under its own header (`ownsStatesOnPatterns` in `views.ts`), so `VIEW_COPY.goals` takes its empty
 * words from here.
 */
export const GOALS_COPY = {
  newAction: 'New goal',
  /** The line under the heading. */
  subtitle: 'Work an agent keeps trying until its check is met.',
  /** The accessible name of the filter bar. */
  filtersLabel: 'Filter goals',
  /** The accessible name of the list of goals. */
  rowsLabel: 'Goals',
  /** The status segments, in the order the filter bar draws them. */
  segments: {
    all: 'All',
    running: 'Running',
    done: 'Done',
    gaveUp: 'Gave up',
    stopped: 'Stopped',
  },
  /** The add-facet chip that narrows the list to one agent. */
  agentLabel: 'Agent',
  clearAction: 'Clear filters',
  /** Nothing yet: the empty state that is the page. */
  empty: {
    title: 'No goals yet',
    description:
      'A goal runs an agent again and again until a check you write passes. Try one when a single reply may not be enough.',
  },
  /** A filter that matches none of the goals read. */
  noMatch: {
    title: 'No goals match these filters',
  },
  /** The name of the loading region, and the line that says the read is slow. */
  loading: 'Loading goals',
  stillLoading: 'Still loading goals…',
  /** What the page says after "Cancel" in the "Still loading" line: nothing failed, the person stopped it. */
  stopped: {
    title: 'Stopped loading goals',
    description: 'You stopped the read, so the goals are not shown. Nothing was changed.',
  },
  /** A read that did not give the page its goals, with the status the server answered with. */
  failed: {
    title: 'Couldn’t load goals',
    answered: (status: number): string =>
      `The server answered with an error (${String(status)}). Nothing you did caused it.`,
    /** A refusal (401 or 403) is something to fix, so it carries the server's own words. */
    refused: (status: number, message: string): string =>
      `The server answered with an error (${String(status)}): ${message.replace(/[.\s]+$/, '')}.`,
    noAnswer: 'The server didn’t answer. Nothing you did caused it.',
    unknown: 'Something went wrong reading the goals. Nothing you did caused it.',
    openHealth: 'Check Health',
    openHealthPath: '/health',
  },
  /** Why the header's "+" is inert while the goals could not be read. */
  newActionOffReason: 'New goal is off until the goals load.',
  /** A day band's words for the days that are not named by their date. */
  band: { today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier' },
  /** What a goal's row says it is trying to make true: the check's text after the word. */
  checkLine: (text: string): string => `Check: ${text}`,
  /** The qualifier on Running for a goal that has been asked to stop and has not yet. */
  stopping: 'stopping',
  /**
   * The goal's own page (`/goals/:goal`): its name and status, the note that says how it ended or
   * what it waits on, its attempts newest first, and a Details panel beside them. The page draws
   * its own loading and failed states under its own header (`ownsStatesOnPatterns` in `views.ts`).
   */
  detail: {
    /** The heading while the goal is read, before its name is known (row 68t). */
    loadingTitle: 'Goal',
    /** The name of the loading region, and the line that says the read is slow. */
    loading: 'Loading this goal',
    stillLoading: 'Still loading this goal…',
    /** What the page says after "Cancel" in the "Still loading" line: nothing failed, the person stopped it. */
    stopped: {
      title: 'Stopped loading this goal',
      description: 'You stopped the read, so the goal is not shown. Nothing was changed.',
    },
    editAction: 'Edit',
    startAgainAction: 'Start again',
    stopAction: 'Stop goal',
    /** Why Start again is off for a model agent while no provider holds a key, and where to fix it. */
    connectProvider: 'Connect a provider',
    connectProviderPath: '/settings/models',
    /** Why Edit and Stop goal are inert while the server gives no answer (row 68w). */
    offlineReason: 'Edit and Stop goal are off until Interborough answers.',
    /** The qualifier on Running while an attempt's result is checked (sweep S73). */
    checkingQualifier: 'checking the result',
    /** The qualifier on Running while the goal is about to make its next attempt (sweep S73). */
    retryingQualifier: (next: number, most: number): string =>
      `attempt ${String(next)} of ${String(most)}`,
    attemptsHeading: 'Attempts',
    /** The accessible name of the list of attempts. */
    attemptsLabel: 'Attempts of this goal, newest first',
    attemptTitle: (number: number): string => `Attempt ${String(number)}`,
    noAttempts: {
      title: 'No attempts yet',
      description: 'The goal has not started an attempt. Its attempts are listed here as they run.',
    },
    /** Line two of an attempt's row, after the agent's name. */
    line: {
      took: (duration: string): string => `took ${duration}`,
      /** While the result is checked, "took" covers the agent's part of the attempt. */
      agentTook: (duration: string): string => `Agent took ${duration}`,
      agentStopped: (why: string): string => `Agent stopped: ${why}`,
      canceledAt: (clock: string, duration: string): string =>
        `canceled at ${clock} after ${duration}`,
      canceled: 'canceled',
      runningFor: (duration: string): string => `running for ${duration}`,
      waitingApproval: (tool: string): string => `${tool} is waiting for your approval`,
      waitingQuestion: 'A question is waiting for your answer',
      /** What an approval is for before its review has been read. */
      aTool: 'A tool',
    },
    /** Why an agent stopped, for the finish reasons that are not its normal end. */
    agentStopReasons: {
      tripwire: 'a guardrail',
      'maximum-steps': 'step limit',
      'budget-exceeded': 'budget',
      error: 'error',
    },
    /** The note under the header: how the goal ended, or what its attempt waits on. */
    note: {
      done: (attempt: number, most: number, when: string | undefined): string =>
        when === undefined
          ? `Done on attempt ${String(attempt)} of ${String(most)}: the check was met.`
          : `Done on attempt ${String(attempt)} of ${String(most)}: the check was met on ${when}.`,
      gaveUp: (made: number, most: number, when: string | undefined): string =>
        `Gave up${when === undefined ? '' : ` on ${when}`}, after ${String(made)} of ${String(most)} attempts. None of them met the check.`,
      stopped: (made: number, most: number, when: string | undefined): string =>
        `Stopped${when === undefined ? '' : ` on ${when}`}, after ${String(made)} of ${String(most)} attempts.`,
      attemptCanceled: (attempt: number): string =>
        `Attempt ${String(attempt)} was canceled; the work it did is kept in its run.`,
      failed: (made: number, most: number, when: string | undefined): string =>
        `Failed${when === undefined ? '' : ` on ${when}`}, after ${String(made)} of ${String(most)} attempts.`,
      openAttempt: (attempt: number): string => `Open attempt ${String(attempt)}`,
      waiting: (attempt: number, what: string): string =>
        `Attempt ${String(attempt)} is waiting on you: ${what}`,
      approvalNeeded: (tool: string): string =>
        `${tool} needs your approval before it can continue.`,
      questionNeeded: 'A question needs your answer before it can continue.',
      /** What an approval is for before its review has been read. */
      aTool: 'A tool',
      openInReviews: 'Open in Reviews',
    },
    /** "Fri, Oct 30 at 10:08 AM". */
    when: (day: string, clock: string): string => `${day} at ${clock}`,
    detailsHeading: 'Details',
    checkFact: 'Check',
    agentFact: 'Agent',
    limitFact: 'Attempt limit',
    stopsFact: 'Stops',
    createdFact: 'Created',
    attemptLimit: (most: number): string => (most === 1 ? '1 attempt' : `${String(most)} attempts`),
    stops: 'When the check passes, or after the last attempt',
    created: (when: string, by: string): string => `${when} by ${by}`,
    createdByYou: 'you',
    /** The Stop goal confirmation (row 67y). */
    stop: {
      title: (name: string): string => `Stop ${name}?`,
      checking: (attempt: number): string =>
        `Attempt ${String(attempt)} has finished and its result is being checked. Stopping cancels the check, and the work the attempt did stays in its run. No more attempts start. You can start the goal again later.`,
      running: (attempt: number): string =>
        `Attempt ${String(attempt)} is still running. Stopping cancels it, and the work the attempt did stays in its run. No more attempts start. You can start the goal again later.`,
      between: 'No more attempts start. You can start the goal again later.',
      busy: 'Stopping…',
      failedTitle: 'Couldn’t stop the goal.',
      failed: 'Interborough didn’t answer. Nothing was changed.',
      changed:
        'The goal changed while you were reading it. Nothing was changed, so look again and try once more.',
    },
    loadFailed: {
      title: 'The goal could not be loaded',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
  },
  /** The words for attempts used, of the most the goal may make. */
  attempts: (used: number, most: number): string => `${String(used)} of ${String(most)}`,
  /**
   * New goal (`/goals/new`, which Start again opens prefilled) and Edit goal (`/goals/:goal/edit`),
   * one form with four fields: what to do, the check, the agent and the attempt limit. The words
   * of Edit are in `edit`; every other key is the form's own.
   */
  form: {
    title: 'New goal',
    description:
      'Describe what you want and how to tell it worked. The agent keeps trying until the check passes.',
    /** The accessible name of the form's fields. */
    fieldsLabel: 'Goal',
    promptLabel: 'What should the agent do?',
    promptDescription:
      'Say what the agent should do. The first line becomes the goal’s name, shown in Goals and on each attempt.',
    promptRequired: 'Say what the agent should do.',
    checkLabel: 'Check',
    checkDescription: 'Write it as a statement that is true or false about the result.',
    checkPlaceholder: 'How will we know it worked?',
    checkRequired: 'Say how to tell the goal is done, such as “Reply says hello”.',
    agentLabel: 'Agent',
    agentPlaceholder: 'Choose an agent',
    agentDescription: 'The agent that makes each attempt.',
    agentUnavailableDescription: 'The agents could not be listed. Reload the page to try again.',
    noAgents: {
      title: 'No agents to run a goal',
      description: 'A goal runs an agent, and this installation lists none. Create an agent first.',
    },
    maximumAttemptsLabel: 'Attempt limit',
    maximumAttemptsDescription: 'Gives up after this many attempts, from 1 to 20.',
    maximumAttemptsInvalid: 'Use a number from 1 to 20.',
    /** Above the first field when a model agent is chosen and no provider holds a key. */
    needsProvider: (agent: string): string =>
      `${agent} needs a model provider, so a goal can’t make attempts yet.`,
    connectProvider: 'Connect a provider',
    connectProviderPath: '/settings/models',
    useAgent: (agent: string): string => `Use ${agent}`,
    /** The note beside the buttons: what the agent chosen needs, or what the form is doing. */
    footer: {
      scripted: (agent: string): string => `${agent} is scripted, so no provider is needed.`,
      starts: 'Creating the goal starts attempt 1.',
      gated: (agent: string): string =>
        `Create goal is off until a provider is connected, or you choose ${agent}.`,
      creating: 'Creating the goal and starting attempt 1…',
      prompt: 'The prompt is required before this can start.',
      check: 'The check is required before this can start.',
      attempts: 'The attempt limit is out of range.',
    },
    createAction: 'Create goal',
    creatingAction: 'Creating…',
    cancelAction: 'Cancel',
    /** What Cancel is called once the goal exists, so there is nothing left to cancel. */
    closeAction: 'Close',
    /** A create the Bureau did not take: what failed, then what is kept. */
    failedTitle: 'Couldn’t create the goal.',
    unreachable: 'Interborough didn’t answer.',
    kept: 'Nothing was saved, and everything you typed is still here.',
    tryAgain: 'Try again',
    /** The goal was committed, and the Bureau could not start its controller: it stays pending until recovery. */
    startFailedTitle: 'Goal created, but it did not start',
    startFailedGoal: (id: string): string => `Goal ${id}`,
    /** The name of the placeholders while Start again reads the goal it opens from. */
    loading: 'Loading the goal',
    /** Edit goal: New goal's four fields, prefilled, and a Save that starts no attempt. */
    edit: {
      title: 'Edit goal',
      description:
        'Changes apply to future attempts only. Attempts already made keep the check they ran against.',
      footer: 'Saving doesn’t start an attempt.',
      saving: 'Saving the goal…',
      saveAction: 'Save',
      savingAction: 'Saving…',
      /** The goal's view never carries its prompt, so the field starts empty and keeps the current one. */
      promptPlaceholder: 'Leave this empty to keep the current prompt.',
      failedTitle: 'Couldn’t save the goal.',
      kept: 'Nothing was changed.',
      changed: 'The goal changed while you were editing it. Look at it again, then try once more.',
    },
  },
} as const;

/** The words the audit log (`/health/audit`) uses: its filters, its table, and the pane of one event. */
export const AUDIT_COPY = {
  /** The accessible name of the filter row. */
  searchLabel: 'Filter the audit log',
  actorLabel: 'Who',
  /** The Who select's first option: no narrowing by who did it. */
  anyone: 'Anyone',
  actors: { you: 'You', agents: 'Agents', interborough: 'Interborough' },
  periodLabel: 'Period',
  periods: {
    today: 'Today',
    '7d': 'Last 7 days',
    '30d': 'Last 30 days',
    '90d': 'Last 90 days',
    all: 'All time',
  },
  actionLabel: 'Action',
  /** The action select's first option: no narrowing by what was done. */
  anyAction: 'Any action',
  actions: {
    approved: 'Approved',
    deleted: 'Deleted',
    edited: 'Edited',
    removed: 'Removed',
    started: 'Started',
  },
  textLabel: 'Search the audit log',
  textPlaceholder: 'Search by actor, action or target',
  /** The count at the right of the search box. */
  count: (count: number, more: boolean): string =>
    `${count.toLocaleString('en-US')} ${count === 1 ? 'event' : 'events'}${more ? ' so far' : ''}`,
  /** The footer of the table. */
  footer: (loaded: number, total: number | undefined, more: boolean): string =>
    total === undefined || !more
      ? `${loaded.toLocaleString('en-US')} ${loaded === 1 ? 'event' : 'events'}, newest first.`
      : `Showing ${loaded.toLocaleString('en-US')} of ${Math.max(total, loaded).toLocaleString('en-US')} events, newest first. Scroll to load more.`,
  /** The name of the table, which also says how it is ordered. */
  caption: 'Audit events, newest first',
  /** The name of the open event's pane. */
  detailLabel: 'Event',
  columns: { when: 'When', who: 'Who', what: 'What', target: 'Target' },
  /** A day group's header: the day, then the zone the times are read in. */
  dayHeading: {
    today: (date: string): string => `Today, ${date}`,
    yesterday: (date: string): string => `Yesterday, ${date}`,
  },
  /** The pane while no event is open. */
  emptyDetailTitle: 'Select an event to see what changed',
  emptyDetailDescription: 'Each event shows who did it, when, and the before and after.',
  /** The line under an event's title. `when` reads "Today at 10:45:12 AM". */
  whenLine: (when: string, context: string | null): string =>
    context === null ? when : `${when}, ${context}`,
  fromThisBrowser: 'from this browser',
  inTheChat: (title: string): string => `in the chat “${title}”`,
  fact: {
    provider: 'Provider',
    effect: 'Effect',
    agent: 'Agent',
    chat: 'Chat',
    version: 'Version',
    changed: 'Changed',
    tool: 'Tool',
    risk: 'Risk',
    amount: 'Amount',
    status: 'Status',
    schedule: 'Schedule',
    workflow: 'Workflow',
    run: 'Run',
    about: 'About',
    detail: 'Details',
  },
  /** What removing a provider's key does, which is the same whichever provider it was. */
  providerRemovedEffect: 'Agents that use a model can’t run until a provider is connected',
  riskDangerous: 'Dangerous, Can’t be undone',
  riskChanges: 'Changes things',
  riskReadOnly: 'Only reads',
  changedWords: {
    instructions: 'Instructions',
    tools: 'Tools',
    approvals: 'Tool approvals',
    // What an audit event recorded before `toolApproval` became `approvals` (COR-2137).
    toolApproval: 'Tool approvals',
    model: 'Model',
    description: 'Description',
    skills: 'Skills',
    // The agent file's keys after COR-2137, worded as the agent editor words them.
    effort: 'Default effort',
    children: 'Child agents',
    card: 'Skill descriptors',
  },
  toolsAdded: (names: string): string => `added ${names}`,
  toolsRemoved: (names: string): string => `removed ${names}`,
  /** The footer of the diff of an agent's instructions, in Cinder's own words. */
  instructionsLabel: 'What changed in the instructions',
  links: {
    providers: 'Open Providers',
    review: 'Open review',
    agent: 'Open agent',
    run: 'Open run',
    chat: 'Open chat',
    schedule: 'Open schedule',
    workflow: 'Open workflow',
    storage: 'Open storage',
  },
  copyAsJson: 'Copy as JSON',
  copiedAsJson: 'Copied as JSON',
  copyKey: 'Copy key',
  copiedKey: 'Copied the key',
  copyFailed: 'Couldn’t copy. Select the text and copy it yourself.',
  /** The heading of a target too long for a table cell, with how many characters it has. */
  targetHeading: (length: number): string => `Target, ${length.toLocaleString('en-US')} characters`,
  /** The footer of every event's pane: how long records are kept, and what Export saves. */
  retention: {
    before: 'Audit records are kept 90 days (',
    link: 'Settings › Data and retention',
    after: '). Export downloads the filtered list as JSON Lines.',
  },
  exportAction: 'Export',
  exporting: 'Exporting…',
  /** Why Export is off while the log on screen is old: the same word the page's other held controls use. */
  exportOff: 'Off until the audit log loads again',
  /** The line under the filter row while Export reads the log: how many events it prepares, and the way out. */
  exportProgress: (count: number): string =>
    `Preparing ${count.toLocaleString('en-US')} ${count === 1 ? 'event' : 'events'} as JSON Lines…`,
  exportCancel: 'Cancel',
  exported: (count: number): string =>
    `Exported ${count.toLocaleString('en-US')} ${count === 1 ? 'event' : 'events'}`,
  nothingToExport: 'There is nothing to export for these filters.',
  /** A danger alert at the page: the lead, then why, then that the filters and the download are as they were. */
  exportFailed: {
    lead: 'Couldn’t export.',
    answered:
      'The server stopped while writing the file. Your filters are unchanged; nothing was downloaded.',
    noAnswer: 'The server didn’t answer. Your filters are unchanged; nothing was downloaded.',
    again: 'Export again',
  },
  loadingLabel: 'Loading the audit log',
  /**
   * Filters that match nothing. A search names itself in the title and says how to search; filters
   * say what was not recorded ("Nothing by agents was recorded today.") and what to try.
   */
  noMatches: {
    title: 'No events match these filters',
    titleForSearch: (text: string): string => `No events match “${text}”`,
    searchHint: 'Check the spelling, or search by actor, action or target.',
    clear: 'Clear filters',
    /** "Nothing", then the action and who when they are set, then when. */
    nothing: 'Nothing',
    byActor: { you: 'by you', agents: 'by agents', interborough: 'by Interborough' },
    actionWords: {
      approved: 'approved',
      deleted: 'deleted',
      edited: 'edited',
      removed: 'removed',
      started: 'started',
    },
    wasRecorded: {
      today: 'was recorded today.',
      '7d': 'was recorded in the last 7 days.',
      '30d': 'was recorded in the last 30 days.',
      '90d': 'was recorded in the last 90 days.',
      all: 'has been recorded.',
    },
    /** What to try, by how far back the period already reaches. */
    tryLongerPeriod: 'Try a longer period.',
    tryAllTime: 'Try all time, or change a filter.',
    tryAnotherFilter: 'Change or clear a filter.',
  },
  /** What the log says after "Cancel" in the "Still loading" line: nothing failed, the person stopped it. */
  stopped: {
    title: 'Stopped loading the audit log',
    description: 'You stopped the read, so the log is not shown. Nothing in it was changed.',
  },
  /** A list with more pages to read, where none of the events read so far matches the search. */
  noLoadedMatches: {
    title: 'No loaded event matches',
    description:
      'None of the events read so far matches this search, and the log has more. Change or clear a filter.',
    clear: 'Clear filters',
  },
  /** An address that names an event the page could not show. */
  recordNotFound: {
    more: 'That event was not found in the recent log. Load more to keep looking.',
    end: 'That event is not in the log.',
  },
  loadMore: 'Load more',
  /** A read that did not give the page its events, with the status the server answered with. */
  failed: {
    title: 'Couldn’t load the audit log',
    answered: (status: number): string =>
      `The server answered with an error (${String(status)}). Nothing you did caused it.`,
    /** A refusal (401 or 403) is something to fix, so it carries the server's own words. */
    refused: (status: number, message: string): string =>
      `The server answered with an error (${String(status)}): ${message.replace(/[.\s]+$/, '')}.`,
    noAnswer: 'The server didn’t answer. Nothing you did caused it.',
    unknown: 'Something went wrong reading the audit log. Nothing you did caused it.',
    /** The second action: this page is already inside Health, so it says Open Health. */
    openHealth: 'Open Health',
    openHealthPath: '/health',
  },
} as const;

/** The sentences that say what an audit event was, in the order the table reads them: who, what, target. */
export const AUDIT_EVENT_COPY = {
  /** The actor of what the host itself did or noticed. */
  host: 'Interborough',
  you: 'You',
  serverStarted: 'Server started',
  serverStartedTarget: 'Interborough',
  /** The target of a start that recorded its version: "Interborough 2.4.1". */
  serverStartedVersionTarget: (version: string): string => `Interborough ${version}`,
  removedProviderKey: (provider: string): string => `Removed the ${provider} key`,
  providerTarget: (provider: string): string => `${provider} provider`,
  startedRun: 'Started a run',
  stoppedRun: 'Stopped a run',
  runFailed: 'A run failed',
  chatTarget: (title: string): string => `Chat › ${title}`,
  scheduleRan: 'Started a scheduled run',
  createdSchedule: 'Created a schedule',
  pausedSchedule: 'Paused a schedule',
  resumedSchedule: 'Resumed a schedule',
  canceledSchedule: 'Canceled a schedule',
  missedRuns: (count: number): string =>
    `Noticed ${count.toLocaleString('en-US')} missed ${count === 1 ? 'run' : 'runs'}`,
  /** A tool asked before running: `request` is the tool's own sentence, lower-cased, such as "refund order 4471". */
  askedTo: (request: string): string => `Asked to ${request}`,
  askedToUse: (tool: string): string => `Asked to use ${tool}`,
  approvedToolCall: 'Approved a tool call',
  deniedToolCall: 'Denied a tool call',
  ranTool: (tool: string): string => `Ran ${tool}`,
  correctedMemory: 'Corrected a memory',
  forgotMemory: 'Forgot a memory',
  editedAgent: 'Edited an agent',
  createdWorkflow: 'Created a workflow',
  editedWorkflow: 'Edited a workflow',
  createdHook: 'Created a hook',
  editedHook: 'Edited a hook',
  deletedChat: 'Deleted a chat',
  chatTargetDeleted: 'Chat',
  /** The target of a deleted chat whose record kept its title: "“Scratch test”, 12 messages". */
  deletedChatTarget: (title: string, messages: number | undefined): string =>
    messages === undefined
      ? `“${title}”`
      : `“${title}”, ${messages.toLocaleString('en-US')} ${messages === 1 ? 'message' : 'messages'}`,
  deletedStorageKey: 'Deleted a storage key',
  storageTarget: (key: string): string => `Storage › ${key}`,
  connectedToolSource: 'Connected a tool source',
  removedToolSource: 'Removed a tool source',
  trustedSkillSource: 'Changed what a skill source may do',
  changedSettings: 'Changed a setting',
  webhookGaveUp: 'Gave up delivering a hook',
  /** An event the page has no sentence for: the record's own type, in words. */
  other: (type: string): string => type,
  anAgent: 'An agent',
  aSchedule: 'A schedule',
  versionRange: (from: number | undefined, to: number | undefined): string =>
    from === undefined ? `version ${to ?? ''}` : `version ${from} → ${to ?? ''}`,
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
  /** The line under the heading of the list (rows 12d and 36r). */
  subtitle: 'Agents run your chats, goals and schedules.',
  filtersLabel: 'Filter agents',
  searchLabel: 'Search agents',
  searchPlaceholder: 'Search agents',
  clearAction: 'Clear filters',
  /** The segments of the list: every agent, and the ones that can run (row 11c). */
  segments: { all: 'All', available: 'Available' },
  /** The card of the agents that can run, and the card of the ones a disabled plugin holds back (rows 36d and 36j). */
  groups: {
    availableCount: (count: number): string => `Available ${String(count)}`,
    sortedBy: 'Sorted by last activity',
    unavailableCount: (count: number): string => `Unavailable ${String(count)}`,
    /** Why the agents of the second card cannot run, and what brings them back. */
    held: (plugins: readonly string[], agents: number): string =>
      `${agents === 1 ? 'Its plugin' : plugins.length === 1 ? 'Their plugin' : 'Their plugins'}, ${nameList(plugins)}, ${plugins.length === 1 ? 'is' : 'are'} disabled. ${agents === 1 ? 'Chats with this agent are' : 'Chats with these agents are'} read-only until you enable ${plugins.length === 1 ? 'it' : 'them'} and restart.`,
    availableLabel: 'Available agents',
    unavailableLabel: 'Unavailable agents',
  },
  /** A row of the list (rows 36f to 36k, 37d and 37f). */
  row: {
    /** The words after the chat count of an agent the host ships itself (row 36g). */
    builtIn: 'Built in',
    noActivity: 'No activity yet',
    yesterday: 'Yesterday',
    /** In the action slot of an agent a disabled plugin holds back, when the host gives no reason. */
    pluginDisabled: (plugin: string): string => `Plugin ${plugin} is disabled`,
    memoryOf: (agent: string): string => `Memory of ${agent}`,
    newChatWith: (agent: string): string => `New chat with ${agent}`,
    editAgent: (agent: string): string => `Edit ${agent}`,
    /** Why New chat is held while no provider can answer (row 11e). */
    connectToChat: 'Connect a provider to start a chat',
  },
  /** Nothing has been created, and no plugin holds any agent back (row 36m). */
  empty: {
    title: 'No agents yet',
    description: 'An agent is a model with instructions and tools. Create one to chat with it.',
    addPlugin: 'Add a plugin',
  },
  /** Every agent is held back by a disabled plugin (row 36o). */
  onlyUnavailable: {
    title: 'No agent can run yet',
    description: (agents: readonly string[], plugins: readonly string[]): string =>
      `${nameList(agents)} ${agents.length === 1 ? 'is' : 'are'} held back while ${nameList(plugins)} ${plugins.length === 1 ? 'is' : 'are'} disabled.`,
  },
  /** Only the host's own agents exist (row 12c): a compact line beneath them. */
  noneOfYours: {
    title: 'No agents of your own yet',
    description: 'Built-in agents are ready; add your own for work they don’t cover.',
  },
  noMatch: {
    title: 'No agent matches this search',
    description: 'Change the search to see more agents.',
  },
  loading: 'Loading agents',
  stillLoading: 'Still loading agents. This is taking longer than usual.',
  /** The accessible name of the list of agent files the Bureau cannot use. */
  invalidListLabel: 'Agent files with a problem',
  /** The Memory tab with the agent's memory count; `more` is true when pages of it are unread. */
  memoryWithCount: (shown: number, more: boolean): string => `Memory ${shown}${more ? '+' : ''}`,
  fileVersion: 'File version',
  history: 'History',
  /**
   * Enabling the plugin behind the unavailable agents, from the list (rows 36x, 36y, 37g and 37h):
   * the question Settings › Plugins asks, with the effect on running work in an inset note.
   */
  enable: {
    action: 'Enable and restart',
    title: (plugins: readonly string[]): string => `Enable ${nameList(plugins)} and restart?`,
    description: (plugins: readonly string[], agents: readonly string[]): string =>
      `Plugins load at startup, so Interborough restarts to load ${nameList(plugins)}.${agents.length === 0 ? '' : ` ${nameList(agents)} ${agents.length === 1 ? 'becomes' : 'become'} available afterwards.`}`,
    /** The runs going now, said first when there are any; the note never says that nothing is running. */
    running: (runs: number): string =>
      runs === 1 ? '1 run is running now.' : `${String(runs)} runs are running now.`,
    /** What a restart does to work in flight: running work resumes and reviews keep waiting. */
    work: (waiting: number): string =>
      `Running work picks up where it stopped; reviews stay waiting${waiting === 0 ? '' : ` (${String(waiting)} ${waiting === 1 ? 'is' : 'are'} waiting on you)`}. Interborough reconnects on its own when it is back.`,
    confirm: 'Enable and restart',
    /** The bold lead of the failure callout, and what it says when nothing was restarted. */
    failedTitle: (plugin: string): string => `Couldn’t enable ${plugin}.`,
    failedReason: (reason: string): string =>
      `${reason.endsWith('.') ? reason : `${reason}.`} Nothing was restarted and nothing changed.`,
    unknownReason: 'The host did not accept the change.',
    /**
     * The lead of the banner when the switch was saved and the host would not restart: the reason
     * after it is `RESTART_COPY.refusal`, which says to restart it where it runs.
     */
    notRestartedTitle: (plugins: readonly string[]): string =>
      `${nameList(plugins)} ${plugins.length === 1 ? 'is' : 'are'} switched on, but Interborough has not restarted.`,
    openPlugins: 'Open Plugins',
    /** The success banner after the host is back; Settings › Plugins draws the steps of the restart (row 37a). */
    back: (plugins: readonly string[], agents: readonly string[]): string =>
      `${nameList(plugins)} ${plugins.length === 1 ? 'is' : 'are'} on.${agents.length === 0 ? '' : ` ${nameList(agents)} ${agents.length === 1 ? 'is' : 'are'} available again.`}`,
  },
} as const;

/** The words of an agent's page: its tabs, the controls over its chats, its instructions and its settings. */
export const AGENT_PAGE_COPY = {
  tabsLabel: 'Sections of this agent',
  /** Each tab's name, in the tab bar, in the narrow form's select and as the last breadcrumb. */
  tabs: {
    chats: 'Chats',
    instructions: 'Instructions',
    access: 'Access',
    hooks: 'Hooks',
    memory: 'Memory',
    settings: 'Settings',
  },
  /**
   * The header every tab shares (board PageAgent, rows 38a to 38c): the status line under the
   * description, which names what the agent's chats are doing and then how many there are, and the
   * reason an agent that needs a model cannot answer while no provider is connected.
   */
  header: {
    waiting: 'Waiting on you',
    running: 'Running',
    unavailable: 'Unavailable',
    noChats: 'No chats yet',
    /** The status word, then the chat count: "Waiting on you, 3 chats". */
    status: (state: string, chats: string): string => `${state}, ${chats}`,
    needsProvider: 'Can’t answer until a provider is connected,',
    connectProvider: 'Connect a provider',
  },
  /**
   * What a tab body shows when it has nothing to show yet or its read failed (board PageAgent,
   * "Loading" and "Error" frames, rows 39e to 39g). The header and the tab bar stay as they are.
   */
  tabState: {
    loading: (tab: string): string => `Loading ${tab}`,
    stillLoading: 'Still loading this tab. This is taking longer than usual.',
    failedTitle: 'Couldn’t load this tab',
    failedDescription: (status: number | undefined): string =>
      status === undefined
        ? 'The server didn’t answer. Nothing you did caused it.'
        : `The server answered with an error (${String(status)}). Nothing you did caused it.`,
    /** The tab still shows what it last loaded, and the banner over it says when that was. */
    staleTitle: 'Couldn’t refresh this tab.',
    staleSubject: 'this tab',
  },
  /**
   * An agent whose plugin is disabled (board PageAgent, "Agent from a disabled plugin", rows 39c and
   * 39d): it can be read and duplicated, and the banner over each tab says why it cannot run.
   */
  unavailable: {
    title: (agent: string): string => `${agent} isn’t available`,
    description: (plugin: string): string =>
      `Its plugin, ${plugin}, is disabled. Chats stay readable; sending, approving and running need the agent.`,
    enable: 'Enable and restart',
    /** Why New chat is held: the reason its tooltip gives. */
    newChatReason: (plugin: string): string => `Enable ${plugin} to start a chat`,
  },
  /**
   * The Chats tab (board PageAgent, rows 38e to 38g and 39p): one filter row of the state segments
   * with their counts, a search, Started by and Sort by, over the chats under day bands. Sort by
   * reads "Newest first" while it is clear: the chats by their last activity.
   */
  chats: {
    filtersLabel: 'Filter this agent’s chats',
    stateLabel: 'Status',
    states: { all: 'All', 'needs-you': 'Waiting on you', running: 'Running' },
    searchLabel: 'Search chats by title',
    searchPlaceholder: 'Search chats',
    startedByLabel: 'Started by',
    startedByAnyone: 'Anyone',
    startedBy: { chat: 'You', schedule: 'A schedule', goal: 'A goal' },
    sortLabel: 'Sort by',
    sortDefault: 'Newest first',
    sorts: { newest: 'Newest started', oldest: 'Oldest first' },
    emptyTitle: 'No chats yet',
    emptyDescription: (agent: string): string => `Chats with ${agent} appear here, newest first.`,
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
  /**
   * The Instructions tab (board PageAgent, rows 38i, 38j and 39r): the version line, the agent
   * file's body as a document, and the reference documents it reads, which are changed in the
   * editor, so the tab only lists them.
   */
  instructions: {
    heading: 'Instructions',
    builtIn: 'This agent is built in, so its instructions cannot be edited here.',
    emptyTitle: 'No instructions',
    emptyDescription: 'This agent has no instructions of its own.',
    emptyAction: 'Add instructions',
    /** The line over the document: "Version 4, saved Oct 29 by you". A save made by editing the file has no person to name. */
    version: (revision: number, saved: string, byYou: boolean): string =>
      `Version ${String(revision)}, saved ${saved}${byYou ? ' by you' : ' in the file'}`,
    referencesHeading: 'Reference documents',
    referencesDescription: 'Read with every chat',
    referencesNote:
      'Documents are added and removed in the editor, so each change becomes a version.',
    editAgent: 'Edit agent',
    /** The one muted line of an agent that reads no document: the editor, its one link, between the two halves. */
    noReferencesBefore: 'None added. Add one in ',
    noReferencesEditor: 'the editor',
    noReferencesAfter: '.',
    /** The same line for a plugin's agent, whose file the page cannot change, so it links nowhere. */
    noReferencesReadOnly: 'None added.',
  },
  /**
   * The Access tab (board PageAgent, rows 38l to 40c; board ResponsiveAndDark, rows 07a and 07b): a
   * toolbar with a search, a segment per source and the one allowed count, the tools in collapsible
   * groups with a leading allow box and an Asks select on each row, the skills, then Guardrails and
   * spend. Each change saves at once as a new version, and each row says when its own save is in
   * flight or failed.
   */
  access: {
    heading: 'Access',
    builtIn: 'This agent is built in, so its access cannot be changed here.',
    loadFailed: 'The access settings could not be loaded.',
    invalid: 'This agent’s file has a problem, so its access cannot be changed until it is fixed.',
    forbidden: 'You may not change this agent.',
    /** The toolbar over the table (row 38l): the search, the source segments, and the allowed count. */
    toolbarLabel: 'Filter tools',
    searchLabel: 'Search tools by name',
    searchPlaceholder: 'Search tools',
    sourceLabel: 'Source',
    all: 'All',
    /** The one allowed count, at the right of the toolbar: "3 of 9 allowed". */
    toolCount: (allowed: number, total: number): string =>
      `${String(allowed)} of ${String(total)} allowed`,
    /** Beside the count once a change saved, and the toast that says the same (row 39h). */
    saved: (revision: number | null): string =>
      revision === null ? 'Saved' : `Saved as Version ${String(revision)}`,
    viewVersions: 'View versions',
    /** What the offline banner names as the data it still shows (row 40b). */
    offlineSubject: 'Access',
    tableCaption: 'The tools this agent may call, and when each asks first',
    /** The table's columns (row 38m); the first holds each row's allow box. */
    columns: {
      allow: 'Allowed',
      tool: 'Tool',
      does: 'What it does',
      risk: 'Risk',
      asks: 'Asks',
    },
    /** The accessible name of a row's allow box. */
    allowLabel: (tool: string): string => `Allow ${tool}`,
    /** The accessible name of a row's Asks select. */
    asksFirstLabel: (tool: string): string => `When ${tool} asks first`,
    approvals: {
      never: 'Never',
      'on-changes': 'On changes',
      always: 'Always',
      blocked: 'Blocked',
    },
    /** An Asks option; the tool's own default says so (row 38p). */
    asksOption: (level: string, isDefault: boolean): string =>
      isDefault ? `${level} (default)` : level,
    /** Under `never`, for a tool that declares no tier: Armorer still asks about a call it cannot classify. */
    neverUnclassifiedHint:
      'This tool declares no tier, so it still asks before every call, even here.',
    /** A group's header after its source: how many of its tools are allowed (row 38m). */
    groupCount: (allowed: number, total: number): string =>
      `${String(allowed)} of ${String(total)} tools allowed`,
    /** The group of tools the file lists that the host no longer offers. */
    notInCatalogGroup: 'No longer offered',
    notInCatalog: 'Not offered by this host any more',
    noToolsTitle: 'This host offers no tools',
    noToolsDescription: 'Tools come from the host’s plugins and saved tool sources.',
    noMatchTitle: 'No tools match',
    noMatchDescription: 'No tool’s name matches this search in this source.',
    clearSearch: 'Clear search',
    /** A row's own state while its change is saved (row 39j). */
    saving: 'Saving…',
    /** The line under a row whose save failed (row 39k), before its Try again link. */
    failed: (subject: string, restored: string): string =>
      `Couldn’t save ${subject}. It went back to ${restored}.`,
    retry: 'Try again',
    /** What a failed allow box or guardrail box went back to. */
    restoredAllowed: 'allowed',
    restoredNotAllowed: 'not allowed',
    restoredOn: 'on',
    restoredOff: 'off',
    /** The Skills group (row 38q): its title and the note after it; skills are not counted with the tools. */
    skillsTitle: (count: number): string => (count === 1 ? '1 skill' : `${String(count)} skills`),
    skillsNote: 'They follow the tools they use.',
    skillWord: 'Skill',
    /** The Risk cell of a skill: it has no risk of its own. */
    skillRisk: '—',
    skillAsks: 'Follows its tools',
    /** A skill the agent's file defines itself (sweep S65), listed above the host's. */
    definedInFile: 'Defined in this file',
    grantLabel: (skill: string): string => `Grant ${skill}`,
    skillsLoadFailed: 'The skills could not be loaded.',
    /** The section under the table (row 38r). */
    guardrailsHeading: 'Guardrails and spend',
    guardrailsLabel: 'Guardrails',
    guardrailsNote: 'Guardrails come from enabled plugins. The default ones always run.',
    noGuardrails: 'No enabled plugin offers a guardrail.',
    guardrailsLoadFailed: 'The guardrails could not be loaded.',
    /** A guardrail the file lists that no enabled plugin offers now. */
    guardrailMissing: 'Not offered by an enabled plugin',
    spendLabel: 'Spend limit per chat',
    spendPlaceholder: 'No limit',
    spendUnit: 'USD',
    spendNote: 'Stops and asks when reached.',
    /** What a failed spend limit is called, and what it went back to when it had none. */
    spendSubject: 'the spend limit',
    noLimit: 'No limit',
  },
  settings: {
    heading: 'Settings',
    modelLabel: 'Model',
    modelsLabel: 'Models it can be switched to',
    stepLimitLabel: 'Step limit',
    /** The step limit of an agent whose file sets none: Operative's default applies. */
    stepLimitDefault: (steps: number): string => `Default (${String(steps)} steps)`,
    defaultEffortLabel: 'Default effort',
    none: 'No limit',
    notSet: 'Not set',
    builtIn: 'This agent is built in, so its settings cannot be changed here.',
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
    /** The day bands: today and yesterday by their names, any other day by its date. */
    today: 'Today',
    yesterday: 'Yesterday',
    earlier: 'Earlier',
    /** The field that narrows the list by what a chat says. */
    searchLabel: 'Search chats',
    searchPlaceholder: 'Search chats',
    /** The status segments over the list; the count is part of each one's accessible name. */
    segmentsLabel: 'Status',
    segments: { all: 'All', waiting: 'Waiting on you', done: 'Done' },
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
  /** An open chat while it is read, and when it cannot be (design rows 17c to 17e, 17j, 17y). */
  load: {
    /** The accessible name of the placeholders while the chat is read. */
    loadingLabel: 'Loading this chat',
    /** Cinder skeleton's status line once the read is taking long, with a Cancel beside it. */
    stillLoading: 'Still loading this chat…',
    /** The breadcrumb's last entry while the chat is not read yet or cannot be read, in place of its identifier. */
    crumb: 'This chat',
    errorTitle: 'This chat couldn’t be loaded',
    errorDescription:
      'Interborough didn’t send it back. Nothing was lost; the messages are stored with the chat.',
    tryAgain: 'Try again',
    backToChats: 'Back to chats',
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

/** The deletion states `bureau.memory.forget` answers with, in the receipt's own vocabulary. */
export type MemoryDeletionState = 'completed' | 'pending' | 'exempt' | 'failed' | 'unknown';

/**
 * The words of an agent's Memory tab (`/agents/:agent/memory`): the list, the search, one memory's
 * lineage, and what forgetting and correcting answer. The tab's first load and a first read that
 * fails are worded as every tab's are (`AGENT_PAGE_COPY.tabState`), and not found is the Agents
 * view's (`VIEW_COPY.agents`).
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
        'Your words are kept until you correct or forget them, and the agent recalls them in its chats with you. Text the content rules flag is held back instead, and you can remove it here.',
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
    /** Text the content rules flagged: stored for inspection, in no list, and the agent never recalls it. */
    held: {
      title: 'The text was held back',
      description:
        'Interborough’s content rules flagged it, so the agent will not recall it. A copy is still stored for inspection until you remove it. Remove it, or reword the text and save again: saving again removes the held copy first.',
      remove: 'Remove the held copy',
      removing: 'Removing…',
      notRemoved: {
        title: 'The held copy was not removed',
        description:
          'The server did not confirm the removal, so the copy is still stored. Try removing it again.',
      },
    },
    refusal: {
      'not-admitted': {
        title: 'The memory was not accepted',
        description:
          'Interborough’s content rules or this agent’s memory limit refused it, so nothing was saved. Reword it and try again.',
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
  /**
   * The Runs list (`/runs`): the header's description, the status segments, the facets, the day
   * bands and the words of each row's line two. Parts of a line are joined by a comma, never a
   * middle dot (owner decision, Nov 10).
   */
  list: {
    description: 'What your agents have done, newest first.',
    /** The accessible name of the list of runs. */
    rowsLabel: 'Runs, newest first',
    /** The status segments, in the order the bar draws them. */
    segments: {
      all: 'All',
      waiting: 'Waiting on you',
      running: 'Running',
      done: 'Done',
      failed: 'Failed',
      canceled: 'Canceled',
    },
    searchLabel: 'Search runs',
    searchPlaceholder: 'Search runs',
    /** The day bands: today's and yesterday's say so before the date. */
    today: 'Today',
    yesterday: 'Yesterday',
    /** What joins the parts of a day band and of a row's line two. */
    separator: ', ',
    /** The first word of line two: what kind of run it is, by what started it. */
    kinds: {
      chat: 'Chat',
      person: 'Started by hand',
      schedule: 'Schedule',
      api: 'API',
      agent: 'Agent',
      'agent-run': 'Workflow',
      goal: 'Goal',
      parent: 'Workflow',
      system: 'Internal',
      none: 'Run',
    },
    /** Line two's agent for a run Interborough started for its own bookkeeping. */
    interboroughStarted: 'Interborough started',
    /** The title of one instance of a workflow file, which only its steps are tasks of. */
    workflowRunTitle: 'Workflow run',
    /** How long a run has waited on a person, at the end of line two. */
    waitingFor: (duration: string): string => `waiting ${duration}`,
    /** How long a run has been going, at the end of line two. */
    runningFor: (duration: string): string => `running ${duration}`,
    /** Which attempt of a goal a run is. */
    attempt: (number: number, of: number): string => `attempt ${String(number)} of ${String(of)}`,
    /** When a canceled run stopped, and how long it had run. The event names no one who canceled it. */
    canceledAt: (time: string, duration: string): string => `canceled at ${time} after ${duration}`,
    /** The collapsed row of the runs a schedule missed. */
    missed: {
      /** The title of a schedule with no name of its own. */
      untitled: 'A schedule',
      /** Line two's last part: how many runs were missed, and since when. */
      since: (count: number, day: string): string =>
        `missed ${String(count)} ${count === 1 ? 'time' : 'times'} since ${day}`,
      /** The accessible name of the list of missed occurrences under the expanded row. */
      occurrencesLabel: 'Missed occurrences',
      viewSchedule: 'View schedule',
    },
    /** The status line under the placeholders when the list is slow to load (row 10l). */
    stillLoading: 'Still loading runs. This is taking longer than usual.',
    /** What replaces the rows after Cancel on a slow load; the header and the bar stay (row 14p). */
    loadingCanceled: {
      title: 'Loading canceled',
      description: 'Runs didn’t finish loading. Nothing is missing; it just wasn’t fetched.',
    },
    /** A list none of its reads could deliver: the full error state under the header (rows 12u, 12v and 14s). */
    loadFailed: {
      title: 'Couldn’t load runs',
      /** The server answered with a fault; its status is said when it gave one. */
      description: (status: number | undefined): string =>
        status === undefined
          ? 'The server answered with an error. Nothing you did caused it.'
          : `The server answered with an error (${String(status)}). Nothing you did caused it.`,
      /** The server did not answer at all. */
      unreachable: 'The server did not answer. Check that Interborough is running, then try again.',
      /** Why the header's "+" is drawn muted and does nothing while this state shows (row 53b). */
      startOffReason: 'Start run is off until the runs load.',
      /** The second action: Health says whether the host is up. */
      checkHealth: 'Check Health',
      healthPath: '/health',
    },
    /**
     * The sentence of the filtered empty state (rows 10r, 12t and 52y): which runs there are none of,
     * then which filter to change, in the order the bar draws them (status, agent, origin, search).
     */
    noMatch: {
      /** The adjective a status segment puts before "runs": "No failed runs". */
      statusWords: {
        waiting: 'waiting',
        running: 'running',
        done: 'finished',
        failed: 'failed',
        canceled: 'canceled',
      },
      /** "Model switcher has no runs" when an agent is chosen, "No runs" otherwise. */
      none: (agent: string | undefined, status: string | undefined): string => {
        const runs = status === undefined ? 'runs' : `${status} runs`;
        return agent === undefined ? `No ${runs}` : `${agent} has no ${runs}`;
      },
      /** After "runs": what started them, from the Started by label ("a goal"). */
      startedBy: (origin: string): string => `started by ${origin}`,
      /** After "runs": the words typed in Search runs. */
      matching: (words: string): string => `matching “${words}”`,
      /** The filters a person can change, as they read in "Try another agent or origin." */
      filters: { status: 'status', agent: 'agent', origin: 'origin', search: 'search' },
      /** The last sentence, naming each filter that is on: "Try another status, agent or origin." */
      tryAnother: (filters: readonly string[]): string => {
        const last = filters.at(-1);
        if (last === undefined) return 'Change the filters to see more runs.';
        const rest = filters.slice(0, -1);
        return `Try another ${rest.length === 0 ? last : `${rest.join(', ')} or ${last}`}.`;
      },
    },
  },
  filtersLabel: 'Filter runs',
  agentLabel: 'Agent',
  statusLabel: 'Status',
  startedByLabel: 'Started by',
  loading: 'Loading runs',
  loadFailed: {
    title: 'The runs could not be loaded',
    description: 'The server did not answer. Check that the host is running, then try again.',
  },
  /**
   * Nothing has run yet: the empty state that is the whole page (rows 52v and 52w). Start run is the
   * one primary, and Chat with an agent, a secondary beside it, is the other way to make a run.
   */
  empty: {
    title: 'No runs yet',
    description:
      'A run is one piece of work an agent or workflow does. Chat with an agent, or start a workflow, and it shows up here.',
    chatAction: 'Chat with an agent',
    chatPath: '/chats/new',
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
  filterAction: 'Filter',
  clearAction: 'Clear filters',
  noMatch: {
    title: 'No runs match these filters',
    description: 'Change the filters to see more runs.',
  },
  loadMore: 'Load more',
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
    title: 'This run doesn’t exist',
    description: NOT_FOUND_COPY.description,
  },
  engineOnlyNote:
    'There is no task for this run. The sections below show what the workflow recorded.',
  answerTruncated: 'The answer was cut short.',
  followUnavailable:
    'This server cannot follow a task live, so its answer and live updates are not shown here.',
  followReconnecting: 'The connection dropped. Reconnecting.',
  waitsHeading: 'What you can do',
  /** The heading once everything the run asked has been answered. */
  waitsAnsweredHeading: 'Answered',
  /** The small line over a question: who asked and how long ago. */
  questionFrom: (agent: string, age: string): string => `Question from ${agent}, ${age}`,
  /** Said under a question: what choosing an answer does, with the Undo window in seconds. */
  answerSendsNote: (seconds: number): string =>
    seconds <= 0
      ? 'Choosing an answer sends it at once.'
      : `Choosing an answer sends it at once. The run waits ${String(seconds)} seconds before it continues, so you can undo it.`,
  /** Said under a question, and after an answer, while no model provider is connected. */
  continuesOnProvider: (agent: string): string =>
    `${agent} continues once a provider is connected.`,
  /** The inline line while an answer is held: what was sent and that it can still be undone. */
  answerSentLine: (label: string, seconds: number): string =>
    `Answer sent: ${label}. Undo for ${String(seconds)} s.`,
  /** The Undo action on that line. */
  answerUndo: 'Undo',
  /** Said under the choice that was picked, while its answer is held. */
  answerSelected: 'Selected',
  /** The run's status line while an answer is held. */
  answerSentStatus: (seconds: number): string => `answer sent, undo for ${String(seconds)} s`,
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
  /** The run page's message bar while no model provider is connected, so nothing can be sent. */
  messageBlocked: {
    reason: 'Connect a model provider to send messages',
    connect: 'Connect a provider',
  },
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
  description: 'Approvals, questions and workflow reviews waiting on you.',
  /** The accessible name of the segments that say which reviews are listed; narrow, they read "Status: Waiting 2". */
  tabsLabel: 'Reviews by state',
  /** The segments of the list: the words ahead of their counts. */
  tabs: { waiting: 'Waiting', done: 'Done' },
  /** The accessible name of each list. */
  listLabel: { waiting: 'Waiting on you', done: 'Decided' },
  detailLabel: 'Review',
  /** Said at the head of the list: the keys that move through it. */
  keysHint: 'J and K move between reviews.',
  /** The bands the Done list is grouped under, before the day's date. */
  day: { today: 'Today', yesterday: 'Yesterday' },
  /** The small line over an open question's and an open workflow review's heading (an approval's is `toolApproval`). */
  questionEyebrow: 'Question from an agent',
  workflowEyebrow: 'Review requested by a workflow',
  /** Said under an approval's heading, ahead of the tool it wants to run. */
  wantsToRun: 'It wants to run',
  /** How risky the tool is, by the risk the approval declares; a low risk says nothing. */
  risk: { high: 'Dangerous, Can’t be undone', medium: 'Changes things' },
  /** The placeholder of the note field on an approval. */
  notePlaceholder: 'Add a note',
  /** Said in place of a review that left the queue while it was open: the agent moved on. */
  noLongerWaiting: {
    message: 'No longer waiting. The agent already moved on, so nothing is needed from you.',
    next: 'Next review',
  },
  /** The words a decision is announced with, politely, once it has landed. */
  announced: {
    approved: 'Approved',
    denied: 'Denied',
    answered: 'Answered',
    sentBack: 'Sent back',
    gone: 'No longer waiting',
  },
  /** One announcement: what happened, then the review it happened to ("Approved: Refund order 4471"). */
  announce: (word: string, title: string): string => (title === '' ? word : `${word}: ${title}`),
  /** A decided review's word when the viewer decided it ("Approved by you"). */
  decidedByYou: (word: string): string => `${word} by you`,
  /** What a workflow review's decision bar says. */
  workflow: {
    approve: 'Approve',
    sendBack: 'Send back',
    notePlaceholder: 'Say what to change if you send it back',
    noteDescription:
      'Saved with your decision. If you send it back, the workflow reads it as what to change.',
    footer: 'The workflow continues as soon as you answer.',
    draftLabel: 'Draft',
    copyDraft: 'Copy the draft',
    draftCopied: 'Draft copied',
  },
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
  /** Said once in the footer of an open question: what the agent does with the answer. */
  answerHint: 'The agent continues as soon as you answer.',
  /** The footer button that commits a structured answer (a form), which picking a value does not send. */
  sendAnswer: 'Send answer',
  /** The optional note saved with any decision; on a denial the agent reads it. */
  noteLabel: 'Note (optional)',
  /** Said under the note field: where the note goes. */
  noteDescription: 'Saved with your decision. If you deny, the agent reads it as the reason.',
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
  allCaughtUp: 'Nothing waiting on you',
  nothingWaiting: 'When an agent asks for approval or has a question, it shows up here.',
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
  /** Said in the chat when the approval went through but the grant will not stop the next ask. */
  notLoosened: {
    title: 'Approved, but it will ask again',
    message: (toolName: string): string =>
      `The permission was saved, but this agent will still ask before using ${toolName} again.`,
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
  /** The top bar's search field, which opens the palette: its words are the design's, no hints. */
  trigger: 'Search everything',
  /** The palette's own field says the same; the footer carries the `>` and `@` hints (design row 03c). */
  placeholder: 'Search everything',
  untitledChat: CHAT_COPY.untitled,
  /** What a run no chat began and no agent ran is called. */
  untitledRun: 'Run',
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
    /** One heading for the agents and the tools, in that order (design row 03g). */
    agentsAndTools: 'Agents and tools',
    actions: 'Actions',
  },
  /** What a waiting row says after its sentence: the kind of wait. */
  waitingMeta: {
    approval: 'Approval, waiting',
    question: 'Question',
  },
  /** What a run row says about how it stands, after its agent. */
  runWaiting: {
    approval: 'waiting for approval',
    answer: 'waiting for your answer',
  },
  /** What an agent's row and a tool's row call themselves, after their identifier. */
  agentKind: 'agent',
  toolKind: 'tool',
  /** The action that starts a chat on what was typed ("New chat about refund"). */
  newChatAbout: (topic: string): string => `New chat about ${topic}`,
  /** The key hints under the list: the prefixes that narrow a search, and the key that opens a row. */
  footer: {
    actions: 'actions',
    agents: 'agents',
    open: 'Enter to open',
  },
} as const;

/**
 * The words of the notification bell: what needs the person, and what finished. Each item is a
 * sentence and a second line that says what kind of wait it is and whose it is, or what the
 * sentence is about, never a run.
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
  hooksLink: 'Email or webhooks: set up a hook ›',
  /** What the bell button is called; the count says how many items are unread. */
  bellLabel: (count: number): string =>
    count === 0 ? 'Notifications' : `Notifications, ${String(count)} unread`,
  /** The count after the popover's title, "Notifications, 3 unread"; nothing when none is unread. */
  unreadSummary: (count: number): string => `${String(count)} unread`,
  /** What the dot before an unread row is called, for a screen reader. */
  unreadMark: 'Unread',
  /** The second line of a review: what it waits for, and whose it is. */
  waiting: (kind: 'approval' | 'answer', agent: string): string =>
    `${kind === 'approval' ? 'Waiting for your approval' : 'Waiting for your answer'}, ${agent}`,
  failed: (subject: string): string => `${subject} failed`,
  budgetExceeded: (subject: string): string => `${subject} exceeded its budget`,
  /** A schedule that did not fire: "Daily summary missed its 3:00 AM run". */
  missedRun: (subject: string, time: string): string => `${subject} missed its ${time} run`,
  /** How many fires a schedule missed and since when: "4 missed since Oct 30". */
  missedSince: (count: number, since: string): string => `${String(count)} missed since ${since}`,
  /** The one fire a schedule missed because its time did not exist on the clock. */
  missedClockGap: 'Its time was skipped by a clock change',
  /** The host's storage rule is firing; the second line says how much is used. */
  storageOverWarning: 'Storage passed its warning level',
  storageUsed: (size: string): string => `${size} used`,
  /** What an agent is called when the Bureau names none. */
  unnamedAgent: 'An agent',
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
  /** The product's name, as text at the top of the sidebar and of its drawer. */
  productName: 'Interborough',
  /** The names of the sidebar's sections; Home sits above them with none. */
  groups: { work: 'Work', build: 'Build', system: 'System' },
  /** The accessible name of the phone's bottom tab bar. */
  tabBar: 'Main tabs',
  /** The tab that opens the navigation drawer, which holds every destination the tab bar leaves out. */
  moreTab: 'More',
  /** The top bar's button that opens the navigation drawer. */
  openNavigation: 'Open navigation',
  /** The drawer's own button that closes it again. */
  closeNavigation: 'Close navigation',
  /** What follows "Reviews" in the row's name and tooltip: "Reviews, 2 need you". */
  reviewsCountLabel: 'need you',
  /** What follows "Health" in the row's name and tooltip: "Health, 3 need attention". */
  healthCountLabel: 'need attention',
  /** What follows "Health" in the row's name when nothing needs attention. */
  healthEmptyLabel: 'nothing needs attention',
  /** What the engine status says in the notification bell, by the state of the live feed. */
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
  /** The name of the theme switch's radiogroup (its positions are Light, System and Dark). */
  themeLabel: 'Color theme',
  sidebar: 'Sidebar',
  expanded: 'Expanded',
  collapsed: 'Collapsed',
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
  /**
   * The count at the right of a filter field, drawn only while something is typed ("0 of 9 tools",
   * row 32b): the list itself shows no stray count.
   */
  filteredCount: {
    tools: (shown: number, total: number): string => `${String(shown)} of ${String(total)} tools`,
    skills: (shown: number, total: number): string => `${String(shown)} of ${String(total)} skills`,
  },
  /** What a tab's count reads while its list has not arrived (rows 32f, 32t): a dash, never a zero. */
  tabCountPending: '–',
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
    inputs: 'Inputs',
    inputsLabel: (name: string): string => `Inputs of ${name}`,
    noInputs: 'This tool takes no inputs.',
    noSchema: 'This tool does not describe its inputs.',
    users: 'Used by',
    /** Used by when no agent has the tool: one muted line with a link inline, never a centred empty state (rows 30e, 30h, 32j). */
    noUsers: {
      line: 'No agent has this tool yet.',
      action: { label: 'Add to an agent', href: '/agents' },
    },
    tier: {
      'read-only': 'Reads only',
      mutating: 'Changes things',
      dangerous: 'Dangerous',
      unclassified: 'Not classified',
    },
    /**
     * The muted chip row under the description (rows 30a, 30f): the risk, the default asks level and
     * where the tool comes from. Each chip has a tooltip; none is coloured, because risk is said in
     * words and a glyph, never in red.
     */
    chips: {
      label: 'About this tool',
      risk: {
        'read-only': 'Reads',
        mutating: 'Changes things',
        dangerous: 'Dangerous',
        unclassified: 'Not classified',
      },
      riskTooltip: {
        'read-only': 'Looks at things and changes nothing.',
        mutating: 'Changes things in what it reaches.',
        dangerous: 'Can do damage that is hard to undo.',
        unclassified: 'Does not say what it does, so it is treated as one that changes things.',
      },
      asks: (level: string): string => `Asks: ${level}`,
      /** What each default level does, before the four values that follow it. */
      asksTooltip: {
        never: 'Runs without asking.',
        'on-changes': 'Asks before it changes something, and runs a read without asking.',
        always: 'Asks before every call.',
        blocked: 'Never runs.',
      },
      asksValues:
        'The values are Never, On changes, Always and Blocked. A chat’s permission mode never overrides Always or Blocked.',
      /** The source chip: the MCP server a tool of the host's names, or where else it comes from. */
      source: {
        bureau: 'Built in',
        host: (server: string | undefined): string =>
          server === undefined ? 'From an MCP server' : `From ${server}`,
        plugin: (plugin: string): string => `From the ${plugin} plugin`,
        skill: (skill: string): string => `From the ${skill} skill`,
      },
      sourceTooltip: {
        bureau: 'Ships with Interborough, not from a plugin.',
        host: 'Comes from a tool source connected to this host.',
        plugin: 'Comes from a plugin this host runs.',
        skill: 'Brought by a skill.',
      },
    },
    /** The states of one tool's page that nothing old can fill: loading, failing to load and missing (rows 30k to 30m). */
    page: {
      loading: { label: 'Loading this tool', stillLoading: 'Still loading this tool…' },
      failed: {
        title: 'This tool couldn’t be loaded',
        description: 'Interborough didn’t send it back. Nothing changed.',
      },
      notFound: {
        title: 'This tool doesn’t exist',
        description: 'It may have been removed, or the link is wrong.',
        back: 'Back to capabilities',
      },
    },
    /** Where a tool comes from; the host passes Interborough's MCP servers' tools, so its are an MCP server's. */
    sources: {
      host: 'MCP server',
      bureau: 'Built in',
      plugin: (plugin: string): string => `Plugin ${plugin}`,
      skill: (skill: string): string => `Skill ${skill}`,
    },
    loadFailed: {
      title: 'The tools could not be read',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
  },
  skill: {
    loading: 'Loading skills',
    /** First use (row 31y): no skill source is configured, and a plugin is how a skill arrives. */
    empty: {
      title: 'No skills yet',
      description: 'A skill is instructions an agent loads when they apply. Plugins add them.',
      action: { label: 'Add a plugin', href: '/settings/plugins' },
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
    /** The muted line under a skill's description (rows 31m, 32v): what it holds, where it is from, when it loads. */
    meta: {
      label: 'About this skill',
      instructionsOnly: 'Instructions only',
      instructionsAndTools: (count: number): string =>
        `Instructions and ${String(count)} ${count === 1 ? 'tool' : 'tools'}`,
      loadedWhenRelevant: 'Loaded when relevant',
    },
    /** The table of the tools a skill ships (row 32v). */
    brings: {
      heading: 'Tools it brings',
      caption: (skill: string): string => `Tools the ${skill} skill brings`,
      columns: { tool: 'Tool', risk: 'Risk', asks: 'Asks' },
    },
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
    /** First use (rows 31z, 32a): the one primary button on the page, which opens Connect tools. */
    empty: {
      title: 'No sources connected',
      description:
        'Connect an MCP server or an OpenAPI spec, and its tools join Capabilities straight away.',
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
    kinds: { mcp: 'MCP server', openapi: 'OpenAPI spec' },
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
      savedFirst:
        'It is saved. Sign in to the server, then restart Interborough to list its tools.',
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
      /** The always-editable tool table (rows 32l, 32r): its caption and column heads. */
      caption: (source: string): string => `Tools of ${source}`,
      columns: { on: 'On', tool: 'Tool', risk: 'Risk', asks: 'Default asks' },
      /** The name of a tool's On checkbox, which has no visible label of its own. */
      onLabel: (tool: string): string => `On: ${tool}`,
      /** The name of a tool's Default asks select, which has no visible label of its own. */
      asksLabel: (tool: string): string => `Default asks: ${tool}`,
      /** The line under the table that says a change was kept (row 32r); empty until one is. */
      saved: 'Saved',
      /** The note under the table (row 31r): how many are on, then what a source offers. */
      note: (on: number, total: number): string =>
        `${String(on)} of ${String(total)} ${total === 1 ? 'tool is' : 'tools are'} on. A source offers On or Off and a default Asks level; Blocked is a per-agent override. Agents get tools on each agent’s Access tab.`,
      /** Under the table of a source that needs a sign-in (row 31u): its rows stay, muted. */
      paused: 'Tools are paused until you sign in again.',
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
      exists: 'A source with that name is already saved.',
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
    /** The Connect tools page at `/capabilities/connect` (`connect-tools.svelte`). */
    connect: {
      action: 'Connect tools',
      /** The page's heading and the last crumb of its breadcrumb (rows 33a, 33c). */
      title: 'Connect tools',
      intro:
        'Add an MCP server or an OpenAPI spec. Its tools are available to agents straight away, with no restart.',
      /** The page's sections, in order (row 33d). */
      sections: {
        source: 'Source',
        address: 'Address',
        signIn: 'Sign in',
        /** Sign in for an OpenAPI spec, which also holds the Base URL (row 33u). */
        baseUrlAndSignIn: 'Base URL and sign in',
        test: 'Test connection',
        chooseTools: 'Choose tools',
      },
      kind: { label: 'What kind of source', mcp: 'MCP server', openapi: 'OpenAPI spec' },
      /** What a person calls the source; the identifier it is saved under is made from it (row 33f). */
      name: {
        label: 'Name',
        description:
          'Filled in after the test; change it if you like. Shown in Capabilities and on each tool.',
        /** The help under Name for an OpenAPI spec, whose title fills it in (rows 33t, 34r). */
        fromSpec: 'Prefilled from the spec’s title. Shown in Capabilities and on each tool.',
        placeholder: 'GitHub',
      },
      transport: { label: 'How Interborough reaches it', http: 'URL', stdio: 'Command' },
      url: {
        label: 'Server URL',
        description: 'Streamable HTTP.',
        placeholder: 'https://mcp.example.com/mcp',
      },
      /** The one-line command of a local server, and the warning under it (rows 33o, 33p). */
      command: {
        label: 'Command',
        placeholder: 'npx -y @example/server',
        warningLabel: 'Runs on this machine',
        warningBefore:
          'This runs on this machine as you, with access to your files. Testing the connection runs the command, and ',
        warningCode: 'npx -y',
        warningAfter:
          ' downloads code before it starts. Interborough starts it with the server and stops it when the server stops.',
      },
      specification: { label: 'Where the document is', url: 'A URL', file: 'A file' },
      specificationUrl: {
        label: 'Spec address',
        description: 'The address of the OpenAPI document.',
        placeholder: 'https://example.com/openapi.json',
      },
      file: {
        label: 'Spec',
        description: 'A JSON or YAML file of up to 3 MB.',
        chosen: (name: string): string => `Using ${name}`,
        tooLarge: 'That file is larger than 3 MB.',
        unreadable: 'That file could not be read.',
      },
      /**
       * Reading the spec before it is connected (rows 34s, 34u, 34v): fetching it from its address,
       * and what a spec that reads says about itself. The summary's parts are drawn side by side,
       * each its own element, and never joined by a separator character.
       */
      spec: {
        fetching: 'Fetching the spec…',
        cancel: 'Cancel',
        summaryLabel: 'What the spec holds',
        version: (version: string): string => `OpenAPI ${version}`,
        operations: (count: number): string =>
          count === 1 ? '1 operation' : `${String(count)} operations`,
        failed: 'The spec could not be read',
      },
      baseUrl: {
        label: 'Base URL',
        description: 'Read from the spec. Change it to point at another environment.',
        placeholder: 'https://api.example.com',
      },
      /** Sign in's choices (rows 33g, 34q): OAuth carries the muted note beside its label. */
      authentication: {
        label: 'How it signs in',
        none: 'None',
        bearer: 'Bearer token',
        oauth: 'OAuth',
        oauthNote: 'opens the provider',
        'api-key': 'API key in a header',
        oauthHelp:
          'You sign in to the provider from the source’s page once it is connected. Interborough keeps the tokens it receives.',
      },
      secret: {
        bearer: { label: 'Token' },
        'api-key': { label: 'API key' },
        description: 'Stored on this machine; never shown again.',
      },
      header: {
        label: 'Header name',
        description: 'The header the key is sent in.',
        placeholder: 'x-api-key',
      },
      probe: {
        action: 'Test connection',
        /** The Test button while the test runs (row 34i). */
        testing: 'Testing…',
        /** The note beside it while the test runs: the host it contacts (row 34i). */
        contacting: (where: string): string => `Contacting ${where}…`,
        /** The note while a local command is started for the test. */
        starting: 'Starting the command…',
        /** A test that passed: a green dot and this word, then how many tools it found (row 34w). */
        connected: 'Connected',
        found: (count: number): string =>
          count === 1 ? 'Found 1 tool' : `Found ${String(count)} tools`,
        skipped: (count: number): string =>
          `${String(count)} of its tools cannot be offered under a name an agent can use.`,
        needsAuthorization:
          'The server is there and asks you to sign in. Connect it, then sign in from its page.',
        failedTitle: 'It did not answer',
        failed: 'The source could not be tested',
        /** Under a test that failed (row 34n). */
        kept: 'Nothing is saved until you connect. Your address and name stay filled in.',
        /** Beside an inert Test connection while the server does not answer (row 35f). */
        offline: 'Off while Interborough can’t be reached.',
        /**
         * Beside Test connection for an OpenAPI spec (rows 33v, 34r): the one read the test makes
         * with the key, so a wrong key shows before Connect.
         */
        calls: (operation: string, method: string, path: string): string =>
          `Calls ${operation} (${method} ${path}) with the key above, so a wrong key shows now.`,
        /** For a spec that has no read the test can make without input. */
        callsNothing: 'The spec has no read that needs no input, so the test reads the spec only.',
      },
      /** Choose tools (rows 33i, 33m, 34w, 33w, 33y). */
      chooseTools: {
        /** The line above the list, and above the dashed box before a test passes (row 33m). */
        intro: 'Pick what agents may use, and when each asks.',
        /** Added to the intro once tools are listed (row 33i). */
        hints: 'The server’s own hints set the starting values; a Dangerous tool starts on Always.',
        /** Before a test has listed any (row 33m). */
        locked: 'Test the connection to list its tools.',
        /** A server that answered and lists none (row 34w). */
        none: 'The server answered but offers no tools. Check that it exposes tools, then test again.',
        /**
         * The legend of the four levels (row 33i), each word in bold before what it does. The items
         * are drawn side by side as a list, never joined by a separator character.
         */
        legendLabel: 'What each level means',
        legend: [
          { word: 'Never', means: 'runs without asking' },
          { word: 'On changes', means: 'asks unless a chat allows all' },
          { word: 'Always', means: 'asks every time' },
          { word: 'Blocked', means: 'never runs' },
        ],
        caption: (source: string): string => `Tools ${source} offers`,
        columns: { on: 'On', tool: 'Tool', risk: 'Risk', asks: 'Asks' },
        /** The name of a tool's On checkbox, whose column head is its visible label. */
        onLabel: (tool: string): string => `On: ${tool}`,
        /** The name of a tool's Asks select, whose column head is its visible label. */
        asksLabel: (tool: string): string => `Asks: ${tool}`,
        /** An OpenAPI spec's operations (rows 33w, 33y). */
        operations: {
          found: (count: number): string =>
            `Found ${String(count)} ${count === 1 ? 'operation' : 'operations'}. Reads start on and changes start off. A Dangerous operation starts on Always.`,
          filterLabel: 'Filter operations',
          riskLabel: 'Show operations that',
          all: 'All',
          selected: (on: number, total: number): string =>
            `${String(on)} of ${String(total)} selected`,
          selectAll: (total: number): string => `Select all ${String(total)}`,
          /** Under a list longer than it shows at once. */
          showing: (shown: number, total: number): string =>
            `Showing ${String(shown)} of ${String(total)}. Scroll the list for the rest.`,
          noMatch: 'No operation matches the filter.',
        },
      },
      /**
       * The footer's summary before a test has passed (row 33n), and for a local command, whose
       * Connect runs the test first (row 33r), as it does while a test runs (row 34j).
       */
      chooseFirst: 'Test the connection to choose tools.',
      testsFirst: 'Connect tests the connection first.',
      /** The footer's summary once tools are chosen (rows 33y, 34c), and for a source with none (row 34x). */
      joins: (count: number, name: string): string =>
        count === 0
          ? `${name} will join Capabilities with no tools.`
          : `${String(count)} ${count === 1 ? 'tool' : 'tools'} from ${name} will join Capabilities.`,
      /** The footer while Connect runs (rows 34a, 34z): the line, what it adds after 15 s, and the button. */
      connecting: (name: string): string => `Connecting ${name}…`,
      slow: 'Taking longer than usual',
      /** The footer while the server does not answer (row 35f). */
      offline: 'Connect is off while Interborough can’t be reached.',
      /** What the page says while the host keeps its configuration in its deployment. */
      locked:
        'This host keeps its configuration in its deployment, so a source cannot be connected here.',
      actions: {
        connect: 'Connect',
        /** Connect once tools are chosen (rows 33y, 34c). */
        connectCount: (count: number): string =>
          count === 1 ? 'Connect 1 tool' : `Connect ${String(count)} tools`,
        connecting: 'Connecting…',
        cancel: 'Cancel',
      },
      /** A connect that failed after a passing test (row 34b), with what was kept. */
      connectFailed: {
        lead: 'Couldn’t connect.',
        stopped: 'The server stopped answering after the test passed.',
        kept: 'Nothing was saved; your choices are kept.',
        retry: 'Try again',
      },
      /** A source already saved at the address typed (row 34e). */
      duplicate: (name: string): string =>
        `${name} is already connected at this address. Use another address, or remove that source first.`,
      /** After connecting (rows 34f, 34g, 34h). */
      success: {
        title: (name: string): string => `${name} is connected`,
        /** `on` tools on; `off` the names of the tools left off. */
        line: (on: number, off: readonly string[]): string => {
          const available =
            on === 1 ? '1 tool is available now' : `${String(on)} tools are available now`;
          const left =
            off.length === 0 ? '' : `; ${nameList(off)} ${off.length === 1 ? 'is' : 'are'} off`;
          return `${available}${left}. No restart needed.`;
        },
        /** For a host that loads the source only when it starts again. */
        restart: (on: number): string =>
          `${on === 1 ? '1 tool is' : `${String(on)} tools are`} saved. Restart Interborough to list them.`,
        listLabel: 'What you chose',
        off: 'Off',
        give: 'Give to an agent',
        view: 'View in Capabilities',
      },
      /** The picker "Give to an agent" opens (rows 35c, 35d). */
      give: {
        title: (name: string): string => `Give ${name}’s tools to which agent?`,
        opens: 'Opens its Access tab',
        loading: 'Reading the agents',
        failed: 'The agents could not be read.',
        none: 'No agent can take new tools. An agent defined in code or shipped by a plugin keeps the tools it states.',
        cancel: 'Cancel',
      },
      /** Asked before a filled form is left (rows 35b, 35f). */
      leave: {
        title: 'Leave without connecting?',
        description: 'Nothing you filled in is saved. Leaving discards it.',
        keep: 'Keep editing',
        discard: 'Discard and leave',
      },
      failed: 'The source could not be connected',
      exists: (id: string): string =>
        `A source named ${id} is already saved. Choose another name, or remove it first.`,
      errors: {
        idRequired: 'Give the source a name.',
        /** A name with no letter, which the identifier it is saved under has to start with. */
        nameInvalid: 'Start the name with a letter.',
        idInvalid: 'Use 1 to 20 lowercase letters, digits or hyphens, starting with a letter.',
        urlRequired: 'Enter the server’s URL.',
        commandRequired: 'Enter the command to run.',
        specificationUrlRequired: 'Enter the document’s URL.',
        /** An OpenAPI spec's Base URL, which the spec's first server fills in (row 33u). */
        baseUrlRequired: 'Enter the base URL.',
        documentRequired: 'Choose an OpenAPI file.',
        documentInvalid: 'That file is not a JSON object.',
        secretRequired: {
          bearer: 'Enter the bearer token.',
          'api-key': 'Enter the API key.',
        },
        headerRequired: 'Enter the header the key is sent in.',
      },
    },
    /** The line under the heading that says where the source stands (rows 31o, 32k): a dot and a word, then muted facts. */
    status: {
      label: 'Source status',
      /** How the source signs in, when the host says: an OAuth source, or one that holds a stored credential. */
      auth: { oauth: 'OAuth sign-in', credentials: 'Credential stored' },
      lastTested: (ago: string): string => `last tested ${ago}`,
    },
    /** The ⋯ menu beside Test connection (row 32m): its button's name, and its entries in order. */
    menu: {
      label: 'More about this source',
      edit: 'Edit connection',
      /** Editing a saved connection happens on the Connect tools page, which does not read a saved source yet. */
      editUnavailable: 'Editing a saved connection is not available yet.',
      test: 'Test connection',
      remove: 'Remove source…',
    },
    /** Test connection on a saved source (rows 32i, 32q): in flight, passed, asked to sign in, and failed. */
    test: {
      action: 'Test connection',
      again: 'Test again',
      testing: (name: string): string => `Testing ${name}…`,
      /** Added after 15 seconds, as Connect tools says it. */
      slow: 'Taking longer than usual',
      passed: (name: string, count: number): string =>
        count === 0
          ? `Reached ${name}. It lists no tools.`
          : count === 1
            ? `Reached ${name}. It lists 1 tool.`
            : `Reached ${name}. It lists ${String(count)} tools.`,
      needsAuthorization: 'It answered and asks you to sign in. Sign in, then test again.',
      failedTitle: (name: string): string => `Couldn’t reach ${name}`,
      /** `where` is the source’s address, or its name when it has none. */
      failedBody: (where: string): string => `${where} didn’t answer.`,
      failedSlow: 'The test showed “Taking longer than usual” after 15 s, then stopped.',
      toolsKept: 'Its tools stay as they were.',
      refused: 'The connection could not be tested',
    },
    /** The restart that lists the tools of the sources saved since the host started (`restart-banner.svelte`). */
    restart: {
      title: (count: number): string =>
        count === 1
          ? '1 source is saved and not running yet'
          : `${String(count)} sources are saved and not running yet`,
      description:
        'Their tools join Capabilities when Interborough starts again. Restarting stops anything in progress for a moment.',
      action: 'Restart Interborough',
      progress: {
        requesting: 'Asking Interborough to restart',
        stopping: 'Interborough is stopping',
        starting: 'Interborough is starting again',
      },
      back: 'Interborough is back. The tools of the sources it loaded are in Capabilities.',
      unconfirmed:
        'Interborough did not restart. Nothing supervises it, or the restart failed. Start it again yourself to list the tools.',
      refusal: {
        locked:
          'This host keeps its configuration in its deployment, so it cannot be restarted here.',
        refused: 'Interborough would not restart.',
        unreachable: 'Interborough could not be reached to ask it to restart.',
      },
    },
    remove: {
      action: 'Remove source…',
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
  home: {
    label: 'Home',
    loading: { title: 'Loading Home', description: 'Reading what needs you and what is running.' },
    error: {
      title: 'Home is unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: FORBIDDEN_COPY.title('Home') },
  },
  chat: {
    label: 'Chat',
    loading: {
      title: 'Loading chat',
      description: 'Checking that the server is ready to take messages.',
    },
    error: {
      title: 'Chat is unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: FORBIDDEN_COPY.title('Chat'), requirement: 'bureau.contexts:read' },
    // A chat that is gone has nothing old to show: the page offers a new chat and the way back
    // (board ChatStates frame g).
    notFound: {
      title: 'This chat doesn’t exist',
      description: 'It may have been deleted, or the link is wrong.',
      create: { label: 'New chat', href: '/chats/new' },
      back: { label: 'Back to chats', href: '/chats' },
    },
    // A new chat is for an agent, and it is the agent that is missing.
    notFoundByPattern: {
      '/chats/new': {
        title: 'This agent doesn’t exist',
        description: NOT_FOUND_COPY.description,
      },
    },
    // A new chat with no `?agent=` starts with the first agent that can run; with none, there is
    // nothing to start it with, and the page is the Agents first-use state (board PageNewChat,
    // "Loading, error and no agents"): create one, or browse the agents there are.
    emptyByPattern: {
      '/chats/new': {
        title: 'No agents yet',
        description:
          'An agent is a model with instructions and tools. Create one, or add a plugin that provides some.',
        action: { label: 'New agent', href: '/agents/new' },
      },
    },
    // The agents a new chat starts with could not be read: the error replaces the greeting and the
    // composer, because there is nothing to send to.
    errorByPattern: {
      '/chats/new': {
        title: 'Agents couldn’t be loaded',
        description: 'Check that Interborough is running, then try again.',
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
    forbidden: { title: FORBIDDEN_COPY.title('Agents'), requirement: 'bureau.agents:read' },
    notFound: {
      title: 'This agent doesn’t exist',
      description: NOT_FOUND_COPY.description,
    },
    // Every tab of an agent's page, Memory among them, words its own loading and failure in its
    // body under the agent's header (`AGENT_PAGE_COPY.tabState`), so the view has no words by pattern.
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
    forbidden: { title: FORBIDDEN_COPY.title('the agent editor') },
    notFound: {
      title: 'This agent doesn’t exist',
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
    forbidden: { title: FORBIDDEN_COPY.title('Workflows') },
    // A workflow's page is neutral and has one way back, the list (board PageWorkflow, row 63h).
    notFound: { ...WORKFLOW_COPY.page.notFound, searchHidden: true },
    notFoundByPattern: {
      '/workflows/:workflow/edit': {
        title: 'This workflow doesn’t exist',
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
    forbidden: { title: FORBIDDEN_COPY.title('Runs'), requirement: 'bureau.tasks:read' },
  },
  schedules: {
    label: 'Schedules',
    loading: { title: 'Loading schedules', description: 'Reading the schedules.' },
    // The page draws its own empty and failed states under its own header (`ownsStates` in
    // `views.ts`) in the words `SCHEDULE_COPY` holds, so the frame and the page never say them two
    // ways.
    empty: { ...SCHEDULE_COPY.empty, action: { label: 'New schedule', href: '/schedules/new' } },
    error: SCHEDULE_COPY.loadFailed,
    forbidden: { title: FORBIDDEN_COPY.title('Schedules') },
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
    forbidden: { title: FORBIDDEN_COPY.title('Reviews'), requirement: 'bureau.reviews:read' },
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
    forbidden: { title: FORBIDDEN_COPY.title('Workers') },
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
    forbidden: { title: FORBIDDEN_COPY.title('Storage') },
  },
  audit: {
    label: 'Audit log',
    loading: {
      title: 'Loading the audit trail',
      description: 'Reading the record of what changed.',
    },
    empty: {
      title: 'Nothing recorded yet',
      description:
        'Changes you and your agents make show up here, newest first, with who made them and what changed.',
    },
    error: {
      title: 'The audit trail is unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: FORBIDDEN_COPY.title('the audit log'), requirement: 'bureau.audit:read' },
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
    forbidden: { title: FORBIDDEN_COPY.title('Settings'), requirement: 'bureau.settings:read' },
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
    forbidden: { title: FORBIDDEN_COPY.title('Capabilities') },
  },
  goals: {
    label: 'Goals',
    loading: { title: 'Loading goals', description: 'Reading the running goals.' },
    // The list at `/goals` draws its own empty and failed states under its own header
    // (`ownsStatesOnPatterns` in `views.ts`), and its empty one in the words `GOALS_COPY` holds, so
    // the frame and the page never say them two ways. A goal's page draws its own loading and failed
    // states too (`GOALS_COPY.detail`); the frame keeps only its not-found and forbidden states.
    empty: { ...GOALS_COPY.empty, action: { label: GOALS_COPY.newAction, href: '/goals/new' } },
    error: {
      title: 'Goals are unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: FORBIDDEN_COPY.title('Goals'), requirement: 'bureau.goals:read' },
    notFound: {
      title: 'This goal doesn’t exist',
      description: NOT_FOUND_COPY.description,
    },
  },
  hooks: {
    label: 'Hooks',
    loading: { title: 'Loading hooks', description: 'Reading the hooks you have written.' },
    // The list draws its own empty and failed states under its own header (`ownsStates` in
    // `views.ts`) in the words `HOOKS_COPY.list` holds, so the frame and the page never say them two
    // ways.
    empty: { ...HOOKS_COPY.list.firstUse, action: { label: 'New hook', href: '/hooks/new' } },
    error: {
      title: HOOKS_COPY.list.loadFailed.title,
      description: HOOKS_COPY.list.loadFailed.noAnswer,
    },
    forbidden: { title: FORBIDDEN_COPY.title('Hooks'), requirement: 'bureau.hooks:read' },
    // The editor says the same when the hook is deleted while its page is open.
    notFound: HOOKS_COPY.editor.notFound,
  },
  health: {
    label: 'Health',
    loading: { title: 'Loading health', description: 'Reading the health overview.' },
    error: {
      title: 'The server is unavailable',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: FORBIDDEN_COPY.title('Health') },
  },
};

/** Said where a write is confirmed when the storage cannot check that the value is unchanged. */
const UNCHECKED_WRITE_NOTE =
  ' This storage cannot check that the value is unchanged first, so it overwrites whatever the key holds now.';

/** The words the storage explorer (`/health/storage`) uses outside its view states. */
export const STORAGE_COPY = {
  title: 'Storage',
  description: 'The keys this installation stores, and the value of each.',
  /** The accessible name of the controls that narrow the table. */
  filtersLabel: 'Find a key',
  groupLabel: 'Group',
  allGroups: 'All groups',
  /** The accessible name of the segmented control that picks how keys are narrowed. */
  modeLabel: 'Search mode',
  modeStartsWith: 'Starts with',
  modeRange: 'Range',
  searchLabel: 'Keys starting with',
  searchPlaceholder: 'Keys starting with',
  /** The accessible name of the two fields of a range, and of each. */
  range: {
    label: 'Range',
    startLabel: 'Range start',
    endLabel: 'Range end',
    startPlaceholder: 'First key',
    endPlaceholder: 'Last key',
    /** The word between the two fields. */
    to: 'to',
    /** What a range whose last key sorts before its first says, under the fields. */
    reversed: 'The end comes before the start. Swap them, or pick a later end.',
    /** The note under a reversed range: the table still shows the last range that was a range. */
    lastResult: (count: number, start: string, end: string): string => {
      const keys = `${String(count)} ${count === 1 ? 'key' : 'keys'}`;
      if (start !== '' && end !== '')
        return `Showing the last result: ${keys} from ${start} to ${end}.`;
      if (start !== '') return `Showing the last result: ${keys} from ${start}.`;
      if (end !== '') return `Showing the last result: ${keys} up to ${end}.`;
      return `Showing the last result: ${keys}.`;
    },
  },
  /** The accessible name of the table of keys. */
  tableLabel: 'Keys',
  columns: {
    key: 'Key',
    group: 'Group',
    size: 'Size',
    /** The column of write times, which names the zone they are read in. */
    updated: (zone: string): string => `Updated (${zone})`,
  },
  /** A key that is in no group, because its name has no prefix. */
  noGroup: 'None',
  /** The Updated column of a key whose backend records no write time. */
  noUpdated: '—',
  /**
   * The table's footer: how many keys are loaded, of how many there are when storage can count them
   * (it cannot for a range), and what loads the rest.
   */
  footer: (loaded: number, total: number | undefined, more: boolean): string => {
    const count = (value: number): string => value.toLocaleString('en-US');
    const keys =
      total === undefined
        ? `Showing ${count(loaded)} ${loaded === 1 ? 'key' : 'keys'}.`
        : `Showing ${count(loaded)} of ${count(Math.max(total, loaded))} ${total === 1 ? 'key' : 'keys'}.`;
    return more ? `${keys} Scroll to load more.` : keys;
  },
  loadingLabel: 'Loading keys',
  /** What the table says after "Cancel" in the "Still loading" line: nothing failed, the person stopped it. */
  stopped: {
    title: 'Stopped loading keys',
    description:
      'You stopped the read, so the keys are not shown. Nothing stored was changed by it.',
    tryAgain: 'Try again',
  },
  /**
   * The footer after "Scroll to load more" failed: the keys already loaded stay, and Cinder's load
   * more says what failed and retries.
   */
  loadMore: {
    itemLabel: 'keys',
    retry: 'Load more',
  },
  empty: {
    title: 'No keys stored yet',
    description: 'Keys appear here once the application stores something.',
  },
  noMatches: {
    title: 'No keys match',
    description: 'No key starts with this text. Choose another group or clear the search.',
    clear: 'Clear filters',
  },
  /** A range in which no key falls. */
  noKeysInRange: {
    title: 'No keys in this range',
    description: 'Nothing is stored between these two keys. Change either end.',
  },
  failed: {
    title: 'The keys could not be read',
    description: 'The server did not answer. Check that the host is running, then try again.',
  },
  /** The marker on a key the application manages. */
  managedBadge: 'Managed',
  detail: {
    label: 'Selected key',
    emptyTitle: 'Select a key to see its value',
    emptyDescription:
      'Pick a row to read what is stored. Keys Interborough doesn’t manage can also be edited and deleted.',
    /** The accessible name of the region that holds the pane. */
    paneLabel: 'Key',
    /** The name of the menu at the end of the header row, which holds Delete. */
    moreActions: 'More actions',
    /** The pane's line while the key is being read: only what the row already says. */
    groupOnly: (group: string): string => group,
    /** The line over the key while its value is being edited after a failed save. */
    editingSummary: (group: string, size: string, key: string): string =>
      `${group}, ${size}, ${key}`,
    /** What the pane says while the value is read: nothing for the first 300 ms, then a skeleton. */
    valueLoadingLabel: 'Loading the value',
    /** What the pane says after "Cancel" in the "Still loading" line. */
    valueStopped: 'You stopped loading this value.',
    /** What the pane says when the value could not be read. */
    valueFailed: 'Couldn’t read the value.',
    valueRetry: 'Try again',
    /** What the pane says when the key was removed after the row was listed. */
    valueGone: 'This key is no longer stored. Another writer removed it.',
    /** The line over the key: its group, size and when it was written. */
    summary: (group: string, size: string, updated: string | null): string =>
      updated === null ? `${group}, ${size}` : `${group}, ${size}, updated ${updated}`,
    /** How long a very long key is, said after it. */
    characters: (count: number): string => `(${count.toLocaleString('en-US')} characters)`,
    copyKey: 'Copy key',
    copyValue: 'Copy value',
    edit: 'Edit',
    delete: 'Delete',
    save: 'Save value',
    cancel: 'Cancel',
    jsonSwitch: 'JSON',
    valueLabel: 'Value',
    editLabel: 'Value',
    /** The lock line of a managed key, around its prefix, which the pane sets in monospace. */
    locked: {
      before: 'Locked: Interborough manages keys that start with ',
      after: ' and needs them to recover runs.',
    },
    /** Why a key has no Edit or Delete, in one string: what a refused write says. */
    managedNote: (prefix: string): string =>
      `Locked: Interborough manages keys that start with ${prefix} and needs them to recover runs.`,
    /** Why no key has Edit or Delete while the managed prefixes are not known. */
    unknownManaged:
      'Locked: Interborough could not say which keys it manages, so no key can be edited or deleted here.',
    binaryNote: 'This value is not text, so it cannot be edited here.',
    notJson: 'The value was JSON and this is not, so it cannot be saved.',
    /**
     * The danger alert over the editor after a failed save: a bold lead, the cause, and what became
     * of the edit.
     */
    saveFailed: {
      lead: 'Couldn’t save the value.',
      noAnswer: 'Interborough didn’t answer.',
      kept: 'Your edit is still here.',
    },
    /**
     * The heading over a value shown as text, which says what it is and how big: "Value, text, 2.1 MB".
     */
    textValueLabel: (size: string): string => `Value, text, ${size}`,
    /**
     * The note under a value shown as text. Each part is said only when it is true: that only the
     * start is shown (and Copy value still copies it all), and why there is no Fields or JSON switch.
     */
    textNote: {
      shownStart: (shown: string, size: string): string =>
        `Showing the first ${shown}. Copy value copies all ${size}.`,
      notJson: 'This value isn’t JSON, so there is no Fields or JSON switch.',
      tooLarge: 'This value is too large for the Fields and JSON switch.',
    },
    /**
     * The warning over the editor when the key was written while it was open: a bold lead, then who
     * wrote it and when. The time is left out when the storage records none.
     */
    rewritten: {
      lead: 'This key changed while you were editing.',
      detail: (time: string | null): string =>
        time === null ? 'The app wrote a new value.' : `The app wrote a new value at ${time}.`,
      discard: 'Discard my edit',
      saveOver: 'Save over it…',
      showNew: 'Show new value',
    },
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
  /** The confirmation of Save over it, which replaces the value the application wrote while the editor was open. */
  confirmSaveOver: {
    title: 'Overwrite the app’s newer value?',
    description: (key: string, time: string | null, unchecked = false): string =>
      `${key} was written${time === null ? '' : ` at ${time}`} while you were editing. Saving replaces that value with yours. This can’t be undone.${unchecked ? UNCHECKED_WRITE_NOTE : ''}`,
    confirm: 'Save over it',
  },
  confirmDelete: {
    title: 'Delete this key?',
    /** The sentence after the key, which the dialog sets in monospace: its size and that it cannot be undone. */
    afterKey: (size: string, unchecked = false): string =>
      ` and its ${size} value are removed from storage. This can’t be undone.${unchecked ? UNCHECKED_WRITE_NOTE : ''}`,
    confirm: 'Delete key',
  },
  backend: {
    sqlite: 'SQLite',
    postgres: 'Postgres and S3',
    unknown: 'Storage',
    /** The storage line under the title: the backend, then where it is. */
    line: (backend: string, where: string | undefined): string =>
      where === undefined ? backend : `${backend}, ${where}`,
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
