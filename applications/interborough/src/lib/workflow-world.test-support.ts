/**
 * A stand-in for the two services the Workflows area reads, for component tests: the engine's
 * catalog and runs (`weft.workflows.definitions.*`, `weft.schedules.list`, `weft.workflows.list`,
 * and the revision operations) and the Bureau's workflow files (`bureau.workflows.*`). It keeps
 * the files as a small world a test can change, and it answers writes the way the Bureau does: a
 * write names the hash it read, a file that changed since is `StaleRevision`, and every accepted
 * write gives the file a new hash. Every call is recorded, so a test can say what was sent.
 *
 * The real Bureau and engine are exercised end to end in the Playwright suite.
 */
import { HttpClient } from '@lostgradient/weft';

import {
  STUB_AGENT_DIRECTORY,
  STUB_WORKFLOW_DIRECTORY,
  StubFault,
  urlOf,
} from './bureau-stub.test-support.ts';
import { installFetchImplementation } from './live-source/fetch.test-support.ts';

export type Call = { readonly method: string; readonly params: Record<string, unknown> };

export { STUB_AGENT_DIRECTORY, STUB_WORKFLOW_DIRECTORY } from './bureau-stub.test-support.ts';

export type DefinitionFixture = {
  name: string;
  origin: 'code' | 'source';
  state: 'ready' | 'idle' | 'loading' | 'failed' | 'cancelled';
  lastFailureCategory: 'application' | 'timeout' | 'cancellation' | 'resource' | 'system' | null;
  revision: string | null;
  workflowVersion: string | null;
  description: string | null;
  tags: string[] | null;
  signals: string[] | null;
  updates: string[] | null;
  queries: string[] | null;
  contractHash: string | null;
  contract: Record<string, unknown> | null;
};

export type FileFixture = {
  id: string;
  state: 'ready' | 'invalid';
  owner: string;
  hash: string | null;
  agent: string | null;
  paused: boolean;
  version: string | null;
  problem: {
    code: string;
    message: string;
    issues: { path: string; message: string }[] | null;
  } | null;
  text: string | null;
  schedule: { id: string; status: 'active' | 'paused'; nextFireAt: string | null } | null;
};

export type ScheduleFixture = {
  id: string;
  workflowType: string;
  status: 'active' | 'paused' | 'cancelled';
  cronExpression?: string;
  intervalMs?: number;
  description?: string;
  overlap: string;
  backfill: boolean;
  revisionPolicy: string;
  /** How many times the schedule itself has changed: `1` when created, then one more per change. */
  revision: number;
  createdAt: number;
  updatedAt: number;
  missedFireCount: number;
  skippedCount: number;
  nextFireAt: number | null;
  queuedRuns: unknown[];
};

export type RunFixture = {
  id: string;
  type: string;
  status: string;
  createdAt: number;
  updatedAt: number;
};

export type RevisionFixture = {
  workflowVersion: string;
  firstRunAt: string;
  lastRunAt: string;
  document: { name: string; trigger: Record<string, unknown>; steps: Record<string, unknown>[] };
};

export const DOCUMENT_TEXT = JSON.stringify(
  {
    name: 'digest',
    agent: 'writer',
    trigger: { kind: 'schedule', spec: '0 6 * * *' },
    steps: [
      { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'Write it.' } },
      { kind: 'await-signal', signal: 'approve' },
    ],
  },
  null,
  2,
);

/** A workflow type that code registered, as `weft.workflows.definitions.get` shows it. */
export function codeDefinition(
  name: string,
  overrides: Partial<DefinitionFixture> = {},
): DefinitionFixture {
  return {
    name,
    origin: 'code',
    state: 'ready',
    lastFailureCategory: null,
    revision: 'revision-1',
    workflowVersion: '1.0.0',
    description: `The ${name} workflow.`,
    tags: [],
    signals: ['pause-it'],
    updates: [],
    queries: ['progress'],
    contractHash: 'contract-1',
    contract: {
      name,
      workflowVersion: '1.0.0',
      inputSchema: { type: 'object', properties: { orderId: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { shipped: { type: 'boolean' } } },
    },
    ...overrides,
  };
}

/** A workflow type Weft loaded from a source, which is how it holds a Bureau file's document. */
export function sourceDefinition(
  name: string,
  overrides: Partial<DefinitionFixture> = {},
): DefinitionFixture {
  return codeDefinition(name, { origin: 'source', ...overrides });
}

/** A Bureau workflow file that loaded. */
export function readyFile(id: string, overrides: Partial<FileFixture> = {}): FileFixture {
  return {
    id,
    state: 'ready',
    owner: 'anonymous:local',
    hash: 'hash-1',
    agent: 'writer',
    paused: false,
    version: 'version-1',
    problem: null,
    text: DOCUMENT_TEXT.replace('"digest"', JSON.stringify(id)),
    schedule: { id: `bureau-workflow-schedule:${id}:1`, status: 'active', nextFireAt: null },
    ...overrides,
  };
}

/** A Bureau workflow file the Bureau cannot use. */
export function invalidFile(id: string, overrides: Partial<FileFixture> = {}): FileFixture {
  return {
    id,
    state: 'invalid',
    owner: 'anonymous:local',
    hash: 'hash-bad',
    agent: null,
    paused: false,
    version: null,
    problem: {
      code: 'invalid-document',
      message: 'The document is not a workflow.',
      issues: [{ path: 'trigger.spec', message: 'Not a schedule specification.' }],
    },
    text: '{ "name": "broken", "trigger": { "kind": "schedule", "spec": "never" }, "steps": [] }',
    schedule: null,
    ...overrides,
  };
}

export function scheduleFixture(
  id: string,
  workflowType: string,
  overrides: Partial<ScheduleFixture> = {},
): ScheduleFixture {
  return {
    id,
    workflowType,
    status: 'active',
    cronExpression: '*/5 * * * *',
    overlap: 'skip',
    backfill: false,
    revisionPolicy: 'active-at-fire',
    revision: 1,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    missedFireCount: 0,
    skippedCount: 0,
    nextFireAt: 1_760_000_300_000,
    queuedRuns: [],
    ...overrides,
  };
}

export function runFixture(
  id: string,
  type: string,
  overrides: Partial<RunFixture> = {},
): RunFixture {
  return {
    id,
    type,
    status: 'completed',
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    ...overrides,
  };
}

/** The faults the two services answer with. */
export const workflowFaults = {
  notFound: (what: string) => new StubFault('NotFound', 404, `No ${what}.`),
  stale: (currentRevision: string, expectedRevision = 'old') =>
    new StubFault('StaleRevision', 409, 'The workflow file changed on disk.', {
      currentRevision,
      expectedRevision,
    }),
  /** A schedule that changed since the caller read it: Weft's guard, answered as the Bureau does. */
  staleSchedule: (expectedRevision: number, currentRevision: number) =>
    new StubFault('StaleRevision', 409, 'The schedule changed since it was read.', {
      expectedRevision,
      currentRevision,
    }),
  unprocessable: (message: string) =>
    new StubFault('Unprocessable', 422, message, { reason: 'invalid-document' }),
  unavailable: () => new StubFault('Unavailable', 503, 'The engine did not answer.'),
  /** The Bureau replaced the file, and then the engine or the schedule could not follow. */
  applyFailed: () =>
    new StubFault('Unavailable', 503, 'The change was written but the engine did not apply it.', {
      reason: 'workflow-apply-failed',
    }),
  /** A name the engine refuses before it looks, as a name with a dot in it. */
  invalidParams: () =>
    new StubFault('InvalidParams', 400, 'workflow name "foo.bar" contains a dot.', {}),
};

export type World = {
  definitions: DefinitionFixture[];
  files: FileFixture[];
  schedules: ScheduleFixture[];
  runs: RunFixture[];
  /** What `bureau.workflows.revisions` answers, by identifier: only the versions that have run. */
  revisions: Record<string, RevisionFixture[]>;
  /** What `weft.workflows.revisions.list` answers, by name: every installed version, run or not. */
  installedRevisions: Record<string, unknown[]>;
  /** What `bureau.workflows.signal` answers. */
  signalAnswer: { started: string[]; delivered: string[] };
  /** The directory `/host/paths` reports, or `null` for a host that does not say. */
  workflowDirectory: string | null;
  /** Makes the engine's schedule list answer with a refusal, as a server that cannot read them would. */
  failSchedules: boolean;
  /** The agent each Bureau schedule runs, by schedule id. A schedule that is not here is not a Bureau agent schedule. */
  scheduleAgents: Record<string, string>;
  /** What `bureau.agents.list` answers. */
  agents: Array<Record<string, unknown>>;
  /** Makes `bureau.schedules.list` answer with a fault, as a Bureau that is down would. */
  failBureauSchedules: boolean;
};

export function emptyWorld(overrides: Partial<World> = {}): World {
  return {
    definitions: [],
    files: [],
    schedules: [],
    runs: [],
    revisions: {},
    installedRevisions: {},
    signalAnswer: { started: [], delivered: [] },
    workflowDirectory: STUB_WORKFLOW_DIRECTORY,
    failSchedules: false,
    scheduleAgents: {},
    agents: [],
    failBureauSchedules: false,
    ...overrides,
  };
}

export type WorkflowStub = {
  readonly world: World;
  readonly calls: Call[];
  callsTo(method: string): Call[];
  /** Makes one operation answer with `handler` from now on, such as to fail it. */
  on(method: string, handler: (params: Record<string, unknown>) => unknown): void;
  /** The files as they stand now. */
  file(id: string): FileFixture | undefined;
  client: HttpClient;
  restore(): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

let counter = 0;

/** Installs the stand-in over `fetch`, and returns a client that talks to it. */
export function installWorkflowWorld(world: World = emptyWorld()): WorkflowStub {
  const calls: Call[] = [];
  const overrides = new Map<string, (params: Record<string, unknown>) => unknown>();

  const find = (id: unknown) => world.files.find((file) => file.id === id);
  const listing = (file: FileFixture) => {
    const { text: _text, schedule: _schedule, ...rest } = file;
    return rest;
  };
  const rehash = (file: FileFixture): string => {
    counter += 1;
    file.hash = `hash-${String(counter + 1)}`;
    return file.hash;
  };
  const guarded = (params: Record<string, unknown>): FileFixture => {
    const file = find(params['id']);
    if (file === undefined) throw workflowFaults.notFound(`workflow ${String(params['id'])}`);
    if (file.hash !== params['expectedHash']) {
      throw workflowFaults.stale(file.hash ?? '', String(params['expectedHash']));
    }
    return file;
  };
  const written = (file: FileFixture) => ({ id: file.id, hash: file.hash });

  /** The engine counts every change to a schedule: a revision, and a new `updatedAt`. */
  const touch = (schedule: ScheduleFixture): void => {
    schedule.revision += 1;
    schedule.updatedAt += 1;
  };
  const changeSchedulesOf = (workflowType: string, status: 'active' | 'paused'): void => {
    for (const schedule of world.schedules) {
      if (schedule.workflowType === workflowType && schedule.status !== status) {
        schedule.status = status;
        touch(schedule);
      }
    }
  };
  const findSchedule = (id: unknown) => world.schedules.find((schedule) => schedule.id === id);
  const iso = (milliseconds: number | null) =>
    milliseconds === null ? null : new Date(milliseconds).toISOString();
  /** Whether the Bureau shows this schedule: it runs an agent, or it is a workflow file's. */
  const bureauKnows = (schedule: ScheduleFixture) =>
    schedule.id in world.scheduleAgents ||
    world.files.some((file) => file.id === schedule.workflowType);
  const bureauView = (schedule: ScheduleFixture) => ({
    id: schedule.id,
    owner: 'anonymous:local',
    agentName: world.scheduleAgents[schedule.id] ?? null,
    workflowType: schedule.workflowType,
    description: schedule.description ?? null,
    cronExpression: schedule.cronExpression ?? null,
    intervalMs: schedule.intervalMs ?? null,
    status: schedule.status,
    overlap: schedule.overlap,
    revision: schedule.revision,
    nextFireAt: iso(schedule.nextFireAt),
    lastFireAt: null,
    missedFireCount: schedule.missedFireCount,
    skippedCount: schedule.skippedCount,
    createdAt: iso(schedule.createdAt),
    updatedAt: iso(schedule.updatedAt),
  });
  const receipt = (schedule: ScheduleFixture) => ({
    id: schedule.id,
    status: schedule.status,
    revision: schedule.revision,
  });
  /** A Bureau schedule write: the schedule must be a Bureau agent schedule, and a revision it names must be current. */
  const bureauGuarded = (params: Record<string, unknown>): ScheduleFixture => {
    const schedule = findSchedule(params['scheduleId']);
    if (schedule === undefined || !(schedule.id in world.scheduleAgents)) {
      throw workflowFaults.notFound(`schedule ${String(params['scheduleId'])}`);
    }
    const expected = params['expectedRevision'];
    if (typeof expected === 'number' && expected !== schedule.revision) {
      throw workflowFaults.staleSchedule(expected, schedule.revision);
    }
    return schedule;
  };

  const bureauHandlers: Record<string, (params: Record<string, unknown>) => unknown> = {
    'bureau.agents.list': () => ({ agents: world.agents }),
    'bureau.schedules.list': () => {
      if (world.failBureauSchedules) throw workflowFaults.unavailable();
      return { schedules: world.schedules.filter(bureauKnows).map(bureauView), nextOffset: null };
    },
    'bureau.schedules.get': (params) => {
      const schedule = findSchedule(params['scheduleId']);
      if (schedule === undefined || !bureauKnows(schedule)) {
        throw workflowFaults.notFound(`schedule ${String(params['scheduleId'])}`);
      }
      return bureauView(schedule);
    },
    'bureau.schedules.create': (params) => {
      counter += 1;
      const spec = String(params['spec']);
      const schedule = scheduleFixture(`schedule-created-${String(counter)}`, 'agentRun', {
        ...(typeof params['description'] === 'string' ? { description: params['description'] } : {}),
        overlap: typeof params['overlap'] === 'string' ? params['overlap'] : 'skip',
      });
      if (/^\d+(?:ms|s|m|h|d)$/.test(spec)) {
        delete schedule.cronExpression;
        schedule.intervalMs = 60_000;
      } else {
        schedule.cronExpression = spec;
      }
      world.schedules.push(schedule);
      world.scheduleAgents[schedule.id] = String(params['agentName']);
      return bureauView(schedule);
    },
    'bureau.schedules.pause': (params) => {
      const schedule = bureauGuarded(params);
      if (schedule.status === 'active') {
        schedule.status = 'paused';
        touch(schedule);
      }
      return receipt(schedule);
    },
    'bureau.schedules.resume': (params) => {
      const schedule = bureauGuarded(params);
      if (schedule.status === 'paused') {
        schedule.status = 'active';
        touch(schedule);
      }
      return receipt(schedule);
    },
    'bureau.schedules.cancel': (params) => {
      const schedule = bureauGuarded(params);
      if (schedule.status !== 'cancelled') {
        schedule.status = 'cancelled';
        touch(schedule);
      }
      return receipt(schedule);
    },
    'bureau.schedules.update': (params) => {
      const schedule = bureauGuarded(params);
      const spec = String(params['spec']);
      if (/^\d+(?:ms|s|m|h|d)$/.test(spec)) {
        delete schedule.cronExpression;
        schedule.intervalMs = 60_000;
      } else {
        schedule.cronExpression = spec;
        delete schedule.intervalMs;
      }
      if (typeof params['description'] === 'string') schedule.description = params['description'];
      if (typeof params['overlap'] === 'string') schedule.overlap = params['overlap'];
      touch(schedule);
      return receipt(schedule);
    },
    'bureau.workflows.list': () => ({ workflows: world.files.map(listing), nextOffset: null }),
    'bureau.workflows.get': (params) => {
      const file = find(params['id']);
      if (file === undefined) throw workflowFaults.notFound(`workflow ${String(params['id'])}`);
      return file;
    },
    'bureau.workflows.revisions': (params) => {
      const revisions = world.revisions[String(params['id'])];
      if (revisions === undefined) {
        throw workflowFaults.notFound(`workflow ${String(params['id'])}`);
      }
      return { revisions };
    },
    'bureau.workflows.pause': (params) => {
      const file = guarded(params);
      file.paused = true;
      if (file.schedule !== null) file.schedule.status = 'paused';
      changeSchedulesOf(file.id, 'paused');
      rehash(file);
      return written(file);
    },
    'bureau.workflows.resume': (params) => {
      const file = guarded(params);
      file.paused = false;
      if (file.schedule !== null) file.schedule.status = 'active';
      changeSchedulesOf(file.id, 'active');
      rehash(file);
      return written(file);
    },
    'bureau.workflows.delete': (params) => {
      const file = guarded(params);
      world.files = world.files.filter((candidate) => candidate !== file);
      return written(file);
    },
    'bureau.workflows.update': (params) => {
      const file = guarded(params);
      const definition = params['definition'];
      if (!isRecord(definition) || 'name' in definition) {
        throw new StubFault('InvalidParams', 400, 'Unrecognized key: "name"', {});
      }
      file.text = JSON.stringify({ name: file.id, ...definition }, null, 2);
      file.state = 'ready';
      file.problem = null;
      rehash(file);
      return written(file);
    },
    'bureau.workflows.signal': () => world.signalAnswer,
  };

  const weftHandlers: Record<string, (params: Record<string, unknown>) => unknown> = {
    'weft.workflows.definitions.list': () => ({
      definitions: world.definitions.map(
        ({ contractHash: _hash, contract: _contract, ...summary }) => summary,
      ),
    }),
    'weft.workflows.definitions.get': (params) => {
      const found = world.definitions.find((definition) => definition.name === params['name']);
      if (found === undefined)
        throw workflowFaults.notFound(`definition ${String(params['name'])}`);
      return found;
    },
    'weft.system.registry': () => ({
      activeRevisions: Object.fromEntries(
        world.definitions.map((definition) => [definition.name, definition.revision]),
      ),
    }),
    'weft.workflows.revisions.list': (params) =>
      world.installedRevisions[String(params['name'])] ?? [],
    'weft.workflows.active.get': () => {
      throw workflowFaults.notFound('active revision');
    },
  };

  /** The engine's schedule routes: `GET /schedules`, `GET|PATCH|DELETE /schedules/:id`, and `POST` to create, pause, or resume. */
  const answerSchedule = (
    id: string | undefined,
    action: string | undefined,
    init: RequestInit | undefined,
    url: URL,
  ): Response => {
    const method = init?.method ?? 'GET';
    if (id === undefined) {
      if (method === 'POST') {
        const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
        const request = isRecord(body) ? body : {};
        calls.push({ method: 'POST /schedules', params: request });
        counter += 1;
        const created = scheduleFixture(
          typeof request['id'] === 'string' ? request['id'] : `schedule-engine-${String(counter)}`,
          String(request['type']),
          typeof request['description'] === 'string'
            ? { description: request['description'] }
            : {},
        );
        if (typeof request['cronExpression'] === 'string') {
          created.cronExpression = request['cronExpression'];
        } else {
          delete created.cronExpression;
          created.intervalMs = Number(request['every']);
        }
        world.schedules.push(created);
        return Response.json({ id: created.id });
      }
      calls.push({ method: 'GET /schedules', params: Object.fromEntries(url.searchParams) });
      if (world.failSchedules) {
        return new Response('The schedules are unavailable.', { status: 422 });
      }
      const type = url.searchParams.get('workflowType');
      const items = world.schedules.filter((s) => type === null || s.workflowType === type);
      return Response.json({ items, total: items.length });
    }
    const verb = action === undefined ? method : `${method} ${action}`;
    calls.push({ method: `${verb} /schedules/:id`, params: { id } });
    const schedule = findSchedule(decodeURIComponent(id));
    if (method === 'GET') return Response.json(schedule ?? null);
    if (schedule === undefined) return new Response('Not found', { status: 404 });
    if (action === 'pause' && schedule.status === 'active') {
      schedule.status = 'paused';
      touch(schedule);
    } else if (action === 'resume' && schedule.status === 'paused') {
      schedule.status = 'active';
      touch(schedule);
    } else if (method === 'DELETE' && schedule.status !== 'cancelled') {
      schedule.status = 'cancelled';
      touch(schedule);
    } else if (method === 'PATCH') {
      const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      const request = isRecord(body) ? body : {};
      calls.push({ method: 'PATCH /schedules/:id body', params: request });
      if (typeof request['cronExpression'] === 'string') {
        schedule.cronExpression = request['cronExpression'];
        delete schedule.intervalMs;
      } else if (typeof request['every'] === 'number') {
        schedule.intervalMs = request['every'];
        delete schedule.cronExpression;
      }
      if (typeof request['description'] === 'string') schedule.description = request['description'];
      if (typeof request['overlap'] === 'string') schedule.overlap = request['overlap'];
      touch(schedule);
    }
    return new Response(null, { status: 204 });
  };

  const restoreFetch = installFetchImplementation(async (input, init) => {
    const url = new URL(urlOf(input), 'http://localhost');
    if (url.pathname === '/host/paths') {
      return world.workflowDirectory === null
        ? new Response('Not found', { status: 404 })
        : Response.json({
            agentDirectory: STUB_AGENT_DIRECTORY,
            workflowDirectory: world.workflowDirectory,
          });
    }
    const scheduleRoute = url.pathname.endsWith('/jsonrpc')
      ? null
      : /\/schedules(?:\/([^/]+)(?:\/(pause|resume))?)?$/.exec(url.pathname);
    if (scheduleRoute !== null) {
      return answerSchedule(scheduleRoute[1], scheduleRoute[2], init, url);
    }
    if (typeof init?.body === 'string') {
      const body: unknown = JSON.parse(init.body);
      if (!isRecord(body) || typeof body['method'] !== 'string') {
        return new Response('Bad request', { status: 400 });
      }
      const method = body['method'];
      const params = isRecord(body['params']) ? body['params'] : {};
      calls.push({ method, params });
      const bureau = url.pathname.startsWith('/bureau');
      const handler =
        overrides.get(method) ?? (bureau ? bureauHandlers[method] : weftHandlers[method]);
      if (handler === undefined) {
        return Response.json({ error: `The stub has no handler for ${method}.` }, { status: 500 });
      }
      try {
        return Response.json({ jsonrpc: '2.0', id: body['id'], result: await handler(params) });
      } catch (error) {
        if (!(error instanceof StubFault)) throw error;
        return Response.json({
          jsonrpc: '2.0',
          id: body['id'],
          error: {
            code: -32000,
            message: error.message,
            data: { ...error.data, weftCode: error.weftCode, httpStatus: error.httpStatus },
          },
        });
      }
    }
    if (url.pathname.endsWith('/workflows')) {
      calls.push({ method: 'GET /workflows', params: Object.fromEntries(url.searchParams) });
      const type = url.searchParams.get('type');
      const statuses = url.searchParams.getAll('status');
      const items = world.runs.filter(
        (run) =>
          (type === null || run.type === type) &&
          (statuses.length === 0 || statuses.includes(run.status)),
      );
      return Response.json({ items, total: items.length });
    }
    return new Response('Not found', { status: 404 });
  });

  return {
    world,
    calls,
    callsTo: (method) => calls.filter((call) => call.method === method),
    on: (method, handler) => {
      overrides.set(method, handler);
    },
    file: (id) => find(id),
    client: new HttpClient({ baseUrl: 'http://localhost/api' }),
    restore: restoreFetch,
  };
}
