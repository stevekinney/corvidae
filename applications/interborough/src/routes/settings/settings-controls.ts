/**
 * Which control a setting gets, read from the shape of its JSON Schema node
 * (`bureau.settings.schema`). The page renders from the schema, not from a list of keys, so a key
 * the Bureau adds gets a control with no change here. Every shape has a control: a node nothing
 * more specific reads falls to the JSON editor, which can edit any value, so there is no
 * "unsupported" control.
 *
 * - a boolean: a switch.
 * - a string with an `enum`: a select.
 * - a string: a text field.
 * - an integer or a number: a number field.
 * - an object whose every property is a number and one is required (`retention.receipts`): a number
 *   field for each property.
 * - a union of one or more literals and such an object (`retention.audit`, `retention.checkpoints`):
 *   a select between the literals and the object, and a number field for each of its properties.
 * - a union of `false` and any other object (`tools.humanInput`): a switch, and a JSON editor for
 *   the object while the switch is on.
 * - anything else (`modelPolicy`, `engine.retention`, `engine.history`, `engine.payloadSize`): a JSON
 *   editor.
 */
import type { SchemaNode } from '../../lib/bureau-settings.ts';

/** One number in an object-valued setting. */
export type NumberField = {
  readonly name: string;
  readonly required: boolean;
  readonly integer: boolean;
  readonly minimum: number | undefined;
  readonly exclusiveMinimum: number | undefined;
  readonly maximum: number | undefined;
};

/** The control of one setting, by the shape of its schema node. */
export type Control =
  | { readonly kind: 'toggle' }
  | { readonly kind: 'select'; readonly options: readonly string[] }
  | { readonly kind: 'text'; readonly pattern: string | undefined }
  | ({ readonly kind: 'number' } & Omit<NumberField, 'name' | 'required'>)
  | { readonly kind: 'fields'; readonly fields: readonly NumberField[] }
  | {
      readonly kind: 'literal-or-fields';
      readonly literals: readonly string[];
      readonly fields: readonly NumberField[];
    }
  | { readonly kind: 'switch-json' }
  | { readonly kind: 'json' };

function isNumeric(node: SchemaNode): boolean {
  return node.type === 'integer' || node.type === 'number';
}

function numberField(name: string, node: SchemaNode, required: boolean): NumberField {
  return {
    name,
    required,
    integer: node.type === 'integer',
    minimum: node.minimum,
    exclusiveMinimum: node.exclusiveMinimum,
    maximum: node.maximum,
  };
}

/**
 * The number fields of an object node whose every property is a number and at least one is
 * required, or `undefined` for any other object. An object with no required property (such as
 * `engine.history`) is an object of options and is edited as JSON.
 */
function fieldsOf(node: SchemaNode): readonly NumberField[] | undefined {
  if (node.type !== 'object' || node.properties === undefined) return undefined;
  const entries = Object.entries(node.properties);
  const required = new Set(node.required ?? []);
  if (entries.length === 0 || !entries.every(([, property]) => isNumeric(property))) {
    return undefined;
  }
  if (!entries.some(([name]) => required.has(name))) return undefined;
  return entries.map(([name, property]) => numberField(name, property, required.has(name)));
}

function isStringLiteral(node: SchemaNode): node is SchemaNode & { readonly const: string } {
  return typeof node.const === 'string';
}

function isFalseLiteral(node: SchemaNode): boolean {
  return node.const === false;
}

function unionControl(branches: readonly SchemaNode[]): Control {
  const literals = branches.filter(isStringLiteral).map((branch) => branch.const);
  const objects = branches.filter((branch) => branch.type === 'object');
  if (literals.length > 0 && literals.length + objects.length === branches.length) {
    const [only, ...rest] = objects;
    const fields = only === undefined || rest.length > 0 ? undefined : fieldsOf(only);
    if (fields !== undefined) return { kind: 'literal-or-fields', literals, fields };
  }
  if (
    branches.length === 2 &&
    branches.some(isFalseLiteral) &&
    branches.some((branch) => branch.type === 'object')
  ) {
    return { kind: 'switch-json' };
  }
  return { kind: 'json' };
}

/** The control of the setting whose schema node is `node`. */
export function controlFor(node: SchemaNode): Control {
  if (node.anyOf !== undefined) return unionControl(node.anyOf);
  if (node.type === 'boolean') return { kind: 'toggle' };
  if (node.type === 'string') {
    if (node.enum !== undefined && node.enum.every((value) => typeof value === 'string')) {
      return { kind: 'select', options: node.enum };
    }
    return { kind: 'text', pattern: node.pattern };
  }
  if (isNumeric(node)) {
    const { name: _name, required: _required, ...rest } = numberField('', node, false);
    return { kind: 'number', ...rest };
  }
  const fields = fieldsOf(node);
  return fields === undefined ? { kind: 'json' } : { kind: 'fields', fields };
}

/** Whether a setting's value is held as JSON text, so its draft can hold text that is not yet JSON. */
export function holdsJson(control: Control): boolean {
  return control.kind === 'json' || control.kind === 'switch-json';
}

/** The groups the page shows, in order, with the words of each group's heading. */
export const SETTING_GROUPS = [
  { id: 'tools', label: 'Tools' },
  { id: 'modelPolicy', label: 'Model policy' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'context', label: 'Context' },
  { id: 'retention', label: 'Retention' },
  { id: 'sessionInput', label: 'Session input' },
  { id: 'children', label: 'Children' },
  { id: 'engine', label: 'Engine' },
  { id: 'durability', label: 'Durability' },
] as const;

/** The keys whose first segment is not their group: the ones that fix how the deployment is built. */
const DURABILITY_KEYS: ReadonlySet<string> = new Set([
  'durable',
  'maintenance',
  'durableOwnership.ownership',
  'workflowVersion',
]);

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
