/**
 * The rows of Home's two activity bands (COR-2227): Workflow activity, from the engine's fleet feed
 * worded by {@link FLEET_EVENT_RULES}, and Agent activity, from the Bureau's feed worded by
 * `bureau.events.format`. Both bands draw one row shape: the kind's glyph, the title, a status
 * badge on line two for a warning or critical event followed by the body, the time, and the link as
 * the whole row.
 *
 * An event the application could not word (a Bureau kind no formatter claims, an event of a format
 * call that failed, or a fleet kind with no rule) has one form: its kind in plain words as the
 * title, the neutral activity glyph, no tier, and a link whenever it names
 * a run. A row's tier comes only from the formatter's tier or the rule's, never from its words.
 */
import {
  Activity,
  Archive,
  Ban,
  Bell,
  Bot,
  Brain,
  Calendar,
  CalendarClock,
  Check,
  CircleCheck,
  CircleX,
  Clock,
  Cpu,
  Database,
  Download,
  Eye,
  FileCode,
  FileText,
  Flag,
  Goal,
  Hammer,
  HardDrive,
  Hourglass,
  Inbox,
  Key,
  Link,
  ListChecks,
  Mail,
  MessageSquare,
  Package,
  Pause,
  Pencil,
  Play,
  Plug,
  RefreshCw,
  Rocket,
  Send,
  Server,
  Shield,
  ShieldAlert,
  Sparkles,
  Star,
  Target,
  Terminal,
  Timer,
  TimerOff,
  TriangleAlert,
  Upload,
  User,
  UserCheck,
  Users,
  Webhook,
  Workflow,
  Wrench,
  Zap,
} from '@lucide/svelte';

import { HOME_COPY } from '../../app/copy/home.ts';
import type { FormattedBureauEvent } from '../../lib/bureau-event-format.ts';
import type { BureauEventFrame } from '../../lib/live-source/bureau-event-frame.ts';
import type { FleetEventFrame } from '../../lib/live-source/fleet-event-source.svelte.ts';
import { workflowDetailPath } from '../../lib/router.svelte.ts';
import { workflowTypeName } from '../../lib/workflow-type-name.ts';
import { eventWords } from '../hooks/hook-presentation.ts';
import { RECENT_CHAT_LIMIT } from './home-rows.ts';

/** How many rows a band shows: the limit of Home's other history list. */
export const ACTIVITY_ROW_LIMIT = RECENT_CHAT_LIMIT;

/** How many events a band keeps in memory: one format batch. */
export const ACTIVITY_WINDOW_LIMIT = 200;

/** How much an event matters, as its formatter or its rule says. */
export type ActivityTier = 'info' | 'warning' | 'critical';

/** A Lucide glyph a row leads with. */
export type ActivityIcon = typeof Activity;

/** One event as a band row draws it, apart from its time, which follows the clock. */
export interface ActivityEntry {
  /** The event's id in its feed (its cursor), which keys its row. */
  readonly key: string;
  /** When the event was published, in epoch milliseconds. */
  readonly at: number;
  readonly icon: ActivityIcon;
  readonly title: string;
  readonly tier: ActivityTier;
  /** More detail, after the tier word on line two. */
  readonly body?: string | undefined;
  /** The router-relative path the whole row opens. */
  readonly href?: string | undefined;
}

/** The status label that says a row's tier: none for an info row. */
export function tierWord(tier: ActivityTier): 'Warning' | 'Critical' | undefined {
  if (tier === 'warning') return 'Warning';
  if (tier === 'critical') return 'Critical';
  return undefined;
}

/** Line two of a row as text, for its tooltip: the tier label and the body. */
export function lineTwoText(entry: ActivityEntry): string | undefined {
  const word = tierWord(entry.tier);
  const parts = [word, entry.body].filter(
    (part): part is string => part !== undefined && part !== '',
  );
  return parts.length === 0 ? undefined : parts.join(', ');
}

/** The glyphs a formatter may name, by their Lucide names. A name not here draws the activity glyph. */
const ICONS: ReadonlyMap<string, ActivityIcon> = new Map([
  ['activity', Activity],
  ['archive', Archive],
  ['ban', Ban],
  ['bell', Bell],
  ['bot', Bot],
  ['brain', Brain],
  ['calendar', Calendar],
  ['calendar-clock', CalendarClock],
  ['check', Check],
  ['circle-check', CircleCheck],
  ['check-circle', CircleCheck],
  ['circle-x', CircleX],
  ['x-circle', CircleX],
  ['clock', Clock],
  ['cpu', Cpu],
  ['database', Database],
  ['download', Download],
  ['eye', Eye],
  ['file-code', FileCode],
  ['file-text', FileText],
  ['flag', Flag],
  ['goal', Goal],
  ['hammer', Hammer],
  ['hard-drive', HardDrive],
  ['hourglass', Hourglass],
  ['inbox', Inbox],
  ['key', Key],
  ['link', Link],
  ['list-checks', ListChecks],
  ['mail', Mail],
  ['message-square', MessageSquare],
  ['package', Package],
  ['pause', Pause],
  ['pencil', Pencil],
  ['play', Play],
  ['plug', Plug],
  ['refresh-cw', RefreshCw],
  ['rocket', Rocket],
  ['send', Send],
  ['server', Server],
  ['shield', Shield],
  ['shield-alert', ShieldAlert],
  ['sparkles', Sparkles],
  ['star', Star],
  ['target', Target],
  ['terminal', Terminal],
  ['timer', Timer],
  ['timer-off', TimerOff],
  ['triangle-alert', TriangleAlert],
  ['alert-triangle', TriangleAlert],
  ['upload', Upload],
  ['user', User],
  ['user-check', UserCheck],
  ['users', Users],
  ['webhook', Webhook],
  ['workflow', Workflow],
  ['wrench', Wrench],
  ['zap', Zap],
]);

/**
 * The glyph for a formatter's Lucide icon name (`calendar-clock`, or `CalendarClock`), or the one
 * neutral activity glyph for a name that is absent or unknown, whatever the tier.
 */
export function activityIcon(name: string | undefined): ActivityIcon {
  if (name === undefined) return Activity;
  const kebab = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
  return ICONS.get(kebab) ?? Activity;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberField(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The payload fields that name the run a Bureau event is about, in the order the Bureau reads them. */
const BUREAU_RUN_FIELDS = ['runId', 'goalRunId', 'taskId', 'parentRunId'] as const;

/** The run a Bureau event's payload names, read as the Bureau reads it, for a row it did not word. */
function bureauRunOf(payload: unknown): string | undefined {
  const record = recordOf(payload);
  for (const field of BUREAU_RUN_FIELDS) {
    const value = stringField(record, field);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** The form of an event the application could not word. */
function unworded(key: string, at: number, kind: string, runId: string | undefined): ActivityEntry {
  return {
    key,
    at,
    icon: Activity,
    // `eventWords` splits a Bureau kind at its dots; a fleet kind's family ends in a colon.
    title: eventWords(kind.replaceAll(':', '.')),
    tier: 'info',
    ...(runId === undefined ? {} : { href: workflowDetailPath(runId) }),
  };
}

/**
 * One Bureau envelope as a row: the Bureau's words when a formatter claimed it, else the unworded
 * form, which an envelope of a format call that failed (`formatted` is `null`) takes too.
 */
export function bureauEntry(
  envelope: BureauEventFrame,
  formatted: FormattedBureauEvent | null,
): ActivityEntry {
  if (formatted === null || formatted.formattedBy === undefined) {
    return unworded(
      envelope.cursor,
      envelope.emittedAtMs,
      envelope.kind,
      formatted?.runId ?? bureauRunOf(envelope.payload),
    );
  }
  const href =
    formatted.link !== undefined && formatted.link.startsWith('/')
      ? formatted.link
      : formatted.runId === undefined
        ? undefined
        : workflowDetailPath(formatted.runId);
  return {
    key: envelope.cursor,
    at: envelope.emittedAtMs,
    icon: activityIcon(formatted.icon),
    title: formatted.title,
    tier: formatted.tier,
    ...(formatted.body === undefined || formatted.body === '' ? {} : { body: formatted.body }),
    ...(href === undefined ? {} : { href }),
  };
}

/** A fleet kind the band words: its tier, its glyph, its title and, from its payload, its body. */
export interface FleetEventRule {
  readonly tier: ActivityTier;
  readonly icon: ActivityIcon;
  readonly title: string;
  readonly body?: (payload: Readonly<Record<string, unknown>>) => string | undefined;
}

/**
 * A fleet kind the band leaves out: telemetry and the steps of a run as it goes, which arrive many
 * times a second and would push every event a person reads out of a three-row band.
 */
export interface OmittedFleetEvent {
  readonly omit: true;
}

const words = HOME_COPY.activity.workflowEvents;
const OMIT: OmittedFleetEvent = { omit: true };

const workflowType = (payload: Readonly<Record<string, unknown>>) => {
  const type = stringField(payload, 'workflowType');
  if (type === undefined) return undefined;
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(type) ? workflowTypeName(type) : type;
};
const errorText = (payload: Readonly<Record<string, unknown>>) => stringField(payload, 'error');
const stepLine = (payload: Readonly<Record<string, unknown>>) => {
  const name = stringField(payload, 'activityName');
  return name === undefined ? undefined : words.step(name, numberField(payload, 'attempt'));
};
const stepAndError = (payload: Readonly<Record<string, unknown>>) =>
  [stepLine(payload), errorText(payload)].filter((part) => part !== undefined).join(', ') ||
  undefined;

/**
 * How Workflow activity words each fleet kind, by kind. A kind with no entry here is shown in the
 * unworded form (its kind in plain words); an omitted kind is not listed.
 */
export const FLEET_EVENT_RULES: Readonly<Record<string, FleetEventRule | OmittedFleetEvent>> = {
  'workflow:started': {
    tier: 'info',
    icon: Workflow,
    title: words.runStarted,
    body: workflowType,
  },
  'workflow:completed': { tier: 'info', icon: Workflow, title: words.runFinished },
  'workflow:failed': { tier: 'critical', icon: Workflow, title: words.runFailed, body: errorText },
  'workflow:cancelled': { tier: 'info', icon: Workflow, title: words.runCanceled },
  'workflow:timed-out': { tier: 'warning', icon: Workflow, title: words.runTimedOut },
  'workflow:suspended': { tier: 'info', icon: Workflow, title: words.runPaused },
  'workflow:resumed': { tier: 'info', icon: Workflow, title: words.runResumed },
  'workflow:recovery-skipped': {
    tier: 'warning',
    icon: Workflow,
    title: words.runNotRecovered,
    body: workflowType,
  },
  'workflow:definition-registered': {
    tier: 'info',
    icon: FileCode,
    title: words.workflowRegistered,
    body: workflowType,
  },
  'activity:failed': {
    tier: 'warning',
    icon: ListChecks,
    title: words.stepFailed,
    body: stepAndError,
  },
  'task:dead-lettered': {
    tier: 'critical',
    icon: ListChecks,
    title: words.stepGaveUp,
    body: (payload) => stringField(payload, 'activityName'),
  },
  'worker:connected': {
    tier: 'info',
    icon: Server,
    title: words.workerConnected,
    body: (payload) => {
      const queue = stringField(payload, 'queue');
      return queue === undefined ? undefined : words.queue(queue);
    },
  },
  'worker:disconnected': { tier: 'info', icon: Server, title: words.workerDisconnected },
  'worker:registration-rejected': { tier: 'warning', icon: Server, title: words.workerRefused },
  'worker:deployment-changed': {
    tier: 'info',
    icon: Server,
    title: words.workerDeploymentChanged,
  },
  'schedule:fired': { tier: 'info', icon: CalendarClock, title: words.scheduleStarted },
  'schedule:missed-fire': {
    tier: 'warning',
    icon: CalendarClock,
    title: words.scheduleMissed,
    body: (payload) => {
      const count = numberField(payload, 'missedCount');
      return count === undefined ? undefined : words.missed(count);
    },
  },
  'schedule:skipped': { tier: 'info', icon: CalendarClock, title: words.scheduleSkipped },
  'human-review:requested': { tier: 'info', icon: UserCheck, title: words.reviewRequested },
  'human-review:completed': { tier: 'info', icon: UserCheck, title: words.reviewAnswered },
  'alert:fired': {
    tier: 'warning',
    icon: Bell,
    title: words.alertFired,
    body: (payload) => stringField(payload, 'metric'),
  },
  'alert:resolved': {
    tier: 'info',
    icon: Bell,
    title: words.alertResolved,
    body: (payload) => stringField(payload, 'metric'),
  },
  'constraint:violated': {
    tier: 'warning',
    icon: Shield,
    title: words.constraintViolated,
    body: (payload) => stringField(payload, 'constraintName'),
  },
  'checkpoint:size-warning': { tier: 'warning', icon: HardDrive, title: words.checkpointLarge },
  'development:warning': {
    tier: 'warning',
    icon: Wrench,
    title: words.developmentWarning,
    body: (payload) => stringField(payload, 'message'),
  },
  'cleanup:warning': {
    tier: 'warning',
    icon: Wrench,
    title: words.cleanupWarning,
    body: errorText,
  },
  'catalog:revision-installed': { tier: 'info', icon: Package, title: words.revisionInstalled },
  'catalog:revision-activated': { tier: 'info', icon: Package, title: words.revisionActivated },
  'catalog:activation-rejected': {
    tier: 'warning',
    icon: Package,
    title: words.revisionRejected,
  },
  'catalog:revision-draining': { tier: 'info', icon: Package, title: words.revisionDraining },
  'catalog:revision-removed': { tier: 'info', icon: Package, title: words.revisionRemoved },
  'workflow-source:load-ready': { tier: 'info', icon: FileCode, title: words.filesLoaded },
  'workflow-source:load-failed': {
    tier: 'warning',
    icon: FileCode,
    title: words.filesFailed,
    body: errorText,
  },
  'stream:chunk': OMIT,
  'storage:size-reported': OMIT,
  'queue:depth-changed': OMIT,
  'attributes:changed': OMIT,
  'activity:started': OMIT,
  'activity:completed': OMIT,
  'activity:async-pending': OMIT,
  'activity:remote-queued': OMIT,
  'activity:remote-cancellation-requested': OMIT,
  'signal:received': OMIT,
  'signal:waiting': OMIT,
  'signal:delivered': OMIT,
  'update:received': OMIT,
  'update:completed': OMIT,
  'task:result-delivery': OMIT,
  'schedule:attempted': OMIT,
  'workflow:teardown': OMIT,
  'workflow:checkpoint': OMIT,
  'workflow-source:load-started': OMIT,
  'workflow-source:load-cancelled': OMIT,
};

/** Whether the band lists a fleet kind: every kind but the omitted ones. */
export function listsFleetKind(kind: string): boolean {
  const rule = Object.hasOwn(FLEET_EVENT_RULES, kind) ? FLEET_EVENT_RULES[kind] : undefined;
  return rule === undefined || !('omit' in rule);
}

/** One fleet frame as a row, by its rule, or in the unworded form when its kind has none. */
export function fleetEntry(frame: FleetEventFrame): ActivityEntry {
  const payload = recordOf(frame.payload);
  const runId = frame.workflowId ?? stringField(payload, 'workflowId');
  const rule = Object.hasOwn(FLEET_EVENT_RULES, frame.kind)
    ? FLEET_EVENT_RULES[frame.kind]
    : undefined;
  if (rule === undefined || 'omit' in rule) {
    return unworded(frame.cursor, frame.emittedAtMs, frame.kind, runId);
  }
  const body = rule.body?.(payload);
  return {
    key: frame.cursor,
    at: frame.emittedAtMs,
    icon: rule.icon,
    title: rule.title,
    tier: rule.tier,
    ...(body === undefined || body === '' ? {} : { body }),
    ...(runId === undefined ? {} : { href: workflowDetailPath(runId) }),
  };
}

/**
 * Entries newest first, each key once, at most {@link ACTIVITY_WINDOW_LIMIT}: the newer of two
 * events published in the same millisecond is the one later in `entries`' own order.
 */
export function newestFirst(entries: readonly ActivityEntry[]): ActivityEntry[] {
  const seen = new Set<string>();
  const unique: ActivityEntry[] = [];
  for (const entry of entries.toReversed()) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    unique.push(entry);
  }
  return unique
    .map((entry, index) => ({ entry, index }))
    .toSorted((left, right) => right.entry.at - left.entry.at || left.index - right.index)
    .map(({ entry }) => entry)
    .slice(0, ACTIVITY_WINDOW_LIMIT);
}
