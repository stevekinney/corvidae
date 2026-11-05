/**
 * The words of the Health page (`/health` and its tabs): the heading, the storage line under it,
 * the tab names, the four counts, the Needs attention list, Recent activity, the metric cards and
 * the Advanced disclosure. The design is the canvas's Health board (rows 76a to 77m).
 */
import { formatBytes } from '../../lib/format/index.ts';

/** The page heading, which is the same on every tab; the tab is the breadcrumb's leaf. */
export const HEALTH_TITLE = 'Health';

/** The tabs under the heading, in order, with where each opens. */
export const HEALTH_PAGE_TABS = [
  { value: 'overview', label: 'Overview', path: '/health' },
  { value: 'workers', label: 'Workers', path: '/health/workers' },
  { value: 'storage', label: 'Storage', path: '/health/storage' },
  { value: 'audit', label: 'Audit log', path: '/health/audit' },
] as const;

/** A Health tab's value. */
export type HealthTabValue = (typeof HEALTH_PAGE_TABS)[number]['value'];

/** The words of the page's frame: the heading's storage line, the tab bar and the live indicator. */
export const HEALTH_FRAME_COPY = {
  /** The tab bar's accessible name, and the prefix its select shows below 640 pixels ("Section: Storage"). */
  tabsLabel: 'Section',
  /** The line under the heading, before the storage details: the backend, then where it is. */
  runningOn: (backend: string, where: string | undefined): string =>
    where === undefined ? `Running on ${backend}` : `Running on ${backend} in ${where}`,
  /** The line when the host cannot say where it keeps its state. */
  runningUnknown: 'Running on this storage',
  sqlite: 'SQLite',
  postgres: 'Postgres and S3',
  /** The backend's name when the host cannot say. */
  unknownBackend: 'Storage',
  /** The link-styled button that opens the storage's facts. */
  storageDetails: 'Storage details',
  /** The popover's accessible name. */
  popoverLabel: 'Storage details',
  /** The popover's list of facts, and where storage is set up. */
  details: {
    backend: 'Backend',
    location: 'Location',
    size: 'Size',
    keys: 'Keys',
    writes: 'Writes',
    /** How a write works: one key at a time, and the keys the application manages cannot be changed here. */
    writesPerKey: 'Per key; managed keys are locked',
    /** A fact the host could not say. */
    unknown: '—',
    loading: 'Loading storage details',
    footerBefore: 'Storage is set up in ',
    footerLink: 'Settings › Data and retention',
    footerAfter: '.',
    settingsPath: '/settings/data-and-retention',
  },
} as const;

/** The words of the four counts under the tab bar. */
export const HEALTH_COUNTS_COPY = {
  label: 'Health counts',
  runningNow: 'Running now',
  needsYou: 'Needs you',
  failedIn24Hours: 'Failed in 24 hours',
  missedRuns: 'Missed schedule runs (7 days)',
  /** What a count that could not be read shows in place of its number. */
  unavailable: '—',
  /** The line under "Running now". */
  running: (count: number): string =>
    count === 0
      ? 'Nothing is running'
      : count === 1
        ? '1 run is running'
        : `${count} runs are running`,
  /** The line under "Needs you" when nothing waits. */
  nothingWaiting: 'Nothing is waiting on you',
  /** The line under "Failed in 24 hours". */
  failed: (count: number): string =>
    count === 0 ? 'No failed runs' : count === 1 ? '1 run failed' : `${count} runs failed`,
  /** The line under "Missed schedule runs" when every run started. */
  everyRunStarted: 'Every run started on time',
  /** What each kind of waiting review is called, singular and plural, for "An approval and a question". */
  waitingKinds: {
    approval: { one: 'An approval', many: (count: number): string => `${count} approvals` },
    question: { one: 'A question', many: (count: number): string => `${count} questions` },
    review: {
      one: 'A workflow review',
      many: (count: number): string => `${count} workflow reviews`,
    },
  },
} as const;

/** The words of the Needs attention list. */
export const HEALTH_ATTENTION_COPY = {
  title: 'Needs attention',
  /** The list's accessible name. */
  listLabel: 'Needs attention',
  /** What nothing needing attention says, and what it covers. */
  allClearTitle: 'Nothing needs attention',
  allClearLine: 'Storage, schedules, providers and hooks are fine.',
  /** The row when the list could not be read, and so cannot say all is well. */
  unavailableTitle: 'Couldn’t read what needs attention',
  unavailableLine: 'Interborough didn’t answer. Nothing you did caused it.',
  retry: 'Try again',
  /** The row when the caller may not read the list. */
  lockedTitle: 'Not available to you',
  provider: {
    title: 'No model provider connected',
    line: (provider: string | null, at: string | null): string =>
      provider === null || at === null
        ? 'Agents can’t answer until one is connected.'
        : `Agents can’t answer until one is connected. The ${provider} key was removed at ${at}.`,
    action: 'Connect a provider',
  },
  storage: {
    title: (size: number): string => `Storage is over its warning level · ${formatBytes(size)}`,
    line: (at: string): string => `Alert firing since ${at}.`,
    view: 'View storage',
    retention: 'Change retention',
  },
  failureRate: {
    title: (rate: number): string =>
      `Workflow failure rate is over its warning level · ${String(Math.round(rate * 100))}%`,
  },
  slowSteps: {
    title: (milliseconds: number): string =>
      `Slowest steps are over their warning level · ${String(Math.round(milliseconds / 1000))} s`,
  },
  otherAlert: {
    title: (metric: string): string => `${metric} is over its warning level`,
    line: (at: string): string => `Alert firing since ${at}.`,
    action: 'Open alerts',
  },
  missedRuns: {
    title: (name: string, count: number, since: string): string =>
      `${name} missed ${count === 1 ? '1 run' : `${count} runs`} since ${since}`,
    unnamed: 'A schedule',
    line: (dates: string): string => `Interborough was off when it was due on ${dates}.`,
    action: 'View schedule',
  },
  hook: {
    failedTitle: (name: string, status: string | null): string =>
      status === null
        ? `${name}’s last delivery failed`
        : `${name}’s last delivery failed · ${status}`,
    gaveUpTitle: (name: string, status: string | null): string =>
      status === null ? `${name} gave up` : `${name} gave up · ${status}`,
    unnamed: 'A hook',
    failedLine: (host: string | null, status: string | null, at: string): string =>
      host !== null && status !== null
        ? `${host} answered ${status} on its last try at ${at}.`
        : `Its last try failed at ${at}.`,
    errorLine: (error: string, at: string): string => `${error} Its last try was at ${at}.`,
    gaveUpLine: (attempts: number, on: string): string =>
      `Stopped after ${attempts} tries on ${on}. The URL may have been removed.`,
    action: 'View hook',
  },
  plugin: {
    title: (name: string): string => `${name} didn’t load`,
    line: (at: string | null): string =>
      at === null
        ? 'Its tools aren’t available to agents until it loads.'
        : `Its tools aren’t available to agents until it loads. Interborough couldn’t start it at ${at}.`,
    action: 'Open Plugins',
  },
  worker: {
    title: (name: string): string => `${name} is disconnected`,
    /** A worker that has no name of its own is called by what it serves. */
    unnamed: (queue: string): string => `The ${queue} worker`,
    line: (waiting: number, failedForGood: number, queue: string, at: string): string =>
      `${waiting === 1 ? '1 task is' : `${waiting} tasks are`} waiting for the ${queue} queue and ${failedForGood} failed for good. It was last heard from at ${at} and reconnects by itself when its process starts again.`,
    action: 'View worker',
  },
} as const;

/** The words of the Recent activity section. */
export const HEALTH_ACTIVITY_COPY = {
  title: 'Recent activity',
  /** After the title, so the times on the rows are read in this zone. */
  zone: 'Central time',
  /** The link to the whole trail, with the number of events the trail holds when it is known. */
  auditLink: (total: number | undefined): string =>
    total === undefined
      ? 'Open audit log'
      : `Open audit log (${total.toLocaleString('en-US')} ${total === 1 ? 'event' : 'events'})`,
  /** The list's accessible name. */
  listLabel: 'Recent activity',
  empty: 'Nothing has happened yet.',
  unavailable: 'Couldn’t read recent activity.',
  retry: 'Try again',
  serverStarted: 'Server started',
  removedProviderKey: (provider: string): string => `You removed the ${provider} key`,
  addedProviderKey: (provider: string): string => `You connected ${provider}`,
  runStarted: (title: string, waiting: boolean): string =>
    waiting ? `Run started · ${title} · waiting on you` : `Run started · ${title}`,
  runFinished: (title: string): string => `Run finished · ${title}`,
  runFailed: (title: string): string => `Run failed · ${title}`,
  runStopped: (title: string): string => `Run stopped · ${title}`,
  alertFiring: (metric: string): string => `Alert firing · ${metric}`,
  storageAlertFiring: 'Storage alert firing · over its warning level',
  missedRunsNoticed: (name: string, due: string | null): string =>
    due === null
      ? `Missed runs noticed · ${name}`
      : `Missed runs noticed · ${name} · was due ${due}`,
  scheduleRan: (name: string): string => `Schedule ran · ${name}`,
  deletedChat: (title: string): string => `You deleted a chat · “${title}”`,
  deletedChatUntitled: 'You deleted a chat',
  /** A chat, schedule or agent the page cannot name. */
  untitledChat: 'Untitled chat',
  unnamedSchedule: 'a schedule',
} as const;

/** The words of the three metric cards beside the Needs attention list. */
export const HEALTH_METRICS_COPY = {
  label: 'Last 24 hours',
  window: 'Last 24 hours',
  storageUse: 'Storage use',
  runsStarted: 'Runs started',
  timeToFinish: 'Time to finish',
  /** What the Storage use card says before the engine has reported a size. */
  noSize: 'Not reported yet',
  noSizeCaption: 'Interborough reports its storage size when it tidies up.',
  /** The one line that stands in for a chart until there are two sizes to draw. */
  chartsFill: 'Charts fill in as Interborough runs.',
  storageSeries: (size: string): string => `Storage use over the last 24 hours, now ${size}`,
  axisStart: (size: string): string => `${size} · 24 hours ago`,
  axisEnd: 'Now',
  runsCaption: (done: number, waiting: number, other: readonly string[]): string => {
    const parts = [
      ...(done > 0 ? [`${done} done`] : []),
      ...(waiting > 0 ? [`${waiting} waiting on you`] : []),
      ...other,
    ];
    return parts.length === 0 ? 'No runs started' : parts.join(' · ');
  },
  /** The Runs started caption when every run finished: how the day compares with the one before. */
  comparedWithDayBefore: (difference: number): string =>
    difference === 0
      ? 'The same as the day before'
      : difference > 0
        ? `${difference} more than the day before`
        : `${-difference} fewer than the day before`,
  medianCaption: (count: number): string =>
    `Median across ${count} finished ${count === 1 ? 'run' : 'runs'}`,
  noFinished: 'No run has finished',
  /** The value of a card that could not be read. */
  unavailable: '—',
  unavailableCaption: 'Couldn’t be read',
} as const;

/** The words of the Advanced disclosure at the foot of Overview. */
export const HEALTH_ADVANCED_COPY = {
  title: 'Advanced',
  summary: 'Metrics, alerts and checks',
  /** The section names, and what each says it holds. */
  metrics: {
    title: 'Metrics',
    line: 'Storage use, runs started, time to finish; each opens its chart.',
    action: 'Open metrics',
  },
  alerts: {
    title: 'Alerts',
    /** The rules firing now: their metrics, since when, and how many; or that none is. */
    line: (firing: readonly string[], since: string | null): string =>
      firing.length === 0 || since === null
        ? 'No alert is firing'
        : `${firing.join(', ')} · firing since ${since} · ${firing.length} ${firing.length === 1 ? 'rule' : 'rules'}`,
    action: 'Open alerts',
  },
  checks: {
    title: 'Checks',
    line: (needAttention: number, areas: readonly string[]): string =>
      needAttention === 0
        ? 'Every check passes'
        : `${needAttention} need${needAttention === 1 ? 's' : ''} attention · ${areas.join(', ')}`,
    action: 'Open checks',
    /** What an area says when it found nothing. */
    passes: 'No problem found',
  },
  realms: {
    title: 'Realms',
    line: 'The pools workflows run in.',
    action: 'Open realms',
  },
  /** The names of the areas a check counts, as the line under Checks words them. */
  areas: {
    storage: 'Storage',
    schedules: 'Schedules',
    providers: 'Providers',
    hooks: 'Hooks',
    plugins: 'Plugins',
    workers: 'Workers',
    runs: 'Runs',
  },
  /** The accessible name of an opened section. */
  sectionLabel: (title: string): string => `${title} detail`,
  close: 'Close',
} as const;
