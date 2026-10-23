/**
 * A human-input wait's JSON Schema as an A2UI v0.9.1 basic-catalog form, and a submission of that
 * form checked against the schema (COR-1487).
 *
 * The schema is the native payload: an author configures it per signal on `requestHumanInput`, and
 * the wait carries it. A2UI is a projection of it for A2A clients, so nothing here is stored.
 *
 * ## The mapping
 *
 * | JSON Schema property | Component |
 * | --- | --- |
 * | `type: "string"` | `TextField` (`shortText`) |
 * | `type: "string"` with `enum` | `ChoicePicker` (`mutuallyExclusive`) |
 * | `type: "string"`, `format: "date"` | `DateTimeInput` (`enableDate`) |
 * | `type: "string"`, `format: "date-time"` | `DateTimeInput` (`enableDate`, `enableTime`) |
 * | `type: "number"` or `"integer"` | `TextField` (`number`) |
 * | `type: "boolean"` | `CheckBox` |
 * | listed in `required` | the `required` function, as a `checks` entry |
 *
 * Only that vocabulary maps: a root `object` whose `properties` use `type`, `title`, `description`,
 * `enum` and `format` as above, and a `required` list naming them. Any other schema feature (a
 * nested object, an array, `$ref`, `oneOf`, a length or range, a `pattern`, a default) falls back
 * to one long-text `TextField`, in which the person types the whole answer as JSON.
 *
 * ## The submission
 *
 * A submission is the form's value as one JSON object, keyed by property name, sent as the data
 * part of a `SendMessage` that continues the task. Whatever its source, it is untrusted input:
 * {@link checkFormSubmission} validates it against the original schema before anything is
 * delivered. A fallback form's submission may instead be `{ "response": "<JSON text>" }`, which is
 * parsed first.
 *
 * @module input-form
 */

import type { HumanInputSchema } from '@lostgradient/operative';
import { InteractiveSurfaceSchemaCompiler } from '../interactive-surface/validation.ts';
import type { InteractiveSurfaceJsonObject } from '../interactive-surface/types.ts';

/** The catalog id of the vendored basic catalog (`basic-catalog.schema.json`). */
export const A2UI_BASIC_CATALOG_ID =
  'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';

/** The media type of a data part that carries one A2UI message. */
export const A2UI_MEDIA_TYPE = 'application/json+a2ui';

/** The name of the action event a form's submit button raises. */
export const INPUT_FORM_SUBMIT_EVENT = 'submit-input';

/** One A2UI v0.9 server-to-client message. */
export type A2uiMessage = Record<string, unknown>;

type Property = Readonly<Record<string, unknown>>;

const ROOT_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'type',
  'properties',
  'required',
  'additionalProperties',
]);
const PROPERTY_KEYWORDS: ReadonlySet<string> = new Set([
  'title',
  'description',
  'type',
  'enum',
  'format',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON Pointer of a top-level property of the form's data model. */
function pointerOf(name: string): string {
  return `/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

type FormField = {
  readonly name: string;
  readonly property: Property;
  readonly required: boolean;
};

/**
 * The form's fields in property order, or `undefined` when the schema uses anything the mapping
 * does not cover.
 */
function mappableFieldsOf(schema: HumanInputSchema): FormField[] | undefined {
  for (const keyword of Object.keys(schema)) {
    if (!ROOT_KEYWORDS.has(keyword)) return undefined;
  }
  const properties = schema['properties'];
  if (schema['type'] !== 'object' || !isRecord(properties)) return undefined;
  const names = Object.keys(properties);
  if (names.length === 0) return undefined;
  const requiredValue = schema['required'];
  if (
    requiredValue !== undefined &&
    (!Array.isArray(requiredValue) ||
      requiredValue.some((entry) => typeof entry !== 'string' || !names.includes(entry)))
  ) {
    return undefined;
  }
  const required = new Set<string>((requiredValue as string[] | undefined) ?? []);
  const fields: FormField[] = [];
  for (const name of names) {
    const property = properties[name];
    if (!isRecord(property)) return undefined;
    for (const keyword of Object.keys(property)) {
      if (!PROPERTY_KEYWORDS.has(keyword)) return undefined;
    }
    const type = property['type'];
    const format = property['format'];
    const enumeration = property['enum'];
    if (enumeration !== undefined) {
      if (
        type !== 'string' ||
        format !== undefined ||
        !Array.isArray(enumeration) ||
        enumeration.length === 0 ||
        enumeration.some((entry) => typeof entry !== 'string')
      ) {
        return undefined;
      }
    } else if (format !== undefined) {
      if (type !== 'string' || (format !== 'date' && format !== 'date-time')) return undefined;
    } else if (type !== 'string' && type !== 'number' && type !== 'integer' && type !== 'boolean') {
      return undefined;
    }
    fields.push({ name, property, required: required.has(name) });
  }
  return fields;
}

function labelOf(name: string, property: Property): string {
  return typeof property['title'] === 'string' && property['title'] !== ''
    ? property['title']
    : name;
}

function requiredCheck(name: string, label: string): Record<string, unknown> {
  return {
    checks: [
      {
        condition: { call: 'required', args: { value: { path: pointerOf(name) } } },
        message: `${label} is required.`,
      },
    ],
  };
}

function componentOf(field: FormField, id: string): Record<string, unknown> {
  const { name, property } = field;
  const label = labelOf(name, property);
  const value = { path: pointerOf(name) };
  const checks = field.required ? requiredCheck(name, label) : {};
  const enumeration = property['enum'];
  if (Array.isArray(enumeration)) {
    return {
      id,
      component: 'ChoicePicker',
      label,
      variant: 'mutuallyExclusive',
      options: (enumeration as string[]).map((entry) => ({ label: entry, value: entry })),
      value,
      ...checks,
    };
  }
  switch (property['format']) {
    case 'date':
      return { id, component: 'DateTimeInput', label, value, enableDate: true, ...checks };
    case 'date-time':
      return {
        id,
        component: 'DateTimeInput',
        label,
        value,
        enableDate: true,
        enableTime: true,
        ...checks,
      };
    default:
      break;
  }
  switch (property['type']) {
    case 'boolean':
      return { id, component: 'CheckBox', label, value, ...checks };
    case 'number':
    case 'integer':
      return { id, component: 'TextField', label, value, variant: 'number', ...checks };
    default:
      return { id, component: 'TextField', label, value, variant: 'shortText', ...checks };
  }
}

/**
 * The A2UI messages that render a human-input schema as a form: a `createSurface` for the basic
 * catalog and an `updateComponents` holding the form. A mappable schema becomes one field per
 * property under a column with a submit button; any other schema becomes one long-text field.
 */
export function inputFormMessages(surfaceId: string, schema: HumanInputSchema): A2uiMessage[] {
  const fields = mappableFieldsOf(schema);
  const components: Record<string, unknown>[] = [];
  const context: Record<string, unknown> = {};
  const children: string[] = [];
  if (fields === undefined) {
    components.push({
      id: 'field-response',
      component: 'TextField',
      label: 'Answer as JSON matching the requested schema',
      value: { path: '/response' },
      variant: 'longText',
    });
    children.push('field-response');
    context['response'] = { path: '/response' };
  } else {
    fields.forEach((field, index) => {
      const id = `field-${index}`;
      components.push(componentOf(field, id));
      children.push(id);
      context[field.name] = { path: pointerOf(field.name) };
    });
  }
  components.push(
    { id: 'submit-label', component: 'Text', text: 'Submit' },
    {
      id: 'submit',
      component: 'Button',
      child: 'submit-label',
      variant: 'primary',
      action: { event: { name: INPUT_FORM_SUBMIT_EVENT, context } },
    },
    { id: 'root', component: 'Column', children: [...children, 'submit'] },
  );
  return [
    { version: 'v0.9', createSurface: { surfaceId, catalogId: A2UI_BASIC_CATALOG_ID } },
    { version: 'v0.9', updateComponents: { surfaceId, components } },
  ];
}

/**
 * The compiler every submission is checked with: the one the interactive-surface contract uses,
 * so a wait's schema is held to the same rules as a surface's (no `pattern`, no `$id`, no `$async`).
 */
const schemaChecker = new InteractiveSurfaceSchemaCompiler();

/** The outcome of {@link checkFormSubmission}. */
export type FormSubmission =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string };

/**
 * Checks a submitted answer against the schema its wait was parked with, and returns the value to
 * deliver. The submission is untrusted: it is validated here, in full, and a refusal says why.
 *
 * A schema the form could not map is answered as `{ "response": "<JSON text>" }` or directly as the
 * value; the first is parsed, and the result is validated the same way.
 */
export function checkFormSubmission(schema: HumanInputSchema, submitted: unknown): FormSubmission {
  let value: unknown = submitted;
  if (
    mappableFieldsOf(schema) === undefined &&
    isRecord(submitted) &&
    Object.keys(submitted).length === 1 &&
    typeof submitted['response'] === 'string'
  ) {
    try {
      value = JSON.parse(submitted['response']);
    } catch {
      return { ok: false, message: 'The response is not valid JSON.' };
    }
  }
  let problem: string | undefined;
  try {
    problem = schemaChecker.check(schema as InteractiveSurfaceJsonObject, value);
  } catch (error) {
    return {
      ok: false,
      message: `The wait's schema could not be used: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return problem === undefined ? { ok: true, value } : { ok: false, message: problem };
}
