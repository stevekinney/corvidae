/**
 * The shapes of Interborough's own HTTP API (board PageSettingsSections, "API reference ·
 * Operations"): what each `/api` operation takes and answers. The routes validate every request
 * with these schemas (`api-routes.ts`) and the served OpenAPI description is made from the same
 * schemas (`api-description.ts`), so the description cannot say something the routes do not do.
 *
 * @module api-contract
 */
import { z } from 'zod';

/** The most results one page of a list answers with. */
export const API_PAGE_LIMIT_MAXIMUM = 100;

/** The results one page of a list answers with when the request does not say. */
export const API_PAGE_LIMIT_DEFAULT = 25;

/** The statuses a workflow run can be in, which `GET /api/runs` filters by. */
export const API_RUN_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
  'suspended',
] as const;

const identifier = (what: string) =>
  z.string().min(1).max(512).describe(`The identifier of the ${what}.`);

const limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(API_PAGE_LIMIT_MAXIMUM)
  .default(API_PAGE_LIMIT_DEFAULT)
  .describe('How many results to answer with.');

const offset = z.coerce
  .number()
  .int()
  .min(0)
  .default(0)
  .describe('How many results to skip, from the `nextOffset` of the page before.');

const nextOffset = z
  .number()
  .int()
  .nullable()
  .describe('The `offset` of the next page, or `null` on the last one.');

/** The query of an operation that reads none: any parameter is refused. */
export const emptyQuery = z.strictObject({});

/** The query `GET /api/runs` reads. */
export const runListQuery = z.strictObject({
  workflow: identifier('workflow whose runs to list').optional(),
  status: z.enum(API_RUN_STATUSES).optional().describe('Only the runs in this status.'),
  limit,
  offset,
});

/** The query `GET /api/schedules` reads. */
export const scheduleListQuery = z.strictObject({ limit, offset });

/** The path parameter of `GET /api/runs/{run}`. */
export const runParameters = z.strictObject({ run: identifier('run') });

/** The path parameter of `POST /api/chats/{chat}/messages`. */
export const chatParameters = z.strictObject({ chat: identifier('chat') });

/** The path parameter of `POST /api/reviews/{review}/decision`. */
export const reviewParameters = z.strictObject({ review: identifier('review') });

/** The body of `POST /api/runs`. */
export const runStartBody = z.strictObject({
  workflow: identifier('workflow to start'),
  input: z
    .unknown()
    .optional()
    .describe(
      'The input the workflow’s input schema describes. Left out, the run starts with none.',
    ),
});

/** The body of `POST /api/chats/{chat}/messages`. */
export const messageBody = z.strictObject({
  text: z.string().min(1).max(100_000).describe('What to say to the chat’s agent.'),
});

/** The body of `POST /api/reviews/{review}/decision`. */
export const decisionBody = z.strictObject({
  decision: z.enum(['approve', 'deny']).describe('Whether to approve or deny what is waiting.'),
  reason: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe('Why, which the review keeps with the decision.'),
});

const runStatus = z.enum(API_RUN_STATUSES).describe('Where the run is.');

/** One run, as `GET /api/runs` lists it. */
export const runSummary = z.strictObject({
  run: identifier('run'),
  workflow: identifier('workflow the run is an instance of'),
  status: runStatus,
  createdAt: z.string().describe('When the run was created, as an ISO 8601 time.'),
  updatedAt: z.string().describe('When the run last changed, as an ISO 8601 time.'),
});

/** One step of a run, as `GET /api/runs/{run}` lists it. */
export const runStep = z.strictObject({
  step: z.number().int().describe('The step’s place in the run, from 0.'),
  operation: z.string().describe('What the step did, as the workflow names it.'),
  type: z.string().describe('The kind of step: an activity, a sleep, a signal wait and so on.'),
  status: z.string().describe('Where the step is.'),
  startedAt: z.string().describe('When the step started, as an ISO 8601 time.'),
  durationMilliseconds: z
    .number()
    .optional()
    .describe('How long the step took, once it has finished.'),
});

/** What `GET /api/runs` answers. */
export const runList = z.strictObject({ runs: z.array(runSummary), nextOffset });

/** What `GET /api/runs/{run}` answers. */
export const runDetail = runSummary.extend({
  error: z.string().optional().describe('Why the run failed, for a run that did.'),
  steps: z.array(runStep).describe('The run’s steps, in the order they ran.'),
});

/** What `POST /api/runs` answers. */
export const runStarted = z.strictObject({ run: identifier('run'), status: runStatus });

/** What `POST /api/chats/{chat}/messages` answers. */
export const messageSent = z.strictObject({
  chat: identifier('chat'),
  run: identifier('run that answers the message'),
});

/** What `GET /api/agents` answers. */
export const agentList = z.strictObject({
  agents: z.array(
    z.strictObject({
      agent: identifier('agent'),
      name: z.string().describe('The agent’s name, as a person reads it.'),
      description: z.string().nullable().describe('What the agent is for.'),
      kind: z.enum(['code', 'file']).describe('Whether the agent is defined in code or in a file.'),
    }),
  ),
});

/** What `GET /api/schedules` answers. */
export const scheduleList = z.strictObject({
  schedules: z.array(
    z.strictObject({
      schedule: identifier('schedule'),
      workflow: identifier('workflow the schedule starts'),
      description: z.string().nullable().describe('What the schedule is for.'),
      status: z.string().describe('Whether the schedule is active, paused and so on.'),
      nextRunAt: z
        .string()
        .nullable()
        .describe('When it next starts a run, as an ISO 8601 time, or `null` for none.'),
    }),
  ),
  nextOffset,
});

/** What `POST /api/reviews/{review}/decision` answers. */
export const decisionMade = z.strictObject({
  review: identifier('review'),
  decision: z.enum(['approve', 'deny', 'reject']).describe('The decision the review recorded.'),
});

/** What an operation answers when it does not do what was asked. */
export const apiFault = z.strictObject({
  error: z
    .enum(['invalid', 'forbidden', 'not-found', 'conflict', 'unavailable', 'failed'])
    .describe('What kind of refusal it is.'),
  message: z.string().describe('What went wrong, in a sentence.'),
  scope: z.string().optional().describe('The scope the session lacks, for `forbidden`.'),
  issues: z
    .array(z.strictObject({ path: z.string(), message: z.string() }))
    .optional()
    .describe('Where the request is wrong, for `invalid`.'),
});

/** The body of a refusal. */
export type ApiFault = z.infer<typeof apiFault>;
