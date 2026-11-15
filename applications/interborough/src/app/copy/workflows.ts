/** `text` with its first letter capitalized, to open a sentence: "step 3" reads "Step 3". */
function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

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
    /** There is nothing to list because none have been registered: said as the environment, not as a promise. */
    empty: {
      title: 'No internal workflows registered',
      description:
        'Nothing has registered the workflows Interborough runs for chats, goals and schedules on this host yet. They are listed here once they are, which happens when Interborough is started on its own.',
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
    /** The crumb while On a schedule is chosen (board PageRunSetup, "On a schedule"). */
    scheduleCrumb: 'Schedule',
    title: (name: string): string => `Run ${name}`,
    /** The first word of the heading, which the workflow's name and identifier follow. */
    runVerb: 'Run',
    /** The first word of the heading while On a schedule is chosen. */
    scheduleVerb: 'Schedule',
    inputHeading: 'Input',
    inputDescription: 'The form is drawn from the workflow’s input schema.',
    /** Above the Input section while On a schedule is chosen, because the schedule keeps its input. */
    scheduleInputLead: 'These values are used on every run.',
    /** The link at the right of the Input description that swaps the drawn form for a JSON editor. */
    editAsJson: 'Edit as JSON',
    /** The Input description while the JSON editor shows and its text parses. */
    jsonEditing: 'Editing the input as JSON. Back to form returns to the drawn form.',
    /** The Input description while the JSON does not parse: the way back is off. */
    jsonEditingInvalid: 'Editing the input as JSON.',
    backToForm: 'Back to form',
    /** The way back while the JSON does not parse: off, with the reason in its label. */
    backToFormBlocked: (line: number): string => `Back to form (fix line ${String(line)} first)`,
    /** The JSON editor's own label. */
    jsonEditorLabel: 'Input as JSON',
    /** A workflow that declares no schema takes its input as JSON. */
    jsonLabel: 'Input (JSON)',
    jsonDescription: 'JSON. Leave empty to start with no input.',
    invalidJson: 'The input must be valid JSON, or left empty.',
    /** Said under the JSON editor when the text is empty: input that the form draws is never left empty. */
    jsonRequired: 'The input can’t be left empty. Enter it as JSON, or go back to the form.',
    whenHeading: 'When',
    whenLabel: 'When to run',
    now: 'Now',
    /** The line under Now. */
    nowDescription: 'Starts as soon as you press Start run.',
    schedule: 'On a schedule',
    scheduleDescription: 'Starts a run each time the schedule fires, with this input.',
    scheduleLabel: 'Schedule',
    /** The label of the second policy select, which the builder draws beside the first. */
    catchUpLabel: 'If Interborough was off',
    nameLabel: 'Name',
    nameDescription:
      'Starts as the workflow’s name; change it if you like. Shown in Schedules and on every run it starts.',
    nameRequired: 'Give the schedule a name.',
    nameTooLong: (most: number): string =>
      `The name is too long: it can be at most ${String(most)} characters.`,
    /**
     * The line under When that says what else starts the workflow: the schedule is named by a link,
     * then its cadence in parentheses, or that it is paused.
     */
    alsoStartedBy: {
      before: 'Also started by the ',
      after: ' schedule',
      cadence: (words: string): string => ` (${words}).`,
      paused: ' (paused).',
      bare: '.',
    },
    /** What starts a file on its own, by its trigger (sweep S67): a signal names itself, a schedule is changed in the file. */
    triggerSignal: { before: 'Also starts on its own when ', after: ' arrives.' },
    triggerSchedule: (cadence: string): string =>
      `Runs on its own schedule (${cadence}). Change it in the workflow.`,
    /**
     * The line under Now while as many runs are going as the engine runs at once
     * (`engine.maxConcurrentRuns`; board PageRunSetup, "At the concurrency limit").
     */
    nowAtLimit: (most: number): string =>
      `${String(most)} runs are going, the most at once. This one starts when one finishes.`,
    /** Under When, once the schedules are read, when none starts the workflow (board PageRunSetup, "No input"). */
    notScheduled: 'Not used by any schedule.',
    /** The footer's one line when the choice is Now: the input in plain words, when it says anything. */
    summaryNow: (inputWords = ''): string => `Runs once, right away${inputWords}.`,
    /** The same at the concurrency limit: the run waits for one of the runs that are going. */
    summaryQueued: (most: number, inputWords = ''): string =>
      `Runs once, when one of the ${String(most)} finishes${inputWords}.`,
    /** The footer's line while a start is in flight (board PageRunSetup, "Starting"). */
    startingSummary: (name: string): string => `Starting ${name}…`,
    /** The footer's line while the JSON editor holds an input that parses. */
    summaryJson: 'Runs once, right away, with the JSON above.',
    /** The footer's line while the JSON does not parse. */
    summaryJsonInvalid: 'Fix the JSON above to run.',
    /** The footer's line when the choice is On a schedule. */
    summarySchedule: (name: string, inputWords: string, cadence: string): string =>
      `Creates a schedule that runs ${name}${inputWords}, ${cadence}.`,
    /** The same, while the JSON editor holds the input. */
    summaryScheduleJson: (name: string, cadence: string): string =>
      `Creates a schedule that runs ${name} with the JSON above, ${cadence}.`,
    /** What the footer says of the input from the fields it reads: ", on main" then ", since Oct 23" or ", from the last release". */
    inputWords: {
      on: (branch: string): string => `on ${branch}`,
      since: (date: string): string => `since ${date}`,
      sinceLastRelease: 'from the last release',
    },
    startAction: 'Start run',
    scheduleAction: 'Create schedule',
    /** The primary button while a start is in flight; the form is read-only meanwhile. */
    startingAction: 'Starting…',
    /** The primary button while a schedule is being created. */
    creatingAction: 'Creating…',
    cancel: 'Cancel',
    /** The lead of the alert above the footer when the start was refused (board PageRunSetup, "Start failed"). */
    startFailed: 'Couldn’t start the run.',
    scheduleFailed: 'Couldn’t create the schedule.',
    /** Closes that alert: a refused start created nothing, and Start run is the retry. */
    nothingStarted: 'Nothing started, and what you typed is still here.',
    nothingCreated: 'Nothing was created, and what you typed is still here.',
    /** The Bureau no longer finds the workflow it was asked to start: it was paused or removed. */
    notFoundOnStart:
      'The workflow is paused or was removed. Resume it in the workflow, and it can run.',
    /** The alert line above the footer that repeats the first missing field (board PageRunSetup, "Validation"). */
    requiredBeforeRun: (field: string): string => `${field} is required before this can run.`,
    /** The message on a required input field that was left empty, as the form words its own (board PageRunSetup, "Validation"). */
    fieldRequired: (field: string): string => `${field} is required.`,
    /** The Input section of a file that declares no input schema (board PageRunSetup, "No input"). */
    takesNoInput: (name: string): string => `${name} takes no input.`,
    /** The Input section of a file the Bureau cannot read (board PageRunSetup, "Order refund, can’t load"). */
    unreadableInput: 'The input form can’t be drawn from a file that can’t be read.',
    /** The Input section's own error block when the schema could not be read (board PageRunSetup, "Schema failed to load"). */
    inputFailed: {
      title: 'Couldn’t load the input form',
      description:
        'Interborough didn’t answer when it asked for the schema. Nothing you typed is lost.',
    },
    /** The skeleton's status line after ten seconds (board PageRunSetup, "Loading"). */
    loadingInput: 'Loading the input form…',
    /** The neutral alert above Input for a paused file, and its button (board PageRunSetup, "Paused workflow"). */
    paused: (name: string): string => `${name} is paused. Resume it to run it.`,
    resumeAction: 'Resume',
    /** The amber alert above Input when a step's agent needs a model and no provider is connected. */
    noProvider: (agents: string): string =>
      `No model provider is connected, so ${agents} can’t answer. Connect one to run this.`,
    connectProvider: 'Connect a provider',
    /** Closes the red alert of a file that cannot load, after the file and the line it stops on. */
    unreadableStartOff: 'Start run is off until the file is fixed.',
    openCode: 'Open Code',
    /** Why the primary action is off, beside it: the action's own name, then what it waits for. */
    actionOff: {
      paused: (action: string): string => `${action} is off while the workflow is paused.`,
      provider: (action: string): string => `${action} is off until a provider is connected.`,
      unloaded: (action: string): string => `${action} is off until the input form loads.`,
      invalid: (action: string): string => `${action} is off while the file can’t load.`,
    },
    /** The answer was lost, so the Bureau may have acted: say so, and do not suggest trying again blindly. */
    scheduleInvalid: 'A field in the schedule is not valid. Correct it, then create the schedule.',
    startMaybe: 'The run may have started',
    scheduleMaybe: 'The schedule may have been created',
    lostDescription:
      'The server did not answer. Check before trying again, so it is not done twice.',
    checkRuns: 'Check the runs',
    checkSchedules: 'Check the schedules',
    forbidden: 'You may not start runs or create schedules here.',
    /** A type the Bureau starts itself, which is never set up here, and where to go instead. */
    blocked: {
      openWorkflow: 'Open the workflow',
      engineTitle: 'Interborough starts this workflow itself',
      engineDescription: 'There is nothing to set up here.',
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
      'The file the builder writes; while it is valid JSON it is the same as the builder. It uses the extended workflow file format: timezone and catchUp on a schedule trigger, a manual trigger kind, and a title on the workflow and on each step. The titles are removed before the workflow runs. Every field the builder writes is here, including the schedule trigger, each title and the Input and Output schemas. Keys the builder doesn’t show are saved exactly as written.',
    saveAction: 'Create workflow',
    /** The primary button while the file is being written; the whole form is read-only meanwhile. */
    creatingAction: 'Creating…',
    cancelAction: 'Cancel',
    /** The lead of the error above the footer when the file could not be written (board PageWorkflowBuilder, "Create failed"). */
    saveFailed: 'Couldn’t create the workflow.',
    /** Closes that error: a create that failed wrote nothing, and Create workflow is the retry. */
    nothingSaved: 'Nothing was saved.',
    noName: 'Give the workflow a name: a "name" key holding its identifier.',
    invalidName:
      'The name must use lowercase letters, digits, and hyphens, start with a letter, and be at most 64 characters.',
    reservedName:
      'This name is reserved: /workflows/new is the page that creates a workflow, so a workflow called new could never be opened. Choose another.',
    /** Said at the ID when a file already has it; {@link takenLink} is the link inside it. */
    taken: (name: string): string =>
      `A workflow with the ID ${name} already exists. Choose another ID, or open that workflow.`,
    /** The words of {@link taken} that open the workflow that has the ID. */
    takenLink: 'open that workflow',
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
    /**
     * What each card is, at its top beside its number. A card for an activity reads the activity's
     * own title; `activity` is what it reads before the catalog says.
     */
    stepKinds: {
      agent: 'Ask an agent',
      person: 'Wait for a person',
      signal: 'Wait for a signal',
      wait: 'Wait',
      activity: 'Run an activity',
      workflow: 'Run a workflow',
      branch: 'Choose a path by a value',
      parallel: 'Run side by side',
      map: 'Repeat for each item',
      other: 'Another kind of step',
    },
    /**
     * Where a step is, in the words the labels below put in a name: "step 3" for a top-level step,
     * and "step 1 of the approved case of step 3" for one inside it.
     */
    where: {
      step: (position: number): string => `step ${String(position)}`,
      nested: (position: number, list: string): string => `step ${String(position)} of ${list}`,
      caseOf: (value: string, step: string): string => `the ${value} case of ${step}`,
      otherwiseOf: (step: string): string => `the otherwise path of ${step}`,
      branchOf: (name: string, step: string): string => `the ${name} list of ${step}`,
      bodyOf: (step: string): string => `the repeated steps of ${step}`,
    },
    /** A step's optional name, its `title`; empty, its placeholder is the step's kind. */
    stepNameLabel: 'Step name',
    stepName: (where: string): string => `Name of ${where}`,
    agentFieldLabel: 'Agent',
    agentPlaceholder: 'Choose an agent',
    agentLabel: (where: string): string => `Agent for ${where}`,
    /** Under an agent that needs a model while no provider is connected. The workflow still saves. */
    needsProvider: 'Won’t run until a provider is connected.',
    messageFieldLabel: 'Message',
    messagePlaceholder: 'What should the agent do?',
    messageLabel: (where: string): string => `Message for ${where}`,
    /** The one line a "Wait for a person" card shows under its name. */
    personDescription:
      'It shows in Reviews while it waits, titled with the step name, and the run reads Waiting on you.',
    signalFieldLabel: 'Until someone sends',
    signalPlaceholder: 'Signal name',
    signalDescription:
      'The run reads Waiting, with this signal named, until it arrives. It doesn’t show in Reviews.',
    signalLabel: (where: string): string => `Signal ${where} waits for`,
    /** The wait's length is a number and a unit in one Cinder DurationField, which names its select "For unit". */
    amountFieldLabel: 'For',
    units: { seconds: 'seconds', minutes: 'minutes', hours: 'hours', days: 'days' },
    /** A wait whose duration For and its unit cannot say, such as a bare number of milliseconds. */
    durationFieldLabel: 'How long',
    durationDescription: 'A bare number is milliseconds. Or write 30s, 5m, 1h.',
    /** The group of a wait's For field and its unit, or its How long field when they cannot say its duration. */
    durationLabel: (where: string): string => `How long ${where} waits`,
    /**
     * A wait for a person or a signal can give up: after the limit the run goes on without it. The
     * number and unit are the wait's own For and Unit; clearing the number removes the limit.
     */
    timeoutLabel: 'Stop waiting after',
    timeoutDescription: 'If nothing arrives, the run goes on without it.',
    timeoutAmountLabel: (where: string): string => `How long ${where} waits before it stops`,
    timeoutText: (where: string): string => `Limit on the wait in ${where}`,
    timeoutTextDescription:
      'A bare number is milliseconds. Or write 30s, 5m, 1h. Empty, there is no limit.',
    moveEarlier: (where: string): string => `Move ${where} earlier`,
    moveLater: (where: string): string => `Move ${where} later`,
    remove: (where: string): string => `Remove ${where}`,
    /** The one control that adds a step to a list, and its menu. */
    addLabel: 'Add a step',
    addTo: (where: string): string => `Add a step to ${where}`,
    add: {
      agent: 'Ask an agent',
      person: 'Wait for a person',
      signal: 'Wait for a signal',
      wait: 'Wait',
      branch: 'Choose a path by a value',
      parallel: 'Run side by side',
      map: 'Repeat for each item',
    },
    /** The groups of the add menu that the Bureau's catalog fills. */
    addMenu: {
      activitiesHeading: 'Activities',
      workflowsHeading: 'Workflows',
      loadingActivities: 'Loading activities…',
      activitiesFailed: 'Couldn’t load activities. Try again',
      loadingWorkflows: 'Loading workflows…',
      workflowsFailed: 'Couldn’t load workflows. Try again',
    },
    /** An activity or workflow card, whose fields the catalog describes. */
    activity: {
      /** The kind label while the catalog has no title for the activity. */
      untitled: (handler: string): string => `Run ${handler}`,
      checking: (handler: string): string => `Checking the activity ${handler}…`,
      failed: (handler: string): string =>
        `The activity ${handler} is kept as the file has it, but the list of activities did not load, so its input cannot be shown.`,
      unavailable: (handler: string): string =>
        `No running plugin provides the activity ${handler}. Change it in the JSON tab.`,
      noSchema: 'Its input is edited in the JSON tab.',
      noInput: 'It takes no input.',
      inputNotObject: 'Its input is not an object. It is edited in the JSON tab.',
      retry: 'Try again',
    },
    workflowCard: {
      field: 'Workflow',
      placeholder: 'Choose a workflow',
      /** A workflow the file names that no running plugin lists, kept selectable under its own id. */
      missing: (id: string): string => `${id} (no running plugin provides it)`,
      checking: 'Checking the workflows…',
      failed:
        'The list of workflows did not load, so the one this step runs is kept as the file has it.',
      retry: 'Try again',
      label: (where: string): string => `Workflow for ${where}`,
      /** The workflow's registration declares no input schema, or no running plugin lists the workflow. */
      noSchema: 'Its input is edited in the JSON tab.',
      noInput: 'It takes no input.',
      inputNotObject: 'Its input is not an object. It is edited in the JSON tab.',
    },
    /** The control-flow cards, in the person's words. */
    controlFlow: {
      onLabel: 'Look at',
      onDescription: 'A property of the step before, such as status.',
      onLabelFor: (where: string): string => `Property ${where} looks at`,
      caseLabel: 'When it is',
      caseLabelFor: (where: string): string => `Value of ${where}`,
      addCase: 'Add a case',
      removeCase: (value: string): string => `Remove the ${value} case`,
      caseTaken: 'Another case already has this value.',
      caseHeading: (value: string): string => `When it is ${value}`,
      otherwiseHeading: 'Otherwise',
      addOtherwise: 'Add otherwise',
      removeOtherwise: 'Remove otherwise',
      branchLabel: 'List name',
      branchLabelFor: (where: string): string => `Name of ${where}`,
      addBranch: 'Add a list',
      removeBranch: (name: string): string => `Remove the ${name} list`,
      branchTaken: 'Another list already has this name.',
      branchHeading: (name: string): string => `List: ${name}`,
      overLabel: 'Items in',
      overDescription: 'A property of the step before that holds a list, such as files.',
      overLabelFor: (where: string): string => `Property ${where} repeats over`,
      concurrencyLabel: 'At most at once',
      concurrencyDescription: 'Leave it empty to let the run decide.',
      concurrencyLabelFor: (where: string): string => `How many of ${where} run at once`,
      bodyHeading: (over: string): string =>
        over.trim() === '' ? 'For each item' : `For each item in ${over}`,
      emptyList: 'No steps yet.',
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
      personWithin: (limit: string): string => `wait up to ${limit} for a person to review it`,
      waitForSignal: (signal: string): string => `wait for ${signal}`,
      anySignalWait: 'wait for a signal',
      signalWithin: (signal: string, limit: string): string => `wait up to ${limit} for ${signal}`,
      anySignalWithin: (limit: string): string => `wait up to ${limit} for a signal`,
      wait: (duration: string): string => `wait ${duration}`,
      runActivity: (name: string): string => `run ${name}`,
      runWorkflow: (name: string): string => `run the workflow ${name}`,
      anyWorkflow: 'run a workflow',
      /** One clause that never says what the cases hold: "choose a path by status (2 cases)". */
      choosePath: (on: string, count: number): string =>
        `choose a path by ${on.trim() === '' ? 'a value' : on}${
          count === 0 ? ' (no cases yet)' : ` (${String(count)} ${count === 1 ? 'case' : 'cases'})`
        }`,
      sideBySide: (count: number): string =>
        count === 0
          ? 'run lists side by side'
          : `run ${String(count)} ${count === 1 ? 'list' : 'lists'} side by side`,
      repeat: (count: number, over: string): string =>
        `repeat ${count === 0 ? 'the steps' : `${String(count)} ${count === 1 ? 'step' : 'steps'}`} for each item${
          over.trim() === '' ? '' : ` in ${over}`
        }`,
      other: 'run a step the builder can’t describe',
      next: 'then',
    },
    /** Below 640 pixels the builder is read-only (board ResponsiveAndDark, row 05n). */
    phone: {
      message: 'Open on a larger screen',
      backToWorkflow: 'Back to the workflow',
      backToWorkflows: 'Back to Workflows',
    },
    /**
     * What the builder says when the JSON tab holds text it cannot draw: the Builder tab is off, and
     * the footer, in place of the read-back, says where to fix it (board PageWorkflowBuilder, "JSON
     * tab, invalid").
     */
    json: {
      /** The footer's sentence, once. The Builder tab's reason is the same sentence. */
      fixLine: (line: number): string => `Fix line ${String(line)} to return to the builder.`,
      /** The toolbar's status for JSON that parses but is not a JSON object. */
      notWorkflow: 'Valid JSON, not a valid workflow',
      /** Under the line a value that is not an object starts on. */
      notObject: 'A workflow is a JSON object.',
    },
    /** What Create workflow says is wrong, at the field and once above the footer. */
    problems: {
      agent: 'Choose an agent.',
      message: 'Write what to ask the agent.',
      signal: 'Name the signal to wait for.',
      duration: 'Say how long to wait.',
      workflow: 'Choose a workflow.',
      on: 'Say which property to look at.',
      over: 'Say which property holds the items.',
      emptyList: 'Add a step.',
      noCases: 'Add a case.',
      noBranches: 'Add a list.',
      startSignal: 'Name the signal that starts it.',
      schedule: 'Say how often it runs.',
      /** The line above the footer, from two problems: "2 things to fix: Step 2: name the signal. …". */
      summaryLead: (count: number): string => `${String(count)} things to fix:`,
      summary: {
        id: 'ID: use letters, numbers and dashes.',
        idTaken: 'ID: choose another.',
        schedule: 'Starts: say how often it runs.',
        startSignal: 'Starts: name the signal.',
        agent: (where: string): string => `${capitalized(where)}: choose an agent.`,
        message: (where: string): string => `${capitalized(where)}: write what to ask the agent.`,
        signal: (where: string): string => `${capitalized(where)}: name the signal.`,
        duration: (where: string): string => `${capitalized(where)}: say how long to wait.`,
        workflow: (where: string): string => `${capitalized(where)}: choose a workflow.`,
        on: (where: string): string => `${capitalized(where)}: say which property to look at.`,
        over: (where: string): string =>
          `${capitalized(where)}: say which property holds the items.`,
        emptyList: (where: string): string => `${capitalized(where)}: add a step.`,
        noCases: (where: string): string => `${capitalized(where)}: add a case.`,
        noBranches: (where: string): string => `${capitalized(where)}: add a list.`,
        steps: 'Steps: add a step.',
      },
    },
    /** Asked when Cancel, or anything else that leaves the page, would lose what was typed. */
    discard: {
      title: 'Discard your changes?',
      description:
        'You changed this workflow and haven’t saved it. Leaving now discards those changes.',
      keep: 'Keep editing',
      confirm: 'Discard changes',
    },
  },
  revisions: {
    heading: 'Revisions that have run',
    description:
      'The versions of this workflow that have run, most recently run first, each with whether it is compatible with the current one.',
    caption: 'Versions of this workflow that have run',
    /** One row's title: the day the version first ran and its short hash, "Oct 19, 8:00 AM, version 1.3.0, current version". */
    versionTitle: (when: string, shortVersion: string, current: boolean): string =>
      `${when}, version ${shortVersion}, ${current ? 'current version' : 'older version'}`,
    /** The accessible name of the control that copies a version's full hash. */
    copyVersion: (shortVersion: string): string => `Copy version ${shortVersion}`,
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
  /**
   * `/workflows/:workflow/edit` (board PageWorkflowBuilder, "Edit workflow" and its states): the
   * builder over an existing file, the version a save makes, saving and its failure, a file that
   * changed on disk, the offline banner, loading, and a file that cannot load.
   */
  editor: {
    /** The heading: the workflow's title, or its identifier for a file with none. */
    heading: (name: string): string => `Edit ${name}`,
    textLabel: 'Workflow file',
    textDescription:
      'The file’s JSON. Its name is the file’s identifier, so it is not sent when you save.',
    saveAction: 'Save',
    /** The primary button while the file is written; the whole form is read-only meanwhile. */
    savingAction: 'Saving…',
    cancelAction: 'Cancel',
    /** The footer, in place of the read-back, while the draft makes a new version. */
    saveAs: (version: string): string => `Save as version ${version}.`,
    /** The footer while the file is written: the version it makes, when the Bureau said. */
    savingVersion: (version: string | null): string =>
      version === null ? 'Saving…' : `Saving version ${version}…`,
    /** The lead of the error above the footer when the file could not be written. */
    saveFailed: (name: string): string => `Couldn’t save ${name}.`,
    /** The status line Cinder's skeleton shows after ten seconds of loading. */
    stillLoading: (name: string): string => `Still loading ${name}…`,
    /**
     * The compatibility notice above the footer (board PageWorkflowBuilder, "Edit workflow"): the
     * version saving makes, and whether a run in flight can carry on under it. A compatible edit
     * says so in one line; a breaking one says what changed and what happens to running work.
     */
    impact: {
      compatible: (version: string): string =>
        `Saving makes version ${version}. This is a compatible change, so runs in flight keep going.`,
      /** The first version a workflow gets, with nothing before it to be compatible with. */
      first: (version: string): string => `Saving makes version ${version}.`,
      breaking: (version: string): string =>
        `Saving makes version ${version}. This is a breaking change.`,
      /** One breaking change, by its kind. */
      changes: {
        stepSignal: (step: number, from: string, to: string): string =>
          `Step ${String(step)} now waits for ${to} instead of ${from}.`,
        stepRemoved: (step: number): string => `Step ${String(step)} is removed.`,
        stepReplaced: (step: number): string =>
          `Step ${String(step)} is now a different kind of step.`,
        stepInput: (step: number): string => `Step ${String(step)} is given different settings.`,
        inputSchema: 'The Input fields change.',
        outputSchema: 'The Output fields change.',
        other: 'A step changes in a way a run in flight can’t follow.',
      },
      /** What happens to running work, by how many runs are in flight. */
      noneInFlight: 'No runs are in flight, so nothing running is affected.',
      inFlight: (count: number, previous: string | null): string =>
        `${String(count)} ${count === 1 ? 'run is' : 'runs are'} in flight${previous === null ? '' : ` on version ${previous}`}, and this change can stop ${count === 1 ? 'it' : 'them'} from finishing.`,
      /** The caller may not count the runs in flight. */
      unknownInFlight: 'A run in flight may not be able to finish after this change.',
      laterRuns: (version: string): string => `Later runs use ${version}.`,
      renameNote: 'Renaming a step (its Step name) is never breaking.',
    },
    /**
     * The warning under the tabs when the file changed on disk while the form was open (board
     * PageWorkflowBuilder, "Edit, file changed on disk"). Nothing happens until the person chooses.
     */
    changedOnDisk: {
      title: 'This file changed on disk.',
      reload: 'Reload',
      keepMine: 'Keep mine',
    },
    /** The offline banner's sentence for an edit form, in place of the preset's own. */
    offlineConsequence: 'Your edits are kept in the form. Save is off until you’re back.',
    /** The same sentence while the server, not the browser, does not answer. */
    unreachableConsequence: 'Your edits are kept in the form. Save is off until it’s back.',
    /**
     * A file the Bureau cannot load, which opens on the JSON tab (board PageWorkflowBuilder, "Edit a
     * file that can't load"): the file's name, where it stops being a workflow, and what to do.
     */
    invalid: {
      sentence: (file: string, reason: string): string =>
        `${file} can’t be read as a workflow: ${reason}.`,
      /** The reason for JSON that stops at a line: "line 12 expected a comma". */
      atLine: (line: number, reason: string): string => `line ${String(line)} ${reason}`,
      expectedComma: 'expected a comma',
      fix: 'Fix it here, or Cancel and open the file in your editor.',
    },
    unreadable: {
      title: 'This workflow’s file cannot be read',
      description: 'It has no content this page can edit. Fix the file on disk, then reload.',
    },
  },
} as const;
