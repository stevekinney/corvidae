import { NOT_FOUND_COPY } from './views.ts';

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
