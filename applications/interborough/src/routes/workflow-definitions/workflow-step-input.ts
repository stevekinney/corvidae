/**
 * The input of an `activity` step, from the JSON Schema the Bureau's catalog gives the activity: what
 * a step starts with when it is added. A form reports nothing until it is edited, so the draft it
 * shows at mount (a choice's first option, a switch off) is written once, when the step is added:
 * opening the file later is then not an edit, and the JSON tab reads what the form shows.
 */
import { schemaFormInitialDraft } from '@lostgradient/cinder';

import { formSchemaOf } from '../settings/settings-form-schema.ts';

/** The schema as the form reads it, without the dialect marker Zod writes, titled as the settings forms are. */
export function stepFormSchema(
  id: string,
  schema: Readonly<Record<string, unknown>> | null,
): Record<string, unknown> | undefined {
  if (schema === null) return undefined;
  const { $schema: _dialect, ...rest } = schema;
  return formSchemaOf(id, rest);
}

/**
 * The `input` a new step of the activity `id` starts with: the draft its form shows, or `undefined`
 * for an activity that declares no input schema, whose step has no `input` until someone writes one.
 */
export function startingInput(
  id: string,
  schema: Readonly<Record<string, unknown>> | null,
): Record<string, unknown> | undefined {
  const formSchema = stepFormSchema(id, schema);
  if (formSchema === undefined) return undefined;
  const draft = schemaFormInitialDraft(formSchema, undefined);
  return isRecord(draft) ? draft : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
