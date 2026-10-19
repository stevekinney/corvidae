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
} as const;

/** The deletion states `bureau.memory.forget` answers with, in the receipt's own vocabulary. */
export type MemoryDeletionState = 'completed' | 'pending' | 'exempt' | 'failed' | 'unknown';

/**
 * The words the Memory page uses outside its view states (`/agents/:id/memory`): the list, the
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
  listFailed: 'The memories could not be loaded.',
  /** The label on a row's action that opens one memory's details. */
  openDetails: 'Details',
  noContent: 'This memory has no text.',
  relevance: 'Relevance',
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
    openChat: 'Open the chat',
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
  } as Readonly<Record<string, string>>,
  trust: {
    untrusted: 'Untrusted',
    verified: 'Verified',
    system: 'System',
  } as Readonly<Record<string, string>>,
  memoryClass: {
    working: 'Working',
    episodic: 'Episodic',
    semantic: 'Semantic',
    procedural: 'Procedural',
    identity: 'Identity',
    resource: 'Resource',
  } as Readonly<Record<string, string>>,
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
          'It no longer appears in this list, in search, or in what the agent recalls. Other copies are removed in the background.',
      },
      exempt: {
        title: 'This memory is under a legal hold',
        description: 'It stays stored and listed. Forgetting it resumes when the hold is released.',
      },
      pending: {
        title: 'Forgetting has not finished',
        description:
          'The Bureau started removing this memory and has not confirmed it. Check again shortly.',
      },
      failed: {
        title: 'The memory was not removed',
        description:
          'The step that removes it failed, so it is still stored. Forget it again to retry.',
      },
      unknown: {
        title: 'The result could not be confirmed',
        description:
          'The Bureau could not say whether this memory was removed. Check the list, and forget it again if it is still there.',
      },
    } as Readonly<Record<MemoryDeletionState, { title: string; description: string }>>,
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
    } as Readonly<Record<string, string>>,
    targetStatus: {
      completed: 'Done',
      pending: 'Waiting',
      exempt: 'Held',
      failed: 'Failed',
      unknown: 'Unknown',
    } as Readonly<Record<MemoryDeletionState, string>>,
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
          'The Bureau’s content rules or this agent’s memory limit refused it, so nothing changed. Reword it and try again.',
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
    // An agent's memory page (`/agents/:id/memory`) asks the Bureau for what the agent remembers.
    loadingByPattern: {
      '/agents/:id/memory': {
        title: 'Loading memory',
        description: 'Asking the Bureau what this agent remembers of your chats.',
      },
    },
    emptyByPattern: {
      '/agents/:id/memory': {
        title: 'This agent remembers nothing yet',
        description:
          'A memory is saved when the agent answers in a chat. Start a chat with it, then come back.',
      },
    },
    errorByPattern: {
      '/agents/:id/memory': {
        title: 'Memory is unavailable',
        description:
          'The Bureau did not answer, or it keeps no memory. Check that the host is running, then try again.',
      },
    },
    forbiddenByPattern: {
      '/agents/:id/memory': {
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
      description: 'The record of who changed what will appear here once this view is built.',
    },
    error: {
      title: 'The audit trail is unavailable',
      description: 'The service did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'The audit trail is locked' },
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
