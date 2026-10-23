/**
 * What a schedule is called and what it does, in the words of a person who set it up, from what
 * the Bureau and the engine say of it: its description, the agent it runs, and its cadence. The
 * schedule's identifier is never part of either; it is reachable from the actions menu, as
 * "Copy id". Nothing here invents a name: a schedule with no description is named by what it
 * starts.
 */
import { SCHEDULE_COPY } from '../../app/copy.ts';
import type { ScheduleKind } from '../../lib/schedule-kinds.ts';
import { describeCadence, type ScheduleCadence } from './cadence.ts';

/** The fields of a schedule that name it. */
export type ScheduleNaming = {
  readonly description?: string | undefined;
  readonly workflowType: string;
};

/**
 * The name of a schedule: its description when it has one, and otherwise "Schedule for" what it
 * starts: the agent, or the workflow's type. A Bureau schedule whose agent the caller may not read
 * has neither, and is a scheduled agent run.
 */
export function scheduleName(schedule: ScheduleNaming, kind: ScheduleKind): string {
  const description = schedule.description?.trim() ?? '';
  if (description !== '') return description;
  if (kind.kind === 'agent-run') {
    return kind.agentName === null
      ? SCHEDULE_COPY.unnamedAgentRun
      : SCHEDULE_COPY.nameFor(kind.agentName);
  }
  return SCHEDULE_COPY.nameFor(schedule.workflowType);
}

/** What the name is made of that is an identifier, to be set in monospace: nothing for a description. */
export function scheduleNameIdentifiers(schedule: ScheduleNaming, kind: ScheduleKind): string[] {
  if ((schedule.description?.trim() ?? '') !== '') return [];
  if (kind.kind === 'agent-run') return kind.agentName === null ? [] : [kind.agentName];
  return [schedule.workflowType];
}

const WEEKDAY_PLURALS = /^(?:Sundays|Mondays|Tuesdays|Wednesdays|Thursdays|Fridays|Saturdays) /;

/**
 * A cadence as the end of a sentence: "every day at 09:00", "on Mondays at 09:00". The words are
 * `describeCadence`'s, which is the one place a cron expression becomes words; an expression it
 * does not recognise is said as it is, "on cron 0 9 * * 1-5".
 */
export function cadenceClause(cadence: ScheduleCadence): string {
  const words = describeCadence(cadence);
  if (words.startsWith('Cron · ')) return `on cron ${words.slice('Cron · '.length)}`;
  if (words === 'Unknown cadence') return 'on an unknown cadence';
  if (WEEKDAY_PLURALS.test(words)) return `on ${words}`;
  return `${words.charAt(0).toLowerCase()}${words.slice(1)}`;
}

/**
 * What a schedule does and when, as a sentence: "Runs assistant every day at 09:00". What it runs
 * is the middle of the sentence and is left to the page, which links it, so this returns the words
 * on either side.
 */
export function scheduleSentence(
  schedule: ScheduleCadence,
  kind: ScheduleKind,
): { readonly verb: string; readonly clause: string } {
  const clause = cadenceClause(schedule);
  return { verb: kind.kind === 'agent-run' ? 'Runs' : 'Starts', clause };
}
