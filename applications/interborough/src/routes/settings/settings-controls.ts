/**
 * Which control a setting gets, read from the shape of its JSON Schema node
 * (`bureau.settings.schema`). The page renders from the schema, not from a list of keys, so a key
 * the Bureau adds gets a control with no change here. Every shape has a control, so there is no
 * "unsupported" control.
 *
 * Plain values are controls of their own: a boolean is a switch, a string with an `enum` a select,
 * a string a text field, a number a number field. A key that names a model-catalog row
 * (`decisions.fallbackModel`, `context.summarizerModel`) or a decision model (`decisions.model`) is
 * a select of those rows, never a typed `provider/model`. Every object, and every union with one
 * (`retention.audit`, `engine.history`), is a Cinder `SchemaForm` over the node, except an object
 * that declares no field a form can edit (a record of answer schemas), which is free-form JSON. A
 * union of `false` and an object (`tools.humanInput`) is a switch, and the object's own control
 * while it is on. Only a node nothing else reads (an array or a bare `null`) falls to the JSON
 * editor, which can edit any value.
 */
import { A2A_COPY, DATA_RETENTION_COPY } from '../../app/copy.ts';
import type { SchemaNode } from '../../lib/bureau-settings.ts';

/** What a select of catalog rows offers: the models the catalog lists, or the decision models a host registers. */
export type ChoiceSource = 'catalog-rows' | 'decision-models';

/** The control of one setting, by the shape of its schema node. */
export type Control =
  | { readonly kind: 'toggle' }
  | { readonly kind: 'select'; readonly options: readonly string[] }
  | { readonly kind: 'choice'; readonly source: ChoiceSource }
  | { readonly kind: 'text'; readonly pattern: string | undefined }
  | {
      readonly kind: 'number';
      readonly integer: boolean;
      readonly minimum: number | undefined;
      readonly exclusiveMinimum: number | undefined;
      readonly maximum: number | undefined;
    }
  | { readonly kind: 'form' }
  | { readonly kind: 'switch-form' }
  | { readonly kind: 'switch-json' }
  | { readonly kind: 'json' };

/** The keys that name a row of the model catalog, as `<provider>/<model>`. */
const CATALOG_ROW_KEYS: ReadonlySet<string> = new Set([
  'decisions.fallbackModel',
  'context.summarizerModel',
]);

/** The key that names a decision model. */
const DECISION_MODEL_KEY = 'decisions.model';

function isNumeric(node: SchemaNode): boolean {
  return node.type === 'integer' || node.type === 'number';
}

function isObjectNode(node: SchemaNode): boolean {
  return node.type === 'object' || node.properties !== undefined;
}

function isFalseLiteral(node: SchemaNode): boolean {
  return node.const === false;
}

/**
 * Whether a node is an object nothing declares fields for (a record of answer schemas): a
 * `SchemaForm` draws it as a group with no field in it, so the value cannot be set there.
 */
function isOpenObject(node: SchemaNode): boolean {
  if (!isObjectNode(node)) return false;
  if (node.properties !== undefined && Object.keys(node.properties).length > 0) return false;
  // A record of strings is a form field of its own (rows of keys and values).
  const additional = node.additionalProperties;
  return !(
    typeof additional === 'object' &&
    additional !== null &&
    'type' in additional &&
    additional.type === 'string'
  );
}

/** Whether an object has nothing a `SchemaForm` can edit: it declares no field, or only open objects. */
function isFreeForm(node: SchemaNode): boolean {
  if (isOpenObject(node)) return true;
  const fields = Object.values(node.properties ?? {});
  return fields.length > 0 && fields.every(isOpenObject);
}

function unionControl(branches: readonly SchemaNode[]): Control {
  const objects = branches.filter(isObjectNode);
  if (branches.length === 2 && objects.length === 1) {
    // `false` or an object (`tools.humanInput`) is a switch, and the object's own control while it
    // is on: a form, or JSON for an object that holds only free-form values (its answer schemas).
    if (branches.some(isFalseLiteral)) {
      const [object] = objects;
      return object !== undefined && isFreeForm(object)
        ? { kind: 'switch-json' }
        : { kind: 'switch-form' };
    }
    // A literal or an object (`retention.audit`) is the form's own choice.
    if (branches.some((branch) => typeof branch.const === 'string')) return { kind: 'form' };
  }
  return { kind: 'json' };
}

/** The control of the setting `key`, whose schema node is `node`. */
export function controlFor(key: string, node: SchemaNode): Control {
  if (node.anyOf !== undefined) return unionControl(node.anyOf);
  if (node.type === 'boolean') return { kind: 'toggle' };
  if (node.type === 'string') {
    if (node.enum !== undefined && node.enum.every((value) => typeof value === 'string')) {
      return { kind: 'select', options: node.enum };
    }
    if (CATALOG_ROW_KEYS.has(key)) return { kind: 'choice', source: 'catalog-rows' };
    if (key === DECISION_MODEL_KEY) return { kind: 'choice', source: 'decision-models' };
    return { kind: 'text', pattern: node.pattern };
  }
  if (isNumeric(node)) {
    return {
      kind: 'number',
      integer: node.type === 'integer',
      minimum: node.minimum,
      exclusiveMinimum: node.exclusiveMinimum,
      maximum: node.maximum,
    };
  }
  return isObjectNode(node) && !isFreeForm(node) ? { kind: 'form' } : { kind: 'json' };
}

/** Whether a setting's value is held as JSON text, so its draft can hold text that is not yet JSON. */
export function holdsJson(control: Control): boolean {
  return control.kind === 'json' || control.kind === 'switch-json';
}

/** Whether a setting's value is edited through a `SchemaForm`, which checks it against the node. */
export function holdsForm(control: Control): boolean {
  return control.kind === 'form' || control.kind === 'switch-form';
}

/** The groups the page shows, in order, with the words of each group's heading. */
export const SETTING_GROUPS = [
  { id: 'tools', label: 'Tools' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'context', label: 'Context' },
  { id: 'retention', label: 'Retention' },
  { id: 'memory', label: 'Memory' },
  { id: 'logs', label: 'Logs' },
  { id: 'sessionInput', label: 'Session input' },
  { id: 'children', label: 'Children' },
  { id: 'engine', label: 'Workflows' },
  { id: 'durability', label: 'Durability' },
  { id: 'a2a', label: 'Agent2Agent' },
] as const;

/** The keys whose first segment is not their group: the ones that fix how the deployment is built. */
const DURABILITY_KEYS: ReadonlySet<string> = new Set([
  'durable',
  'maintenance',
  'durableOwnership.ownership',
  'workflowVersion',
]);

/**
 * The settings that hold a duration in milliseconds, with the unit the page shows it in and whether
 * the person may change that unit. A claim lasting seconds is always counted in seconds, so its unit
 * is text in the field; a sweep that runs hourly lets the person pick.
 */
export const DURATION_SETTINGS: Readonly<
  Record<string, { readonly unit: 'ms' | 's' | 'min' | 'h'; readonly selectable: boolean }>
> = {
  'engine.workflowClaimTtl': { unit: 's', selectable: false },
  'engine.workflowClaimRenewInterval': { unit: 's', selectable: false },
  'engine.schedulerPollIntervalMs': { unit: 's', selectable: true },
  'engine.retentionSweepInterval': { unit: 'h', selectable: true },
  'children.delegation.defaultTimeToLiveMilliseconds': { unit: 'min', selectable: true },
  'a2a.push.sweepIntervalMs': { unit: 'h', selectable: true },
};

/** The word after a number field's value, for the settings that count something (`4 runs`). */
export const SETTING_UNITS: Readonly<Record<string, string>> = {
  'engine.maxConcurrentRuns': 'runs',
};

/** The one setting the Allowed models section holds, and so the General section does not. */
export const MODEL_POLICY_KEY = 'modelPolicy';

/**
 * The sections of Settings that edit settings: General holds every key but the three below, Allowed
 * models holds the model policy, the Decisions part of the Models page holds `decisions.*`, and
 * the A2A section holds `a2a.*`.
 */
export type SettingsSectionId =
  'general' | 'allowed-models' | 'decisions' | 'a2a' | 'retention' | 'plugins' | 'api-reference';

/** The settings the Models page holds: the decision model, its fallback, and its limit per task. */
function isDecisionKey(key: string): boolean {
  return key.startsWith('decisions.');
}

/** The settings the A2A section holds: the push notifications an A2A caller can ask an agent for. */
function isA2aKey(key: string): boolean {
  return key.startsWith('a2a.');
}

/** The settings the Data and retention section holds: how long each kind of record is kept. */
function isRetentionKey(key: string): boolean {
  return key.startsWith('retention.');
}

/** Whether the section `section` edits the key `key`. */
export function inSection(key: string, section: SettingsSectionId): boolean {
  if (section === 'allowed-models') return key === MODEL_POLICY_KEY;
  if (section === 'decisions') return isDecisionKey(key);
  if (section === 'a2a') return isA2aKey(key);
  if (section === 'retention') return isRetentionKey(key);
  // Plugins edits plugins, not settings: it holds none of the keys, and only reads them for the restart notice.
  if (section === 'plugins' || section === 'api-reference') return false;
  return key !== MODEL_POLICY_KEY && !isDecisionKey(key) && !isA2aKey(key) && !isRetentionKey(key);
}

/**
 * The group a key is shown under: its first segment, except that `durable`, `maintenance`,
 * `durableOwnership.ownership`, and `workflowVersion` are under Durability. A key whose first
 * segment is not one of {@link SETTING_GROUPS} is under a group of its own, so no key is dropped.
 */
export function groupOf(key: string): string {
  if (DURABILITY_KEYS.has(key)) return 'durability';
  return key.split('.')[0] ?? key;
}

/** The label of a group: the one {@link SETTING_GROUPS} gives it, or its identifier for a group the page does not know. */
export function groupLabel(id: string): string {
  return SETTING_GROUPS.find((group) => group.id === id)?.label ?? id;
}

/** The identifiers of the groups the keys fall in: the known groups in order, then any other in the order its first key appeared. */
export function groupsOf(keys: readonly string[]): readonly string[] {
  const present = new Set(keys.map(groupOf));
  const known = SETTING_GROUPS.map((group) => group.id).filter((id) => present.has(id));
  const other = [...present].filter((id) => !SETTING_GROUPS.some((group) => group.id === id));
  return [...known, ...other];
}

/**
 * The settings whose name is not the last part of their key put into words: the A2A switches are
 * named for what they do, so the restart notice and the rows say the same thing.
 */
const SETTING_LABELS: Readonly<Record<string, string>> = {
  'a2a.enabled': A2A_COPY.enabled.label,
  'a2a.agents': A2A_COPY.agents.label,
  'a2a.push.enabled': A2A_COPY.pushNotifications.label,
  ...DATA_RETENTION_COPY.labels,
};

/**
 * The words of a key part that a person does not say as they are written: the unit a duration key
 * ends in is dropped (the field carries its own unit), and an abbreviation is spelled out.
 */
const SPOKEN_WORDS: Readonly<Record<string, string>> = { ttl: 'time to live' };
const UNIT_WORDS: ReadonlySet<string> = new Set(['ms', 'milliseconds']);

/** `text` with its first letter capitalized and the rest left as written. */
function sentenceCase(text: string): string {
  return text === '' ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * A setting's name as a person reads it: the last part of its key, split into words and in
 * sentence case, with a trailing unit dropped and an abbreviation spelled out, so
 * `engine.workflowClaimRenewInterval` is "Workflow claim renew interval" and
 * `engine.schedulerPollIntervalMs` is "Scheduler poll interval".
 */
export function settingLabel(key: string): string {
  if (Object.hasOwn(SETTING_LABELS, key)) return SETTING_LABELS[key] ?? key;
  const last = key.split('.').at(-1) ?? key;
  const split = last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  const unitless =
    split.length > 1 && UNIT_WORDS.has(split.at(-1) ?? '') ? split.slice(0, -1) : split;
  const words = unitless.map((word) =>
    Object.hasOwn(SPOKEN_WORDS, word) ? SPOKEN_WORDS[word] : word,
  );
  return words.length === 0 ? key : sentenceCase(words.join(' '));
}

/**
 * A value of a setting that holds one of a fixed set of words, as a person reads it: `automatic` is
 * "Automatic", `keep-all` is "Keep all". The stored value is what is saved; this is only the label.
 */
export function optionLabel(value: string): string {
  return sentenceCase(
    value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[-_]+/g, ' ')
      .toLowerCase()
      .trim(),
  );
}

/** Whether a property of an object-valued setting is a duration, which every setting takes in milliseconds. */
export function isDuration(name: string): boolean {
  return name === 'olderThan' || name.endsWith('Milliseconds');
}

/**
 * The decision models a host registers by name, which `decisions.model` takes: `catalog`, the
 * language-model fallback alone, and `typesafe:jev`, the model the typesafe plugin contributes
 * (`plugins/typesafe`).
 * The Bureau lists no names, and refuses one the host did not register, which the page says.
 */
export const HOST_DECISION_MODELS = [
  { value: 'catalog', label: 'The language model alone' },
  { value: 'typesafe:jev', label: 'TypeSafe' },
] as const;
