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
    /** The last entry of a run that is over: how it ended, with the clock time. */
    ended: {
      done: (clock: string): string => `Done ${clock}`,
      failed: (clock: string): string => `Failed ${clock}`,
      canceled: (clock: string): string => `Canceled ${clock}`,
    },
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
