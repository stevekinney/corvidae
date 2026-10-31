/**
 * The step builder's model: a workflow file's JSON text, read as the rows the builder shows and
 * edited by returning new text. The text is the only state. The JSON tab edits it directly, and
 * every builder edit parses it, changes one thing, and writes it back, so the two views cannot
 * disagree, and a key the builder has no control for (`inputSchema`, `paused`, a step's other
 * fields) survives an edit.
 */
import { WORKFLOW_COPY } from '../../app/copy.ts';
import { DEFAULT_AGENT } from '../../lib/default-agent.ts';
import { stepLabel, triggerLabel } from './workflow-presentation.ts';

/** The kinds of step the builder adds: an agent step, a wait (`sleep`), and a signal wait. */
export type BuilderStepKind = 'agent' | 'wait' | 'signal';

/** The kinds of trigger the builder sets. */
export type BuilderTriggerKind = 'schedule' | 'signal';

/** One step as a row: the builder's kind and its fields. `other` is a step the builder only moves and removes. */
export type BuilderStep =
  | { readonly kind: 'agent'; readonly agent: string; readonly message: string }
  | { readonly kind: 'wait'; readonly duration: string }
  | { readonly kind: 'signal'; readonly signal: string }
  | { readonly kind: 'other'; readonly label: string };

/** The trigger as the builder shows it: its kind, and the field of that kind. */
export type BuilderTrigger =
  | { readonly kind: 'schedule'; readonly spec: string }
  | { readonly kind: 'signal'; readonly name: string }
  | { readonly kind: 'other'; readonly label: string };

/** What the builder shows for a text that is a JSON object. */
export interface BuilderView {
  readonly name: string;
  readonly description: string;
  readonly trigger: BuilderTrigger | null;
  readonly steps: readonly BuilderStep[];
  /**
   * Whether `steps` is a list the builder can add to: absent or an array. Anything else is a file
   * the Bureau refuses, and an edit here would replace it, so the builder leaves it to the JSON tab.
   */
  readonly stepsEditable: boolean;
  /** The whole workflow in plain words: what starts it, then each step, joined by arrows. */
  readonly summary: string;
}

type Json = Record<string, unknown>;

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

/** Whether an agent step's `input` is absent or an object, the only shapes the builder can edit in place. */
function hasObjectInput(step: Json): boolean {
  return step['input'] === undefined || isRecord(step['input']);
}

function stepOf(step: unknown): BuilderStep {
  if (!isRecord(step)) return { kind: 'other', label: WORKFLOW_COPY.builder.notAnObject };
  const kind = asText(step['kind']);
  if (kind === 'activity' && step['handler'] === 'agent') {
    // An `input` that is not an object (a string, say) has no agent or message to show, and an
    // edit would replace it, so the step is left to the JSON tab like any other it cannot read.
    if (!hasObjectInput(step)) return { kind: 'other', label: stepLabel({ ...step, kind }) };
    const input = isRecord(step['input']) ? step['input'] : {};
    return { kind: 'agent', agent: asText(input['agent']), message: asText(input['message']) };
  }
  if (kind === 'sleep') return { kind: 'wait', duration: asText(step['duration']) };
  if (kind === 'await-signal') return { kind: 'signal', signal: asText(step['signal']) };
  return { kind: 'other', label: stepLabel({ ...step, kind }) };
}

function triggerOf(trigger: unknown): BuilderTrigger | null {
  if (trigger === undefined) return null;
  // A trigger that is not an object is a file the Bureau refuses; an edit would replace it.
  if (!isRecord(trigger)) return { kind: 'other', label: WORKFLOW_COPY.builder.notAnObject };
  const kind = asText(trigger['kind']);
  if (kind === 'schedule') return { kind, spec: asText(trigger['spec']) };
  if (kind === 'signal') return { kind, name: asText(trigger['name']) };
  return { kind: 'other', label: triggerLabel({ ...trigger, kind }) };
}

/**
 * One step in words. A wait's bare number is milliseconds, so the unit is said. An activity right
 * after a wait gets no result: the wait passes nothing on.
 */
function stepSentence(step: Json, before: unknown): string {
  const kind = asText(step['kind']);
  const described =
    kind === 'sleep' && typeof step['duration'] === 'number'
      ? { ...step, kind, duration: `${String(step['duration'])} ms` }
      : { ...step, kind };
  const sentence = stepLabel(described);
  const afterWait = isRecord(before) && before['kind'] === 'sleep';
  return kind === 'activity' && afterWait
    ? `${sentence} ${WORKFLOW_COPY.builder.afterWaitSummary}`
    : sentence;
}

function summaryOf(document: Json): string {
  const sentences: string[] = [];
  const trigger = document['trigger'];
  if (isRecord(trigger))
    sentences.push(triggerLabel({ ...trigger, kind: asText(trigger['kind']) }));
  const steps = Array.isArray(document['steps']) ? document['steps'] : [];
  steps.forEach((step: unknown, index: number) => {
    if (!isRecord(step)) return;
    sentences.push(stepSentence(step, steps[index - 1]));
  });
  return sentences.join(' → ');
}

/** The builder's view of `text`, or `undefined` when the text is not a JSON object the builder can read. */
export function readBuilder(text: string): BuilderView | undefined {
  const document = parseObject(text);
  if (document === undefined) return undefined;
  const steps: unknown = document['steps'];
  return {
    name: asText(document['name']),
    description: asText(document['description']),
    trigger: triggerOf(document['trigger']),
    steps: Array.isArray(steps) ? steps.map(stepOf) : [],
    stepsEditable: steps === undefined || Array.isArray(steps),
    summary: summaryOf(document),
  };
}

function stepsOf(document: Json): unknown[] {
  return Array.isArray(document['steps']) ? [...(document['steps'] as unknown[])] : [];
}

/** `text` with `name` set to `value`; it leads the file, as the template writes it. */
export function setName(text: string, value: string): string {
  const document = parseObject(text);
  if (document === undefined) return text;
  const { name: _previous, ...rest } = document;
  return toText({ name: value, ...rest });
}

/** `text` with `description` set to `value`, or removed when it is empty. */
export function setDescription(text: string, value: string): string {
  const document = parseObject(text);
  if (document === undefined) return text;
  if (value === '') delete document['description'];
  else document['description'] = value;
  return toText(document);
}

/**
 * `text` with its trigger of the given kind. Changing the kind replaces the trigger; changing the
 * field keeps the trigger's other keys (a schedule's `overlap`).
 */
export function setTrigger(text: string, kind: BuilderTriggerKind, value: string): string {
  const document = parseObject(text);
  if (document === undefined) return text;
  if (document['trigger'] !== undefined && !isRecord(document['trigger'])) return text;
  const current = isRecord(document['trigger']) ? document['trigger'] : {};
  const field = kind === 'schedule' ? 'spec' : 'name';
  document['trigger'] =
    current['kind'] === kind ? { ...current, [field]: value } : { kind, [field]: value };
  return toText(document);
}

/** `text` with a new step of `kind` at the end. */
export function addStep(text: string, kind: BuilderStepKind): string {
  const document = parseObject(text);
  if (document === undefined) return text;
  // A `steps` that is not a list stays as it is: adding would replace it.
  if (document['steps'] !== undefined && !Array.isArray(document['steps'])) return text;
  const steps = stepsOf(document);
  if (kind === 'agent') {
    steps.push({
      kind: 'activity',
      handler: 'agent',
      input: { agent: DEFAULT_AGENT, message: '' },
    });
  } else if (kind === 'wait') {
    steps.push({ kind: 'sleep', duration: '1m' });
  } else {
    steps.push({ kind: 'await-signal', signal: '' });
  }
  document['steps'] = steps;
  return toText(document);
}

/** `text` without the step at `index`. */
export function removeStep(text: string, index: number): string {
  const document = parseObject(text);
  if (document === undefined) return text;
  const steps = stepsOf(document);
  if (index < 0 || index >= steps.length) return text;
  steps.splice(index, 1);
  document['steps'] = steps;
  return toText(document);
}

/** `text` with the step at `index` moved by `offset` places (−1 earlier, 1 later), within the list. */
export function moveStep(text: string, index: number, offset: -1 | 1): string {
  const document = parseObject(text);
  if (document === undefined) return text;
  const steps = stepsOf(document);
  const target = index + offset;
  if (index < 0 || index >= steps.length || target < 0 || target >= steps.length) return text;
  const [moved] = steps.splice(index, 1);
  steps.splice(target, 0, moved);
  document['steps'] = steps;
  return toText(document);
}

/** The fields of a step the builder edits. */
export type StepField = 'agent' | 'message' | 'duration' | 'signal';

/** `text` with one field of the step at `index` set; a field the step's kind does not have changes nothing. */
export function setStepField(text: string, index: number, field: StepField, value: string): string {
  const document = parseObject(text);
  if (document === undefined) return text;
  const steps = stepsOf(document);
  const step = steps[index];
  if (!isRecord(step)) return text;
  if (field === 'agent' || field === 'message') {
    if (step['kind'] !== 'activity' || step['handler'] !== 'agent' || !hasObjectInput(step)) {
      return text;
    }
    const input = isRecord(step['input']) ? step['input'] : {};
    steps[index] = { ...step, input: { ...input, [field]: value } };
  } else if (field === 'duration') {
    if (step['kind'] !== 'sleep') return text;
    // A bare number is milliseconds, as the file may already write it; the builder says so.
    steps[index] = { ...step, duration: /^\d+$/.test(value) ? Number(value) : value };
  } else {
    if (step['kind'] !== 'await-signal') return text;
    steps[index] = { ...step, signal: value };
  }
  document['steps'] = steps;
  return toText(document);
}
