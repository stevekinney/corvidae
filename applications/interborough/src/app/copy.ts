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
};

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

/** The words the agent editor uses outside its view states (`/agents/new`, `/agents/:id/edit`). */
export const AGENT_EDITOR_COPY = {
  createHeading: 'New agent',
  editHeading: (name: string): string => `Edit ${name}`,
  /** The accessible name of the form. */
  formLabel: 'Agent definition',
  /** The label before the agent's file path. */
  fileLabel: 'File',
  /** The directory under the state directory that holds agent files, when the host does not say where. */
  fallbackDirectory: 'agents',
  nameLabel: 'Name',
  nameDescription: 'A label for people. It need not be unique.',
  identifierLabel: 'Identifier',
  identifierCreateDescription:
    'The agent’s file name without .md. It follows the name until you change it, and it cannot be changed after the first save.',
  identifierEditDescription: 'The agent’s file name without .md. It cannot be changed.',
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
  modelDescription: 'Only the models this installation offers are listed.',
  modelPlaceholder: 'Choose a model',
  noModels: {
    /** The only option the model field shows when there is no model to choose. */
    option: 'No models available',
    title: 'No models are available',
    description:
      'An agent cannot be saved without a model. Add a model provider to configuration.json in the state directory, then restart the host.',
  },
  toolsLabel: 'Tools',
  toolsDescription: 'The tools this agent may call.',
  noTools: 'This installation offers no tools.',
  instructionsLabel: 'Instructions',
  instructionsDescription: 'What the agent should do. This is the body of its file.',
  publishedLabel: 'Published',
  publishedDescription:
    'A published agent can be started in a new chat. A withdrawn agent cannot, and keeps its history.',
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
  publishFailed: 'The agent’s publication was not changed',
  deleteFailed: 'The agent was not deleted',
  stale: {
    title: 'This agent changed outside Interborough',
    description:
      'Its file was edited or replaced after this page loaded, so nothing was saved or deleted. Reloading shows what is on disk and discards your unsaved edits.',
    action: 'Reload from disk',
  },
  invalid: {
    title: 'This agent’s file is invalid',
    description: 'The Bureau cannot run it until the file is fixed. Edit the file, then reload.',
    action: 'Reload from disk',
    fileLabel: 'File',
  },
  loadFailed: {
    title: 'The agent could not be loaded',
    description: 'The Bureau did not answer. Check that the host is running, then try again.',
  },
  revisions: {
    heading: 'Revision history',
    description: 'The versions of this agent that have run, most recently run first.',
    caption: 'Versions of this agent that have run',
    versionColumn: 'Version',
    lastRunColumn: 'Last run',
    empty: 'No version of this agent has run yet.',
    failed: 'The revision history could not be loaded.',
  },
} as const;

/** The words the Workflows area uses outside its view states (`/workflows` and under it). */
export const WORKFLOW_COPY = {
  /** The badge on every workflow the Bureau holds a file for. A code-defined type has none. */
  agentAuthoredBadge: 'Agent-authored',
  /** The label for the agent that owns a file, shown only when the file names one. */
  owner: (agent: string): string => `Agent: ${agent}`,
  /** The badge on a file the Bureau cannot use. */
  invalidBadge: 'Invalid file',
  pausedBadge: 'Paused',
  /** The label on a workflow whose source failed to load, with the category of the failure. */
  sourceFailed: (category: string): string => `Failed to load: ${category}`,
  /** The directory under the state directory that holds workflow files, when the host does not say where. */
  fallbackDirectory: 'workflows',
  fileLabel: 'File',
  problemLabel: 'Problem',
  issuesLabel: 'Issues',
  agentLabel: 'Agent',
  triggerLabel: 'Trigger',
  stepsLabel: 'Steps',
  noSteps: 'This workflow has no steps.',
  runsAction: 'Runs',
  editAction: 'Edit',
  pauseAction: 'Pause',
  resumeAction: 'Resume',
  deleteAction: 'Delete',
  /** The accessible name of a link to a workflow's page. */
  listLabel: 'Workflows',
  definition: {
    heading: 'Definition',
    descriptionLabel: 'Description',
    noDescription: 'No description.',
    inputSchema: 'Input schema',
    outputSchema: 'Output schema',
    noSchema: 'None declared.',
    signals: 'Accepted signals',
    updates: 'Updates',
    queries: 'Queries',
    none: 'None',
    revision: 'Active revision',
    noRevision: 'None active',
    /** An agent-authored workflow the engine has not registered yet, so it has no definition to show. */
    notRegistered: 'The engine has no definition for this workflow yet.',
  },
  schedules: {
    heading: 'Schedules',
    none: 'No schedule starts this workflow.',
    failed: 'The schedules could not be loaded.',
    active: 'Active',
    paused: 'Paused',
  },
  revisions: {
    heading: 'Revisions that have run',
    description: 'The versions of this workflow that have run, most recently run first.',
    caption: 'Versions of this workflow that have run',
    versionColumn: 'Version',
    firstRunColumn: 'First run',
    lastRunColumn: 'Last run',
    empty: 'No version of this workflow has run yet.',
    failed: 'The revision history could not be loaded.',
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
    title: 'Saved, but the engine could not apply it yet',
    description:
      'The file on disk has the change. The engine did not follow it, and applies the file again by itself. This page shows what is on disk.',
  },
  pauseFailed: 'The workflow was not paused',
  resumeFailed: 'The workflow was not resumed',
  deleteFailed: 'The workflow was not deleted',
  forbidden: 'This installation does not let you change workflows.',
  loadFailed: {
    title: 'The workflow could not be loaded',
    description:
      'The Bureau or the engine did not answer. Check that the host is running, then try again.',
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
        'The Bureau cannot run it until the file is fixed. Edit it below, or fix the file and reload.',
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
  /** What a schedule starts, by the service that owns it. */
  kind: {
    'agent-run': 'Agent run',
    'workflow-file': 'Agent-authored workflow',
    code: 'Code-defined workflow',
  },
  /** A Bureau schedule the caller may not read the agent of. */
  unnamedAgent: 'An agent',
  startsLabel: 'Starts',
  /** The action that opens the editor of the workflow whose file holds a schedule's trigger. */
  editWorkflowAction: 'Edit workflow',
  editWorkflowNote:
    'This schedule is the trigger in a workflow’s file, so its cadence, overlap, and the rest are edited in the workflow, and it ends when the workflow is deleted.',
  /** A write that named the revision of the schedule, or the hash of the file, that the caller read. */
  stale: STALE_COPY,
  /** The Bureau changed the workflow’s file, and the engine could not follow yet. */
  unapplied: {
    title: 'Saved, but the engine could not apply it yet',
    description:
      'The workflow’s file has the change. The engine did not follow it, and applies the file again by itself. This page shows what is on disk.',
  },
  overlayFailed: {
    title: 'The Bureau did not say what these schedules start',
    description:
      'Until it answers, schedules are listed without their agents and cannot be changed. Check that the host is running, then try again.',
  },
  pauseFailed: 'The schedule was not paused',
  resumeFailed: 'The schedule was not resumed',
  cancelFailed: 'The schedule was not cancelled',
  form: {
    startsLabel: 'Start',
    startsAgent: 'An agent run',
    startsWorkflow: 'A workflow type',
    agentLabel: 'Agent',
    agentPlaceholder: 'Choose an agent',
    agentDescription: 'The agent each fire runs. It must be in this installation’s catalog.',
    agentFreeTextDescription: 'The list of agents is unavailable. Enter the agent’s name.',
    noAgents: 'This installation lists no agents.',
    inputLabel: 'Input',
    inputDescription: 'The text each fire sends to the agent.',
    sessionLabel: 'Session',
    sessionDescription:
      'Optional. Each fire continues this session. Without one, every fire is a new session.',
    sessionWithAllow: 'A schedule that continues a session cannot allow its fires to overlap.',
    overlapLabel: 'If a run is still going when the next fire is due',
    descriptionLabel: 'Description',
    descriptionDescription: 'Optional. Shown to operators alongside the schedule.',
    cadenceLabel: 'Cadence',
    agentRequired: 'Choose an agent.',
    descriptionTooLong: (most: number): string =>
      `The description is too long: it can be at most ${String(most)} characters.`,
    inputRequired: 'Enter the text to send.',
    inputTooLong: 'The input is too long.',
    reservedAgentRun:
      'Agent runs are scheduled with “An agent run”, which checks the agent and its owner.',
    reservedBureauWorkflow:
      'The Bureau starts this workflow itself, with checks a schedule made here would skip.',
    reservedAgentAuthored:
      'This workflow is agent-authored. Its schedule is the trigger in its file, so change it in the workflow.',
    registryNote:
      'Only workflows defined in code are listed. An agent-authored workflow is scheduled by the trigger in its file.',
    overlayLoading: 'Checking which workflows are agent-authored.',
    notEditable: 'This schedule cannot be edited here',
  },
} as const;

/** The words the goals (`/goals`) use outside its view states. */
export const GOALS_COPY = {
  newAction: 'New goal',
  loadMore: 'Load more',
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
    agentLabel: 'Agent',
    agentPlaceholder: 'Choose an agent',
    agentDescription: 'The agent that runs each attempt.',
    agentFreeTextDescription: 'The list of agents is unavailable. Enter the agent’s name.',
    promptLabel: 'Prompt',
    promptDescription:
      'What the agent is asked to do. The goal runs it until the validator passes.',
    identityNameLabel: 'Identity name',
    identityVersionLabel: 'Identity version',
    identityDescription: 'Names this goal, with a version, for the people who read about it.',
    validatorNameLabel: 'Validator name',
    validatorVersionLabel: 'Validator version',
    validatorDescription:
      'The exact name and version of a validator this Bureau was configured with. One it lacks is refused.',
    maximumAttemptsLabel: 'Maximum attempts',
    maximumAttemptsDescription: 'The most attempts the goal makes before it ends as exhausted.',
    maximumAttemptsInvalid: 'Enter a whole number of attempts, one or more.',
    maximumTotalStepsLabel: 'Maximum total steps',
    maximumTotalStepsDescription:
      'The most steps the goal takes across all its attempts. The Bureau needs a bound on the attempts together, and this is it.',
    maximumTotalStepsInvalid: 'Enter a whole number of steps, one or more.',
    createAction: 'Create goal',
    cancelAction: 'Cancel',
    failed: 'The goal was not created',
  },
} as const;

/** The words the audit trail (`/audit`) uses outside its view states. */
export const AUDIT_COPY = {
  /** The accessible name of the search form. */
  searchLabel: 'Search the audit trail',
  sinceLabel: 'Since',
  sinceDescription: 'Only records at or after this time, as YYYY-MM-DDTHH:mm in your time zone.',
  typeLabel: 'Type',
  typeDescription: 'The kind of record, such as run.completed or schedule.created.',
  resourceLabel: 'Run or resource',
  resourceDescription:
    'A run id, or schedule:<id>, session:<id>, agent:<id>, or workflow:<id>, to see what happened to one thing.',
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
  noMatches: {
    title: 'No records match',
    description: 'Nothing in the trail matches this search. Change or clear a filter to see more.',
  },
  failed: {
    title: 'The search failed',
    description:
      'The Bureau did not answer this search. Check that the host is running, then try again.',
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
  loadMore: 'Load more',
  noSessions: 'No chats yet',
  loadingSessions: 'Loading chats',
  agentKind: { code: 'Defined in code', file: 'Defined in a file' },
  agentNotPublished: 'Not published',
  agentPublished: 'Published',
  agentModel: 'Model',
  agentTools: 'Tools',
  agentSkills: 'Skills',
  agentRevision: 'Revision',
  noneListed: 'None',
  agentsTitle: 'Agents',
  agentSessions: 'Chats with this agent',
  approvalTitle: 'Needs your approval',
  humanRequestTitle: 'The agent is asking',
  humanRequestFallback: 'The agent is waiting for your answer.',
  humanRequestHint: 'Your next message answers it.',
  approve: 'Approve',
  deny: 'Deny',
  failureTitle: 'The agent did not answer',
  dismiss: 'Dismiss',
  /** The accessible name of the transcript and composer region. */
  regionLabel: 'Conversation',
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
    rejected: 'The Bureau would not accept this file. Its content was refused.',
    /** The upload session was gone before the file finished arriving. */
    expired: 'The upload expired before it finished. Remove the file and attach it again.',
    /** The run was refused because the model could not take an attachment. */
    modelRefusedMedia:
      'The agent’s model could not take an attached file. Send again without the file.',
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
      description: 'Checking that the Bureau is ready to take messages.',
    },
    empty: {
      title: 'No conversations yet',
      description: 'Start one with an agent, and it will be listed here.',
      action: { label: 'New chat', href: '/chat/new' },
    },
    error: {
      title: 'Chat is unavailable',
      description: 'The Bureau did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Chat is locked' },
    notFound: {
      title: 'This conversation was not found',
      description:
        'It may have been deleted, or it may belong to someone else. Open a conversation from the list.',
    },
    // A new chat is for an agent, and it is the agent that is missing.
    notFoundByPattern: {
      '/chat/new': {
        title: 'This agent was not found',
        description:
          'It may have been deleted, or it may not be published. Choose an agent from the list to start a chat.',
      },
    },
  },
  agents: {
    label: 'Agents',
    loading: {
      title: 'Loading agents',
      description: 'Asking the Bureau which agents it publishes.',
    },
    empty: {
      title: 'No agents to show',
      description:
        'The Bureau lists no agents. Add one as a Markdown file in the agents directory.',
    },
    error: {
      title: 'Agents are unavailable',
      description: 'The Bureau did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Agents are locked' },
    notFound: {
      title: 'This agent was not found',
      description: 'It may have been deleted, or it may not be published. Open one from the list.',
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
      description: 'The Bureau did not answer. Check that the host is running, then try again.',
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
      description: 'Reading the workflow definitions the engine knows and the Bureau’s files.',
    },
    empty: {
      title: 'No workflows yet',
      description:
        'Neither the engine nor the Bureau has a workflow. Ask an agent to write one, or add a JSON file to the workflows directory.',
      action: { label: 'See the runs', href: '/runs' },
    },
    error: {
      title: 'Workflows are unavailable',
      description:
        'The engine or the Bureau did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Workflows are locked' },
    notFound: {
      title: 'This workflow was not found',
      description:
        'It may have been deleted, or its file may be gone. Open a workflow from the list.',
    },
    notFoundByPattern: {
      '/workflows/:type/edit': {
        title: 'This workflow was not found',
        description:
          'There is no workflow file with this name that you can edit. It may have been deleted, or it may be defined in code, which cannot be edited here.',
      },
    },
    emptyByPattern: {
      '/workflows/:type/runs': {
        title: 'This workflow has no runs yet',
        description: 'Nothing has run it. Its runs are listed here once it starts.',
      },
    },
  },
  runs: {
    label: 'Runs',
    loading: { title: 'Loading runs', description: 'Reading the engine’s workflow runs.' },
    empty: {
      title: 'No runs yet',
      description: 'Nothing has run on this engine. Start a workflow to see it here.',
      action: { label: 'Start a run', href: '/runs?view=start' },
    },
    error: {
      title: 'Runs are unavailable',
      description: 'The engine did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Runs are locked' },
  },
  schedules: {
    label: 'Schedules',
    loading: { title: 'Loading schedules', description: 'Reading the engine’s schedules.' },
    empty: {
      title: 'No schedules yet',
      description: 'Create a schedule to start a workflow on a timetable.',
      action: { label: 'Create a schedule', href: '/schedules?create=1' },
    },
    error: {
      title: 'Schedules are unavailable',
      description: 'The engine did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Schedules are locked' },
  },
  inbox: {
    label: 'Inbox',
    loading: { title: 'Loading the inbox', description: 'Reading the reviews waiting for you.' },
    empty: {
      title: 'The inbox is empty',
      description:
        'Nothing is waiting for a decision. Reviews appear here when a run asks for one.',
    },
    error: {
      title: 'The inbox is unavailable',
      description: 'The engine did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'The inbox is locked' },
  },
  workers: {
    label: 'Workers',
    loading: {
      title: 'Loading workers',
      description: 'Reading the workers connected to the engine.',
    },
    error: {
      title: 'Workers are unavailable',
      description: 'The engine did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Workers are locked' },
  },
  storage: {
    label: 'Storage',
    loading: {
      title: 'Loading storage',
      description: 'Checking what the engine’s storage can do.',
    },
    error: {
      title: 'Storage is unavailable',
      description: 'The engine did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Storage is locked' },
  },
  system: {
    label: 'System',
    loading: {
      title: 'Loading the system',
      description: 'Reading the engine’s health and registry.',
    },
    error: {
      title: 'The system is unavailable',
      description: 'The engine did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'The system is locked' },
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
      description: 'The Bureau did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'The audit trail is locked' },
  },
  goals: {
    label: 'Goals',
    loading: { title: 'Loading goals', description: 'Reading the goals the Bureau is running.' },
    empty: {
      title: 'No goals yet',
      description:
        'A goal runs an agent on a prompt until a validator passes. Create one to see it here.',
      action: { label: 'Create a goal', href: '/goals?create=1' },
    },
    error: {
      title: 'Goals are unavailable',
      description: 'The Bureau did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Goals are locked' },
  },
  engine: {
    label: 'Engine',
    loading: { title: 'Loading the engine', description: 'Reading the engine’s overview.' },
    error: {
      title: 'The engine is unavailable',
      description: 'The engine did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'The engine overview is locked' },
  },
};
