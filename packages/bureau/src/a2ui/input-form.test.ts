/**
 * COR-1487 — a human-input schema projected as an A2UI v0.9.1 basic-catalog form, and a
 * submission of that form checked against the schema.
 */
import type { HumanInputSchema } from '@lostgradient/operative';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'bun:test';

import {
  A2UI_BASIC_CATALOG_ID,
  type A2uiMessage,
  checkFormSubmission,
  INPUT_FORM_SUBMIT_EVENT,
  inputFormMessages,
} from './input-form.ts';

const catalog = (await Bun.file(
  new URL('./basic-catalog.schema.json', import.meta.url),
).json()) as { $id: string; catalogId: string };

/**
 * The catalog refers to A2UI's `common_types.json`, which is not vendored. This stands in for the
 * definitions the form uses, as the v0.9.1 specification gives them, so a component is checked
 * against everything the vendored catalog itself says about it: its properties, its enumerated
 * values, its required fields, and that no other property appears.
 */
const COMMON_TYPES = 'https://a2ui.org/specification/v0_9/common_types.json';
const commonTypes = {
  $id: COMMON_TYPES,
  $defs: {
    ComponentId: { type: 'string' },
    ComponentCommon: {
      type: 'object',
      properties: { id: { $ref: '#/$defs/ComponentId' } },
      required: ['id'],
    },
    FunctionCall: {
      type: 'object',
      properties: { call: { type: 'string' }, args: { type: 'object' } },
      required: ['call'],
    },
    DynamicString: {
      oneOf: [
        { type: 'string' },
        {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
        { $ref: '#/$defs/FunctionCall' },
      ],
    },
    DynamicBoolean: {
      oneOf: [
        { type: 'boolean' },
        {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
        { $ref: '#/$defs/FunctionCall' },
      ],
    },
    DynamicStringList: {
      oneOf: [
        { type: 'array', items: { type: 'string' } },
        {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
        { $ref: '#/$defs/FunctionCall' },
      ],
    },
    ChildList: { type: 'array', items: { $ref: '#/$defs/ComponentId' } },
    Checkable: {
      type: 'object',
      properties: {
        checks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              condition: { $ref: '#/$defs/FunctionCall' },
              message: { type: 'string' },
            },
            required: ['condition', 'message'],
          },
        },
      },
    },
    Action: {
      type: 'object',
      properties: {
        event: {
          type: 'object',
          properties: { name: { type: 'string' }, context: { type: 'object' } },
          required: ['name'],
        },
      },
    },
  },
};

const ajv = new Ajv2020({ strict: false, validateFormats: false, logger: false });
ajv.addSchema(commonTypes);
ajv.addSchema(catalog);

function componentValidator(name: string) {
  return ajv.compile({ $ref: `${catalog.$id}#/components/${name}` });
}

type Component = Record<string, unknown> & { id: string; component: string };

function messagesOf(schema: HumanInputSchema): {
  createSurface: Record<string, unknown>;
  components: Component[];
  all: A2uiMessage[];
} {
  const all = inputFormMessages('surface-1', schema);
  const create = all[0]?.['createSurface'] as Record<string, unknown>;
  const update = all[1]?.['updateComponents'] as { components: Component[] };
  return { createSurface: create, components: update.components, all };
}

function field(components: readonly Component[], index = 0): Component {
  const found = components.find((component) => component.id === `field-${index}`);
  if (found === undefined) throw new Error(`no field ${index}`);
  return found;
}

describe('inputFormMessages', () => {
  it('opens a surface of the vendored basic catalog', () => {
    const { createSurface, all } = messagesOf({
      type: 'object',
      properties: { name: { type: 'string' } },
    });

    expect(A2UI_BASIC_CATALOG_ID).toBe(catalog.catalogId);
    expect(createSurface).toEqual({ surfaceId: 'surface-1', catalogId: catalog.catalogId });
    expect(all.every((message) => message['version'] === 'v0.9')).toBe(true);
  });

  it('maps a string property to a short TextField', () => {
    const { components } = messagesOf({
      type: 'object',
      properties: { name: { type: 'string', title: 'Your name' } },
    });

    expect(field(components)).toEqual({
      id: 'field-0',
      component: 'TextField',
      label: 'Your name',
      value: { path: '/name' },
      variant: 'shortText',
    });
  });

  it('maps a number property, and an integer one, to a number TextField', () => {
    const { components } = messagesOf({
      type: 'object',
      properties: { count: { type: 'number' }, copies: { type: 'integer' } },
    });

    expect(field(components, 0)).toMatchObject({
      component: 'TextField',
      variant: 'number',
      label: 'count',
    });
    expect(field(components, 1)).toMatchObject({ component: 'TextField', variant: 'number' });
  });

  it('maps a boolean property to a CheckBox', () => {
    const { components } = messagesOf({
      type: 'object',
      properties: { confirmed: { type: 'boolean' } },
    });

    expect(field(components)).toEqual({
      id: 'field-0',
      component: 'CheckBox',
      label: 'confirmed',
      value: { path: '/confirmed' },
    });
  });

  it('maps an enum property to a ChoicePicker with one option per value', () => {
    const { components } = messagesOf({
      type: 'object',
      properties: { environment: { type: 'string', enum: ['staging', 'production'] } },
    });

    expect(field(components)).toEqual({
      id: 'field-0',
      component: 'ChoicePicker',
      label: 'environment',
      variant: 'mutuallyExclusive',
      options: [
        { label: 'staging', value: 'staging' },
        { label: 'production', value: 'production' },
      ],
      value: { path: '/environment' },
    });
  });

  it('maps a date property to a DateTimeInput, with the time for a date-time one', () => {
    const { components } = messagesOf({
      type: 'object',
      properties: {
        day: { type: 'string', format: 'date' },
        moment: { type: 'string', format: 'date-time' },
      },
    });

    expect(field(components, 0)).toMatchObject({ component: 'DateTimeInput', enableDate: true });
    expect(field(components, 0)).not.toHaveProperty('enableTime');
    expect(field(components, 1)).toMatchObject({
      component: 'DateTimeInput',
      enableDate: true,
      enableTime: true,
    });
  });

  it('marks a required property with the required function, and no other', () => {
    const { components } = messagesOf({
      type: 'object',
      properties: { name: { type: 'string' }, note: { type: 'string' } },
      required: ['name'],
    });

    expect(field(components, 0)['checks']).toEqual([
      {
        condition: { call: 'required', args: { value: { path: '/name' } } },
        message: 'name is required.',
      },
    ]);
    expect(field(components, 1)).not.toHaveProperty('checks');
  });

  it('binds a property name that holds a slash or a tilde with a JSON Pointer escape', () => {
    const { components } = messagesOf({
      type: 'object',
      properties: { 'a/b~c': { type: 'string' } },
    });

    expect(field(components)['value']).toEqual({ path: '/a~1b~0c' });
  });

  it('submits every property by name from a button under a root column', () => {
    const { components } = messagesOf({
      type: 'object',
      properties: { name: { type: 'string' }, ok: { type: 'boolean' } },
    });

    expect(components.find((component) => component.id === 'root')).toEqual({
      id: 'root',
      component: 'Column',
      children: ['field-0', 'field-1', 'submit'],
    });
    expect(components.find((component) => component.id === 'submit')?.['action']).toEqual({
      event: {
        name: INPUT_FORM_SUBMIT_EVENT,
        context: { name: { path: '/name' }, ok: { path: '/ok' } },
      },
    });
  });

  describe('a schema the mapping does not cover', () => {
    const unmapped: Record<string, HumanInputSchema> = {
      'a nested object': {
        type: 'object',
        properties: { address: { type: 'object', properties: { street: { type: 'string' } } } },
      },
      'an array property': {
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' } } },
      },
      'a range': { type: 'object', properties: { age: { type: 'number', minimum: 0 } } },
      'a default': { type: 'object', properties: { name: { type: 'string', default: 'x' } } },
      'a combinator': { oneOf: [{ type: 'object' }, { type: 'string' }] },
      'a non-object root': { type: 'string' },
      'an unsupported format': {
        type: 'object',
        properties: { mail: { type: 'string', format: 'email' } },
      },
      'a required name that is not a property': {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['other'],
      },
      'no properties': { type: 'object' },
    };

    for (const [name, schema] of Object.entries(unmapped)) {
      it(`falls back to one long-text TextField for ${name}`, () => {
        const { components } = messagesOf(schema);

        expect(components.filter((component) => component.component === 'TextField')).toEqual([
          {
            id: 'field-response',
            component: 'TextField',
            label: 'Answer as JSON matching the requested schema',
            value: { path: '/response' },
            variant: 'longText',
          },
        ]);
        expect(components.filter((component) => component.component === 'ChoicePicker')).toEqual(
          [],
        );
      });
    }
  });

  describe('against the vendored basic-catalog schema', () => {
    const everything: HumanInputSchema = {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
        count: { type: 'number' },
        confirmed: { type: 'boolean' },
        environment: { type: 'string', enum: ['staging', 'production'] },
        day: { type: 'string', format: 'date' },
        moment: { type: 'string', format: 'date-time' },
      },
      required: ['name', 'environment'],
    };

    for (const [label, schema] of [
      ['a mapped form of every field type', everything],
      ['the long-text fallback', { type: 'string' }],
    ] as const) {
      it(`validates every component of ${label}`, () => {
        const { components } = messagesOf(schema);

        for (const component of components) {
          const validate = componentValidator(component.component);
          expect(validate(component), JSON.stringify([component, validate.errors])).toBe(true);
        }
      });
    }

    it('validates the required function call against the catalog', () => {
      const validate = ajv.compile({ $ref: `${catalog.$id}#/functions/required` });
      const { components } = messagesOf(everything);

      const condition = (field(components, 0)['checks'] as { condition: unknown }[])[0]?.condition;

      expect(validate(condition), JSON.stringify(validate.errors)).toBe(true);
    });

    it('is not vacuous: the same validator refuses a component the catalog does not allow', () => {
      const validate = componentValidator('TextField');

      expect(validate({ id: 'x', component: 'TextField', label: 'x', variant: 'bogus' })).toBe(
        false,
      );
      expect(validate({ id: 'x', component: 'TextField', label: 'x', surprise: true })).toBe(false);
    });

    it('names a component for every id its column lists', () => {
      const { components } = messagesOf(everything);
      const ids = new Set(components.map((component) => component.id));
      const root = components.find((component) => component.id === 'root');
      const children = (root?.['children'] ?? []) as string[];

      expect(children.length).toBeGreaterThan(0);
      for (const child of children) expect(ids.has(child)).toBe(true);
      expect(ids.size).toBe(components.length);
    });
  });
});

describe('checkFormSubmission', () => {
  const schema: HumanInputSchema = {
    type: 'object',
    properties: {
      environment: { type: 'string', enum: ['staging', 'production'] },
      replicas: { type: 'integer' },
    },
    required: ['environment'],
    additionalProperties: false,
  };

  it('accepts a submission that satisfies the schema and returns it', () => {
    const submitted = { environment: 'staging', replicas: 3 };

    expect(checkFormSubmission(schema, submitted)).toEqual({ ok: true, value: submitted });
  });

  it('refuses a missing required field, saying which', () => {
    const result = checkFormSubmission(schema, { replicas: 3 });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('environment');
  });

  it('refuses a value outside an enum, of the wrong type, or with an extra property', () => {
    expect(checkFormSubmission(schema, { environment: 'moon' }).ok).toBe(false);
    expect(checkFormSubmission(schema, { environment: 'staging', replicas: 'many' }).ok).toBe(
      false,
    );
    expect(checkFormSubmission(schema, { environment: 'staging', extra: 1 }).ok).toBe(false);
  });

  it('refuses a submission that is not an object', () => {
    expect(checkFormSubmission(schema, 'staging').ok).toBe(false);
    expect(checkFormSubmission(schema, null).ok).toBe(false);
    expect(checkFormSubmission(schema, ['staging']).ok).toBe(false);
  });

  it('does not coerce a field the form did not generate: a numeric string is not a number there', () => {
    expect(
      checkFormSubmission({ type: 'object', properties: { n: { type: 'number' } } }, { n: '3' }).ok,
    ).toBe(true);
    expect(
      checkFormSubmission(
        { type: 'object', properties: { n: { type: 'number' }, extra: { type: 'array' } } },
        { n: '3' },
      ).ok,
    ).toBe(false);
  });

  describe('the values the generated controls write', () => {
    const typed: HumanInputSchema = {
      type: 'object',
      properties: {
        stage: { type: 'string', enum: ['staging'] },
        replicas: { type: 'integer' },
        ratio: { type: 'number' },
        note: { type: 'string' },
        urgent: { type: 'boolean' },
      },
      required: ['stage', 'replicas'],
      additionalProperties: false,
    };

    it('accepts a ChoicePicker’s one-item list as the enum string and a number field’s text as a number', () => {
      const result = checkFormSubmission(typed, {
        stage: ['staging'],
        replicas: '3',
        ratio: ' 0.5 ',
        note: 'ok',
        urgent: true,
      });

      expect(result).toEqual({
        ok: true,
        value: { stage: 'staging', replicas: 3, ratio: 0.5, note: 'ok', urgent: true },
      });
    });

    it('treats blank number text and an empty choice as no value', () => {
      expect(checkFormSubmission(typed, { stage: ['staging'], replicas: '4', ratio: '' })).toEqual({
        ok: true,
        value: { stage: 'staging', replicas: 4 },
      });
      expect(checkFormSubmission(typed, { stage: [], replicas: '4' }).ok).toBe(false);
    });

    it('still refuses what normalising cannot make valid', () => {
      expect(checkFormSubmission(typed, { stage: ['staging', 'x'], replicas: '3' }).ok).toBe(false);
      expect(checkFormSubmission(typed, { stage: 'staging', replicas: 'many' }).ok).toBe(false);
      expect(checkFormSubmission(typed, { stage: 'staging', replicas: '2.5' }).ok).toBe(false);
    });
  });

  describe('the long-text fallback', () => {
    const unmapped: HumanInputSchema = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['tags'],
    };

    it('parses a { response } submission as JSON before it checks it', () => {
      expect(checkFormSubmission(unmapped, { response: '{"tags":["a"]}' })).toEqual({
        ok: true,
        value: { tags: ['a'] },
      });
    });

    it('refuses a response that is not JSON, or JSON that does not satisfy the schema', () => {
      expect(checkFormSubmission(unmapped, { response: '{tags' }).ok).toBe(false);
      expect(checkFormSubmission(unmapped, { response: '{"tags":[]}' }).ok).toBe(false);
    });

    it('accepts the value sent directly, and does not parse a mapped form’s response', () => {
      expect(checkFormSubmission(unmapped, { tags: ['a'] }).ok).toBe(true);
      const mapped: HumanInputSchema = {
        type: 'object',
        properties: { response: { type: 'string' } },
      };
      expect(checkFormSubmission(mapped, { response: 'not json' })).toEqual({
        ok: true,
        value: { response: 'not json' },
      });
    });
  });

  it('refuses a schema it cannot use rather than accepting what it cannot check', () => {
    const result = checkFormSubmission(
      { type: 'object', properties: { a: { type: 'string', pattern: '^(a+)+$' } } },
      { a: 'aaaa' },
    );

    expect(result.ok).toBe(false);
  });
});
