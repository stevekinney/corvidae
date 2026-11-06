/**
 * The OpenAPI description of Interborough's own HTTP API, served at `GET /api/openapi.json` (board
 * PageSettingsSections, "API reference · Discovery documents": "Every operation, for generating a
 * client."). It names the seven operations `api-routes.ts` serves, in the order Settings › API
 * reference lists them, each with the scope it needs as `x-interborough-scope`, its group as its
 * one tag, and its request and response schemas made from the schemas the routes validate with
 * (`api-contract.ts`), with an example of each.
 *
 * Weft's own description of its engine operations stays at `/openapi.json`.
 *
 * @module api-description
 */
import { z } from 'zod';

import type { ApiScope } from '../lib/api-scopes.ts';
import {
  agentList,
  apiFault,
  chatParameters,
  decisionBody,
  decisionMade,
  messageBody,
  messageSent,
  reviewParameters,
  runDetail,
  runList,
  runListQuery,
  runParameters,
  runStartBody,
  runStarted,
  scheduleList,
  scheduleListQuery,
} from './api-contract.ts';

/** The route the description is served at. */
export const API_DESCRIPTION_ROUTE = '/api/openapi.json';

/** The version of the API the description describes. It changes when an operation does. */
export const API_VERSION = '0.1.0';

/** The OpenAPI extension that names the scope an operation needs. */
export const API_SCOPE_EXTENSION = 'x-interborough-scope';

type JsonSchema = Record<string, unknown>;

/** The schema of a query or of path parameters: an object of named fields. */
export type ParameterSchema = z.ZodObject<Record<string, z.ZodType>>;

/** One operation, as the description names it. */
export interface ApiOperationDescription {
  /** The HTTP method, in lower case as OpenAPI writes it. */
  readonly method: 'get' | 'post';
  /** The path, with each parameter in braces as OpenAPI writes it. */
  readonly path: string;
  /** The operation's identifier. */
  readonly operationId: string;
  /** What the operation does, in a few words: the Operations table's "What it does". */
  readonly summary: string;
  /** What the operation does, in a sentence or two. */
  readonly description: string;
  /** The group the operation belongs to: its one tag. */
  readonly group: string;
  /** The scope the operation needs. */
  readonly scope: ApiScope;
  /** The query the operation reads, if any. */
  readonly parameters?: ParameterSchema;
  /** The path parameters the operation reads, if any. */
  readonly pathParameters?: ParameterSchema;
  /** The body the operation takes, with an example of it, if it takes one. */
  readonly body?: { readonly schema: z.ZodType; readonly example: unknown };
  /** The status the operation answers with when it succeeds, its body, and an example of it. */
  readonly response: {
    readonly status: string;
    readonly schema: z.ZodType;
    readonly example: unknown;
  };
  /** Whether the operation names something that may not exist, and so can answer `404`. */
  readonly names?: boolean;
}

const RUN_EXAMPLE = {
  run: 'run-1-9f3a',
  workflow: 'order-refund',
  status: 'running',
  createdAt: '2026-11-06T09:41:00.000Z',
  updatedAt: '2026-11-06T09:41:02.000Z',
} as const;

/** The seven operations, in the order the description lists them. */
export const API_OPERATIONS: readonly ApiOperationDescription[] = [
  {
    method: 'get',
    path: '/api/runs',
    operationId: 'runs.list',
    summary: 'List runs',
    description: 'Lists the runs of every workflow, a page at a time.',
    group: 'Runs',
    scope: 'runs:read',
    parameters: runListQuery,
    response: {
      status: '200',
      schema: runList,
      example: { runs: [RUN_EXAMPLE], nextOffset: null },
    },
  },
  {
    method: 'post',
    path: '/api/runs',
    operationId: 'runs.start',
    summary: 'Start a run',
    description:
      'Starts a run of a workflow with the input its schema describes. An input the schema refuses is answered `400` with every issue, and nothing starts.',
    group: 'Runs',
    scope: 'runs:write',
    body: { schema: runStartBody, example: { workflow: 'order-refund', input: { order: 4471 } } },
    response: {
      status: '201',
      schema: runStarted,
      example: { run: 'run-1-9f3a', status: 'running' },
    },
    names: true,
  },
  {
    method: 'get',
    path: '/api/runs/{run}',
    operationId: 'runs.get',
    summary: 'Get one run and its steps',
    description: 'Reads one run, how it stands, and each step it has taken.',
    group: 'Runs',
    scope: 'runs:read',
    pathParameters: runParameters,
    response: {
      status: '200',
      schema: runDetail,
      example: {
        ...RUN_EXAMPLE,
        steps: [
          {
            step: 0,
            operation: 'look-up-order',
            type: 'activity',
            status: 'completed',
            startedAt: '2026-11-06T09:41:00.500Z',
            durationMilliseconds: 420,
          },
        ],
      },
    },
    names: true,
  },
  {
    method: 'post',
    path: '/api/chats/{chat}/messages',
    operationId: 'chats.messages.send',
    summary: 'Send a message to a chat',
    description: 'Sends a message to a chat and starts the turn in which its agent answers it.',
    group: 'Chats',
    scope: 'chats:write',
    pathParameters: chatParameters,
    body: { schema: messageBody, example: { text: 'Refund order 4471 in full.' } },
    response: {
      status: '201',
      schema: messageSent,
      example: { chat: 'chat-7c21', run: 'task-2-b81e' },
    },
    names: true,
  },
  {
    method: 'get',
    path: '/api/agents',
    operationId: 'agents.list',
    summary: 'List agents',
    description: 'Lists the agents that are ready to run, defined in code or in a file.',
    group: 'Agents',
    scope: 'agents:read',
    response: {
      status: '200',
      schema: agentList,
      example: {
        agents: [
          {
            agent: 'assistant',
            name: 'Assistant',
            description: 'Answers questions and runs tools.',
            kind: 'file',
          },
        ],
      },
    },
  },
  {
    method: 'get',
    path: '/api/schedules',
    operationId: 'schedules.list',
    summary: 'List schedules',
    description: 'Lists the schedules and when each next starts a run, a page at a time.',
    group: 'Schedules',
    scope: 'schedules:read',
    parameters: scheduleListQuery,
    response: {
      status: '200',
      schema: scheduleList,
      example: {
        schedules: [
          {
            schedule: 'weekly-refund-audit',
            workflow: 'order-refund',
            description: 'Weekly refund audit',
            status: 'active',
            nextRunAt: '2026-11-09T09:00:00.000Z',
          },
        ],
        nextOffset: null,
      },
    },
  },
  {
    method: 'post',
    path: '/api/reviews/{review}/decision',
    operationId: 'reviews.decide',
    summary: 'Approve or deny a review',
    description:
      'Approves or denies what a review is waiting on: a tool call, or a question a run asked a person.',
    group: 'Reviews',
    scope: 'reviews:write',
    pathParameters: reviewParameters,
    body: { schema: decisionBody, example: { decision: 'approve' } },
    response: {
      status: '200',
      schema: decisionMade,
      example: { review: 'review-3-0d4c', decision: 'approve' },
    },
    names: true,
  },
];

function jsonSchemaOf(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: 'any' });
  return rest;
}

function parametersOf(schema: ParameterSchema, where: 'query' | 'path'): readonly JsonSchema[] {
  return Object.entries(schema.shape).map(([name, field]) => {
    const described = jsonSchemaOf(field, 'input');
    const { description, ...parameterSchema } = described;
    return {
      name,
      in: where,
      required: where === 'path' || !field.safeParse(undefined).success,
      ...(typeof description === 'string' ? { description } : {}),
      schema: parameterSchema,
    };
  });
}

function json(schema: JsonSchema, example: unknown): JsonSchema {
  return { content: { 'application/json': { schema: { ...schema, example } } } };
}

function refusal(description: string): JsonSchema {
  return {
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Fault' } } },
  };
}

function operationOf(operation: ApiOperationDescription): JsonSchema {
  const parameters = [
    ...(operation.pathParameters === undefined
      ? []
      : parametersOf(operation.pathParameters, 'path')),
    ...(operation.parameters === undefined ? [] : parametersOf(operation.parameters, 'query')),
  ];
  return {
    operationId: operation.operationId,
    summary: operation.summary,
    description: operation.description,
    tags: [operation.group],
    [API_SCOPE_EXTENSION]: operation.scope,
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(operation.body === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            ...json(jsonSchemaOf(operation.body.schema, 'input'), operation.body.example),
          },
        }),
    responses: {
      [operation.response.status]: {
        description: operation.summary,
        ...json(jsonSchemaOf(operation.response.schema, 'output'), operation.response.example),
      },
      '400': refusal('The request is not what the operation takes.'),
      '403': refusal(`The session does not hold ${operation.scope}.`),
      ...(operation.names === true ? { '404': refusal('Nothing has that identifier.') } : {}),
    },
  };
}

/**
 * The description, naming `origin` as the server a client calls. It is the same for every caller:
 * what a session may do is what `GET /host/session` says.
 */
export function apiDescription(origin: string): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const operation of API_OPERATIONS) {
    paths[operation.path] = {
      ...paths[operation.path],
      [operation.method]: operationOf(operation),
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Interborough',
      version: API_VERSION,
      description:
        'Runs, chats, agents, schedules and reviews. Interborough is single-user for now, so the person at the keyboard holds every scope; each operation names the one it needs.',
    },
    servers: [{ url: origin }],
    tags: [...new Set(API_OPERATIONS.map((operation) => operation.group))].map((name) => ({
      name,
    })),
    paths,
    components: { schemas: { Fault: jsonSchemaOf(apiFault, 'output') } },
  };
}
