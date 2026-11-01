import { describe, expect, test } from 'bun:test';

import {
  arrayValueAtPath,
  choiceBranchForValue,
  cloneJsonCompatible,
  collectJsonFields,
  createSchemaFormModel,
  decodeEnumValue,
  defaultValueForField,
  encodeEnumValue,
  fieldAtPathExists,
  getValueAtPath,
  initialDraftOf,
  initialValueForField,
  isJsonSchemaObject,
  pathId,
  pathKey,
  pruneUndefined,
  rebaseFieldPath,
  setValueAtPath,
  type JsonSchemaObject,
} from './schema-form-model.ts';

describe('schema-form model', () => {
  const schema = {
    type: 'object',
    title: 'Payload',
    properties: {
      name: { type: 'string', title: 'Name', description: 'Visible name.' },
      count: { type: 'integer', title: 'Count' },
      active: { type: 'boolean', title: 'Active' },
      mode: { type: 'string', title: 'Mode', enum: ['fast', 'safe'] },
      tags: { type: 'array', title: 'Tags', items: { type: 'string', title: 'Tag' } },
      nested: {
        type: 'object',
        title: 'Nested',
        properties: { owner: { type: 'string', title: 'Owner' } },
        required: ['owner'],
      },
      raw: { title: 'Raw payload', oneOf: [{ type: 'string' }, { type: 'number' }] },
    },
    required: ['name', 'count', 'active', 'mode', 'nested'],
  } satisfies JsonSchemaObject;

  test('labels untitled properties with humanizeIdentifier and keeps a schema title', () => {
    const model = createSchemaFormModel({
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        wrong_item: { type: 'boolean' },
        APIKey: { type: 'string' },
        callbackUrl: { type: 'string', title: 'Where to call back' },
      },
    });
    expect(model.field.fields.map((field) => field.label)).toEqual([
      'Order ID',
      'Wrong Item',
      'API Key',
      'Where to call back',
    ]);
  });

  test('detects JSON Schema object inputs', () => {
    expect(isJsonSchemaObject(schema)).toBe(true);
  });

  test('builds fields for every supported field type and preserves raw JSON fallbacks', () => {
    const model = createSchemaFormModel(schema);
    expect(model.field.kind).toBe('object');
    expect(model.field.label).toBe('Payload');
    expect(model.field.fields.map((field) => [field.key, field.kind])).toEqual([
      ['name', 'string'],
      ['count', 'integer'],
      ['active', 'boolean'],
      ['mode', 'enum'],
      ['tags', 'tags'],
      ['nested', 'object'],
      ['raw', 'json'],
    ]);

    const mode = model.field.fields.find((field) => field.key === 'mode');
    expect(mode?.options).toEqual([
      { label: 'fast', value: 'fast', encodedValue: '"fast"' },
      { label: 'safe', value: 'safe', encodedValue: '"safe"' },
    ]);

    const tags = model.field.fields.find((field) => field.key === 'tags');
    expect(tags?.item?.kind).toBe('string');

    const rawFields = collectJsonFields(model.field);
    expect(rawFields.map((field) => field.key)).toEqual(['raw']);
  });

  test('builds raw JSON fields for non-object subschemas and honors nullable type arrays', () => {
    const model = createSchemaFormModel({
      type: 'object',
      properties: {
        invalid: false,
        optionalName: { type: ['null', 'string'], title: 'Optional name' },
      },
    });

    expect(model.field.fields.map((field) => [field.key, field.kind])).toEqual([
      ['invalid', 'json'],
      ['optionalName', 'string'],
    ]);
  });

  test('creates defaults and preserves caller-provided initial values', () => {
    const model = createSchemaFormModel(schema);
    expect(defaultValueForField(model.field)).toEqual({
      name: '',
      count: undefined,
      active: false,
      mode: 'fast',
      tags: [],
      nested: { owner: '' },
      raw: null,
    });

    const initial = { name: 'Ada', count: 2, active: true, mode: 'safe' };
    expect(initialValueForField(model.field, initial)).toEqual({
      ...initial,
      tags: [],
      nested: { owner: '' },
      raw: null,
    });
  });

  test('seeds omitted fields in partial initial object and array values', () => {
    const model = createSchemaFormModel({
      type: 'object',
      properties: {
        name: { type: 'string', default: 'Ada' },
        active: { type: 'boolean' },
        nested: {
          type: 'object',
          properties: {
            owner: { type: 'string', default: 'Grace' },
            count: { type: 'integer' },
          },
        },
        contacts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', default: 'email' },
              value: { type: 'string' },
            },
          },
        },
      },
    });

    expect(
      initialValueForField(model.field, {
        active: true,
        nested: { count: 2 },
        contacts: [{ value: 'ada@example.com' }],
        extra: 'preserved',
      }),
    ).toEqual({
      name: 'Ada',
      active: true,
      nested: { owner: 'Grace', count: 2 },
      contacts: [{ kind: 'email', value: 'ada@example.com' }],
      extra: 'preserved',
    });
  });

  test('falls back to defaults when initial values cannot be cloned', () => {
    const model = createSchemaFormModel({
      type: 'object',
      properties: {
        name: { type: 'string', default: 'Ada' },
      },
    });
    const cyclicValue: Record<string, unknown> = {};
    cyclicValue['self'] = cyclicValue;

    expect(cloneJsonCompatible(cyclicValue)).toBeUndefined();
    expect(initialValueForField(model.field, cyclicValue)).toEqual({ name: 'Ada' });
  });

  test('falls back to defaults when initial values contain non-JSON numeric values', () => {
    const model = createSchemaFormModel({
      type: 'object',
      properties: {
        count: { type: 'number', default: 1 },
      },
    });

    expect(cloneJsonCompatible({ count: Number.NaN })).toBeUndefined();
    expect(cloneJsonCompatible({ count: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(cloneJsonCompatible({ count: 1n })).toBeUndefined();
    expect(initialValueForField(model.field, { count: Number.NaN })).toEqual({ count: 1 });
  });

  test('reads, writes, prunes, and lists values by schema paths', () => {
    const value = { nested: { owner: 'Ada' }, tags: ['one'], missing: undefined };
    expect(getValueAtPath(value, ['nested', 'owner'])).toBe('Ada');
    expect(getValueAtPath(value, ['tags', '0'])).toBe('one');
    expect(getValueAtPath('not an object', ['nested'])).toBeUndefined();
    expect(setValueAtPath(value, ['nested', 'owner'], 'Grace')).toEqual({
      nested: { owner: 'Grace' },
      tags: ['one'],
      missing: undefined,
    });
    expect(setValueAtPath(value.tags, ['0'], 'two')).toEqual(['two']);
    expect(arrayValueAtPath(value, ['tags'])).toEqual(['one']);
    expect(arrayValueAtPath(value, ['nested'])).toEqual([]);
    expect(pruneUndefined(value)).toEqual({ nested: { owner: 'Ada' }, tags: ['one'] });
  });

  test('does not write non-index array path segments as object properties', () => {
    const value = ['one'];

    const namedSegment = setValueAtPath(value, ['name'], 'Ada');
    const negativeIndex = setValueAtPath(value, ['-1'], 'Ada');

    expect(namedSegment).toEqual(['one']);
    expect(negativeIndex).toEqual(['one']);
    expect(Object.hasOwn(namedSegment as object, 'name')).toBe(false);
    expect(Object.hasOwn(negativeIndex as object, '-1')).toBe(false);
  });

  test('rebases array item field paths for a concrete index', () => {
    const model = createSchemaFormModel(schema);
    const tags = model.field.fields.find((field) => field.key === 'tags');
    expect(tags?.item).toBeDefined();
    const item = rebaseFieldPath(tags!.item!, ['tags', '2']);
    expect(item.path).toEqual(['tags', '2']);
  });

  test('picks the literal branch of a choice for a literal and the object branch for a record', () => {
    const choice = createSchemaFormModel({
      type: 'object',
      properties: {
        refund: {
          oneOf: [
            { const: 'whole' },
            { type: 'object', properties: { amount: { type: 'integer' } } },
          ],
        },
      },
    }).field.fields[0]!;
    const [literalBranch, objectBranch] = choice.fields;
    expect(choiceBranchForValue(choice, 'whole')).toBe(literalBranch!);
    expect(choiceBranchForValue(choice, { amount: 4 })).toBe(objectBranch!);
  });

  test('finds a host-issue path only where the form has a field for it', () => {
    const { field } = createSchemaFormModel({
      type: 'object',
      properties: {
        name: { type: 'string' },
        labels: { type: 'array', items: { enum: ['a', 'b'] } },
        notes: { type: 'array', items: { type: 'string' }, 'x-kind': 'tags' },
        rows: {
          type: 'array',
          items: { type: 'object', properties: { amount: { type: 'integer' } } },
        },
        refund: {
          oneOf: [
            { const: 'whole' },
            { type: 'object', properties: { amount: { type: 'integer' } } },
          ],
        },
      },
    });
    expect(fieldAtPathExists(field, [])).toBe(true);
    expect(fieldAtPathExists(field, ['name'])).toBe(true);
    expect(fieldAtPathExists(field, ['missing'])).toBe(false);
    // A leaf field has no children to name.
    expect(fieldAtPathExists(field, ['name', 'deeper'])).toBe(false);
    // Array items are named by index, and only by an index.
    expect(fieldAtPathExists(field, ['rows', '3', 'amount'])).toBe(true);
    expect(fieldAtPathExists(field, ['rows', '3', 'other'])).toBe(false);
    expect(fieldAtPathExists(field, ['rows', 'first'])).toBe(false);
    expect(fieldAtPathExists(field, ['labels', '1'])).toBe(true);
    // A choice answers for any of its branches.
    expect(fieldAtPathExists(field, ['refund', 'amount'])).toBe(true);
    expect(fieldAtPathExists(field, ['refund', 'other'])).toBe(false);
  });

  test('refuses a choice that does not hold both branches', () => {
    const choice = createSchemaFormModel({
      type: 'object',
      properties: { refund: { oneOf: [{ const: 'whole' }, { type: 'object' }] } },
    }).field.fields[0]!;
    expect(() => choiceBranchForValue({ ...choice, fields: [] }, 'whole')).toThrow(
      'SchemaForm choice fields hold a literal branch and an object branch.',
    );
    expect(() =>
      choiceBranchForValue({ ...choice, fields: choice.fields.slice(0, 1) }, {}),
    ).toThrow('SchemaForm choice fields hold a literal branch and an object branch.');
  });

  test('encodes path and enum values for DOM-safe ids and select values', () => {
    expect(pathKey(['a/b', 'c~d'])).toBe('a~1b/c~0d');
    expect(pathId([])).toBe('value');
    expect(pathId(['foo-bar'])).not.toBe(pathId(['foo', 'bar']));
    expect(pathId(['tags-0'])).not.toBe(pathId(['tags', '0']));
    expect(pathId(['a/b', 'c~d'])).toMatch(/^[a-zA-Z0-9_]+(?:__[a-zA-Z0-9_]+)*$/);
    expect(decodeEnumValue(encodeEnumValue(true))).toBe(true);
    expect(decodeEnumValue(encodeEnumValue(2))).toBe(2);
    expect(decodeEnumValue(encodeEnumValue(null))).toBeNull();
    expect(() => decodeEnumValue('{"not":"primitive"}')).toThrow();
  });

  test('the initial draft holds the values the fields show before any edit', () => {
    const choices: JsonSchemaObject = {
      type: 'object',
      properties: { urgency: { enum: ['low', 'high'] }, loud: { type: 'boolean' } },
    };
    expect(initialDraftOf(choices)).toEqual({ urgency: 'low', loud: false });
    expect(initialDraftOf(choices, { urgency: 'high' })).toEqual({ urgency: 'high', loud: false });
  });
});
