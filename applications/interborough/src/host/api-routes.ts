/**
 * Interborough's own HTTP API (board PageSettingsSections, "API reference · Operations"): the seven
 * operations a person's programs use, each implemented over the Bureau and checked against the
 * caller's scopes (`src/lib/api-scopes.ts`).
 *
 * - `GET /api/runs` lists runs (`runs:read`).
 * - `POST /api/runs` starts a run of a workflow (`runs:write`).
 * - `GET /api/runs/{run}` reads one run and its steps (`runs:read`).
 * - `POST /api/chats/{chat}/messages` sends a message to a chat (`chats:write`), or answers `409`
 *   while the chat has a turn in progress, as Chat's own send does.
 * - `GET /api/agents` lists agents (`agents:read`).
 * - `GET /api/schedules` lists schedules (`schedules:read`).
 * - `POST /api/reviews/{review}/decision` approves or denies a review (`reviews:write`).
 *
 * `GET /api/openapi.json` describes them (`api-description.ts`), and `GET /host/session` says who
 * the session is and which scopes it holds. Weft's engine operations under `/api/v1` are relayed to
 * Weft's server as before; none of these paths is one of them.
 *
 * Every request passes the host's request guard first. Then the scope is checked, before anything
 * in the request is read, so a session without the scope learns nothing about what it named. Then
 * the path, the query and the body are validated, and a request that fails is answered `400` with
 * every issue. A refusal is JSON of the shape `apiFault` describes (`api-contract.ts`).
 *
 * The same scopes gate the Bureau operations, AG-UI runs and settings routes Interborough's own
 * pages call (`scope-gate.ts`), so a scope this API lists is one the whole host enforces.
 *
 * @module api-routes
 */
import { BureauError, WorkflowInputInvalidError } from '@lostgradient/bureau';
import type { z } from 'zod';

import { API_SCOPES, type ApiScope } from '../lib/api-scopes.ts';
import { HOST_SESSION_ROUTE, type HostSession } from '../lib/host-session.ts';
import {
  agentList,
  chatParameters,
  decisionBody,
  decisionMade,
  emptyQuery,
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
  type ApiFault,
} from './api-contract.ts';

/** Who a request acts as, and the scopes of Interborough's API it holds. */
export interface ApiPrincipal {
  /** The principal the Bureau records as the owner of what the request starts or decides. */
  readonly subject: string;
  /** The scopes the request holds. */
  readonly scopes: ReadonlySet<ApiScope>;
}

/** A run of a workflow, as the Bureau lists it. */
interface RunRecord {
  readonly id: string;
  readonly workflow: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error?: string;
}

/** One step of a run, as the engine's timeline records it. */
export interface ApiTimelineEntry {
  /** The step's place in the run. */
  readonly step: number;
  /** The kind of operation the step was. */
  readonly operationType: string;
  /** What the step did, as the workflow names it. */
  readonly operationLabel: string;
  /** Where the step is. */
  readonly status: string;
  /** When the step started, in milliseconds since the epoch. */
  readonly timestamp: number;
  /** How long the step took, in milliseconds, once it has finished. */
  readonly duration?: number;
}

/**
 * The parts of the Bureau the API calls. It is the Bureau's own interface, narrowed to what the
 * seven operations need, so a test can stand in for it.
 */
export interface ApiBureau {
  /** The workflow files and their runs, or `undefined` when the Bureau has no workflows. */
  readonly workflows:
    | {
        listRuns(filter: {
          readonly workflow?: string | undefined;
          readonly status?: string | undefined;
          readonly limit: number;
          readonly offset: number;
        }): Promise<{ readonly runs: readonly RunRecord[]; readonly nextOffset: number | null }>;
        getRun(runId: string): Promise<RunRecord | undefined>;
        start(
          id: string,
          options: { readonly input?: unknown; readonly owner: string; readonly surface?: 'api' },
        ): Promise<{ readonly runId: string }>;
      }
    | undefined;
  /** The chats, by the context each one is. */
  readonly contexts: {
    get(id: string): Promise<{ readonly agentName: string } | undefined>;
  };
  /** The agents the deployment has. */
  readonly agents: {
    list(): readonly {
      readonly id: string;
      readonly source: 'code' | 'file';
      readonly state: string;
      readonly name: string;
      readonly description: string | null;
    }[];
  };
  /** The schedules. */
  readonly schedules: {
    list(filter: { readonly limit: number; readonly offset: number }): Promise<
      | {
          readonly items: readonly {
            readonly id: string;
            readonly workflowType: string;
            readonly description?: string | undefined;
            readonly status: string;
            readonly nextFireAt: number | null;
          }[];
          readonly total: number;
        }
      | undefined
    >;
  };
  /** The reviews waiting on a person. */
  readonly reviews: {
    resolve(input: {
      readonly id: string;
      readonly decision: 'approve' | 'deny';
      readonly principal: string;
      readonly reason?: string;
    }): Promise<{ readonly id: string; readonly decision: 'approve' | 'deny' | 'reject' }>;
  };
}

/** What the API routes need from the host. */
export interface ApiRouteDependencies {
  /** The Bureau the operations call. */
  readonly bureau: ApiBureau;
  /** The engine's timeline of a run: its steps, in the order they ran. */
  readonly timeline: (runId: string) => Promise<readonly ApiTimelineEntry[]>;
  /** Who a request acts as. */
  readonly principal: (request: Request) => ApiPrincipal;
  /**
   * Starts the turn that answers a message sent to a chat, under the same admission Chat's own send
   * path takes (the chat's thread lease, then whether a run is live on it): it throws a
   * {@link BureauError} with code `CONFLICT` while the chat has a turn in progress, so the API
   * answers 409 and never starts a second run on the session. Bureau's `startIdleTurn` is that.
   */
  readonly startTurn: (input: {
    readonly threadId: string;
    readonly input: string;
    readonly principal: string;
  }) => Promise<{ readonly id: string }>;
}

/** The path of every API operation, as Bun's router names it. */
export const API_ROUTES = {
  runs: '/api/runs',
  run: '/api/runs/:run',
  chatMessages: '/api/chats/:chat/messages',
  agents: '/api/agents',
  schedules: '/api/schedules',
  reviewDecision: '/api/reviews/:review/decision',
} as const;

/**
 * The one local person Interborough serves for now, holding every scope (Interborough v1 is
 * single-user). The host answers only on its own loopback address, behind the request guard.
 */
export function localApiPrincipal(subject: string): ApiPrincipal {
  return { subject, scopes: new Set(API_SCOPES) };
}

/** The largest request body an operation reads. */
const MAXIMUM_BODY_BYTES = 256 * 1024;

type Refuse = (request: Request) => Response | undefined;
type Parameters = Readonly<Record<string, string>>;

/** A request an operation refuses before calling the Bureau. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly fault: ApiFault,
  ) {
    super(fault.message);
  }
}

function refuseWith(status: number, body: ApiFault): Response {
  return Response.json(body, { status });
}

function invalid(error: z.ZodError, where: string): Refusal {
  return new Refusal(400, {
    error: 'invalid',
    message: `The ${where} is not what this operation takes.`,
    issues: error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  });
}

function parse<T>(schema: z.ZodType<T>, value: unknown, where: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid(result.error, where);
  return result.data;
}

function queryOf(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams);
}

async function bodyOf(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAXIMUM_BODY_BYTES) {
    throw new Refusal(400, { error: 'invalid', message: 'The request body is too large.' });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Refusal(400, { error: 'invalid', message: 'The request body is not valid JSON.' });
  }
}

/** The answer an error from the Bureau stands for. The message never repeats a value it was given. */
function answerFor(error: unknown): Response {
  if (error instanceof Refusal) return refuseWith(error.status, error.fault);
  if (error instanceof WorkflowInputInvalidError) {
    return refuseWith(400, {
      error: 'invalid',
      message: 'The input is not what the workflow takes.',
      issues: error.issues.map((issue) => ({
        path: ['input', ...issue.path.map(String)].join('.'),
        message: issue.message,
      })),
    });
  }
  if (error instanceof BureauError) {
    switch (error.code) {
      case 'NOT_FOUND':
        return refuseWith(404, { error: 'not-found', message: 'Nothing has that identifier.' });
      case 'BAD_REQUEST':
        return refuseWith(400, { error: 'invalid', message: error.message });
      case 'CONFLICT':
        return refuseWith(409, { error: 'conflict', message: error.message });
      case 'NOT_CONFIGURED':
      case 'UNSUPPORTED_CAPABILITY':
      case 'STORAGE_UNAVAILABLE':
      case 'RATE_LIMITED':
        return refuseWith(503, { error: 'unavailable', message: 'The Bureau cannot do that now.' });
    }
  }
  return refuseWith(500, { error: 'failed', message: 'The operation failed.' });
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

/** A run as the API names its fields. The answer's schema checks the status on the way out. */
function summaryOf(record: RunRecord): Readonly<Record<string, string>> {
  return {
    run: record.id,
    workflow: record.workflow,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function workflowsOf(bureau: ApiBureau): NonNullable<ApiBureau['workflows']> {
  if (bureau.workflows === undefined) {
    throw new Refusal(503, { error: 'unavailable', message: 'This Bureau runs no workflows.' });
  }
  return bureau.workflows;
}

/**
 * One operation: the scope it needs and what it does. `run` returns the status and the body of
 * the answer, and throws for a refusal.
 */
interface Operation {
  readonly scope: ApiScope;
  readonly run: (
    request: Request,
    parameters: Parameters,
    principal: ApiPrincipal,
  ) => Promise<{ readonly status: number; readonly body: unknown }>;
}

/** The seven operations, keyed by Bun route and method. */
function operationsOf(
  dependencies: ApiRouteDependencies,
): Readonly<Record<string, Readonly<Partial<Record<'GET' | 'POST', Operation>>>>> {
  const { bureau } = dependencies;
  return {
    [API_ROUTES.runs]: {
      GET: {
        scope: 'runs:read',
        run: async (request) => {
          const query = parse(runListQuery, queryOf(request), 'query');
          const page = await workflowsOf(bureau).listRuns(query);
          return {
            status: 200,
            body: runList.parse({ runs: page.runs.map(summaryOf), nextOffset: page.nextOffset }),
          };
        },
      },
      POST: {
        scope: 'runs:write',
        run: async (request, _parameters, principal) => {
          const body = parse(runStartBody, await bodyOf(request), 'request body');
          const workflows = workflowsOf(bureau);
          const started = await workflows.start(body.workflow, {
            ...(body.input === undefined ? {} : { input: body.input }),
            owner: principal.subject,
            surface: 'api',
          });
          const run = await workflows.getRun(started.runId);
          return {
            status: 201,
            body: runStarted.parse({ run: started.runId, status: run?.status ?? 'running' }),
          };
        },
      },
    },
    [API_ROUTES.run]: {
      GET: {
        scope: 'runs:read',
        run: async (request, parameters) => {
          parse(emptyQuery, queryOf(request), 'query');
          const { run } = parse(runParameters, parameters, 'path');
          const record = await workflowsOf(bureau).getRun(run);
          if (record === undefined) {
            throw new Refusal(404, { error: 'not-found', message: 'No run has that identifier.' });
          }
          const timeline = await dependencies.timeline(run);
          return {
            status: 200,
            body: runDetail.parse({
              ...summaryOf(record),
              ...(record.error === undefined ? {} : { error: record.error }),
              steps: timeline.map((entry) => ({
                step: entry.step,
                operation: entry.operationLabel,
                type: entry.operationType,
                status: entry.status,
                startedAt: iso(entry.timestamp),
                ...(entry.duration === undefined ? {} : { durationMilliseconds: entry.duration }),
              })),
            }),
          };
        },
      },
    },
    [API_ROUTES.chatMessages]: {
      POST: {
        scope: 'chats:write',
        run: async (request, parameters, principal) => {
          const { chat } = parse(chatParameters, parameters, 'path');
          const body = parse(messageBody, await bodyOf(request), 'request body');
          const context = await bureau.contexts.get(chat);
          if (context === undefined) {
            throw new Refusal(404, { error: 'not-found', message: 'No chat has that identifier.' });
          }
          // The chat may have a turn in progress, which this message must wait for: the admission
          // (and so the 409) is the one Chat's own send takes, not a check made here.
          const task = await dependencies.startTurn({
            threadId: chat,
            input: body.text,
            principal: principal.subject,
          });
          return { status: 201, body: messageSent.parse({ chat, run: task.id }) };
        },
      },
    },
    [API_ROUTES.agents]: {
      GET: {
        scope: 'agents:read',
        run: async (request) => {
          parse(emptyQuery, queryOf(request), 'query');
          const agents = bureau.agents
            .list()
            .filter((listing) => listing.state === 'ready')
            .map((listing) => ({
              agent: listing.id,
              name: listing.name,
              description: listing.description,
              kind: listing.source,
            }));
          return { status: 200, body: agentList.parse({ agents }) };
        },
      },
    },
    [API_ROUTES.schedules]: {
      GET: {
        scope: 'schedules:read',
        run: async (request) => {
          const query = parse(scheduleListQuery, queryOf(request), 'query');
          const page = await bureau.schedules.list(query);
          const items = page?.items ?? [];
          return {
            status: 200,
            body: scheduleList.parse({
              schedules: items.map((item) => ({
                schedule: item.id,
                workflow: item.workflowType,
                description: item.description ?? null,
                status: item.status,
                nextRunAt: item.nextFireAt === null ? null : iso(item.nextFireAt),
              })),
              nextOffset:
                page !== undefined && query.offset + items.length < page.total
                  ? query.offset + items.length
                  : null,
            }),
          };
        },
      },
    },
    [API_ROUTES.reviewDecision]: {
      POST: {
        scope: 'reviews:write',
        run: async (request, parameters, principal) => {
          const { review } = parse(reviewParameters, parameters, 'path');
          const body = parse(decisionBody, await bodyOf(request), 'request body');
          const resolved = await bureau.reviews.resolve({
            id: review,
            decision: body.decision,
            principal: principal.subject,
            ...(body.reason === undefined ? {} : { reason: body.reason }),
          });
          return {
            status: 200,
            body: decisionMade.parse({ review: resolved.id, decision: resolved.decision }),
          };
        },
      },
    },
  };
}

/** Whether `principal` holds `scope`, answered as the refusal it is when it does not. */
function scopeRefusal(principal: ApiPrincipal, scope: ApiScope): Response | undefined {
  if (principal.scopes.has(scope)) return undefined;
  return refuseWith(403, {
    error: 'forbidden',
    message: `This session does not hold ${scope}.`,
    scope,
  });
}

/**
 * The Bun routes of the seven operations, and of `GET /host/session`. Each answers the request
 * guard's refusal first, then the scope's, then the operation's.
 */
export function apiRoutes(dependencies: ApiRouteDependencies, refuse: Refuse) {
  const routes: Record<
    string,
    Partial<Record<'GET' | 'POST', (request: Bun.BunRequest<string>) => Promise<Response>>>
  > = {};
  for (const [path, methods] of Object.entries(operationsOf(dependencies))) {
    const handlers: Partial<
      Record<'GET' | 'POST', (request: Bun.BunRequest<string>) => Promise<Response>>
    > = {};
    for (const method of ['GET', 'POST'] as const) {
      const operation = methods[method];
      if (operation === undefined) continue;
      handlers[method] = async (request) => {
        const refusal = refuse(request);
        if (refusal !== undefined) return refusal;
        const principal = dependencies.principal(request);
        const forbidden = scopeRefusal(principal, operation.scope);
        if (forbidden !== undefined) return forbidden;
        try {
          const answer = await operation.run(request, request.params, principal);
          return Response.json(answer.body, { status: answer.status });
        } catch (error) {
          return answerFor(error);
        }
      };
    }
    routes[path] = handlers;
  }
  routes[HOST_SESSION_ROUTE] = {
    GET: async (request) => {
      const refusal = refuse(request);
      if (refusal !== undefined) return refusal;
      const principal = dependencies.principal(request);
      const session: HostSession = {
        subject: principal.subject,
        scopes: API_SCOPES.filter((scope) => principal.scopes.has(scope)),
      };
      return Response.json(session);
    },
  };
  return routes;
}
