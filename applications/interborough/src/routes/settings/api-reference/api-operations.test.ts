/**
 * The operations Settings › API reference lists, read from the server's OpenAPI description: which
 * routes are operations, the scope each needs, its group, and the example request and response made
 * from its schemas.
 */
import { describe, expect, test } from 'bun:test';

import {
  buildApiOperations,
  exampleOf,
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
        operationId: 'weft.workflows.list',
        summary: 'List runs',
        tags: ['Runs'],
        'x-weft-access': { kind: 'scoped', scopes: { kind: 'allOf', scopes: ['workflows:read'] } },
        responses: { '200': {} },
      },
      post: {
        operationId: 'weft.workflows.start',
        summary: 'Start a run',
        tags: ['Runs'],
        'x-weft-access': { kind: 'scoped', scopes: { kind: 'allOf', scopes: ['workflows:write'] } },
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
        operationId: 'weft.agents.list',
        summary: 'List agents',
        'x-weft-access': { kind: 'authenticated' },
        responses: { '200': {} },
      },
    },
    '/v1/health': {
      get: {
        operationId: 'healthCheck',
        summary: 'Health',
        tags: ['System'],
        responses: { '200': {} },
      },
    },
  },
};

describe('buildApiOperations', () => {
  const operations = buildApiOperations(DOCUMENT);

  test('lists the routes that carry an access policy and leaves out the ones that do not', () => {
    expect(operations.map((operation) => `${operation.method} ${operation.path}`)).toEqual([
      'GET /api/agents',
      'GET /api/runs',
      'POST /api/runs',
    ]);
  });

  test('keys every row apart, even where the document gives two operations one operationId', () => {
    const repeated = buildApiOperations({
      paths: {
        '/api/workflows/{id}/query/{name}': {
          get: {
            operationId: 'weft.workflows.query',
            'x-weft-access': { kind: 'authenticated' },
            responses: { '200': {} },
          },
          post: {
            operationId: 'weft.workflows.query',
            'x-weft-access': { kind: 'authenticated' },
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
    const start = operations.find((operation) => operation.id === 'weft.workflows.start');
    expect(start).toMatchObject({
      summary: 'Start a run',
      group: 'Runs',
      scope: 'workflows:write',
    });
    expect(operations.find((operation) => operation.id === 'weft.agents.list')).toMatchObject({
      group: 'Other',
      scope: undefined,
    });
  });

  test('makes the example request from the required fields of its schema', () => {
    const start = operations.find((operation) => operation.id === 'weft.workflows.start');
    expect(JSON.parse(start?.request ?? 'null')).toEqual({
      workflow: 'string',
      input: { order: 0 },
    });
  });

  test('makes the example response from the success status, and takes none for an operation without one', () => {
    const start = operations.find((operation) => operation.id === 'weft.workflows.start');
    expect(start?.responseStatus).toBe('201');
    expect(JSON.parse(start?.response ?? 'null')).toEqual({ run: 'string', status: 'running' });
    const list = operations.find((operation) => operation.id === 'weft.workflows.list');
    expect(list?.request).toBeUndefined();
    expect(list?.responseStatus).toBe('200');
    expect(list?.response).toBeUndefined();
  });

  test('lists the groups in the order the table does', () => {
    expect(operationGroups(operations)).toEqual(['Other', 'Runs']);
  });

  test('an empty document lists nothing', () => {
    expect(buildApiOperations({})).toEqual([]);
  });
});

describe('scopeOf', () => {
  test('names the scopes of a scoped policy, joined by what it needs of them', () => {
    expect(
      scopeOf({ kind: 'scoped', scopes: { kind: 'allOf', scopes: ['a:read', 'b:read'] } }),
    ).toBe('a:read, b:read');
    expect(
      scopeOf({ kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['a:read', 'b:read'] } }),
    ).toBe('a:read or b:read');
  });

  test('joins the alternatives of a policy that offers them', () => {
    expect(
      scopeOf({
        kind: 'scopedAlternatives',
        alternatives: [
          { kind: 'allOf', scopes: ['a:read'] },
          { kind: 'allOf', scopes: ['b:write'] },
        ],
      }),
    ).toBe('a:read or b:write');
  });

  test('is nothing for a policy any caller satisfies', () => {
    expect(scopeOf({ kind: 'public' })).toBeUndefined();
    expect(scopeOf({ kind: 'authenticated' })).toBeUndefined();
    expect(scopeOf(undefined)).toBeUndefined();
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
