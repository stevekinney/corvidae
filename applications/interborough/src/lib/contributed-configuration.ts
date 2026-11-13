/**
 * What `contributed-configuration-form.svelte` and the pages that save its value both need to know
 * about a contributed configuration schema: the schema as the form reads it, whether it has any
 * field to draw, and whether two configurations are the same value.
 */
import { formSchemaOf } from '../routes/settings/settings-form-schema.ts';

/** The schema as the form reads it, without the dialect marker Zod writes; `undefined` for a `null` schema. */
export function contributedFormSchema(
  kindId: string,
  schema: Readonly<Record<string, unknown>> | null,
): Record<string, unknown> | undefined {
  if (schema === null) return undefined;
  const { $schema: _dialect, ...rest } = schema;
  return formSchemaOf(kindId, rest);
}

/**
 * Whether the schema has anything to draw: named properties, or free keys (`additionalProperties`
 * that describes a value, which Zod writes for a record). A closed object with no properties is a
 * kind that takes no settings.
 */
export function contributedFormHasFields(
  formSchema: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const properties = formSchema?.['properties'];
  if (typeof properties === 'object' && properties !== null && Object.keys(properties).length > 0) {
    return true;
  }
  const additional = formSchema?.['additionalProperties'];
  return (
    typeof additional === 'object' && additional !== null && Object.keys(additional).length > 0
  );
}

/** Whether two JSON values are equal, whatever order their keys came in. */
export function isSameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => isSameJson(item, right[index]))
    );
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => {
      const leftValue: unknown = Reflect.get(left, key);
      const rightValue: unknown = Reflect.get(right, key);
      return Object.hasOwn(right, key) && isSameJson(leftValue, rightValue);
    })
  );
}
