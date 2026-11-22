import type { StatusDotWordLabel } from '@lostgradient/cinder';

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

/**
 * The words for the longer explanation of a failed agent run that a model writes when asked
 * (COR-2534), under the explanation Bureau stored.
 */
export const RUN_EXPLAIN_FURTHER_COPY = {
  /** The action on a failed agent run that asks a model to read the run and explain it at more length. */
  action: 'Explain further',
  /** The action once a model has written one: asking again replaces the text. */
  again: 'Explain again',
  /** The action's help, shown before the first explanation: what the model reads, in one sentence. */
  note: 'A model reads the explanation above and each step’s name, status and error message, never what a tool took in or gave back.',
  /** The heading over what the model wrote. */
  heading: 'Longer explanation',
  /** Which model wrote it, and when: `when` is a phrase such as "today at 4:00 AM". */
  writtenBy: (model: string, when: string): string => `Written by ${model} ${when}`,
  /** What writing it cost, kept apart from the run’s own cost. */
  cost: (cost: string): string => `Cost of this explanation: ${cost}`,
  /** The cost when the model has no price. */
  costUnknown: 'The cost of this explanation is not known.',
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
  /** The same, for a run that is over: nothing came from it (row 55d). */
  noneOver: 'No other runs came from this one.',
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

/**
 * The words for a fork compared with the run it came from: the action that opens the comparison,
 * the steps the two runs share, and what differs in a step the fork ran again.
 */
export const RUN_COMPARISON_COPY = {
  /** How a run is named beside its workflow: when it started, not its id. `ago` is `formatRelativeTime`'s. */
  startedAgo: (ago: string): string => `started ${ago}`,
  /** A source's revision as the Lineage row says it: the revision itself is in the tooltip, in full. */
  pinnedRevision: 'Pinned revision',
  action: 'Compare with source',
  actionHide: 'Hide comparison',
  heading: 'Compared with the source run',
  /** What the comparison's error state says failed to load, in the one "Couldn’t load …" pattern every screen uses. */
  loadFailedSubject: 'the comparison',
  intro: (forkPoint: number): string =>
    `Forked from checkpoint step ${String(forkPoint)}. The steps before it keep the source’s results; the rest ran again.`,
  sharedSummary: (count: number): string =>
    count === 1 ? '1 step the same as the source' : `${String(count)} steps the same as the source`,
  sharedNote: 'The fork kept the source’s result for these steps and did not run them again.',
  stepsLabel: 'Steps the fork ran again',
  detailRegionLabel: 'Step differences',
  stepsHeading: 'Steps after the fork point',
  noStepsTitle: 'Nothing to compare',
  noStepsDescription: 'Neither run has any steps after the fork point yet.',
  stepTitle: (index: number, label: string): string => `Step ${String(index + 1)}, ${label}`,
  /**
   * One word, `Same`, for a step the fork kept from the source and for one it ran again with the
   * same result: nothing differs in either. The run comparison panel uses the same words.
   */
  kinds: {
    shared: 'Same',
    changed: 'Changed',
    unchanged: 'Same',
    'source-only': 'Only in the source',
    'fork-only': 'Only in the fork',
  },
  fields: {
    operation: 'operation',
    label: 'name',
    status: 'status',
    input: 'input',
    output: 'output',
  },
  changedFields: (fields: readonly string[]): string => `Differs in ${fields.join(', ')}`,
  chooseTitle: 'Select a step',
  chooseDescription: 'Choose a step to read what differs between the source and the fork.',
  detailLabel: (index: number): string => `Step ${String(index + 1)} differences`,
  statusChange: (source: string, fork: string): string =>
    `${source} in the source, ${fork} in the fork`,
  operationChange: (source: string, fork: string): string =>
    `${source} in the source, ${fork} in the fork`,
  inputHeading: 'Input',
  outputHeading: 'Output',
  diffLabel: (heading: string, index: number): string =>
    `${heading} differences, step ${String(index + 1)}`,
  sameBothSides: (heading: string): string =>
    `The ${heading.toLowerCase()} is the same in both runs.`,
  missingSource: (heading: string): string =>
    `The source has not recorded an ${heading.toLowerCase()} for this step.`,
  missingFork: (heading: string): string =>
    `The fork has not recorded an ${heading.toLowerCase()} for this step.`,
  onlyInSource: 'The fork has not reached this step.',
  onlyInFork: 'The source never reached this step.',
} as const;

/** The words in the fork dialog for what a fork will do, read from the server's dry run before it is confirmed. */
export const RUN_FORK_PREVIEW_COPY = {
  heading: 'What this fork will do',
  loading: 'Reading what the fork would do',
  failedTitle: 'The fork could not be previewed',
  keptHeading: (count: number): string => `Kept, not run again (${String(count)})`,
  rerunHeading: (count: number): string => `Run again (${String(count)})`,
  keptNote: 'These steps keep their results.',
  rerunNote: 'These steps run again from the fork point.',
  noSteps: 'No steps',
  step: (index: number, label: string): string => `Step ${String(index + 1)}, ${label}`,
  /**
   * The warning when the dry run says the fork would run on another revision. It names no revision:
   * the run's own page holds it, and a hash in a sentence is not something a person reads. It is the
   * dialog's one statement of the revision, so the "Retains…" line is not shown beside it.
   */
  revisionWouldChangeTitle: 'Runs on a different revision',
  revisionWouldChange: (chosen: boolean): string =>
    chosen
      ? 'The fork would run on the revision you chose, not the source run’s own.'
      : 'The fork would run on a different revision than the source run.',
  refusedTitle: 'Revision unavailable',
  /** The dialog's note under the choices: what making a fork does. */
  linked: 'A new run is created and linked to this one.',
  /** The start of the line after a fork is made: followed by its workflow's name, a link to the run. */
  forkedAs: 'Forked as',
  /** The end of that line: a run made a moment ago, so its start time is now. */
  startedJustNow: 'started just now',
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
  eventsHeading: 'Events',
  eventsLockedTitle: 'Events are locked',
  checkpointsHeading: 'Checkpoints',
  lineageHeading: 'Lineage',
  detailsHeading: 'Run details',
  /** Under Tags when the run has none, and the field's placeholder (rows 54j, 54p, 55d, 55h). */
  noTags: 'None',
  addTag: 'Add a tag',
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
    /** The tokens the run used, from the Bureau's own count of the run (COR-2525); its cost is `COST_COPY.label`. */
    tokens: 'Tokens',
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
    /** The schedule tick, the run that records what the scheduler did (COR-2009). */
    scheduleTick: 'Schedule tick',
  },
  /** Said after the identifier of a workflow Interborough runs itself. */
  builtIn: '(built in)',
  /** The disclosure under what happened, for what only an operator reads. */
  /**
   * The hooks of a run (COR-2115, the agreed design): the section after What happened that lists a
   * live run's hook plan with the hooks that threw first, and a settled run's failed hooks alone. It
   * says "Run hooks", never "Hooks", which is the page of webhooks. No row has a retry or a reason:
   * the record names the registration, the hook point and who registered it, and nothing of the error.
   */
  hooks: {
    heading: 'Run hooks',
    /** The accessible name of the list of hooks. */
    listLabel: 'Run hooks',
    descriptionLive: 'In the order they run, failed hooks first.',
    /** For a settled run, verbatim from the brief. */
    descriptionSettled: 'The full hook plan is shown while a run is live.',
    descriptionUnreadable: 'This run’s hook plan can’t be read.',
    /** The accessible name of the placeholders while a live run’s hooks load. */
    loading: 'Loading this run’s hooks',
    loadFailed: {
      title: 'Couldn’t load this run’s hooks.',
      description: 'The rest of the run is shown.',
    },
    forbidden: {
      title: 'Your sign-in can’t see this run’s hooks',
      reason: 'The rest of the run is still available.',
      /** The scope Interborough’s API checks before it lets the inspection through (`host/scope-gate.ts`). */
      requirement: 'runs:read',
    },
    /** A hook that threw: its one status word, with how many times when it was more than once. */
    failed: (count: number): StatusDotWordLabel =>
      count > 1 ? `Failed, ${String(count)} times` : 'Failed',
    priority: (priority: number): string => `priority ${String(priority)}`,
    replay: { safe: 'no side effects', effectful: 'has side effects' },
    /** Who registered a hook, for the sources that are not a plugin or the run’s agent. */
    sources: { bureau: 'Interborough', direct: 'This run' },
    /** The hook points, in the person’s words. A point this table does not know is shown as its name, in code. */
    points: {
      prepareStep: 'Before each step',
      onStep: 'After each step',
      beforeToolExecution: 'Before a tool runs',
      afterToolExecution: 'After a tool runs',
      selectTools: 'When tools are chosen',
      selectToolChoice: 'When the tool choice is made',
      validateResponse: 'When a reply is checked',
      validateToolResult: 'When a tool’s result is checked',
      beforeGenerate: 'Before the model is asked',
      afterGenerate: 'After the model answers',
      onLLMInput: 'Watching what the model is sent',
      onLLMOutput: 'Watching what the model sends back',
      beforeCompaction: 'Before the conversation is shortened',
      beforeBackgroundCompaction: 'Before a background shortening',
      afterCompaction: 'After the conversation is shortened',
      onRunStart: 'When the run starts',
      onRunComplete: 'When the run finishes',
      onRunError: 'When the run fails',
      onRunAbort: 'When the run is stopped',
      onError: 'When a step fails',
    } as Readonly<Record<string, string>>,
  },
  howItRan: {
    heading: 'How it ran',
    caption: 'For operators',
    rawPayloads: 'Raw payloads',
    /** The tabs inside How it ran (row 54i); Versioning and Search attributes only when filled. */
    tabs: {
      label: 'How it ran',
      steps: 'Steps',
      inspector: 'Inspector',
      raw: 'Raw payloads',
      events: 'Events and logs',
      versioning: 'Versioning',
      attributes: 'Search attributes',
    },
  },
  /** Related runs in the rail of a run that is only the Bureau's: the other runs of its chat. */
  related: {
    heading: 'Related runs',
    noneInChat: 'No other runs came from this chat.',
    /** The other attempts of the goal a run is an attempt of: "Attempt 1 of 5 (Check not met)". */
    attempt: (number: number, of: number, outcome: string): string =>
      `Attempt ${String(number)} of ${String(of)} (${outcome})`,
    attemptOutcome: {
      running: 'Running',
      evaluating: 'Checking',
      passed: 'Check met',
      failed: 'Check not met',
      aborted: 'Canceled',
    },
    /** No other attempt of the goal. */
    noOtherAttempts: 'No other attempts of this goal.',
    /** Said of the run that was the schedule's last, and how many occurrences it has missed since. */
    scheduleLastRun: 'This was the schedule’s last run.',
    scheduleMissedSince: (count: number): string =>
      `It has missed ${String(count)} ${count === 1 ? 'occurrence' : 'occurrences'} since.`,
    /** Said of a run a schedule started that is not its last. */
    scheduleNotLast: 'The schedule has run since.',
  },
  /** The Schedule row of the Details rail of a run a schedule started. */
  schedule: 'Schedule',
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
  /**
   * What the page says of an instance of a workflow file, from the history the Bureau keeps of it
   * and the steps of the version it ran: how far it got, the step that failed, and which version.
   */
  instance: {
    /**
     * The status line of an instance of a workflow file that is still going (row 54l): how long ago
     * it started, in place of the day, the time and "so far", then the step.
     */
    startedAgo: (duration: string): string => `Started ${duration} ago`,
    /** After the time of a run still going: "step 2 of 4". */
    stepOf: (at: number, total: number): string => `step ${String(at)} of ${String(total)}`,
    /** After the word Failed: "at step 2 of 4". */
    failedAt: (at: number, total: number): string => `at step ${String(at)} of ${String(total)}`,
    /** The block on the step that failed: "Step 2, Collect merged changes, failed after 2 tries". */
    failureHeading: (at: number, name: string | undefined, tries: number): string =>
      `Step ${String(at)}${name === undefined ? '' : `, ${name}`}, failed${
        tries > 1 ? ` after ${String(tries)} tries` : ''
      }`,
    /** One step the run began, in what happened: "Step 2, Collect merged changes". */
    stepEntry: (at: number, name: string | undefined): string =>
      `Step ${String(at)}${name === undefined ? '' : `, ${name}`}`,
    /** The block's heading for the reason, and the sentence that follows the reason. */
    whyItFailed: 'Why it failed',
    /**
     * Said after the reason when the failure was not the person's (row 14t): every failure of a
     * step except a cancellation, which a person asked for.
     */
    notYourFault: 'It wasn’t anything you did.',
    /** The actions inside the failure block (row 14t), beside the header's own. */
    inBlock: {
      retry: (at: number): string => `Retry from step ${String(at)}`,
      runsOn: (version: string): string => `runs on ${version}`,
      runAgain: 'Run again',
      openStep: (at: number): string => `Open step ${String(at)}`,
      errorDetails: 'Show the error details',
      /** The Tries row of the explanation when the history says how long the tries took (row 55b). */
      triesIn: (tries: string, took: string): string => `${tries}, ${took} in all`,
    },
    /** The Version row: which version the run ran, and where it stands against the current one. */
    versionCurrent: (version: string): string => `${version}, current version`,
    versionOlder: (version: string): string => `${version}, older version`,
    versionOlderNote: (current: string): string =>
      `Ran on an older version of this workflow. The current one is ${current}.`,
    /** The header's primary action on a failed run of a workflow file (row 54z). */
    retryFromStep: 'Retry from this step',
    /**
     * The text beside the header's buttons on a failed run (row 54z): which version each runs on.
     * `current` is `null` when the run ran on the current version.
     */
    besideButtons: (ran: string, current: string | null): string =>
      current === null
        ? `Retry from this step and Run again both run on ${ran}, the current version.`
        : `Retry from this step runs on ${ran}, like this run. Run again runs on ${current}, the current version.`,
    /** After why it failed: how often the step was tried, and how long that took (row 55b). */
    triedIn: (tries: number, took: string | undefined): string =>
      took === undefined
        ? `Interborough tried ${String(tries)} times.`
        : `Interborough tried ${String(tries)} times in ${took}.`,
    /**
     * What Retry from this step does (row 55b): the steps it keeps. The version it runs on is said
     * once in the block, beside its button (row 14t), and once in the header's caption (row 54z), so
     * the sentence does not say it a third time in the first screen (COR-2489 design round).
     */
    retryKeeps: (at: number): string =>
      at <= 1
        ? 'Retry from this step runs step 1 again.'
        : `Retry from this step keeps ${
            at === 2 ? 'step 1’s result' : `the results of steps 1 to ${String(at - 1)}`
          } and runs step ${String(at)} again.`,
    /** Said in the status line once the retry is under way, and when it was refused. */
    retrying: 'running again from the failed step',
    retryRefused: {
      'run-not-failed': 'This run is no longer failed, so there is nothing to retry.',
      'step-not-found': 'This step is not part of the version this run used.',
      'earlier-steps-incomplete': 'A step before this one did not finish, so it cannot run again.',
      'step-completed': 'This step finished, so it does not need to run again.',
      'step-not-retryable':
        'This step would fail the same way again. Run the workflow again instead.',
      'no-checkpoint': 'Nothing was kept to retry from. Run the workflow again instead.',
      'version-unavailable':
        'The version this run used is no longer available. Run the workflow again instead.',
    } as Readonly<Record<string, string>>,
    retryFailed: 'The step was not retried',
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
  /** The Run inspector card under How it ran: five rows about where the run stands for an operator. */
  inspector: {
    heading: 'Run inspector',
    /** The badge beside the heading: the run is one of Interborough's own workflows. */
    builtIn: 'Built in',
    rows: {
      progress: 'Progress',
      waiting: 'Waiting on',
      liveness: 'Liveness',
      stream: 'Event stream',
      cleanup: 'Cleanup',
    },
    nothing: 'Nothing',
    progressOver: {
      completed: 'Finished; nothing left to do',
      failed: 'Stopped; it failed',
      canceled: 'Stopped; it was canceled',
    },
    progressWaiting: 'Paused; it needs a person',
    progressSubmitted: 'Queued; it has not started',
    progressWorking: 'Working',
    waitAnswer: 'Your answer',
    waitApproval: 'Your approval',
    waitSignal: (signals: readonly string[]): string => `The signal ${signals.join(', ')}`,
    livenessOver: (ended: string | undefined): string =>
      ended === undefined ? 'No signals; the run ended' : `No signals; the run ended ${ended}`,
    livenessWaiting: 'Idle; it is waiting',
    livenessWorking: 'Working; it is reporting progress',
    stream: {
      connecting: 'Connecting',
      live: 'Live',
      reconnecting: 'Reconnecting',
      upToDate: 'Up to date',
      unavailable: 'Not available',
      'not-found': 'Not available',
    },
    cleanupNone: 'None needed',
    cleanup: {
      'cancel-requested': 'Cancel requested; the run has not stopped yet',
      canceled: 'Canceled; nothing to clean up',
      'cleanup-pending': 'Cleaning up after the cancel',
      'cleaned-up': 'Cleaned up',
      'cleanup-failed': 'Cleanup failed',
      'cleanup-unresolved': 'Cleanup could not be confirmed',
      'unknown-outcome': 'Not known whether the cancel finished everything',
    },
  },
  /** The bar docked at the bottom of a chat's run that is going, to add something the agent reads next. */
  sendMessage: {
    label: 'Message the run',
    field: 'Send a message',
    send: 'Send',
    sent: 'Message sent. The agent reads it at its next step.',
    failed: 'The message was not sent',
  },
  /** Beneath Run again while no model provider is connected and the run needs one. */
  connectProvider: 'Connect a provider',
  providersPath: '/settings/models',
  /** The Input and output section: what each card is called, and the sentence under the heading. */
  io: {
    /** Under the heading of a run that answered a chat message. */
    chatDescription:
      'The message that started the run, what it answered, and the steps in between.',
    /** Under the heading of a run of a workflow: its input and what it produced. */
    workflowDescription: 'What this run was started with, and what it produced.',
    /** The same while the run is still going (row 54p). */
    workflowDescriptionLive: 'What this run was started with, and what it will produce.',
    /** Under the heading of a run a schedule started, which has no chat. */
    scheduleDescription:
      'A schedule run has no chat, so the schedule’s prompt is the input and the result is the output.',
    /**
     * Under the heading of a goal's attempt, which no person sent in a chat: the goal's prompt went
     * in, and what the agent answered is what the goal's check reads.
     */
    goalDescription:
      'An attempt of a goal has no chat, so the goal’s prompt is the input and the reply is what its check reads.',
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
    /** Who a goal's attempt's prompt is from: the goal, never "you" or a chat. */
    fromGoal: 'From the goal',
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
    /** The output of a run that failed at a step, named by the workflow's `outputName` (row 55c). */
    noOutputFailedAt: (at: number, name: string): string =>
      `No output. The run failed at step ${String(at)}, so ${name} was never produced.`,
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
