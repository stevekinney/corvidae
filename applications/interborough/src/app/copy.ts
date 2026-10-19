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

/** The words the chat view uses outside its states. */
export const CHAT_COPY = {
  /** What a session with no title is called, in the header and in lists. */
  untitled: 'New chat',
  approvalTitle: 'Needs your approval',
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
      description: 'Conversations with your agents will appear here once chat is available.',
      action: { label: 'See the agents', href: '/agents' },
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
  },
  agents: {
    label: 'Agents',
    loading: {
      title: 'Loading agents',
      description: 'Asking the Bureau which agents it publishes.',
    },
    empty: {
      title: 'No agents to show yet',
      description: 'The agents the Bureau publishes will be listed here once this view is built.',
    },
    error: {
      title: 'Agents are unavailable',
      description: 'The Bureau did not answer. Check that the host is running, then try again.',
    },
    forbidden: { title: 'Agents are locked' },
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
