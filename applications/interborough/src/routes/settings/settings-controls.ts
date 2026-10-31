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
 * (`retention.audit`, `engine.history`), is a Cinder `SchemaForm` over the node. A union of `false`
 * and an object (`tools.humanInput`) is a switch, and a form for the object while it is on. Only a
 * node nothing else reads (an array or a bare `null`) falls to the JSON editor, which can edit any
 * value.
 */
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

function unionControl(branches: readonly SchemaNode[]): Control {
  const objects = branches.filter(isObjectNode);
  if (branches.length === 2 && objects.length === 1) {
    // `false` or an object (`tools.humanInput`) is a switch and a form.
    if (branches.some(isFalseLiteral)) return { kind: 'switch-form' };
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
  return isObjectNode(node) ? { kind: 'form' } : { kind: 'json' };
}

/** Whether a setting's value is held as JSON text, so its draft can hold text that is not yet JSON. */
export function holdsJson(control: Control): boolean {
  return control.kind === 'json';
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
  { id: 'a2a', label: 'A2A' },
] as const;

/** The keys whose first segment is not their group: the ones that fix how the deployment is built. */
const DURABILITY_KEYS: ReadonlySet<string> = new Set([
  'durable',
  'maintenance',
  'durableOwnership.ownership',
  'workflowVersion',
]);

/** The one setting the Model policy section holds, and so the General section does not. */
export const MODEL_POLICY_KEY = 'modelPolicy';

/** The sections of Settings that edit settings: General holds every key but the model policy. */
export type SettingsSectionId = 'general' | 'model-policy';

/** Whether the section `section` edits the key `key`. */
export function inSection(key: string, section: SettingsSectionId): boolean {
  return (key === MODEL_POLICY_KEY) === (section === 'model-policy');
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

/** Whether a property of an object-valued setting is a duration, which every setting takes in milliseconds. */
export function isDuration(name: string): boolean {
  return name === 'olderThan' || name.endsWith('Milliseconds');
}

/**
 * The decision models a host registers by name, which `decisions.model` takes: `catalog`, the
 * language-model fallback alone, and `typesafe`, the model a TypeSafe key registers (`host.ts`).
 * The Bureau lists no names, and refuses one the host did not register, which the page says.
 */
export const HOST_DECISION_MODELS = [
  { value: 'catalog', label: 'The language model alone' },
  { value: 'typesafe', label: 'TypeSafe' },
] as const;
