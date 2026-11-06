/**
 * The operations Settings › API reference lists, read from the server's OpenAPI description: which
 * routes are operations, the scope each needs, its group, and the example request and response made
 * from its schemas.
 */
import { describe, expect, test } from 'bun:test';

import {
  buildApiOperations,
  exampleOf,
  formatExample,
  operationGroups,
  scopeOf,
  type OpenApiDocumentLike,
} from './api-operations.ts';

const DOCUMENT: OpenApiDocumentLike = {
  components: {
    schemas: {
      StartInput: {
        type: 'object',
        required: ['workflow', 'input'],
        properties: {
          workflow: { type: 'string' },
          input: {
            type: 'object',
            properties: { order: { type: 'integer' } },
            required: ['order'],
          },
          note: { type: 'string' },
        },
      },
      Started: {
        type: 'object',
        required: ['run', 'status'],
        properties: { run: { type: 'string' }, status: { enum: ['running', 'done'] } },
      },
    },
  },
  paths: {
    '/api/runs': {
      get: {
        operationId: 'runs.list',
        summary: 'List runs',
        tags: ['Runs'],
        'x-interborough-scope': 'runs:read',
        responses: { '200': {} },
      },
      post: {
        operationId: 'runs.start',
        summary: 'Start a run',
        tags: ['Runs'],
        'x-interborough-scope': 'runs:write',
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/StartInput' } } },
        },
        responses: {
          '201': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Started' } } },
          },
          '404': {},
        },
      },
    },
    '/api/agents': {
      get: {
        operationId: 'agents.list',
        summary: 'List agents',
        responses: { '200': {} },
      },
    },
  },
};

describe('buildApiOperations', () => {
  const operations = buildApiOperations(DOCUMENT);

  test('lists every operation in the order the document does: by path, then by method', () => {
    expect(operations.map((operation) => `${operation.method} ${operation.path}`)).toEqual([
      'GET /api/runs',
      'POST /api/runs',
      'GET /api/agents',
    ]);
  });

  test('keys every row apart, even where the document gives two operations one operationId', () => {
    const repeated = buildApiOperations({
      paths: {
        '/api/workflows/{id}/query/{name}': {
          get: {
            operationId: 'weft.workflows.query',
            responses: { '200': {} },
          },
          post: {
            operationId: 'weft.workflows.query',
            responses: { '200': {} },
          },
        },
      },
    });
    const identifiers = repeated.map((operation) => operation.id);
    expect(identifiers).toHaveLength(2);
    expect(new Set(identifiers).size).toBe(2);
  });

  test('says each operation’s summary, group and scope', () => {
    const start = operations.find((operation) => operation.id === 'runs.start');
    expect(start).toMatchObject({
      summary: 'Start a run',
      group: 'Runs',
      scope: 'runs:write',
    });
    expect(operations.find((operation) => operation.id === 'agents.list')).toMatchObject({
      group: 'Other',
      scope: undefined,
    });
  });

  test('makes the example request from the required fields of its schema', () => {
    const start = operations.find((operation) => operation.id === 'runs.start');
    expect(JSON.parse(start?.request ?? 'null')).toEqual({
      workflow: 'string',
      input: { order: 0 },
    });
  });

  test('makes the example response from the success status, and takes none for an operation without one', () => {
    const start = operations.find((operation) => operation.id === 'runs.start');
    expect(start?.responseStatus).toBe('201');
    expect(JSON.parse(start?.response ?? 'null')).toEqual({ run: 'string', status: 'running' });
    const list = operations.find((operation) => operation.id === 'runs.list');
    expect(list?.request).toBeUndefined();
    expect(list?.responseStatus).toBe('200');
    expect(list?.response).toBeUndefined();
  });

  test('lists the groups in the order the table does', () => {
    expect(operationGroups(operations)).toEqual(['Runs', 'Other']);
  });

  test('an empty document lists nothing', () => {
    expect(buildApiOperations({})).toEqual([]);
  });
});

describe('scopeOf', () => {
  test('is the scope the operation names', () => {
    expect(scopeOf({ 'x-interborough-scope': 'runs:read' })).toBe('runs:read');
  });

  test('is nothing for an operation that names none', () => {
    expect(scopeOf({})).toBeUndefined();
    expect(scopeOf({ 'x-interborough-scope': '' })).toBeUndefined();
  });
});

describe('formatExample', () => {
  test('writes a short example on one line, spaced as the board draws it', () => {
    expect(formatExample({ workflow: 'order-refund', input: { order: 4471 } })).toBe(
      '{ "workflow": "order-refund", "input": { "order": 4471 } }',
    );
    expect(formatExample({ list: [1, 'a'], empty: {}, none: [] })).toBe(
      '{ "list": [1, "a"], "empty": {}, "none": [] }',
    );
  });

  test('indents an example too long for one line', () => {
    const long = { description: 'x'.repeat(80) };
    expect(formatExample(long)).toBe(JSON.stringify(long, null, 2));
  });
});

describe('exampleOf', () => {
  test('prefers a stated example, then a constant, a default and the first enum value', () => {
    expect(exampleOf({ type: 'string', example: 'x', default: 'y' }, {})).toBe('x');
    expect(exampleOf({ const: 3 }, {})).toBe(3);
    expect(exampleOf({ default: 'y' }, {})).toBe('y');
    expect(exampleOf({ enum: ['a', 'b'] }, {})).toBe('a');
  });

  test('draws an array of one item and takes the first alternative of a union', () => {
    expect(exampleOf({ type: 'array', items: { type: 'boolean' } }, {})).toEqual([false]);
    expect(exampleOf({ anyOf: [{ type: 'integer' }, { type: 'string' }] }, {})).toBe(0);
  });

  test('stops at a depth, and at a reference that names nothing', () => {
    const deep: OpenApiDocumentLike = {
      components: {
        schemas: { Node: { type: 'array', items: { $ref: '#/components/schemas/Node' } } },
      },
    };
    expect(JSON.stringify(exampleOf({ $ref: '#/components/schemas/Node' }, deep))).toBe(
      '[[[[[]]]]]',
    );
    expect(exampleOf({ $ref: '#/components/schemas/Missing' }, {})).toEqual({});
  });
});
