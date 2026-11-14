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
import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
import { readBackOf, type ReadBackOptions } from './workflow-builder-read-back.ts';
import { stepLabel, triggerLabel } from './workflow-presentation.ts';

/**
 * The kinds of step the builder adds: an agent step, a wait for a person (an `await-signal` with
 * `review: true`, which shows in Reviews), a wait for an outside signal, a wait (`sleep`), a call of
 * a plugin's activity (`activity`) or of its code workflow (`workflow`), and the three control-flow
 * kinds: `branch` (choose a path by a value), `parallel` (run lists of steps side by side) and `map`
 * (repeat steps for each item).
 */
export type BuilderStepKind =
  'agent' | 'person' | 'signal' | 'wait' | 'activity' | 'workflow' | 'branch' | 'parallel' | 'map';

/**
 * Where a step is: the keys and indices from the document down to it, such as
 * `['steps', 2, 'cases', 'approved', 0]` (the first step of the `approved` case of the third step).
 * A number is a top-level step, so `2` is `['steps', 2]`.
 */
export type StepPath = number | readonly (string | number)[];

/** Where a list of steps is: {@link ROOT_LIST}, or a case, `otherwise`, branch or map body of a step. */
export type ListPath = readonly (string | number)[];

/** The workflow's own steps. */
export const ROOT_LIST: ListPath = ['steps'];

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

/** A duration as the file writes it, and as a number and a unit when those can say it. */
export interface DurationView {
  /** The duration as written: `15m`, `2 hours`, or a bare number of milliseconds as text. */
  readonly duration: string;
  /** The duration as a number and a unit, or `null` for one those cannot say (a bare number, a fraction). */
  readonly parts: WaitParts | null;
}

/** One case of a `branch`: the value it matches, and the steps it runs. */
export interface BuilderCase {
  readonly value: string;
  readonly steps: readonly BuilderStep[];
}

/** One list of a `parallel` step: its name, and the steps it runs. */
export interface BuilderBranch {
  readonly name: string;
  readonly steps: readonly BuilderStep[];
}

/**
 * One step as the builder shows it: its kind, the fields of that kind, and its `title` (`''` when
 * it has none). `other` is a step the builder only moves and removes.
 */
export type BuilderStep = (
  | { readonly kind: 'agent'; readonly agent: string; readonly message: string }
  /**
   * An `await-signal` with `review: true`. Its signal is generated when it is added, and kept.
   * `timeout` is how long it waits before the run goes on without it, or `null` for no limit.
   */
  | {
      readonly kind: 'person';
      readonly signal: string;
      readonly timeout: DurationView | null;
    }
  | {
      readonly kind: 'signal';
      readonly signal: string;
      readonly timeout: DurationView | null;
    }
  /**
   * A `sleep`. `parts` is its duration as a number and a unit, or `null` for a duration those
   * cannot say (a bare number of milliseconds, a fraction), which is edited as written.
   */
  | { readonly kind: 'wait'; readonly duration: string; readonly parts: WaitParts | null }
  /**
   * A call of an activity other than `agent`. `input` is its object (`{}` when it has none), or
   * `null` for an `input` that is not an object, which the builder leaves to the JSON tab.
   */
  | {
      readonly kind: 'activity';
      readonly handler: string;
      readonly input: Readonly<Record<string, unknown>> | null;
    }
  /** A plugin's code workflow started as a child; `workflow` is its `plugin:name`. */
  | {
      readonly kind: 'workflow';
      readonly workflow: string;
      readonly input: Readonly<Record<string, unknown>> | null;
    }
  /** Chooses a path by the value of `on`, a property of the previous step's result. */
  | {
      readonly kind: 'branch';
      readonly on: string;
      readonly cases: readonly BuilderCase[];
      /** The steps that run when no case matches, or `null` when there is no such path. */
      readonly otherwise: readonly BuilderStep[] | null;
    }
  | { readonly kind: 'parallel'; readonly branches: readonly BuilderBranch[] }
  /**
   * Runs `steps` for each item of `over`, a property of the previous step's result. `concurrency` is
   * how many run at once, as text, or `''` for the engine's default.
   */
  | {
      readonly kind: 'map';
      readonly over: string;
      readonly concurrency: string;
      readonly steps: readonly BuilderStep[];
    }
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

/** A duration key as the builder shows it, or `undefined` for a value that is neither text nor a number. */
function durationOf(value: unknown): DurationView | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const duration = asText(value);
  // A bare number is milliseconds, which "For" and "Unit" cannot say; it is edited as written.
  return { duration, parts: typeof value === 'number' ? null : waitPartsOf(duration) };
}

/** A list of steps as the builder shows it, or `undefined` when the value is not a list. */
function stepListOf(value: unknown): BuilderStep[] | undefined {
  return Array.isArray(value) ? value.map(stepOf) : undefined;
}

/**
 * The named lists of a `branch`'s `cases` or a `parallel`'s `branches`, in the file's order, or
 * `undefined` when the value is not an object of lists.
 */
function namedListsOf(value: unknown): { name: string; steps: BuilderStep[] }[] | undefined {
  if (!isRecord(value)) return undefined;
  const lists: { name: string; steps: BuilderStep[] }[] = [];
  for (const [name, list] of Object.entries(value)) {
    const steps = stepListOf(list);
    if (steps === undefined) return undefined;
    lists.push({ name, steps });
  }
  return lists;
}

function stepOf(step: unknown): BuilderStep {
  if (!isRecord(step))
    return { kind: 'other', label: WORKFLOW_COPY.builder.notAnObject, title: '' };
  const kind = asText(step['kind']);
  const title = asText(step['title']);
  const other = (): BuilderStep => ({ kind: 'other', label: stepLabel({ ...step, kind }), title });
  if (kind === 'activity') {
    const handler = step['handler'];
    // An `input` that is not an object (a string, say) has no agent or message to show, and an
    // edit would replace it, so the step is left to the JSON tab like any other it cannot read.
    if (handler === 'agent') {
      if (!hasObjectInput(step)) return other();
      const input = isRecord(step['input']) ? step['input'] : {};
      return {
        kind: 'agent',
        agent: asText(input['agent']),
        message: asText(input['message']),
        title,
      };
    }
    if (typeof handler !== 'string' || handler === '') return other();
    return {
      kind: 'activity',
      handler,
      input: hasObjectInput(step) ? (isRecord(step['input']) ? step['input'] : {}) : null,
      title,
    };
  }
  if (kind === 'workflow') {
    if (typeof step['workflow'] !== 'string') return other();
    return {
      kind: 'workflow',
      workflow: step['workflow'],
      input: hasObjectInput(step) ? (isRecord(step['input']) ? step['input'] : {}) : null,
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
    const timeout = Object.hasOwn(step, 'timeout') ? durationOf(step['timeout']) : null;
    // A `timeout` that is neither text nor a number is a file the Bureau refuses; an edit would replace it.
    if (timeout === undefined) return other();
    return step['review'] === true
      ? { kind: 'person', signal, timeout, title }
      : { kind: 'signal', signal, timeout, title };
  }
  if (kind === 'branch') {
    const cases = namedListsOf(step['cases']);
    const otherwise = Object.hasOwn(step, 'otherwise') ? stepListOf(step['otherwise']) : null;
    if (cases === undefined || otherwise === undefined) return other();
    return {
      kind: 'branch',
      on: asText(step['on']),
      cases: cases.map((entry) => ({ value: entry.name, steps: entry.steps })),
      otherwise,
      title,
    };
  }
  if (kind === 'parallel') {
    const branches = namedListsOf(step['branches']);
    if (branches === undefined) return other();
    return { kind: 'parallel', branches, title };
  }
  if (kind === 'map') {
    const steps = stepListOf(step['steps']);
    if (steps === undefined) return other();
    return {
      kind: 'map',
      over: asText(step['over']),
      concurrency: asText(step['concurrency']),
      steps,
      title,
    };
  }
  return other();
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

/** Calls `visit` for each step of `steps` and, inside it, each step it holds, depth first. */
export function forEachStep(
  steps: readonly BuilderStep[],
  visit: (step: BuilderStep) => void,
): void {
  for (const step of steps) {
    visit(step);
    if (step.kind === 'branch') {
      for (const entry of step.cases) forEachStep(entry.steps, visit);
      if (step.otherwise !== null) forEachStep(step.otherwise, visit);
    } else if (step.kind === 'parallel') {
      for (const entry of step.branches) forEachStep(entry.steps, visit);
    } else if (step.kind === 'map') {
      forEachStep(step.steps, visit);
    }
  }
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

/** The steps a step holds, in every one of its lists: cases, `otherwise`, branches, and a map's body. */
function childLists(step: Json): unknown[][] {
  const lists: unknown[][] = [];
  for (const key of ['cases', 'branches'] as const) {
    const named = step[key];
    if (isRecord(named)) {
      for (const list of Object.values(named)) if (Array.isArray(list)) lists.push(list);
    }
  }
  for (const key of ['otherwise', 'steps'] as const) {
    if (Array.isArray(step[key])) lists.push(step[key]);
  }
  return lists;
}

/** Adds the signal of every step in `steps`, at any depth, to `taken`. */
function collectSignals(steps: readonly unknown[], taken: Set<string>): void {
  for (const step of steps) {
    if (!isRecord(step)) continue;
    if (typeof step['signal'] === 'string') taken.add(step['signal']);
    for (const list of childLists(step)) collectSignals(list, taken);
  }
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
  collectSignals(steps, taken);
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
  /** The list the step goes at the end of. Defaults to the workflow's own steps ({@link ROOT_LIST}). */
  readonly into?: ListPath;
  /** The activity a new `activity` step calls: its `id` in the Bureau's catalog. */
  readonly handler?: string;
  /** The code workflow a new `workflow` step starts: its `plugin:name`. */
  readonly workflow?: string;
  /**
   * What a new `activity` or `workflow` step starts with as its `input`: the draft its form shows,
   * so a field with a default is written when the step is added, and opening the file later is not
   * an edit. Left out, the step has no `input`.
   */
  readonly input?: Readonly<Record<string, unknown>>;
}

/** The first of `base-1`, `base-2` and so on that `taken` does not hold. */
function freshName(taken: Readonly<Record<string, unknown>>, base: string): string {
  let count = 1;
  while (Object.hasOwn(taken, `${base}-${String(count)}`)) count += 1;
  return `${base}-${String(count)}`;
}

/** The step a new `kind` starts as. `document` finds a review signal no other step uses. */
function newStep(kind: BuilderStepKind, options: AddStepOptions, document: Json): Json {
  switch (kind) {
    case 'agent':
      return {
        kind: 'activity',
        handler: 'agent',
        input: { agent: options.agent ?? '', message: '' },
      };
    case 'person': {
      // A signal is unique across the whole file, nested steps included.
      const base = options.reviewSignal ?? `review-${randomSuffix()}`;
      return {
        kind: 'await-signal',
        signal: reviewSignalFor(document, allSteps(document), base),
        review: true,
      };
    }
    case 'signal':
      return { kind: 'await-signal', signal: '' };
    case 'wait':
      return { kind: 'sleep', duration: '1m' };
    case 'activity':
      return {
        kind: 'activity',
        handler: options.handler ?? '',
        ...(options.input === undefined ? {} : { input: options.input }),
      };
    case 'workflow':
      return {
        kind: 'workflow',
        workflow: options.workflow ?? '',
        ...(options.input === undefined ? {} : { input: options.input }),
      };
    // A branch, a parallel and a map start with the one list the engine needs, empty: the page says
    // to add a step to it, rather than saving a file the Bureau refuses.
    case 'branch':
      return { kind: 'branch', on: '', cases: { 'value-1': [] } };
    case 'parallel':
      return { kind: 'parallel', branches: { 'branch-1': [] } };
    case 'map':
      return { kind: 'map', over: '', steps: [] };
  }
}

/** The workflow's own steps, which hold every other step: a review signal is unique across them all. */
function allSteps(document: Json): readonly unknown[] {
  return Array.isArray(document['steps']) ? (document['steps'] as unknown[]) : [];
}

/**
 * `document` after `change` edits the list at `listPath` (a copy of the workflow's own steps, or the
 * nested list in place), or `undefined` when there is no such list or `change` returns `false`.
 * Absent `steps` is an empty workflow's list; any other value is a file the builder leaves alone.
 */
function withList(
  document: Json,
  listPath: ListPath,
  change: (list: unknown[]) => boolean | void,
): Json | undefined {
  if (listPath.length === 1 && listPath[0] === 'steps') {
    if (document['steps'] !== undefined && !Array.isArray(document['steps'])) return undefined;
    const steps = stepsOf(document);
    if (change(steps) === false) return undefined;
    return withKey(document, 'steps', steps);
  }
  const list = walk(document, listPath);
  if (!Array.isArray(list)) return undefined;
  if (change(list) === false) return undefined;
  return document;
}

/** The value `path` leads to from `root`, or `undefined`. Only own keys are followed. */
function walk(root: unknown, path: ListPath): unknown {
  let current = root;
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment < 0 || segment >= current.length) return undefined;
      current = current[segment];
    } else {
      if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
      current = current[segment];
    }
  }
  return current;
}

/** A step's path as keys and indices. */
function pathOf(path: StepPath): ListPath {
  return typeof path === 'number' ? ['steps', path] : path;
}

/** `document` after `change` edits the step at `path` in its list, or `undefined` when there is no such step. */
function withStep(
  document: Json,
  path: StepPath,
  change: (step: Json, list: unknown[], index: number) => boolean | void,
): Json | undefined {
  const full = pathOf(path);
  const index = full.at(-1);
  if (typeof index !== 'number') return undefined;
  return withList(document, full.slice(0, -1), (list) => {
    const step = list[index];
    if (!isRecord(step)) return false;
    return change(step, list, index);
  });
}

/** `text` with a new step of `kind` at the end of `options.into`, or of the workflow's own steps. */
export function addStep(text: string, kind: BuilderStepKind, options: AddStepOptions = {}): string {
  return edit(text, (document) =>
    withList(document, options.into ?? ROOT_LIST, (list) => {
      list.push(newStep(kind, options, document));
    }),
  );
}

/** `text` without the step at `path`. */
export function removeStep(text: string, path: StepPath): string {
  return edit(text, (document) =>
    withStep(document, path, (_step, list, index) => {
      list.splice(index, 1);
    }),
  );
}

/** `text` with the step at `path` moved by `offset` places (−1 earlier, 1 later), within its list. */
export function moveStep(text: string, path: StepPath, offset: -1 | 1): string {
  return edit(text, (document) =>
    withStep(document, path, (_step, list, index) => {
      const target = index + offset;
      if (target < 0 || target >= list.length) return false;
      const [moved] = list.splice(index, 1);
      list.splice(target, 0, moved);
      return true;
    }),
  );
}

/**
 * `text` with the step at `path` named `value`, its `title`, or without one when it is blank. A
 * new title leads the step, as the format's files write it.
 */
export function setStepTitle(text: string, path: StepPath, value: string): string {
  return replaceStep(text, path, (step) => {
    if (value.trim() === '') return withoutKey(step, 'title');
    return Object.hasOwn(step, 'title') ? { ...step, title: value } : { title: value, ...step };
  });
}

/** `text` with the step at `path` replaced by what `change` makes of it, or unchanged for `undefined`. */
function replaceStep(
  text: string,
  path: StepPath,
  change: (step: Json) => Json | undefined,
): string {
  return edit(text, (document) =>
    withStep(document, path, (step, list, index) => {
      const next = change(step);
      if (next === undefined) return false;
      list[index] = next;
      return true;
    }),
  );
}

/** The fields of a step the builder edits. */
export type StepField = 'agent' | 'message' | 'duration' | 'signal' | 'on' | 'over' | 'workflow';

/** `text` with one field of the step at `path` set; a field the step's kind does not have changes nothing. */
export function setStepField(
  text: string,
  path: StepPath,
  field: StepField,
  value: string,
): string {
  return replaceStep(text, path, (step) => {
    if (field === 'agent' || field === 'message') {
      if (step['kind'] !== 'activity' || step['handler'] !== 'agent' || !hasObjectInput(step)) {
        return undefined;
      }
      const input = isRecord(step['input']) ? step['input'] : {};
      return { ...step, input: { ...input, [field]: value } };
    }
    if (field === 'duration') {
      if (step['kind'] !== 'sleep') return undefined;
      // A bare number is milliseconds, as the file may already write it; the builder says so.
      return { ...step, duration: /^\d+$/.test(value) ? Number(value) : value };
    }
    if (field === 'signal') {
      return step['kind'] === 'await-signal' ? { ...step, signal: value } : undefined;
    }
    const kind = field === 'on' ? 'branch' : field === 'over' ? 'map' : 'workflow';
    return step['kind'] === kind ? { ...step, [field]: value } : undefined;
  });
}

/** `text` with the wait at `path` lasting `amount` of `unit`, as "For" and "Unit" set it. */
export function setWaitDuration(
  text: string,
  path: StepPath,
  amount: string,
  unit: WaitUnit,
): string {
  return setStepField(text, path, 'duration', waitDurationOf(amount, unit));
}

/**
 * `text` with the `await-signal` step at `path` giving up after `value` (`15m`, or a bare number of
 * milliseconds), or waiting without a limit for `null`, which removes the key: a step with no
 * timeout writes none. When the timeout expires the run goes on with `{ timedOut: true }`.
 */
export function setStepTimeout(text: string, path: StepPath, value: string | null): string {
  return replaceStep(text, path, (step) => {
    if (step['kind'] !== 'await-signal') return undefined;
    if (value === null || value.trim() === '') return withoutKey(step, 'timeout');
    return { ...step, timeout: /^\d+$/.test(value) ? Number(value) : value };
  });
}

/** `text` with the timeout of the wait at `path` `amount` of `unit`, or none while `amount` is empty. */
export function setTimeoutDuration(
  text: string,
  path: StepPath,
  amount: string,
  unit: WaitUnit,
): string {
  return setStepTimeout(text, path, amount.trim() === '' ? null : waitDurationOf(amount, unit));
}

/**
 * `text` with the `map` at `path` running at most `value` items at once, or the engine's default
 * for `null`, which removes the key. The engine takes a positive whole number, so anything else
 * is left out.
 */
export function setStepConcurrency(text: string, path: StepPath, value: number | null): string {
  return replaceStep(text, path, (step) => {
    if (step['kind'] !== 'map') return undefined;
    if (value === null || !Number.isInteger(value) || value < 1) {
      return withoutKey(step, 'concurrency');
    }
    return { ...step, concurrency: value };
  });
}

/**
 * The properties a JSON Schema names, or `undefined` when it names none (a schema that describes
 * free keys, or none at all), in which case a form reports every key there is.
 */
function declaredProperties(
  schema: Readonly<Record<string, unknown>> | null,
): string[] | undefined {
  const properties = schema?.['properties'];
  return isRecord(properties) && Object.keys(properties).length > 0
    ? Object.keys(properties)
    : undefined;
}

/**
 * `text` with the `input` of the `activity` or `workflow` step at `path` set to `draft`, the whole
 * object the step's form reports. A form reports the fields its `schema` names, so a key the schema
 * does not name (one the file wrote by hand, or one an older version of the activity took) is kept
 * as it is rather than dropped by an edit to another field; a field the form leaves out is removed.
 * A step whose `input` is not an object, which the builder cannot draw, is left alone, and so is an
 * `agent` step, whose `agent` and `message` have their own fields.
 */
export function setStepInput(
  text: string,
  path: StepPath,
  draft: Readonly<Record<string, unknown>>,
  schema: Readonly<Record<string, unknown>> | null = null,
): string {
  return replaceStep(text, path, (step) => {
    if (step['kind'] !== 'activity' && step['kind'] !== 'workflow') return undefined;
    if (step['kind'] === 'activity' && step['handler'] === 'agent') return undefined;
    if (!hasObjectInput(step)) return undefined;
    const declared = declaredProperties(schema);
    const existing = isRecord(step['input']) ? step['input'] : {};
    const kept =
      declared === undefined
        ? {}
        : Object.fromEntries(Object.entries(existing).filter(([key]) => !declared.includes(key)));
    return { ...step, input: { ...kept, ...draft } };
  });
}

/** The container a `branch`'s cases or a `parallel`'s branches live in. */
type SlotContainer = 'cases' | 'branches';

/** `text` after `change` edits the `cases` object of the `branch` or the `branches` of the `parallel` at `path`. */
function withSlots(
  text: string,
  path: StepPath,
  container: SlotContainer,
  change: (slots: Json) => Json | undefined,
): string {
  return replaceStep(text, path, (step) => {
    if (step['kind'] !== (container === 'cases' ? 'branch' : 'parallel')) return undefined;
    const slots = step[container];
    if (!isRecord(slots)) return undefined;
    const next = change(slots);
    return next === undefined ? undefined : { ...step, [container]: next };
  });
}

function addSlot(text: string, path: StepPath, container: SlotContainer): string {
  const base = container === 'cases' ? 'value' : 'branch';
  return withSlots(text, path, container, (slots) => ({ ...slots, [freshName(slots, base)]: [] }));
}

function removeSlot(text: string, path: StepPath, container: SlotContainer, name: string): string {
  // The engine refuses a step with none, which the page says at the step: it is a problem to fix,
  // not a removal to refuse.
  return withSlots(text, path, container, (slots) =>
    Object.hasOwn(slots, name) ? withoutKey(slots, name) : undefined,
  );
}

function renameSlot(
  text: string,
  path: StepPath,
  container: SlotContainer,
  name: string,
  next: string,
): string {
  return withSlots(text, path, container, (slots) => {
    // A name another one holds, or an empty one, would merge or lose a list: it is not written.
    if (!Object.hasOwn(slots, name) || next === '') return undefined;
    if (next !== name && Object.hasOwn(slots, next)) return undefined;
    return Object.fromEntries(
      Object.entries(slots).map(([key, list]) => [key === name ? next : key, list]),
    );
  });
}

/** `text` with one more case, empty, on the `branch` at `path`, named `value-1`, `value-2` and so on. */
export function addCase(text: string, path: StepPath): string {
  return addSlot(text, path, 'cases');
}

/** `text` without the case `value` of the `branch` at `path`, and the steps in it. */
export function removeCase(text: string, path: StepPath, value: string): string {
  return removeSlot(text, path, 'cases', value);
}

/** `text` with the case `value` of the `branch` at `path` matching `next` instead, in the same place. */
export function setCaseValue(text: string, path: StepPath, value: string, next: string): string {
  return renameSlot(text, path, 'cases', value, next);
}

/** `text` with one more list, empty, on the `parallel` at `path`, named `branch-1`, `branch-2` and so on. */
export function addBranch(text: string, path: StepPath): string {
  return addSlot(text, path, 'branches');
}

/** `text` without the list `name` of the `parallel` at `path`, and the steps in it. */
export function removeBranch(text: string, path: StepPath, name: string): string {
  return removeSlot(text, path, 'branches', name);
}

/** `text` with the list `name` of the `parallel` at `path` named `next` instead, in the same place. */
export function setBranchName(text: string, path: StepPath, name: string, next: string): string {
  return renameSlot(text, path, 'branches', name, next);
}

/** `text` with an empty `otherwise` on the `branch` at `path`, the steps that run when no case matches. */
export function addOtherwise(text: string, path: StepPath): string {
  return replaceStep(text, path, (step) =>
    step['kind'] === 'branch' && !Object.hasOwn(step, 'otherwise')
      ? { ...step, otherwise: [] }
      : undefined,
  );
}

/** `text` without the `otherwise` of the `branch` at `path`, and the steps in it. */
export function removeOtherwise(text: string, path: StepPath): string {
  return replaceStep(text, path, (step) =>
    step['kind'] === 'branch' && Object.hasOwn(step, 'otherwise')
      ? withoutKey(step, 'otherwise')
      : undefined,
  );
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
