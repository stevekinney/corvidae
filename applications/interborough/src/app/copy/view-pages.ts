import { HOOKS_COPY } from '../../routes/hooks/hook-copy.ts';
import type { ViewName } from '../views.ts';
import { GOALS_COPY } from './goals.ts';
import { SCHEDULE_COPY } from './schedules.ts';
import { FORBIDDEN_COPY, NOT_FOUND_COPY, type ViewCopy } from './views.ts';
import { WORKFLOW_COPY } from './workflows.ts';

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
    headerByPattern: { '/agents/new': 'New agent' },
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
    header: 'Capabilities',
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
