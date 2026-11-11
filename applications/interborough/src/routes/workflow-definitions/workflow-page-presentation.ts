/**
 * What a workflow's page says in its header and in its steps: the lines under the title, and the
 * numbered rows of a file's steps. Plain functions over data, in the words `copy.ts` holds, so the
 * lines are tested without a page. Facts on a line are joined with commas, never a middle dot.
 */
import type { WorkflowStatus } from '@lostgradient/weft';

import { WORKFLOW_COPY } from '../../app/copy.ts';
import { calendarDay, clockTime, viewerTimeZone } from '../../lib/format/clock.ts';
import { workflowRunStatusWord, type StatusWord } from '../../lib/status.ts';
import { listDate, type TriggerSummary } from './workflow-presentation.ts';

/** One stretch of a header line: plain words, an identifier in monospace, a link, or a status word. */
export type HeaderRun = {
  readonly text: string;
  /** The text is an identifier, set in monospace. */
  readonly code?: true;
  /** The text is a link to this address. */
  readonly href?: string;
  /** The run is a status word beside its dot, and `text` is empty. */
  readonly word?: StatusWord;
};

/** One fact of a header line: runs that read together. The facts of a line are joined with commas. */
export type HeaderPart = readonly HeaderRun[];

/** One line under a workflow's title. */
export type HeaderLine = {
  readonly id: 'starts' | 'last-run' | 'schedule' | 'built-in';
  readonly parts: readonly HeaderPart[];
};

/** "Every Friday at 11:00 AM" reads "every Friday at 11:00 AM" after "Starts"; any other cadence keeps its case. */
function afterStarts(words: string): string {
  return words.startsWith('Every ') ? `every ${words.slice('Every '.length)}` : words;
}

/** What starts the workflow, as the first fact of its line, or `null` when nothing is known to. */
export function startsPart(trigger: TriggerSummary | null): HeaderPart | null {
  if (trigger === null) return null;
  const copy = WORKFLOW_COPY.page.header;
  if (trigger.kind === 'signal') {
    return [
      { text: copy.startsOnSignal.before },
      { text: trigger.name, code: true },
      { text: copy.startsOnSignal.after },
    ];
  }
  if (trigger.count !== undefined && trigger.count > 1) {
    return [{ text: copy.startsFromMany(trigger.count) }];
  }
  return [{ text: copy.starts(afterStarts(trigger.words)) }];
}

/**
 * The first line of a header: what starts the workflow, that a person can start it too, and the
 * agent it runs as. A fact the workflow does not have is not on the line, and a line with none is
 * `null`.
 */
export function startsLine(input: {
  readonly trigger: TriggerSummary | null;
  /** A person can start it from the page. */
  readonly canStart: boolean;
  /** The agent's name as a person reads it, or `null` when the file names none. */
  readonly agent: string | null;
}): HeaderLine | null {
  const copy = WORKFLOW_COPY.page.header;
  const parts: HeaderPart[] = [];
  const starts = startsPart(input.trigger);
  if (starts !== null) parts.push(starts);
  if (input.canStart && input.trigger !== null) parts.push([{ text: copy.startYourself }]);
  if (input.agent !== null) parts.push([{ text: copy.runsAs(input.agent) }]);
  return parts.length === 0 ? null : { id: 'starts', parts };
}

/** The newest run of a workflow, as much of it as the header says. */
export type LastRun = {
  readonly id: string;
  readonly status: WorkflowStatus;
  /** When it began, in milliseconds. */
  readonly createdAt: number;
};

/**
 * The second line of a header: when the workflow last ran and how that ended, and its file.
 * `lastRun` is `undefined` until the engine has said, so a run that has not been read is never
 * "Never run", and `null` once the engine says there is none.
 */
export function lastRunLine(input: {
  readonly lastRun: LastRun | null | undefined;
  /** The file's name with its extension, or `null` for a type that has no file. */
  readonly fileName: string | null;
  /** Where a run's page is. */
  readonly runHref: (runId: string) => string;
  readonly now?: number;
  readonly zone?: string;
}): HeaderLine | null {
  const copy = WORKFLOW_COPY.page.header;
  const now = input.now ?? Date.now();
  const zone = input.zone ?? viewerTimeZone();
  const parts: HeaderPart[] = [];
  const last = input.lastRun;
  if (last === null) {
    parts.push([{ text: copy.neverRun }]);
  } else if (last !== undefined) {
    parts.push([
      { text: `${copy.lastRunLabel} ` },
      { text: listDate(last.createdAt, now, zone), href: input.runHref(last.id) },
    ]);
    parts.push([{ text: '', word: workflowRunStatusWord(last.status) }]);
  }
  if (input.fileName !== null) {
    parts.push([{ text: `${copy.fileLabel} ` }, { text: input.fileName, code: true }]);
  }
  return parts.length === 0 ? null : { id: 'last-run', parts };
}

/** A schedule that starts a workflow, as the header names it. */
export type HeaderSchedule = {
  /** The name a person reads: the file's own name for it, else the engine's description, else its identifier. */
  readonly label: string;
  readonly href: string;
  readonly status: 'active' | 'paused';
  /** Its cadence in words, for the note after an active one. */
  readonly cadence: string | null;
};

/**
 * The line that names the schedule a file defines or, for a workflow some other schedule starts,
 * "Also started by": one by name and state (its cadence while it is active), several by count.
 */
export function scheduleLine(input: {
  readonly schedules: readonly HeaderSchedule[];
  /** The file's own trigger is a schedule, so the schedule is defined in the file. */
  readonly definedInFile: boolean;
}): HeaderLine | null {
  const copy = WORKFLOW_COPY.page.header;
  const [only] = input.schedules;
  if (only === undefined) return null;
  if (input.schedules.length > 1) {
    return { id: 'schedule', parts: [[{ text: copy.alsoStartedByMany(input.schedules.length) }]] };
  }
  if (input.definedInFile) {
    return {
      id: 'schedule',
      parts: [
        [
          { text: copy.scheduleDefined.before },
          { text: only.label, href: only.href },
          { text: copy.scheduleDefined.after },
        ],
      ],
    };
  }
  const note = only.status === 'paused' ? copy.schedulePaused : only.cadence;
  return {
    id: 'schedule',
    parts: [
      [
        { text: copy.alsoStartedBy.before },
        { text: only.label, href: only.href },
        { text: copy.alsoStartedBy.after },
        { text: note === null ? copy.scheduleEnd : copy.scheduleNote(note) },
      ],
    ],
  };
}

/**
 * The line under an internal workflow's description: that it is built in, its identifier, what
 * starts it when Interborough knows, and when it last ran ("today, 10:42 AM" for today).
 * `lastRunAt` is `undefined` until the engine has said, and `null` when it has never run.
 */
export function builtInLine(input: {
  readonly name: string;
  readonly lastRunAt: number | null | undefined;
  readonly now?: number;
  readonly zone?: string;
}): HeaderLine {
  const copy = WORKFLOW_COPY.page.header;
  const now = input.now ?? Date.now();
  const zone = input.zone ?? viewerTimeZone();
  const parts: HeaderPart[] = [[{ text: copy.builtIn }], [{ text: input.name, code: true }]];
  if (Object.hasOwn(copy.startedBy, input.name)) {
    const who = copy.startedBy[input.name as keyof typeof copy.startedBy];
    parts.push([{ text: copy.startedByPrefix(who) }]);
  }
  const last = input.lastRunAt;
  if (last === null) {
    parts.push([{ text: copy.neverRun }]);
  } else if (last !== undefined) {
    parts.push([
      {
        text:
          calendarDay(last, zone) >= calendarDay(now, zone)
            ? copy.lastRunToday(clockTime(last, zone))
            : copy.lastRun(listDate(last, now, zone)),
      },
    ]);
  }
  return { id: 'built-in', parts };
}

/** A step as a file writes it: its `kind`, and whatever else that kind carries. */
export type WorkflowStepSource = { readonly kind: string; readonly [key: string]: unknown };

type Described = WorkflowStepSource;

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One step of a file as the Overview's numbered list shows it. */
export type PageStep = {
  readonly position: number;
  /** The step's own title, or "Step 2" for a step the file does not name. */
  readonly title: string;
  /** The muted line under the title: what kind of step it is, and for whom. */
  readonly kind: string;
  /** An identifier set in monospace after the kind, such as the signal a step waits for. */
  readonly identifier: string | null;
  /** What the step does, in the file's own words, or `null` when it says none. */
  readonly description: string | null;
};

/**
 * A file's steps as numbered rows. A step's title is the file's `title` for it, and an agent
 * step's description is the message it sends; a wait for a signal and a wait for a person (an
 * `await-signal` with `review: true`) say what the run reads while it waits.
 */
export function stepRows(
  steps: readonly Described[],
  agentName: (identifier: string) => string = (identifier) => identifier,
): PageStep[] {
  const copy = WORKFLOW_COPY.page.steps;
  return steps.map((step, index): PageStep => {
    const position = index + 1;
    const named = text(step['title'])?.trim() ?? '';
    const title = named === '' ? copy.untitled(position) : named;
    switch (step.kind) {
      case 'activity': {
        const handler = text(step['handler']) ?? 'activity';
        const input = step['input'];
        if (handler === 'agent' && isRecord(input)) {
          const agent = text(input['agent']);
          return {
            position,
            title,
            kind: agent === undefined ? copy.kindAgentUnnamed : copy.kindAgent(agentName(agent)),
            identifier: null,
            description: text(input['message']) ?? null,
          };
        }
        return {
          position,
          title,
          kind: WORKFLOW_COPY.steps.activity(handler),
          identifier: null,
          description: null,
        };
      }
      case 'sleep':
        return {
          position,
          title,
          kind: copy.kindSleep(text(step['duration']) ?? ''),
          identifier: null,
          description: null,
        };
      case 'await-signal': {
        const person = step['review'] === true;
        return {
          position,
          title,
          kind: person ? copy.kindPerson : copy.kindSignal,
          identifier: person ? null : (text(step['signal']) ?? null),
          description: person ? copy.waitingForPerson : copy.waitingForSignal,
        };
      }
      default:
        return {
          position,
          title,
          kind: WORKFLOW_COPY.steps.unknown(step.kind),
          identifier: null,
          description: null,
        };
    }
  });
}

/** A step message longer than this is long enough that the list shows its first step and offers the rest. */
export const LONG_STEP_DESCRIPTION = 160;

/** Whether any step's description is long enough that the list collapses to its first step. */
export function hasLongStep(steps: readonly PageStep[]): boolean {
  return steps.some((step) => (step.description?.length ?? 0) > LONG_STEP_DESCRIPTION);
}
