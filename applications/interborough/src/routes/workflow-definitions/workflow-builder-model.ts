/**
 * The step builder's model: a workflow file's JSON text, read as the fields the builder shows and
 * edited by returning new text. The text is the only state. The JSON tab edits it directly, and
 * every builder edit parses it, changes one thing, and writes it back, so the two views cannot
 * disagree, and a key the builder has no control for (`paused`, a schedule's `timezone`, a step's
 * other fields) survives an edit.
 *
 * It writes only what the workflow file format accepts (`packages/bureau/src/workflow-file.ts`,
 * COR-2009): a workflow `title` and a step `title`, which are removed rather than written blank; a
 * `manual` trigger, written as `{ "kind": "manual" }` and nothing else; `review: true` on the
 * `await-signal` step a person decides, never `false`; and `inputSchema` and `outputSchema`, which
 * are JSON objects. An edit that leaves the document as it was returns the text it was given, byte
 * for byte, so reading a hand-formatted file and writing every field back keeps its spacing.
 */
import { WORKFLOW_COPY } from '../../app/copy.ts';
import { readBackOf, type ReadBackOptions } from './workflow-builder-read-back.ts';
import { stepLabel, triggerLabel } from './workflow-presentation.ts';

/**
 * The kinds of step the builder adds: an agent step, a wait for a person (an `await-signal` with
 * `review: true`, which shows in Reviews), a wait for an outside signal, and a wait (`sleep`).
 */
export type BuilderStepKind = 'agent' | 'person' | 'signal' | 'wait';

/** The kinds of trigger the builder sets: started by hand (`manual`), on a schedule, or by a signal. */
export type BuilderTriggerKind = 'manual' | 'schedule' | 'signal';

/** The units a wait's "For" is counted in, each written as its Weft duration letter. */
export type WaitUnit = 'seconds' | 'minutes' | 'hours' | 'days';

/** The units a wait offers, shortest first. */
export const WAIT_UNITS: readonly WaitUnit[] = ['seconds', 'minutes', 'hours', 'days'];

/** A wait's duration as a number and a unit, which the builder edits as "For" and "Unit". */
export interface WaitParts {
  /** The number, as typed: digits, or `''` while it is empty. */
  readonly amount: string;
  readonly unit: WaitUnit;
}

/**
 * One step as the builder shows it: its kind, the fields of that kind, and its `title` (`''` when
 * it has none). `other` is a step the builder only moves and removes.
 */
export type BuilderStep = (
  | { readonly kind: 'agent'; readonly agent: string; readonly message: string }
  /** An `await-signal` with `review: true`. Its signal is generated when it is added, and kept. */
  | { readonly kind: 'person'; readonly signal: string }
  | { readonly kind: 'signal'; readonly signal: string }
  /**
   * A `sleep`. `parts` is its duration as a number and a unit, or `null` for a duration those
   * cannot say (a bare number of milliseconds, a fraction), which is edited as written.
   */
  | { readonly kind: 'wait'; readonly duration: string; readonly parts: WaitParts | null }
  | { readonly kind: 'other'; readonly label: string }
) & { readonly title: string };

/** The trigger as the builder shows it: its kind, and the field of that kind. */
export type BuilderTrigger =
  | { readonly kind: 'manual' }
  | { readonly kind: 'schedule'; readonly spec: string }
  | { readonly kind: 'signal'; readonly name: string }
  /** A trigger kind a plugin contributes (`plugin:name`), with the rest of the trigger as its configuration. */
  | {
      readonly kind: 'contributed';
      readonly id: string;
      readonly configuration: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'other'; readonly label: string };

/** Which of the two schemas: what a run starts with, or what it finishes with. */
export type SchemaKey = 'inputSchema' | 'outputSchema';

/**
 * A schema as the builder shows it: absent, a JSON object it can edit, or a value the format
 * refuses (not an object), which an edit would replace and so is left to the JSON tab.
 */
export type BuilderSchema =
  | { readonly kind: 'none' }
  | { readonly kind: 'schema'; readonly schema: Readonly<Record<string, unknown>> }
  | { readonly kind: 'unreadable' };

/** What the builder shows for a text that is a JSON object. */
export interface BuilderView {
  /** The file's `name`, the workflow's identifier, or `''`. */
  readonly name: string;
  /** The file's `title`, the name a person reads, or `''` when it has none. */
  readonly title: string;
  readonly description: string;
  readonly trigger: BuilderTrigger | null;
  readonly steps: readonly BuilderStep[];
  /**
   * Whether `steps` is a list the builder can add to: absent or an array. Anything else is a file
   * the Bureau refuses, and an edit here would replace it, so the builder leaves it to the JSON tab.
   */
  readonly stepsEditable: boolean;
  readonly inputSchema: BuilderSchema;
  readonly outputSchema: BuilderSchema;
  /** The whole workflow in one plain-words sentence: what starts it, then each step. */
  readonly readBack: string;
}

type Json = Record<string, unknown>;

/**
 * The order the format writes a file's keys in (`serializeWorkflowFile`). A key the builder adds
 * goes before the first key that follows it here, so a new `title` sits after `name`.
 */
const KEY_ORDER = [
  'name',
  'title',
  'description',
  'agent',
  'paused',
  'trigger',
  'inputSchema',
  'outputSchema',
  'steps',
] as const;

/** The longest workflow identifier the Bureau accepts. */
const IDENTIFIER_MAXIMUM_LENGTH = 64;

/** Weft's duration letter for each wait unit. */
const UNIT_LETTERS: Readonly<Record<WaitUnit, string>> = {
  seconds: 's',
  minutes: 'm',
  hours: 'h',
  days: 'd',
};

/**
 * A whole number of a unit, as Weft's `parseDuration` reads it: `15m`, `2 hours`, `1 day`. The
 * number may be missing, as in `h`: that is what "For" and "Unit" write while "For" is empty, so the
 * chosen unit is kept.
 */
const WAIT_PATTERN = /^(\d*)\s*(s|seconds?|m|minutes?|h|hours?|d|days?)$/i;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** The text as an object, or `undefined` when it is not JSON or not an object. */
function parseObject(text: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function toText(document: Json): string {
  return JSON.stringify(document, null, 2);
}

/**
 * `text` after `change` edits its object. `change` returns the edited document, or `undefined` to
 * leave the text alone. Text that is not a JSON object is returned as it is, and so is text whose
 * document the edit left unchanged: a field set to the value it holds keeps the file byte for byte.
 */
function edit(text: string, change: (document: Json) => Json | undefined): string {
  const document = parseObject(text);
  if (document === undefined) return text;
  const before = JSON.stringify(document);
  const next = change(document);
  if (next === undefined) return text;
  return JSON.stringify(next) === before ? text : toText(next);
}

/**
 * `document` with `key` set to `value`: in place when the key is there, and otherwise before the
 * first key that follows it in {@link KEY_ORDER}, or last. No other key moves.
 */
function withKey(document: Json, key: (typeof KEY_ORDER)[number], value: unknown): Json {
  if (Object.hasOwn(document, key)) return { ...document, [key]: value };
  const later = KEY_ORDER.slice(KEY_ORDER.indexOf(key) + 1);
  const result: Json = {};
  let placed = false;
  for (const [existing, existingValue] of Object.entries(document)) {
    if (!placed && (later as readonly string[]).includes(existing)) {
      result[key] = value;
      placed = true;
    }
    result[existing] = existingValue;
  }
  if (!placed) result[key] = value;
  return result;
}

/** `document` without `key`. */
function withoutKey(document: Json, key: string): Json {
  const { [key]: _removed, ...rest } = document;
  return rest;
}

/** Whether an agent step's `input` is absent or an object, the only shapes the builder can edit in place. */
function hasObjectInput(step: Json): boolean {
  return step['input'] === undefined || isRecord(step['input']);
}

/**
 * A wait's duration as a number and a unit, or `null` when it is not a whole number of one unit.
 * A unit with no number (`h`) is an empty "For" of that unit; an empty duration is one of minutes.
 */
export function waitPartsOf(duration: string): WaitParts | null {
  if (duration.trim() === '') return { amount: '', unit: 'minutes' };
  const match = WAIT_PATTERN.exec(duration.trim());
  if (match === null) return null;
  const letter = (match[2] ?? 'm').charAt(0).toLowerCase();
  const unit = WAIT_UNITS.find((candidate) => UNIT_LETTERS[candidate] === letter) ?? 'minutes';
  return { amount: match[1] ?? '', unit };
}

/**
 * The duration a wait's "For" and "Unit" write: `15m`, or the unit's letter alone (`h`) while "For"
 * is empty, so clearing "For" to type a new number, or choosing a unit before it, keeps the unit.
 */
export function waitDurationOf(amount: string, unit: WaitUnit): string {
  return `${amount.trim()}${UNIT_LETTERS[unit]}`;
}

function stepOf(step: unknown): BuilderStep {
  if (!isRecord(step))
    return { kind: 'other', label: WORKFLOW_COPY.builder.notAnObject, title: '' };
  const kind = asText(step['kind']);
  const title = asText(step['title']);
  if (kind === 'activity' && step['handler'] === 'agent') {
    // An `input` that is not an object (a string, say) has no agent or message to show, and an
    // edit would replace it, so the step is left to the JSON tab like any other it cannot read.
    if (!hasObjectInput(step)) return { kind: 'other', label: stepLabel({ ...step, kind }), title };
    const input = isRecord(step['input']) ? step['input'] : {};
    return {
      kind: 'agent',
      agent: asText(input['agent']),
      message: asText(input['message']),
      title,
    };
  }
  if (kind === 'sleep') {
    // A bare number is milliseconds, which "For" and "Unit" cannot say; it is edited as written.
    const duration = asText(step['duration']);
    const parts = typeof step['duration'] === 'number' ? null : waitPartsOf(duration);
    return { kind: 'wait', duration, parts, title };
  }
  if (kind === 'await-signal') {
    const signal = asText(step['signal']);
    return step['review'] === true
      ? { kind: 'person', signal, title }
      : { kind: 'signal', signal, title };
  }
  return { kind: 'other', label: stepLabel({ ...step, kind }), title };
}

/** Whether a trigger's `kind` is a plugin's: `plugin:name`, each part a lowercase identifier. */
export function isContributedTriggerId(kind: string): boolean {
  return /^[a-z](?:[a-z0-9-]*[a-z0-9])?:[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(kind);
}

function triggerOf(trigger: unknown): BuilderTrigger | null {
  if (trigger === undefined) return null;
  // A trigger that is not an object is a file the Bureau refuses; an edit would replace it.
  if (!isRecord(trigger)) return { kind: 'other', label: WORKFLOW_COPY.builder.notAnObject };
  const kind = asText(trigger['kind']);
  if (kind === 'manual') return { kind };
  if (kind === 'schedule') return { kind, spec: asText(trigger['spec']) };
  if (kind === 'signal') return { kind, name: asText(trigger['name']) };
  if (isContributedTriggerId(kind)) {
    const { kind: _kind, ...configuration } = trigger;
    return { kind: 'contributed', id: kind, configuration };
  }
  return { kind: 'other', label: triggerLabel({ ...trigger, kind }) };
}

function schemaOf(document: Json, key: SchemaKey): BuilderSchema {
  if (!Object.hasOwn(document, key)) return { kind: 'none' };
  const schema = document[key];
  return isRecord(schema) ? { kind: 'schema', schema } : { kind: 'unreadable' };
}

/**
 * The builder's view of `text`, or `undefined` when the text is not a JSON object the builder can
 * read. `options` names the agents and pins the clock its read-back sentence uses.
 */
export function readBuilder(text: string, options: ReadBackOptions = {}): BuilderView | undefined {
  const document = parseObject(text);
  if (document === undefined) return undefined;
  const steps: unknown = document['steps'];
  const trigger = triggerOf(document['trigger']);
  const rows = Array.isArray(steps) ? steps.map(stepOf) : [];
  return {
    name: asText(document['name']),
    title: asText(document['title']),
    description: asText(document['description']),
    trigger,
    steps: rows,
    stepsEditable: steps === undefined || Array.isArray(steps),
    inputSchema: schemaOf(document, 'inputSchema'),
    outputSchema: schemaOf(document, 'outputSchema'),
    readBack: readBackOf(document['trigger'], trigger, rows, options),
  };
}

function stepsOf(document: Json): unknown[] {
  return Array.isArray(document['steps']) ? [...(document['steps'] as unknown[])] : [];
}

/**
 * The identifier a title makes: lowercase letters, digits and single dashes, starting with a
 * letter, at most 64 characters, so capitals, accents and punctuation never make it fail.
 * "Morning Briefing" makes `morning-briefing`. A title with no letter in it makes `''`.
 */
export function identifierFromTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, IDENTIFIER_MAXIMUM_LENGTH)
    .replace(/-+$/, '');
}

/** `text` with `name` set to `value`, where the file has it, or first when it has none. */
export function setName(text: string, value: string): string {
  return edit(text, (document) =>
    Object.hasOwn(document, 'name') ? { ...document, name: value } : { name: value, ...document },
  );
}

/**
 * `text` with `title` set to `value`, or removed when it is blank: the format refuses an empty
 * title. It never changes `name`, so an existing workflow's identifier stays what it is.
 */
export function setTitle(text: string, value: string): string {
  return edit(text, (document) =>
    value.trim() === '' ? withoutKey(document, 'title') : withKey(document, 'title', value),
  );
}

/**
 * For a new workflow: `text` with `title` set to `value` and, while the identifier still follows
 * the title, `name` set to the identifier the new title makes. It follows while `name` is empty or
 * is the identifier the previous title made, so an identifier typed in the ID field or the JSON tab
 * is kept. A following identifier is emptied when the title is cleared or makes none, so a title
 * typed again makes it afresh instead of leaving a stale one.
 */
export function setTitleDerivingName(text: string, value: string): string {
  const document = parseObject(text);
  if (document === undefined) return text;
  const name = asText(document['name']);
  const follows = name === '' || name === identifierFromTitle(asText(document['title']));
  const titled = setTitle(text, value);
  return follows ? setName(titled, identifierFromTitle(value)) : titled;
}

/** `text` with `description` set to `value`, or removed when it is empty. */
export function setDescription(text: string, value: string): string {
  return edit(text, (document) =>
    value === '' ? withoutKey(document, 'description') : withKey(document, 'description', value),
  );
}

/**
 * `text` with its trigger of the given kind. Changing the kind replaces the trigger; changing the
 * field keeps the trigger's other keys (a schedule's `overlap` and `timezone`). A `manual` trigger
 * has no field and no other key.
 */
export function setTrigger(text: string, kind: BuilderTriggerKind, value = ''): string {
  return edit(text, (document) => {
    if (document['trigger'] !== undefined && !isRecord(document['trigger'])) return undefined;
    const current = isRecord(document['trigger']) ? document['trigger'] : {};
    if (kind === 'manual') {
      return withKey(document, 'trigger', current['kind'] === 'manual' ? current : { kind });
    }
    const field = kind === 'schedule' ? 'spec' : 'name';
    return withKey(
      document,
      'trigger',
      current['kind'] === kind ? { ...current, [field]: value } : { kind, [field]: value },
    );
  });
}

/**
 * `text` with its trigger a contributed kind `id` (`plugin:name`) holding `configuration`, the
 * fields of the kind's schema. The trigger is replaced: a file's trigger is the kind and its
 * configuration, nothing else.
 */
export function setContributedTrigger(
  text: string,
  id: string,
  configuration: Readonly<Record<string, unknown>>,
): string {
  return edit(text, (document) => {
    if (document['trigger'] !== undefined && !isRecord(document['trigger'])) return undefined;
    const { kind: _kind, ...fields } = configuration;
    return withKey(document, 'trigger', { kind: id, ...fields });
  });
}

/** Eight random hexadecimal digits, which make a new review signal unlike any other workflow's. */
function randomSuffix(): string {
  return globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 8);
}

/**
 * The signal a new "Wait for a person" step waits on: `review-` and eight random digits, so a
 * signal sent by name to every waiting instance can only resume this step, with `-2`, `-3` and so on
 * added in the unlikely case a step or the trigger of the file already uses it. It is written once,
 * when the step is added, and never derived again: changing a step's signal is a breaking change,
 * and renaming or moving the step must not be one.
 */
function reviewSignalFor(document: Json, steps: readonly unknown[], base: string): string {
  const taken = new Set<string>();
  for (const step of steps) {
    if (isRecord(step) && typeof step['signal'] === 'string') taken.add(step['signal']);
  }
  const trigger = document['trigger'];
  if (isRecord(trigger) && typeof trigger['name'] === 'string') taken.add(trigger['name']);
  let signal = base;
  for (let count = 2; taken.has(signal); count += 1) signal = `${base}-${String(count)}`;
  return signal;
}

/** What a new step starts with besides its kind. */
export interface AddStepOptions {
  /** The agent a new agent step names. Defaults to none (`''`), so nothing is chosen for the person. */
  readonly agent?: string;
  /** The signal a new "Wait for a person" step waits on. Defaults to `review-` and random digits. */
  readonly reviewSignal?: string;
}

/** `text` with a new step of `kind` at the end. */
export function addStep(text: string, kind: BuilderStepKind, options: AddStepOptions = {}): string {
  return edit(text, (document) => {
    // A `steps` that is not a list stays as it is: adding would replace it.
    if (document['steps'] !== undefined && !Array.isArray(document['steps'])) return undefined;
    const steps = stepsOf(document);
    if (kind === 'agent') {
      steps.push({
        kind: 'activity',
        handler: 'agent',
        input: { agent: options.agent ?? '', message: '' },
      });
    } else if (kind === 'person') {
      const base = options.reviewSignal ?? `review-${randomSuffix()}`;
      steps.push({
        kind: 'await-signal',
        signal: reviewSignalFor(document, steps, base),
        review: true,
      });
    } else if (kind === 'signal') {
      steps.push({ kind: 'await-signal', signal: '' });
    } else {
      steps.push({ kind: 'sleep', duration: '1m' });
    }
    return withKey(document, 'steps', steps);
  });
}

/** `text` without the step at `index`. */
export function removeStep(text: string, index: number): string {
  return edit(text, (document) => {
    if (document['steps'] !== undefined && !Array.isArray(document['steps'])) return undefined;
    const steps = stepsOf(document);
    if (index < 0 || index >= steps.length) return undefined;
    steps.splice(index, 1);
    return withKey(document, 'steps', steps);
  });
}

/** `text` with the step at `index` moved by `offset` places (−1 earlier, 1 later), within the list. */
export function moveStep(text: string, index: number, offset: -1 | 1): string {
  return edit(text, (document) => {
    if (document['steps'] !== undefined && !Array.isArray(document['steps'])) return undefined;
    const steps = stepsOf(document);
    const target = index + offset;
    if (index < 0 || index >= steps.length || target < 0 || target >= steps.length) {
      return undefined;
    }
    const [moved] = steps.splice(index, 1);
    steps.splice(target, 0, moved);
    return withKey(document, 'steps', steps);
  });
}

/**
 * `text` with the step at `index` named `value`, its `title`, or without one when it is blank. A
 * new title leads the step, as the format's files write it.
 */
export function setStepTitle(text: string, index: number, value: string): string {
  return edit(text, (document) => {
    const steps = stepsOf(document);
    const step = steps[index];
    if (!isRecord(step)) return undefined;
    if (value.trim() === '') steps[index] = withoutKey(step, 'title');
    else
      steps[index] = Object.hasOwn(step, 'title')
        ? { ...step, title: value }
        : { title: value, ...step };
    return withKey(document, 'steps', steps);
  });
}

/** The fields of a step the builder edits. */
export type StepField = 'agent' | 'message' | 'duration' | 'signal';

/** `text` with one field of the step at `index` set; a field the step's kind does not have changes nothing. */
export function setStepField(text: string, index: number, field: StepField, value: string): string {
  return edit(text, (document) => {
    const steps = stepsOf(document);
    const step = steps[index];
    if (!isRecord(step)) return undefined;
    if (field === 'agent' || field === 'message') {
      if (step['kind'] !== 'activity' || step['handler'] !== 'agent' || !hasObjectInput(step)) {
        return undefined;
      }
      const input = isRecord(step['input']) ? step['input'] : {};
      steps[index] = { ...step, input: { ...input, [field]: value } };
    } else if (field === 'duration') {
      if (step['kind'] !== 'sleep') return undefined;
      // A bare number is milliseconds, as the file may already write it; the builder says so.
      steps[index] = { ...step, duration: /^\d+$/.test(value) ? Number(value) : value };
    } else {
      if (step['kind'] !== 'await-signal') return undefined;
      steps[index] = { ...step, signal: value };
    }
    return withKey(document, 'steps', steps);
  });
}

/** `text` with the wait at `index` lasting `amount` of `unit`, as "For" and "Unit" set it. */
export function setWaitDuration(
  text: string,
  index: number,
  amount: string,
  unit: WaitUnit,
): string {
  return setStepField(text, index, 'duration', waitDurationOf(amount, unit));
}

/**
 * `text` with `inputSchema` or `outputSchema` set to `schema`, or removed for `undefined`. A value
 * there that is not an object is a file the Bureau refuses, and is left to the JSON tab.
 */
export function setSchema(
  text: string,
  key: SchemaKey,
  schema: Readonly<Record<string, unknown>> | undefined,
): string {
  return edit(text, (document) => {
    if (Object.hasOwn(document, key) && !isRecord(document[key])) return undefined;
    return schema === undefined ? withoutKey(document, key) : withKey(document, key, schema);
  });
}
