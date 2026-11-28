/**
 * What the run setup page (`/workflows/:workflow/run`) decides outside the page: whether a
 * workflow can be run from it, the schema its input form is drawn from, the Bureau's or the
 * engine's refusal of an input turned into the field problems the form shows, what the heading
 * calls the workflow, and the one-line summary of what the primary action will do.
 */
import {
  describeScheduleFields,
  humanizeIdentifier,
  schemaHoldsConcealedField,
  type ScheduleValue,
} from '@lostgradient/cinder';
import { HttpClientError } from '@lostgradient/weft/client';

import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
import {
  isEngineType,
  type CatalogRow,
  type DefinitionDetail,
  type WorkflowResolution,
} from '../../lib/workflow-catalog.ts';
import { cadenceText } from '../schedules/schedule-cadence-text.ts';
import {
  schemaOf,
  specCadence,
  triggerSummary,
  type TriggerSummary,
} from './workflow-presentation.ts';

/** Where a refused input goes: the field its path names, or the form itself when the path is empty. */
export type InputIssue = {
  readonly path: readonly (string | number)[];
  readonly message: string;
};

/** One validation issue as a line of text: the path to the value, then what is wrong with it. */
export function describeIssue(issue: InputIssue): string {
  return issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`;
}

/** The declared schema JSON input is held to, or `undefined` when none is declared. */
export function declaredSchemaOf(schema: unknown): Record<string, unknown> | undefined {
  return isRecord(schema) ? schema : undefined;
}

/** What a run is started from: a file the Bureau holds, or a type that code registered. */
export type RunSetupTarget =
  | {
      /** `paused` is a file that loaded and starts nothing until it is resumed; its form still shows. */
      readonly status: 'ready' | 'paused';
      readonly kind: 'file' | 'code';
      /** The JSON Schema the input is described by, or `undefined` when the workflow declares none. */
      readonly schema: unknown;
    }
  | { readonly status: 'engine' | 'invalid' };

/** A known-safe JSON input after the detail read failed. */
export type JsonFallbackTarget = {
  readonly kind: 'file' | 'code';
  readonly schema: unknown;
  readonly paused: boolean;
};

/**
 * Whether independently read metadata permits raw JSON after the detail read failed. A file with
 * no schema keeps its known no-input state, while code with a confirmed absent schema accepts JSON.
 */
export function jsonFallbackTarget(
  row: CatalogRow | undefined,
  definition: DefinitionDetail | undefined,
): JsonFallbackTarget | undefined {
  if (row?.engine === true) return undefined;
  if (row?.kind === 'agent-authored') {
    const file = row.file;
    if (file?.state !== 'ready' || file.inputSchema === null || file.inputSchema === undefined) {
      return undefined;
    }
    if (schemaHoldsConcealedField(file.inputSchema)) return undefined;
    return { kind: 'file', schema: file.inputSchema, paused: file.paused };
  }
  if (row?.kind !== 'code' || definition?.origin !== 'code') return undefined;
  const schema = schemaOf(undefined, definition, 'inputSchema');
  if (schemaHoldsConcealedField(schema)) return undefined;
  return { kind: 'code', schema, paused: false };
}

/**
 * Whether the workflow can be run from the page. The types the Bureau registers to run itself are
 * never started by a person, and a file that is invalid starts nothing and has no form to draw. A
 * paused file keeps its form: the page says it is paused, and turns Start run off.
 */
export function runSetupTarget(type: string, resolution: WorkflowResolution): RunSetupTarget {
  if (isEngineType(type)) return { status: 'engine' };
  if (resolution.kind === 'code') {
    return {
      status: 'ready',
      kind: 'code',
      schema: schemaOf(undefined, resolution.definition, 'inputSchema'),
    };
  }
  const { file } = resolution;
  if (file.state !== 'ready') return { status: 'invalid' };
  return {
    status: file.paused ? 'paused' : 'ready',
    kind: 'file',
    schema: schemaOf(file.inputSchema, resolution.definition, 'inputSchema'),
  };
}

/**
 * Whether a workflow takes no input whatever starts it: a file that declares no input schema. A
 * type code registered without one still takes JSON, because its code may read an input that its
 * contract does not describe.
 */
export function takesNoInput(kind: 'file' | 'code', schema: unknown): boolean {
  return kind === 'file' && schema === undefined;
}

/**
 * Why the primary action is off: the form is still loading, its schema could not be read, the file
 * cannot be read, the file is paused, or a step's agent needs a model and no provider is connected.
 */
export type StartBlock = 'loading' | 'unloaded' | 'invalid' | 'paused' | 'provider';

/**
 * The reason drawn beside the primary action while it is off, in the action's own name ("Start run
 * is off while the workflow is paused."). A form that is still loading says nothing: its skeleton
 * already shows why.
 */
export function actionOffReason(block: StartBlock | undefined, action: string): string | null {
  if (block === undefined || block === 'loading') return null;
  return WORKFLOW_COPY.runSetup.actionOff[block](action);
}

/** A required field a form draft leaves empty: its key in the input, and the name a person reads. */
export type MissingField = { readonly key: string; readonly name: string };

/**
 * The name a person reads of the first required field a form draft leaves empty (its `title`, or
 * its key in words), or `undefined` when every required field holds something.
 */
export function missingRequiredField(schema: unknown, value: unknown): string | undefined {
  return firstMissingField(schema, value)?.name;
}

/** Whether a property's schema lets it hold `null`: a type list with `null`, or a union that has it. */
function allowsNull(property: unknown): boolean {
  if (!isRecord(property)) return false;
  const type = property['type'];
  if (type === 'null' || (Array.isArray(type) && type.includes('null'))) return true;
  return ['anyOf', 'oneOf'].some((keyword) => {
    const branches = property[keyword];
    return Array.isArray(branches) && branches.some(allowsNull);
  });
}

/**
 * The first required field of an object schema that a form draft leaves empty, or `undefined` when
 * every required field holds something. Only the top level is read: it is where a run's required
 * fields are. A required string that holds only spaces counts as empty.
 */
export function firstMissingField(schema: unknown, value: unknown): MissingField | undefined {
  if (!isRecord(schema)) return undefined;
  const required = schema['required'];
  const properties = schema['properties'];
  if (!Array.isArray(required) || !isRecord(properties)) return undefined;
  const draft: Record<string, unknown> = isRecord(value) ? value : {};
  const keys: readonly unknown[] = required;
  for (const key of keys) {
    if (typeof key !== 'string' || !Object.hasOwn(properties, key)) continue;
    const held = Object.hasOwn(draft, key) ? draft[key] : undefined;
    const property = properties[key];
    // `null` is a value a field that allows it holds, so a required one is not missing for it.
    const empty =
      held === undefined ||
      (held === null && !allowsNull(property)) ||
      (typeof held === 'string' && held.trim() === '');
    if (!empty) continue;
    const title = isRecord(property) ? property['title'] : undefined;
    const name =
      typeof title === 'string' && title.trim() !== ''
        ? title.trim()
        : humanizeIdentifier(key, { casing: 'sentence' });
    return { key, name };
  }
  return undefined;
}

/**
 * The agents a file's steps run (an `agent` activity names one in `input.agent`), each once and
 * sorted, for the provider check. `[]` for a file whose steps were not read.
 */
export function stepAgentsOf(
  steps: readonly Readonly<Record<string, unknown>>[] | null | undefined,
): string[] {
  const agents = new Set<string>();
  for (const step of steps ?? []) {
    const input = step['input'];
    if (step['kind'] !== 'activity' || step['handler'] !== 'agent' || !isRecord(input)) continue;
    const agent = input['agent'];
    if (typeof agent === 'string' && agent.trim() !== '') agents.add(agent);
  }
  return [...agents].sort();
}

/** Agents named in a sentence: "Tool runner", "Tool runner and Writer", "A, B and C". */
export function agentNames(agents: readonly string[]): string {
  const names = agents.map((agent) => humanizeIdentifier(agent, { casing: 'sentence' }));
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The schema a form can be drawn from: an object schema with fields. Anything else (no schema, an
 * array or a scalar input, an object that names no field) is entered as JSON.
 */
export function formSchemaOf(schema: unknown): Record<string, unknown> | undefined {
  if (!isRecord(schema) || schema['type'] !== 'object') return undefined;
  const properties = schema['properties'];
  return isRecord(properties) && Object.keys(properties).length > 0 ? schema : undefined;
}

/**
 * The field problems in a refusal of the input: an `InvalidParams` fault that lists its issues,
 * which both services answer. The Bureau roots every path at the `input` it was sent, so a path
 * that starts there is relative to the input from then on; `[]` is the input as a whole. `null`
 * when the error is not such a refusal.
 */
export function inputIssuesOf(error: unknown): readonly InputIssue[] | null {
  if (!(error instanceof HttpClientError)) return null;
  const data = error.data;
  // JSON-RPC carries the code in the envelope's data, and a REST body in the error itself.
  const invalid = data?.['weftCode'] === 'InvalidParams' || error.faultCode === 'InvalidParams';
  if (!invalid || data === undefined || !Array.isArray(data['issues'])) return null;
  const issues: InputIssue[] = [];
  for (const issue of data['issues'] as unknown[]) {
    if (!isRecord(issue) || typeof issue['message'] !== 'string') continue;
    const raw = Array.isArray(issue['path']) ? (issue['path'] as unknown[]) : [];
    const path = raw.filter(
      (segment): segment is string | number =>
        typeof segment === 'string' || typeof segment === 'number',
    );
    issues.push({ path: path[0] === 'input' ? path.slice(1) : path, message: issue['message'] });
  }
  return issues.length === 0 ? null : issues;
}

/** What the page calls a workflow: the name in its heading and its summary, and what it is for. */
export type RunSetupIdentity = {
  /** The file's title, or the identifier when the file gives none. */
  readonly name: string;
  /** Whether the file gave a title, so the heading names it and shows the identifier beside it. */
  readonly titled: boolean;
  /** What the workflow is for, or `null` when neither the file nor the engine says. */
  readonly description: string | null;
};

function nonEmpty(text: string | null | undefined): string | null {
  const trimmed = text?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * The words the heading and the summary use for a workflow. A file's title is its own; a file
 * without one, and a type that code registered, is known by its identifier alone.
 */
export function runSetupIdentity(
  type: string,
  resolution: WorkflowResolution | undefined,
  catalogRow?: CatalogRow,
): RunSetupIdentity {
  const title = nonEmpty(
    resolution === undefined
      ? catalogRow?.file?.title
      : resolution.kind === 'agent-authored'
        ? resolution.file.title
        : undefined,
  );
  const description =
    resolution === undefined
      ? catalogRow?.description
      : resolution.kind === 'agent-authored'
        ? (resolution.file.description ?? resolution.definition?.description)
        : resolution.definition.description;
  return {
    name: title ?? type,
    titled: title !== null,
    description: nonEmpty(description),
  };
}

/**
 * What starts a file on its own, by its trigger, or `null` for a type code registered and a trigger
 * that says nothing. A schedule trigger carries its cadence the way a header says it ("every
 * Friday at 11:00 AM"), ready for the sentence it ends.
 */
export function runSetupTrigger(
  resolution: WorkflowResolution | undefined,
  catalogRow?: CatalogRow,
): TriggerSummary | null {
  const trigger =
    resolution === undefined
      ? catalogRow?.file?.trigger
      : resolution.kind === 'agent-authored'
        ? resolution.file.trigger
        : null;
  const summary = triggerSummary(trigger ?? null);
  if (summary === null || summary.kind !== 'schedule') return summary;
  const spec = trigger?.['spec'];
  return typeof spec === 'string'
    ? { kind: 'schedule', words: cadenceText(specCadence(spec)).file }
    : summary;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** An ISO date (`2026-10-23`) as the footer says it ("Oct 23"), or `undefined` when it is not one. */
export function shortDate(iso: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (match === null) return undefined;
  const month = MONTHS[Number(match[2]) - 1];
  return month === undefined ? undefined : `${month} ${String(Number(match[3]))}`;
}

/** What the footer reads of an input, in plain words: where it runs, and since when. */
export type InputWords = { readonly on: string; readonly since?: string };

/**
 * The input read in plain words, from the two fields the footer knows how to say: a `branch`
 * ("on main") and, when the schema declares a `since`, the date it counts from ("since Oct 23"),
 * or "from the last release" while it is empty. Without a branch the input says nothing, and
 * neither does a schema that declares neither field.
 */
export function inputWordsOf(schema: unknown, value: unknown): InputWords | undefined {
  if (!isRecord(value)) return undefined;
  const branch = value['branch'];
  if (typeof branch !== 'string' || branch.trim() === '') return undefined;
  const on = WORKFLOW_COPY.runSetup.inputWords.on(branch.trim());
  const properties = isRecord(schema) ? schema['properties'] : undefined;
  if (!isRecord(properties) || !Object.hasOwn(properties, 'since')) return { on };
  const since = value['since'];
  const date = typeof since === 'string' ? shortDate(since) : undefined;
  return {
    on,
    since:
      date === undefined
        ? WORKFLOW_COPY.runSetup.inputWords.sinceLastRelease
        : WORKFLOW_COPY.runSetup.inputWords.since(date),
  };
}

/**
 * A schedule value as the end of a sentence: "every day at 9:00 AM Central time", "weekdays at 9:00
 * AM Pacific time", "every 15 minutes". An interval counts elapsed time, so it names no zone. The
 * words are the builder's own, read from `describeScheduleFields`. `zone: false` leaves the zone
 * off a time of day, for a schedule that is only mentioned.
 */
export function cadenceSentence(value: ScheduleValue, options: { zone?: boolean } = {}): string {
  const rows = describeScheduleFields(value);
  const field = (label: string): string => rows.find((row) => row.label === label)?.value ?? '';
  const repeats = field('Repeats');
  const at = field('At');
  const zone = options.zone === false ? '' : field('Time zone');
  let words: string;
  switch (repeats) {
    case 'Custom days':
      words = `on ${field('Days')}`;
      break;
    case 'Monthly on a day':
      words = `monthly on day ${field('Day of month')}`;
      break;
    case 'Every few minutes or hours': {
      const every = field('Every');
      return `every ${every.startsWith('1 ') ? every.slice(2) : every}`;
    }
    case 'Custom cron':
      return zone === ''
        ? `on cron ${field('Cron expression')}`
        : `on cron ${field('Cron expression')} in ${zone}`;
    default:
      // Only the first letter is lowered, so a weekday keeps its capital: "every Friday".
      words = `${repeats.charAt(0).toLowerCase()}${repeats.slice(1)}`;
  }
  const clock = at === '' ? words : `${words} at ${at}`;
  return zone === '' ? clock : `${clock} ${zone}`;
}

/** Where the input is held: the drawn form, or the JSON editor and whether its text parses. */
export type InputState =
  | { readonly mode: 'form'; readonly value: unknown }
  | { readonly mode: 'json'; readonly valid: boolean };

/** The one line the footer shows: what the primary action does with the choices made so far. */
export function summaryOf(choice: {
  readonly name: string;
  readonly when: 'now' | 'schedule';
  readonly cadence: ScheduleValue;
  readonly schema: unknown;
  readonly input: InputState;
  /** The cap on runs at once when as many are going, so a run started now waits for one to finish. */
  readonly queuedBehind?: number | undefined;
}): string {
  const copy = WORKFLOW_COPY.runSetup;
  const { input } = choice;
  if (input.mode === 'json' && !input.valid) return copy.summaryJsonInvalid;
  const words = input.mode === 'form' ? inputWordsOf(choice.schema, input.value) : undefined;
  if (choice.when === 'now') {
    if (input.mode === 'json') return copy.summaryJson;
    const said =
      words === undefined ? '' : `, ${[words.on, words.since].filter(Boolean).join(' ')}`;
    return choice.queuedBehind === undefined
      ? copy.summaryNow(said)
      : copy.summaryQueued(choice.queuedBehind, said);
  }
  const cadence = cadenceSentence(choice.cadence);
  if (input.mode === 'json') return copy.summaryScheduleJson(choice.name, cadence);
  return copy.summarySchedule(
    choice.name,
    words === undefined ? '' : ` ${[words.on, words.since].filter(Boolean).join(', ')}`,
    cadence,
  );
}
