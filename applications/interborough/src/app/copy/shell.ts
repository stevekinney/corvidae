import { CHAT_COPY } from './chat.ts';

/** The words of the ⌘K palette. */
export const PALETTE_COPY = {
  label: 'Command palette',
  /** The top bar's search field, which opens the palette: its words are the design's, no hints. */
  trigger: 'Search everything',
  /** The palette's own field says the same; the footer carries the `>` and `@` hints (design row 03c). */
  placeholder: 'Search everything',
  untitledChat: CHAT_COPY.untitled,
  /** What a run no chat began and no agent ran is called. */
  untitledRun: 'Run',
  emptyTitle: 'Search the console',
  emptyDescription: 'Type the name of a chat or an agent, or an ID, to jump to it.',
  noMatchesTitle: 'No matches',
  noMatchesDescription: (query: string): string => `Nothing matched "${query}".`,
  /** Said when a search could not read some of what it searches, so what is missing is not taken for "no matches". */
  searchFailedTitle: 'The search did not finish',
  searchFailedDescription: (domains: readonly string[]): string =>
    `Could not read ${domains.join(', ').toLowerCase()}. Matches there may be missing; try the search again.`,
  /** The heading of each kind of result, in the order the palette lists them. */
  groups: {
    waiting: 'Waiting on you',
    chats: 'Chats',
    workflows: 'Workflows',
    runs: 'Runs',
    schedules: 'Schedules',
    workers: 'Workers',
    reviews: 'Reviews',
    agents: 'Agents',
    tools: 'Tools',
    /** One heading for the agents and the tools, in that order (design row 03g). */
    agentsAndTools: 'Agents and tools',
    actions: 'Actions',
  },
  /** What a waiting row says after its sentence: the kind of wait. */
  waitingMeta: {
    approval: 'Approval, waiting',
    question: 'Question',
  },
  /** What a run row says about how it stands, after its agent. */
  runWaiting: {
    approval: 'waiting for approval',
    answer: 'waiting for your answer',
  },
  /** What an agent's row and a tool's row call themselves, after their identifier. */
  agentKind: 'agent',
  toolKind: 'tool',
  /** The action that starts a chat on what was typed ("New chat about refund"). */
  newChatAbout: (topic: string): string => `New chat about ${topic}`,
  /** The key hints under the list: the prefixes that narrow a search, and the key that opens a row. */
  footer: {
    actions: 'actions',
    agents: 'agents',
    open: 'Enter to open',
  },
} as const;

/**
 * The words of the notification bell: what needs the person, and what finished. Each item is a
 * sentence and a second line that says what kind of wait it is and whose it is, or what the
 * sentence is about, never a run.
 */
export const NOTIFICATION_COPY = {
  panelTitle: 'Notifications',
  markAllRead: 'Mark all read',
  /** The empty list: everything that needed the person is done. */
  empty: {
    title: 'Nothing needs you right now',
    description: 'Approvals, questions, failures and missed schedules show up here.',
  },
  /** The list could not be read, so it must not read as empty. */
  loadFailed: {
    title: 'Notifications could not be loaded',
    description: 'What is shown may be out of date. Nothing here says that nothing needs you.',
  },
  /** A mark-as-read the Bureau refused: the items are unread again, here and in every browser. */
  readFailed: 'The notifications could not be marked as read. They are unread again.',
  /** Where email or webhooks are set up, and where the bell's own settings are. */
  linksLabel: 'Where notifications are set up',
  settingsLink: 'Notification settings',
  hooksLink: 'Email or webhooks: set up a hook ›',
  /** What the bell button is called; the count says how many items are unread. */
  bellLabel: (count: number): string =>
    count === 0 ? 'Notifications' : `Notifications: ${String(count)} unread`,
  /** The count after the popover's title, "Notifications 3 unread"; nothing when none is unread. */
  unreadSummary: (count: number): string => `${String(count)} unread`,
  /** What the dot before an unread row is called, for a screen reader. */
  unreadMark: 'Unread',
  /** The second line of a review: what it waits for, and whose it is. */
  waiting: (kind: 'approval' | 'answer', agent: string): string =>
    `${kind === 'approval' ? 'Waiting for your approval' : 'Waiting for your answer'} from ${agent}`,
  failed: (subject: string): string => `${subject} failed`,
  budgetExceeded: (subject: string): string => `${subject} exceeded its budget`,
  /** A schedule that did not fire: "Daily summary missed its 3:00 AM run". */
  missedRun: (subject: string, time: string): string => `${subject} missed its ${time} run`,
  /** How many fires a schedule missed and since when: "4 missed since Oct 30". */
  missedSince: (count: number, since: string): string => `${String(count)} missed since ${since}`,
  /** The one fire a schedule missed because its time did not exist on the clock. */
  missedClockGap: 'Its time was skipped by a clock change',
  /** The host's storage rule is firing; the second line says how much is used. */
  storageOverWarning: 'Storage passed its warning level',
  storageUsed: (size: string): string => `${size} used`,
  /** What an agent is called when the Bureau names none. */
  unnamedAgent: 'An agent',
  noErrorText: 'No reason was given',
} as const;

/** The words of the navigation and the top bar, and what the engine status says. */
export const NAVIGATION_COPY = {
  /** The accessible name of the sidebar's list of destinations. */
  destinations: 'Views',
  /** The accessible name of the top bar's breadcrumb trail. */
  breadcrumb: 'Breadcrumb',
  /** What the Health page's links to the engine's other pages are called. */
  healthSections: 'Health sections',
  /** What the link to the audit trail is called among the Health page's links. */
  auditLog: 'Audit log',
  /** The button that folds the sidebar to its icon rail, and opens it again. */
  collapseSidebar: 'Collapse sidebar',
  expandSidebar: 'Expand sidebar',
  /** The product's name, as text at the top of the sidebar and of its drawer. */
  productName: 'Interborough',
  /** The names of the sidebar's sections; Home sits above them with none. */
  groups: { work: 'Work', build: 'Build', system: 'System' },
  /** The accessible name of the phone's bottom tab bar. */
  tabBar: 'Main tabs',
  /** The tab that opens the navigation drawer, which holds every destination the tab bar leaves out. */
  moreTab: 'More',
  /** The top bar's button that opens the navigation drawer. */
  openNavigation: 'Open navigation',
  /** The drawer's own button that closes it again. */
  closeNavigation: 'Close navigation',
  /** What follows "Reviews" in the row's name and tooltip: "Reviews, 2 need you". */
  reviewsCountLabel: 'need you',
  /** What follows "Health" in the row's name and tooltip: "Health, 3 need attention". */
  healthCountLabel: 'need attention',
  /** What follows "Health" in the row's name when nothing needs attention. */
  healthEmptyLabel: 'nothing needs attention',
  /** What the engine status says in the notification bell, by the state of the live feed. */
  engineStatus: {
    connecting: 'Server connecting',
    live: 'Server healthy',
    reconnecting: 'Server reconnecting',
    polling: 'Server healthy (polling)',
    stale: 'Server status stale',
    closed: 'Server unreachable',
  },
} as const;

/** The words of the keyboard shortcuts and their map, opened with `?`. */
export const SHORTCUT_COPY = {
  mapTitle: 'Keyboard shortcuts',
  openMap: 'Show keyboard shortcuts',
  openSearch: 'Search everything',
  generalGroup: 'General',
  navigationGroup: 'Go to',
  chatGroup: 'Chat',
  newChat: 'New chat',
  listGroup: 'Lists',
  goTo: (label: string): string => `Go to ${label}`,
} as const;
