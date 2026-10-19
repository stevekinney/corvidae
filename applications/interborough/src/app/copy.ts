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
      description: 'Reading the workflow definitions the engine knows.',
    },
    empty: {
      title: 'No workflow definitions yet',
      description:
        'The catalog of workflow definitions will be listed here once this view is built.',
      action: { label: 'See the runs', href: '/runs' },
    },
    error: {
      title: 'Workflows are unavailable',
      description: 'The engine did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Workflows are locked' },
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
