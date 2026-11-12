/** The words the audit log (`/health/audit`) uses: its filters, its table, and the pane of one event. */
export const AUDIT_COPY = {
  /** The accessible name of the filter row. */
  searchLabel: 'Filter the audit log',
  actorLabel: 'Who',
  /** The Who select's first option: no narrowing by who did it. */
  anyone: 'Anyone',
  actors: { you: 'You', agents: 'Agents', interborough: 'Interborough' },
  periodLabel: 'Period',
  periods: {
    today: 'Today',
    '7d': 'Last 7 days',
    '30d': 'Last 30 days',
    '90d': 'Last 90 days',
    all: 'All time',
  },
  actionLabel: 'Action',
  /** The action select's first option: no narrowing by what was done. */
  anyAction: 'Any action',
  actions: {
    approved: 'Approved',
    deleted: 'Deleted',
    edited: 'Edited',
    removed: 'Removed',
    started: 'Started',
  },
  textLabel: 'Search the audit log',
  textPlaceholder: 'Search by actor, action or target',
  /** The count at the right of the search box. */
  count: (count: number, more: boolean): string =>
    `${count.toLocaleString('en-US')} ${count === 1 ? 'event' : 'events'}${more ? ' so far' : ''}`,
  /** The footer of the table. */
  footer: (loaded: number, total: number | undefined, more: boolean): string =>
    total === undefined || !more
      ? `${loaded.toLocaleString('en-US')} ${loaded === 1 ? 'event' : 'events'}, newest first.`
      : `Showing ${loaded.toLocaleString('en-US')} of ${Math.max(total, loaded).toLocaleString('en-US')} events, newest first. Scroll to load more.`,
  /** The name of the table, which also says how it is ordered. */
  caption: 'Audit events, newest first',
  /** The name of the open event's pane. */
  detailLabel: 'Event',
  columns: { when: 'When', who: 'Who', what: 'What', target: 'Target' },
  /** A day group's header: the day, then the zone the times are read in. */
  dayHeading: {
    today: (date: string): string => `Today, ${date}`,
    yesterday: (date: string): string => `Yesterday, ${date}`,
  },
  /** The pane while no event is open. */
  emptyDetailTitle: 'Select an event to see what changed',
  emptyDetailDescription: 'Each event shows who did it, when, and the before and after.',
  /** The line under an event's title. `when` reads "Today at 10:45:12 AM". */
  whenLine: (when: string, context: string | null): string =>
    context === null ? when : `${when}, ${context}`,
  fromThisBrowser: 'from this browser',
  inTheChat: (title: string): string => `in the chat “${title}”`,
  fact: {
    provider: 'Provider',
    effect: 'Effect',
    agent: 'Agent',
    chat: 'Chat',
    version: 'Version',
    changed: 'Changed',
    tool: 'Tool',
    risk: 'Risk',
    amount: 'Amount',
    status: 'Status',
    schedule: 'Schedule',
    workflow: 'Workflow',
    run: 'Run',
    about: 'About',
    detail: 'Details',
  },
  /** What removing a provider's key does, which is the same whichever provider it was. */
  providerRemovedEffect: 'Agents that use a model can’t run until a provider is connected',
  riskDangerous: 'Dangerous, Can’t be undone',
  riskChanges: 'Changes things',
  riskReadOnly: 'Only reads',
  changedWords: {
    instructions: 'Instructions',
    tools: 'Tools',
    approvals: 'Tool approvals',
    // What an audit event recorded before `toolApproval` became `approvals` (COR-2137).
    toolApproval: 'Tool approvals',
    model: 'Model',
    description: 'Description',
    skills: 'Skills',
    // The agent file's keys after COR-2137, worded as the agent editor words them.
    effort: 'Default effort',
    children: 'Child agents',
    card: 'Skill descriptors',
  },
  toolsAdded: (names: string): string => `added ${names}`,
  toolsRemoved: (names: string): string => `removed ${names}`,
  /** The footer of the diff of an agent's instructions, in Cinder's own words. */
  instructionsLabel: 'What changed in the instructions',
  links: {
    providers: 'Open Providers',
    review: 'Open review',
    agent: 'Open agent',
    run: 'Open run',
    chat: 'Open chat',
    schedule: 'Open schedule',
    workflow: 'Open workflow',
    storage: 'Open storage',
  },
  copyAsJson: 'Copy as JSON',
  copiedAsJson: 'Copied as JSON',
  copyKey: 'Copy key',
  copiedKey: 'Copied the key',
  copyFailed: 'Couldn’t copy. Select the text and copy it yourself.',
  /** The heading of a target too long for a table cell, with how many characters it has. */
  targetHeading: (length: number): string => `Target, ${length.toLocaleString('en-US')} characters`,
  /** The footer of every event's pane: how long records are kept, and what Export saves. */
  retention: {
    before: 'Audit records are kept 90 days (',
    link: 'Settings › Data and retention',
    after: '). Export downloads the filtered list as JSON Lines.',
  },
  exportAction: 'Export',
  exporting: 'Exporting…',
  /** Why Export is off while the log on screen is old: the same word the page's other held controls use. */
  exportOff: 'Off until the audit log loads again',
  /** The line under the filter row while Export reads the log: how many events it prepares, and the way out. */
  exportProgress: (count: number): string =>
    `Preparing ${count.toLocaleString('en-US')} ${count === 1 ? 'event' : 'events'} as JSON Lines…`,
  exportCancel: 'Cancel',
  exported: (count: number): string =>
    `Exported ${count.toLocaleString('en-US')} ${count === 1 ? 'event' : 'events'}`,
  nothingToExport: 'There is nothing to export for these filters.',
  /** A danger alert at the page: the lead, then why, then that the filters and the download are as they were. */
  exportFailed: {
    lead: 'Couldn’t export.',
    answered:
      'The server stopped while writing the file. Your filters are unchanged; nothing was downloaded.',
    noAnswer: 'The server didn’t answer. Your filters are unchanged; nothing was downloaded.',
    again: 'Export again',
  },
  loadingLabel: 'Loading the audit log',
  /**
   * Filters that match nothing. A search names itself in the title and says how to search; filters
   * say what was not recorded ("Nothing by agents was recorded today.") and what to try.
   */
  noMatches: {
    title: 'No events match these filters',
    titleForSearch: (text: string): string => `No events match “${text}”`,
    searchHint: 'Check the spelling, or search by actor, action or target.',
    clear: 'Clear filters',
    /** "Nothing", then the action and who when they are set, then when. */
    nothing: 'Nothing',
    byActor: { you: 'by you', agents: 'by agents', interborough: 'by Interborough' },
    actionWords: {
      approved: 'approved',
      deleted: 'deleted',
      edited: 'edited',
      removed: 'removed',
      started: 'started',
    },
    wasRecorded: {
      today: 'was recorded today.',
      '7d': 'was recorded in the last 7 days.',
      '30d': 'was recorded in the last 30 days.',
      '90d': 'was recorded in the last 90 days.',
      all: 'has been recorded.',
    },
    /** What to try, by how far back the period already reaches. */
    tryLongerPeriod: 'Try a longer period.',
    tryAllTime: 'Try all time, or change a filter.',
    tryAnotherFilter: 'Change or clear a filter.',
  },
  /** What the log says after "Cancel" in the "Still loading" line: nothing failed, the person stopped it. */
  stopped: {
    title: 'Stopped loading the audit log',
    description: 'You stopped the read, so the log is not shown. Nothing in it was changed.',
  },
  /** A list with more pages to read, where none of the events read so far matches the search. */
  noLoadedMatches: {
    title: 'No loaded event matches',
    description:
      'None of the events read so far matches this search, and the log has more. Change or clear a filter.',
    clear: 'Clear filters',
  },
  /** An address that names an event the page could not show. */
  recordNotFound: {
    more: 'That event was not found in the recent log. Load more to keep looking.',
    end: 'That event is not in the log.',
  },
  loadMore: 'Load more',
  /** A read that did not give the page its events, with the status the server answered with. */
  failed: {
    title: 'Couldn’t load the audit log',
    answered: (status: number): string =>
      `The server answered with an error (${String(status)}). Nothing you did caused it.`,
    /** A refusal (401 or 403) is something to fix, so it carries the server's own words. */
    refused: (status: number, message: string): string =>
      `The server answered with an error (${String(status)}): ${message.replace(/[.\s]+$/, '')}.`,
    noAnswer: 'The server didn’t answer. Nothing you did caused it.',
    unknown: 'Something went wrong reading the audit log. Nothing you did caused it.',
  },
} as const;

/** The sentences that say what an audit event was, in the order the table reads them: who, what, target. */
export const AUDIT_EVENT_COPY = {
  /** The actor of what the host itself did or noticed. */
  host: 'Interborough',
  you: 'You',
  serverStarted: 'Server started',
  serverStartedTarget: 'Interborough',
  /** The target of a start that recorded its version: "Interborough 2.4.1". */
  serverStartedVersionTarget: (version: string): string => `Interborough ${version}`,
  removedProviderKey: (provider: string): string => `Removed the ${provider} key`,
  providerTarget: (provider: string): string => `${provider} provider`,
  startedRun: 'Started a run',
  stoppedRun: 'Stopped a run',
  runFailed: 'A run failed',
  chatTarget: (title: string): string => `Chat › ${title}`,
  scheduleRan: 'Started a scheduled run',
  createdSchedule: 'Created a schedule',
  pausedSchedule: 'Paused a schedule',
  resumedSchedule: 'Resumed a schedule',
  canceledSchedule: 'Canceled a schedule',
  missedRuns: (count: number): string =>
    `Noticed ${count.toLocaleString('en-US')} missed ${count === 1 ? 'run' : 'runs'}`,
  /** A tool asked before running: `request` is the tool's own sentence, lower-cased, such as "refund order 4471". */
  askedTo: (request: string): string => `Asked to ${request}`,
  askedToUse: (tool: string): string => `Asked to use ${tool}`,
  approvedToolCall: 'Approved a tool call',
  deniedToolCall: 'Denied a tool call',
  ranTool: (tool: string): string => `Ran ${tool}`,
  correctedMemory: 'Corrected a memory',
  forgotMemory: 'Forgot a memory',
  editedAgent: 'Edited an agent',
  createdWorkflow: 'Created a workflow',
  editedWorkflow: 'Edited a workflow',
  createdHook: 'Created a hook',
  editedHook: 'Edited a hook',
  deletedChat: 'Deleted a chat',
  chatTargetDeleted: 'Chat',
  /** The target of a deleted chat whose record kept its title: "“Scratch test”, 12 messages". */
  deletedChatTarget: (title: string, messages: number | undefined): string =>
    messages === undefined
      ? `“${title}”`
      : `“${title}”, ${messages.toLocaleString('en-US')} ${messages === 1 ? 'message' : 'messages'}`,
  deletedStorageKey: 'Deleted a storage key',
  storageTarget: (key: string): string => `Storage › ${key}`,
  connectedToolSource: 'Connected a tool source',
  removedToolSource: 'Removed a tool source',
  trustedSkillSource: 'Changed what a skill source may do',
  changedSettings: 'Changed a setting',
  webhookGaveUp: 'Gave up delivering a hook',
  /** An event the page has no sentence for: the record's own type, in words. */
  other: (type: string): string => type,
  anAgent: 'An agent',
  aSchedule: 'A schedule',
  versionRange: (from: number | undefined, to: number | undefined): string =>
    from === undefined ? `version ${to ?? ''}` : `version ${from} → ${to ?? ''}`,
} as const;
