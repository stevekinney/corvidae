import {
  choiceBranchForValue,
  defaultValueForField,
  getValueAtPath,
  isRecord,
  type SchemaFormField,
} from './schema-form-model.ts';

const MAXIMUM_SHOWN_VALUES = 4;
const MAXIMUM_SHOWN_NAMES = 2;

/** The fields a person fills in under a group, with nested groups flattened away. */
export function leafFieldsOf(field: SchemaFormField): SchemaFormField[] {
  if (field.kind !== 'object') return [field];
  return field.fields.flatMap(leafFieldsOf);
}

/**
 * The one-line summary of a closed group. When something under the group has been changed it
 * lists those values (`Damaged · whole order`); otherwise it names the fields and says whether
 * the schema supplies defaults (`Carrier, Tracking Number… · none set`).
 */
export function summarizeGroup(group: SchemaFormField, formValue: unknown): string {
  const leaves = leafFieldsOf(group);
  const shown: string[] = [];
  let changed = 0;
  for (const leaf of leaves) {
    const text = changedValueText(leaf, formValue);
    if (text === undefined) continue;
    changed += 1;
    if (shown.length < MAXIMUM_SHOWN_VALUES) shown.push(text);
  }
  if (changed > 0) return `${shown.join(' · ')}${changed > shown.length ? '…' : ''}`;

  const names = leaves
    .slice(0, MAXIMUM_SHOWN_NAMES)
    .map((leaf) => leaf.label)
    .join(', ');
  const more = leaves.length > MAXIMUM_SHOWN_NAMES ? '…' : '';
  const hasDefaults = leaves.some((leaf) => 'default' in leaf.schema);
  return `${names}${more} · ${hasDefaults ? 'defaults' : 'none set'}`;
}

/** The text that stands for a leaf's value, or `undefined` when it is still at its default. */
function changedValueText(leaf: SchemaFormField, formValue: unknown): string | undefined {
  const current = getValueAtPath(formValue, leaf.path);
  if (current === undefined || current === null) return undefined;
  if (JSON.stringify(current) === JSON.stringify(defaultValueForField(leaf))) return undefined;

  if (typeof current === 'boolean') return current ? leaf.label : undefined;
  if (typeof current === 'string') return current === '' ? undefined : current;
  if (typeof current === 'number') return String(current);
  if (Array.isArray(current)) {
    return current.length === 0 ? undefined : current.map((entry) => String(entry)).join(', ');
  }
  if (leaf.kind === 'choice') return choiceBranchForValue(leaf, current).label;
  // Every other JSON value is an object, whose keys name what it holds.
  const keys = isRecord(current) ? Object.keys(current) : [];
  return keys.length === 0 ? undefined : keys.join(', ');
}
