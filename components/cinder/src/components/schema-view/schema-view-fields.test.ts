import { describe, expect, test } from 'bun:test';

import {
  partitionRequiredFields,
  readSchemaFields,
  splitDescription,
} from './schema-view-fields.ts';
import { longValuesSchema, notifySchema, workflowSchema } from './schema-view-test-support.ts';

describe('readSchemaFields', () => {
  test('reads properties in order with formatted labels, types, descriptions and required', () => {
    const fields = readSchemaFields({
      type: 'object',
      required: ['orderId'],
      properties: {
        orderId: { type: 'string', description: 'The order to refund.' },
        refundAmount: { type: 'number' },
        wrong_item: { type: 'boolean' },
      },
    });
    expect(fields.map((field) => field.label)).toEqual(['Order ID', 'Refund amount', 'Wrong item']);
    expect(fields.map((field) => field.type)).toEqual(['text', 'number', 'yes or no']);
    expect(fields.map((field) => field.required)).toEqual([true, false, false]);
    expect(fields[0]?.description).toBe('The order to refund.');
    expect(fields[1]?.description).toBeUndefined();
  });

  test('nests the fields of an object and of the objects an array holds', () => {
    const fields = readSchemaFields({
      type: 'object',
      properties: {
        customer: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string', format: 'email' } },
        },
        lines: {
          type: 'array',
          items: { type: 'object', properties: { sku: { type: 'string' } } },
        },
      },
    });
    expect(fields[0]?.fields[0]).toMatchObject({
      label: 'Email',
      type: 'email address',
      required: true,
    });
    expect(fields[1]?.type).toBe('list of lines');
    expect(fields[1]?.fields[0]?.label).toBe('Sku');
  });

  test('follows local references and merges allOf members', () => {
    const fields = readSchemaFields({
      type: 'object',
      properties: {
        address: { $ref: '#/$defs/address' },
        contact: { allOf: [{ properties: { phone: { type: 'string' } }, required: ['phone'] }] },
      },
      $defs: {
        address: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    });
    expect(fields[0]?.type).toBe('group of fields');
    expect(fields[0]?.fields[0]).toMatchObject({ label: 'City', required: true });
    expect(fields[1]?.fields[0]).toMatchObject({ label: 'Phone', required: true });
  });

  test('describes enums, constants, unions and nullable types in one short string', () => {
    const fields = readSchemaFields({
      properties: {
        mode: { enum: ['fast', 'slow'] },
        many: { enum: ['a', 'b', 'c', 'd', 'e', 'f'] },
        kind: { const: 'refund' },
        note: { type: ['string', 'null'] },
        either: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
        anything: {},
      },
    });
    expect(fields.map((field) => field.type)).toEqual([
      'one of: fast, slow',
      'one of: a, b, c, d, e, f',
      'exactly refund',
      'text or none',
      'text or whole number',
      'anything',
    ]);
  });

  test('describes an array with no usable items schema as a bare array', () => {
    const fields = readSchemaFields({
      properties: { open: { type: 'array' }, boolean: { type: 'array', items: true } },
    });
    expect(fields.map((field) => field.type)).toEqual(['list', 'list']);
  });

  test('shows a self-reference as a recursive reference instead of expanding it again', () => {
    const fields = readSchemaFields({
      $ref: '#/$defs/node',
      $defs: {
        node: {
          type: 'object',
          properties: { name: { type: 'string' }, child: { $ref: '#/$defs/node' } },
        },
      },
    });
    expect(fields.map((field) => [field.key, field.type])).toEqual([
      ['name', 'text'],
      ['child', 'node (recursive)'],
    ]);
    expect(fields[1]?.fields).toEqual([]);
  });

  test('keeps a recursive filter-expression schema to a handful of fields', () => {
    const fields = readSchemaFields({
      type: 'object',
      properties: { filter: { $ref: '#/$defs/expression' } },
      $defs: {
        expression: {
          type: 'object',
          properties: {
            field: { type: 'string' },
            and: { type: 'array', items: { $ref: '#/$defs/expression' } },
            or: { type: 'array', items: { $ref: '#/$defs/expression' } },
            not: { $ref: '#/$defs/expression' },
          },
        },
      },
    });
    const count = (entries: typeof fields): number =>
      entries.reduce((total, entry) => total + 1 + count(entry.fields), 0);
    expect(count(fields)).toBe(5);
    expect(fields[0]?.fields.map((field) => field.type)).toEqual([
      'text',
      'list of expression (recursive)',
      'list of expression (recursive)',
      'expression (recursive)',
    ]);
  });

  test('a reference to the document root is a recursive reference', () => {
    const fields = readSchemaFields({
      type: 'object',
      properties: { parent: { $ref: '#' }, name: { type: 'string' } },
    });
    expect(fields[0]).toMatchObject({ type: 'schema (recursive)', fields: [] });
  });

  test('stops expanding a wide, non-recursive fan-out once the field budget is spent', () => {
    const defs: Record<string, unknown> = {};
    for (let level = 0; level < 9; level += 1) {
      defs[`level${level}`] = {
        type: 'object',
        properties: Object.fromEntries(
          ['a', 'b', 'c', 'd'].map((key) => [key, { $ref: `#/$defs/level${level + 1}` }]),
        ),
      };
    }
    defs['level9'] = { type: 'object', properties: { leaf: { type: 'string' } } };
    const fields = readSchemaFields({ $ref: '#/$defs/level0', $defs: defs });
    const all: typeof fields = [];
    const collect = (entries: typeof fields) => {
      for (const entry of entries) {
        all.push(entry);
        collect(entry.fields);
      }
    };
    collect(fields);
    expect(all.length).toBeLessThan(600);
    expect(all.some((field) => field.truncated)).toBe(true);
  });

  test('describes a recursive array type without looping', () => {
    const fields = readSchemaFields({
      $defs: { nested: { type: 'array', items: { $ref: '#/$defs/nested' } } },
      properties: { tree: { $ref: '#/$defs/nested' } },
    });
    expect(fields[0]?.type).toBe('list of nested (recursive)');
  });

  test('does not call an array of non-recursive references recursive', () => {
    const fields = readSchemaFields({
      type: 'object',
      properties: {
        lines: { type: 'array', items: { $ref: '#/$defs/Line' } },
        optionalLines: { type: ['array', 'null'], items: { $ref: '#/$defs/Line' } },
        tree: { type: 'array', items: { $ref: '#/$defs/Node' } },
      },
      $defs: {
        Line: { type: 'object', properties: { sku: { type: 'string' } } },
        Node: {
          type: 'object',
          properties: { children: { type: 'array', items: { $ref: '#/$defs/Node' } } },
        },
      },
    });
    const [lines, optionalLines, tree] = fields;
    expect(lines?.type).toBe('list of lines');
    expect(lines?.fields.map((field) => field.key)).toEqual(['sku']);
    expect(optionalLines?.type).toBe('list of optional lines or none');
    expect(optionalLines?.fields.map((field) => field.key)).toEqual(['sku']);
    expect(tree?.type).toBe('list of tree');
    expect(tree?.fields[0]?.type).toBe('list of Node (recursive)');
  });

  test('merges the property schemas of allOf members that describe the same property', () => {
    const fields = readSchemaFields({
      allOf: [
        {
          type: 'object',
          properties: {
            customer: {
              type: 'object',
              required: ['email'],
              properties: { email: { type: 'string' } },
            },
          },
        },
        { properties: { customer: { properties: { name: { type: 'string' } } } } },
      ],
    });
    const customer = fields[0]?.fields ?? [];
    expect(customer.map((field) => field.key)).toEqual(['email', 'name']);
    expect(customer[0]?.required).toBe(true);
  });

  test('keeps referenced properties and required entries beside sibling keywords', () => {
    const fields = readSchemaFields({
      $ref: '#/$defs/base',
      properties: { extra: { type: 'number' } },
      required: ['extra'],
      $defs: {
        base: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    });
    expect(fields.map((field) => [field.key, field.required])).toEqual([
      ['id', true],
      ['extra', true],
    ]);
  });

  test('a dangling reference and an inherited key name are treated as unresolved', () => {
    const fields = readSchemaFields({
      properties: {
        missing: { $ref: '#/$defs/nope' },
        proto: { $ref: '#/constructor' },
      },
    });
    expect(fields.map((field) => field.type)).toEqual(['anything', 'anything']);
  });

  test('a schema that is not an object with properties yields one Value line', () => {
    expect(readSchemaFields({ type: 'string', description: 'A name.' })).toMatchObject([
      { label: 'Value', type: 'text', description: 'A name.' },
    ]);
  });

  test('true, an empty schema and non-objects yield no fields', () => {
    expect(readSchemaFields(true)).toEqual([]);
    expect(readSchemaFields({})).toEqual([]);
    expect(readSchemaFields(null)).toEqual([]);
    expect(readSchemaFields('string')).toEqual([]);
  });

  test('keeps non-object alternatives readable without treating them as choice branches', () => {
    expect(readSchemaFields({ oneOf: [true, { type: 'string' }] })).toMatchObject([
      { key: 'value', type: 'text' },
    ]);
  });

  test('expands object alternatives declared at the schema root', () => {
    const fields = readSchemaFields({
      oneOf: [
        { properties: { email: { type: 'string' } } },
        { properties: { webhook: { type: 'string' } } },
      ],
    });
    expect(fields.map((field) => field.label)).toEqual([
      'If option 1: Email',
      'If option 2: Webhook',
    ]);
    expect(fields.map((field) => field.path)).toEqual(['option 1:email', 'option 2:webhook']);
  });

  test('keeps the file order and puts the required fields first only on request', () => {
    const fields = readSchemaFields(workflowSchema);
    expect(fields.map((field) => field.key)).toEqual([
      'title',
      'description',
      'id',
      'steps',
      'trigger',
      'inputSchema',
      'outputSchema',
      'paused',
    ]);
    const { required, optional } = partitionRequiredFields(fields);
    expect(required.map((field) => field.key)).toEqual(['steps', 'trigger']);
    expect(optional.map((field) => field.key)).toEqual([
      'title',
      'description',
      'id',
      'inputSchema',
      'outputSchema',
      'paused',
    ]);
  });

  test('names types in plain words', () => {
    const types = Object.fromEntries(
      readSchemaFields(workflowSchema).map((field) => [field.key, field.type]),
    );
    expect(types).toEqual({
      title: 'text',
      description: 'text',
      id: 'text',
      steps: 'list of steps',
      trigger: 'one of: schedule, signal, manual',
      inputSchema: 'JSON schema',
      outputSchema: 'JSON schema',
      paused: 'yes or no',
    });
    const steps = readSchemaFields(workflowSchema).find((field) => field.key === 'steps');
    expect(steps?.fields.map((field) => field.type)).toEqual([
      'text',
      'text',
      'one of: activity, wait',
      'text',
    ]);
  });

  test('marks nested fields required on their own object and keeps their order', () => {
    const steps = readSchemaFields(workflowSchema).find((field) => field.key === 'steps');
    expect(steps?.fields.map((field) => [field.label, field.required])).toEqual([
      ['Name', true],
      ['Title', false],
      ['Kind', true],
      ['Handler', false],
    ]);
  });

  test('lists each branch of a choice under it, labelled by the branch and its own required fields', () => {
    const trigger = readSchemaFields(workflowSchema).find((field) => field.key === 'trigger');
    expect(trigger?.fields.map((field) => [field.label, field.required])).toEqual([
      ['If schedule: Cron', true],
      ['If schedule: Time zone', false],
      ['If schedule: Catch up', false],
      ['If signal: Signal name', true],
    ]);
    const notify = readSchemaFields(notifySchema)[0];
    expect(notify?.type).toBe('one of: email, slack, webhook');
    expect(notify?.fields.map((field) => [field.label, field.required, field.summary])).toEqual([
      ['If email: Address', true, 'Who receives it.'],
      ['If slack: Channel', true, 'The channel name, such as #refunds.'],
      ['If webhook: URL', true, 'Called with the summary as JSON.'],
      ['If webhook: Secret', false, 'Sent as a header. Never shown again.'],
    ]);
  });

  test('gives every field a path that is unique, including fields that share a name across branches', () => {
    const paths: string[] = [];
    const collect = (entries: ReturnType<typeof readSchemaFields>) => {
      for (const entry of entries) {
        paths.push(entry.path);
        collect(entry.fields);
      }
    };
    collect(readSchemaFields(workflowSchema));
    collect(
      readSchemaFields({
        properties: {
          pick: {
            oneOf: [
              { properties: { kind: { const: 'a' }, value: { type: 'string' } } },
              { properties: { kind: { const: 'b' }, value: { type: 'string' } } },
            ],
          },
        },
      }),
    );
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('trigger/schedule:cron');
    expect(paths).toContain('pick/a:value');
    expect(paths).toContain('pick/b:value');
  });

  test('names branches by title, then by position, when no constant tells them apart', () => {
    const [titled] = readSchemaFields({
      properties: {
        pick: {
          oneOf: [
            { title: 'Card', properties: { number: { type: 'string' } } },
            { title: 'Bank', properties: { account: { type: 'string' } } },
          ],
        },
      },
    });
    expect(titled?.type).toBe('one of: Card, Bank');
    expect(titled?.fields.map((field) => field.label)).toEqual([
      'If Card: Number',
      'If Bank: Account',
    ]);
    const [numbered] = readSchemaFields({
      properties: {
        pick: {
          anyOf: [
            { properties: { a: { type: 'string' } } },
            { properties: { b: { type: 'string' } } },
          ],
        },
      },
    });
    expect(numbered?.type).toBe('one of: option 1, option 2');
    expect(numbered?.fields.map((field) => field.label)).toEqual([
      'If option 1: A',
      'If option 2: B',
    ]);
  });

  test('a choice between plain types is one type, not a choice of branches', () => {
    const [field] = readSchemaFields({
      properties: { limit: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
    });
    expect(field?.type).toBe('text or number');
    expect(field?.fields).toEqual([]);
  });

  test('a branch of a choice that is itself nested still expands, and a deep branch is cut at maxDepth', () => {
    const schema = {
      properties: {
        pick: {
          oneOf: [
            {
              properties: {
                kind: { const: 'a' },
                inner: { type: 'object', properties: { leaf: { type: 'string' } } },
              },
            },
            { properties: { kind: { const: 'b' } } },
          ],
        },
      },
    };
    const [pick] = readSchemaFields(schema);
    expect(pick?.fields[0]?.label).toBe('If a: Inner');
    expect(pick?.fields[0]?.fields.map((field) => field.label)).toEqual(['Leaf']);
    const [cut] = readSchemaFields(schema, 0);
    expect(cut?.fields).toEqual([]);
    expect(cut?.truncated).toBe(true);
  });

  test('names a format in words and leaves other formats as text', () => {
    const fields = readSchemaFields({
      properties: {
        when: { type: 'string', format: 'date-time' },
        site: { type: 'string', format: 'uri' },
        other: { type: 'string', format: 'hostname' },
        flag: { type: 'string', format: 'json-schema' },
        count: { type: 'integer' },
      },
    });
    expect(fields.map((field) => field.type)).toEqual([
      'date and time',
      'link',
      'text',
      'JSON schema',
      'whole number',
    ]);
  });

  test('a long unbroken enum value stays whole in its type', () => {
    const [, tracking] = readSchemaFields(longValuesSchema);
    expect(tracking?.type).toBe(
      'one of: QmVkS3Jvbm9zUHJpbWVWZXJ0ZXhDb250cm9sbGVyU2Vzc2lvblRva2VuQmFzZTY0…, other',
    );
  });
});

describe('splitDescription', () => {
  test('the first paragraph is the summary and the rest is the detail', () => {
    expect(splitDescription('The work to do, in order.\n\nEach step runs. Top to bottom.')).toEqual(
      {
        summary: 'The work to do, in order.',
        detail: 'Each step runs. Top to bottom.',
      },
    );
  });

  test('a description of one paragraph has no detail, however many sentences it has', () => {
    expect(splitDescription('A friendly name. Optional.')).toEqual({
      summary: 'A friendly name. Optional.',
    });
  });

  test('line breaks inside a paragraph read as spaces and later paragraphs join with one space', () => {
    expect(splitDescription('One\nline.\n\nSecond\nparagraph.\n  \nThird.')).toEqual({
      summary: 'One line.',
      detail: 'Second paragraph. Third.',
    });
  });

  test('drops blank detail paragraphs while joining the remaining text', () => {
    expect(splitDescription('Summary\n\n   \n\nDetail')).toEqual({
      summary: 'Summary',
      detail: 'Detail',
    });
  });
});
