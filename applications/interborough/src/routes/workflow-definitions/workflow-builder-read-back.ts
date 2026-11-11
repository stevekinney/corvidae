/**
 * The builder's read-back: the whole workflow in one plain-words sentence, what starts it and then
 * each step, as the footer says it (board PageWorkflowBuilder): "On weekdays at 9:00 AM CST, ask
 * Assistant to summarize what happened yesterday, wait for a person to review it, then wait 15
 * minutes." A step the builder cannot read is said as one it cannot describe, never dropped.
 */
import { WORKFLOW_COPY } from '../../app/copy.ts';
import { agentLabel } from '../../lib/agent-label.ts';
import type { BuilderStep, BuilderTrigger, WaitUnit } from './workflow-builder-model.ts';

/** What the read-back needs besides the file: how agents are named, and the clock. */
export interface ReadBackOptions {
  /**
   * The name a person reads for an agent's identifier ("Tool runner" for `tool-runner`). Defaults
   * to the identifier in words.
   */
  readonly agentName?: (identifier: string) => string;
  /** The instant whose zone abbreviation a schedule names (CST in winter, CDT in summer). Defaults to now. */
  readonly now?: number;
}

const copy = WORKFLOW_COPY.builder.readBack;

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** The unit an interval letter counts, as `{ one, many }`. */
const INTERVAL_UNITS: Readonly<Record<string, { one: string; many: string }>> = {
  s: { one: 'second', many: 'seconds' },
  m: { one: 'minute', many: 'minutes' },
  h: { one: 'hour', many: 'hours' },
  d: { one: 'day', many: 'days' },
};

const UNIT_WORDS: Readonly<Record<WaitUnit, { one: string; many: string }>> = {
  seconds: { one: 'second', many: 'seconds' },
  minutes: { one: 'minute', many: 'minutes' },
  hours: { one: 'hour', many: 'hours' },
  days: { one: 'day', many: 'days' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The zone's short name at `now` ("CST"), or the zone itself where the runtime does not know it. */
function zoneAbbreviation(zone: string, now: number): string {
  try {
    return (
      new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
        .formatToParts(now)
        .find((part) => part.type === 'timeZoneName')?.value ?? zone
    );
  } catch {
    return zone;
  }
}

/** An hour and a minute on a twelve-hour clock: "9:00 AM". */
function clockOf(hour: number, minute: number): string {
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(twelve)}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

/**
 * A cron spec in words, for the shapes a person sets in the builder: every day, weekdays, weekends
 * or one weekday, at one time, in the trigger's zone (UTC when it names none, as Bureau runs it).
 */
function cronPhrase(spec: string, zone: string, now: number): string | undefined {
  const fields = spec.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minute, hour, day, month, weekday] = fields;
  if (!/^\d{1,2}$/.test(minute ?? '') || !/^\d{1,2}$/.test(hour ?? '')) return undefined;
  if (day !== '*' || month !== '*') return undefined;
  const hours = Number(hour);
  const minutes = Number(minute);
  if (hours > 23 || minutes > 59) return undefined;
  const at = `${clockOf(hours, minutes)} ${zoneAbbreviation(zone, now)}`;
  if (weekday === '*') return copy.everyDay(at);
  if (weekday === '1-5') return copy.weekdays(at);
  if (weekday === '0,6' || weekday === '6,0') return copy.weekends(at);
  if (/^[0-7]$/.test(weekday ?? '')) return copy.weekly(WEEKDAYS[Number(weekday)] ?? '', at);
  return undefined;
}

/** An interval spec in words: "Every hour", "Every 15 minutes". */
function intervalPhrase(spec: string): string | undefined {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(spec.trim());
  const unit = match === null ? undefined : INTERVAL_UNITS[match[2] ?? ''];
  if (match === null || unit === undefined) return undefined;
  const count = Number(match[1]);
  return copy.every(count === 1 ? unit.one : `${String(count)} ${unit.many}`);
}

function schedulePhrase(spec: string, rawTrigger: unknown, now: number): string {
  if (spec.trim() === '') return copy.anySchedule;
  const zone =
    isRecord(rawTrigger) && typeof rawTrigger['timezone'] === 'string'
      ? rawTrigger['timezone']
      : 'UTC';
  return cronPhrase(spec, zone, now) ?? intervalPhrase(spec) ?? copy.onSchedule(spec);
}

/** What starts the workflow, as the sentence opens: "On weekdays at 9:00 AM CST". */
function leadOf(rawTrigger: unknown, trigger: BuilderTrigger | null, now: number): string {
  switch (trigger?.kind) {
    case 'manual':
      return copy.manual;
    case 'schedule':
      return schedulePhrase(trigger.spec, rawTrigger, now);
    case 'signal':
      return trigger.name === '' ? copy.anySignal : copy.signal(trigger.name);
    case 'contributed':
      return copy.contributed(trigger.id);
    default:
      return '';
  }
}

/** A message as the task in "ask Assistant to …": its first letter lowered, its last stop dropped. */
function taskOf(message: string): string {
  const trimmed = message.trim().replace(/[.!?]+$/, '');
  if (trimmed === '') return '';
  const second = trimmed.charAt(1);
  // "API keys" keeps its capitals; "Summarize" reads "summarize".
  return second !== '' && second === second.toUpperCase() && second !== second.toLowerCase()
    ? trimmed
    : `${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`;
}

/** How long a wait lasts in words: "15 minutes", "5000 ms", or the duration as written. */
function durationWords(step: Extract<BuilderStep, { kind: 'wait' }>): string {
  if (step.parts !== null && step.parts.amount !== '') {
    const words = UNIT_WORDS[step.parts.unit];
    return `${step.parts.amount} ${step.parts.amount === '1' ? words.one : words.many}`;
  }
  return /^\d+$/.test(step.duration) ? `${step.duration} ms` : step.duration;
}

function stepPhrase(step: BuilderStep, agentName: (identifier: string) => string): string {
  switch (step.kind) {
    case 'agent':
      return copy.ask(
        step.agent === '' ? copy.anAgent : agentName(step.agent),
        taskOf(step.message),
      );
    case 'person':
      return copy.person;
    case 'signal':
      return step.signal === '' ? copy.anySignalWait : copy.waitForSignal(step.signal);
    case 'wait':
      return copy.wait(durationWords(step));
    case 'other':
      return copy.other;
  }
}

/**
 * The read-back sentence for a file's trigger (as written, and as the builder reads it) and its
 * steps. With no steps, or with an agent step still empty, it says what to do first instead.
 */
export function readBackOf(
  rawTrigger: unknown,
  trigger: BuilderTrigger | null,
  steps: readonly BuilderStep[],
  options: ReadBackOptions = {},
): string {
  if (steps.length === 0) return copy.noSteps;
  const unfilled = steps.findIndex(
    (step) => step.kind === 'agent' && step.agent === '' && step.message.trim() === '',
  );
  if (unfilled !== -1) return copy.fillIn(unfilled + 1);
  const agentName =
    options.agentName ?? ((identifier: string) => agentLabel(identifier, undefined));
  const now = options.now ?? Date.now();
  const phrases = steps.map((step, index) => {
    const phrase = stepPhrase(step, agentName);
    const last = index > 0 && index === steps.length - 1;
    // A manual start reads "Run it when you press Start run, then ask …".
    const afterManual = index === 0 && trigger?.kind === 'manual';
    return last || afterManual ? `${copy.then} ${phrase}` : phrase;
  });
  const sentence = [leadOf(rawTrigger, trigger, now), ...phrases]
    .filter((part) => part !== '')
    .join(', ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
