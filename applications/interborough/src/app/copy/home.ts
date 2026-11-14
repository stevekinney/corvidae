import { nameList } from './shared.ts';

/**
 * The words of Home (`/`): the date line, the Spotlight that says how many reviews wait on you and
 * the one count under it, what needs you, what needs attention, the box that starts a chat, and
 * the chats you were last in. The count uses the label and window Health uses for it.
 */
export const HOME_COPY = {
  /** The screen-reader heading; the breadcrumb already says Home, so none is drawn. */
  heading: 'Home',
  /** The accessible name of the count under the Spotlight. */
  countsLabel: 'Home counts',
  counts: {
    /** The one count: the runs that failed in the last day, the one Home lists nowhere else. */
    failed: 'Failed in 24 hours',
  },
  /** The value of a count that could not be read. */
  unavailable: '—',
  /** The words of a row's link to where the rest lives, such as "Open Reviews". */
  needsYou: {
    /** The Spotlight that leads Home: how many reviews wait on you, from the list under it. */
    spotlight: (count: number): string =>
      count === 0 ? 'Nothing needs you' : `${String(count)} ${count === 1 ? 'needs' : 'need'} you`,
    title: 'Needs you',
    link: 'Open Reviews',
    /** The accessible name of the list of reviews waiting on the person. */
    listLabel: 'Reviews waiting on you',
    empty: {
      title: 'Nothing is waiting on you',
      description: 'Approvals and questions from your agents show up here.',
    },
    answer: 'Answer',
    review: 'Review',
    kind: { approval: 'Approval', question: 'Question', workflow: 'Workflow review' },
    cantBeUndone: 'Can’t be undone',
    /** The line under the rows when more wait than Home lists. */
    more: (count: number): string => `${String(count)} more in Reviews`,
  },
  attention: {
    title: 'Needs attention',
    link: 'Open Health',
    listLabel: 'System problems',
    /** The one line that stands for the card when nothing needs attention. */
    clear: {
      title: 'Nothing needs attention',
      description: 'Storage, schedules, providers and hooks are fine.',
    },
    storage: {
      title: 'Storage is over its warning level',
      detail: (size: string): string => `${size} used`,
      action: 'Review storage',
    },
    failureRate: {
      title: 'Workflow failure rate is over its warning level',
      detail: (rate: string): string => `${rate} of recent runs failed`,
      action: 'Review health',
    },
    slowSteps: {
      title: 'Slowest steps are over their warning level',
      detail: (duration: string): string => `Slowest steps take ${duration}`,
      action: 'Review health',
    },
    otherAlert: {
      title: (metric: string): string => `${metric} is over its warning level`,
      action: 'Review health',
    },
    missedRuns: {
      title: (name: string, count: number, since: string): string =>
        `${name} missed ${String(count)} ${count === 1 ? 'run' : 'runs'} since ${since}`,
      /** What a schedule with no description of its own is called. */
      unnamed: 'A schedule',
      kind: 'Schedule',
      action: 'View schedule',
    },
    hookFailed: {
      title: (name: string, gaveUp: boolean): string =>
        `${name}’s ${gaveUp ? 'delivery gave up' : 'last delivery failed'}`,
      /** What a hook with no name of its own is called. */
      unnamed: 'A hook',
      action: 'View hook',
    },
    pluginNotLoaded: {
      title: (plugin: string): string => `${plugin} did not load`,
      action: 'View plugins',
    },
    noProvider: {
      title: 'No model provider connected',
      detail: 'Model agents can’t answer until one is connected. Assistant works now.',
      action: 'Connect a provider',
    },
  },
  startChat: {
    title: 'Start a chat',
    messageLabel: 'Message',
    placeholder: 'Ask an agent to do something',
    agentLabel: 'Agent',
    send: 'Send',
    /** The note beside the agent while the server is off, and Send is disabled with it. */
    offNote: 'Off until it’s back',
    /** What the card says when the agents it offers could not be read. */
    failed: 'Couldn’t load agents.',
  },
  recent: {
    title: 'Recent chats',
    link: 'All chats',
    listLabel: 'Recent chats',
    /** What the card says before the person has sent a first message. */
    empty: {
      title: 'No chats yet',
      description: 'Your chats appear here once you send a first message.',
    },
  },
  /**
   * What Home says while it loads and when a read fails: one card that cannot be read says so in
   * its own place and the rest stay live, a load that takes long can be canceled, and a server
   * that does not answer with nothing loaded yet is the full error state.
   */
  states: {
    /** The words of the status line under the loading placeholders, and its button. */
    stillLoading: 'Still loading Home. This is taking longer than usual.',
    /** The line that names the loading region for assistive technology. */
    loadingLabel: 'Loading Home',
    /** What the page says after the person canceled a slow load, with Try again beside it. */
    canceled: {
      title: 'Loading canceled',
      description: 'Home stopped loading. Try again when you’re ready.',
    },
    /** The sentence that ends every card's own failure: the other cards are fine. */
    restIsLive: 'The rest of Home is live.',
    /** What each card says it could not load; the card's title is already above it. */
    cardFailed: {
      needsYou: 'Couldn’t load what needs you.',
      attention: 'Couldn’t load system problems.',
      recent: 'Couldn’t load recent chats.',
    },
  },
  /** The Running now card, which sits under Needs you while any run is going. */
  running: {
    title: 'Running now',
    link: 'Open Runs',
    listLabel: 'Runs running now',
    /** The button at the end of a row, which opens the run. */
    viewRun: 'View run',
    /** The word that leads line two, in Cinder's status table. */
    status: 'Running',
    /** What a run reads when no title can be found for it: its agent, else this. */
    untitled: 'A run',
    startedAt: (time: string): string => `started ${time}`,
    /** What started the run, as line two says it: one word, kind first. */
    startedBy: {
      chat: 'Chat',
      person: 'Person',
      schedule: 'Schedule',
      api: 'API',
      agent: 'Agent',
      'agent-run': 'Agent',
      goal: 'Goal',
      parent: 'Workflow',
      system: 'Interborough',
    },
    /** The line under the rows when more run than Home lists. */
    more: (count: number): string => `${String(count)} more in Runs`,
  },
  /**
   * The checklist a new installation shows in place of the overview (rows 01y to 02b), until the
   * person has had a chat. The words lead the page in place of the date line.
   */
  firstRun: {
    /** The accessible name of the checklist, and its title. */
    title: 'Get started',
    /** The line that leads the page, from how many of the three steps are still open. */
    lead: (stepsLeft: number): string =>
      stepsLeft >= 3
        ? 'Welcome. Three steps to your first chat.'
        : stepsLeft === 2
          ? 'Welcome. Two steps left.'
          : 'Welcome. One step left.',
    provider: {
      title: 'Connect a provider',
      description: 'Agents need a model provider before they can answer.',
      /** What a connected step says: the providers that hold a key, by name. */
      done: (providers: readonly string[]): string =>
        `${nameList(providers)} ${providers.length === 1 ? 'is' : 'are'} connected.`,
      action: 'Connect a provider',
      href: '/settings/models',
    },
    agent: {
      title: 'Create an agent, or start from Assistant',
      description: 'Assistant works now; other agents need a provider.',
      /** The title and the sentence of a host that lists no Assistant, where Assistant is not offered or named. */
      titleWithoutAssistant: 'Create an agent',
      descriptionWithoutAssistant: 'An agent is a model with instructions and tools.',
      /** What a done step says: the agent that is ready, such as "Assistant", or "An agent" when none is named. */
      done: (agent: string): string => `${agent} is ready to use.`,
      /** Who is ready when the host lists no agent to name. */
      anAgent: 'An agent',
      /** The quiet link that takes Assistant as the agent to start from. */
      useAssistant: 'Use Assistant',
      action: 'Create an agent',
      href: '/agents/new',
    },
    chat: {
      title: 'Say hello',
      description: 'Send a first message to see a chat run end to end.',
      action: 'Start a chat',
    },
  },
} as const;
