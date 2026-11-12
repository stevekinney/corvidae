import { NOT_FOUND_COPY, STALE_COPY } from './views.ts';

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
