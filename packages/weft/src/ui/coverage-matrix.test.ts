/**
 * Keeps `documentation/ui/coverage-matrix.md` honest: every operation in
 * `CLIENT_OPERATION_NAMES` and every non-catalog surface has exactly one row,
 * every `exposed` row points at a file that really reaches its operation,
 * every `Method` sends the request Weft's REST binding for that operation
 * expects, and every gap names its issue or its reason.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLIENT_OPERATION_NAMES, HttpClient } from '@lostgradient/weft';

import { createLiveRestBindings } from '../server/rest-bindings.ts';
import { API_PREFIX } from '../server/route-model.ts';
import {
  checkCoverageMatrix,
  parseCoverageMatrix,
  routePathMatches,
  type CoverageMatrixContext,
  type RecordedRoute,
} from './coverage-matrix.test-support.ts';
import { installFetchImplementation } from './lib/live-source/fetch.test-support.ts';

const PACKAGE_ROOT = join(import.meta.dir, '..', '..');
const MATRIX_PATH = 'documentation/ui/coverage-matrix.md';

/**
 * Surfaces Weft offers outside its operation catalog, each with the text an
 * `exposed` row's `Location` file must contain.
 */
const NON_CATALOG_SURFACES: Readonly<Record<string, string>> = {
  'feed:workflow-events:sse': 'client.tail(',
  'feed:workflow-events:websocket': 'client.tail(',
  'feed:fleet-events:sse': '/v1/events/sse',
  'feed:fleet-events:websocket': "'weft.events.subscribe'",
  'metrics:prometheus': "'/v1/metrics'",
  'traces:opentelemetry': '@opentelemetry/',
  'audit:authentication': "'weft.audit.list'",
  'mount:dashboard': 'export function dashboard(',
};

type MethodInvocation = (client: HttpClient) => Promise<unknown>;

/** Example arguments for every `HttpClient` method a row may name in `Method`. */
const METHOD_EXAMPLES: Readonly<Record<string, MethodInvocation>> = {
  'activity.complete': (client) => client.activity.complete('token-1', { ok: true }),
  'activity.completeExceptionally': (client) =>
    client.activity.completeExceptionally('token-1', { message: 'failed' }),
  addTags: (client) => client.addTags('workflow-1', 'tag-a'),
  cancel: (client) => client.cancel('workflow-1'),
  cancelSchedule: (client) => client.cancelSchedule('schedule-1'),
  fork: (client) => client.fork('workflow-1'),
  get: (client) => client.get('workflow-1'),
  getEvents: (client) => client.getEvents('workflow-1'),
  getRetentionOverview: (client) => client.getRetentionOverview(),
  getSchedule: (client) => client.getSchedule('schedule-1'),
  getTimeline: (client) => client.getTimeline('workflow-1'),
  list: (client) => client.list(),
  listReviews: (client) => client.listReviews(),
  listSchedules: (client) => client.listSchedules(),
  pauseSchedule: (client) => client.pauseSchedule('schedule-1'),
  query: (client) => client.query('workflow-1', 'status'),
  removeTags: (client) => client.removeTags('workflow-1', 'tag-a'),
  replayTo: (client) => client.replayTo('workflow-1', 1),
  resume: (client) => client.resume('workflow-1'),
  resumeSchedule: (client) => client.resumeSchedule('schedule-1'),
  schedule: (client) => client.schedule('order', {}, '0 * * * *'),
  signal: (client) => client.signal('workflow-1', 'approve', { approved: true }),
  start: (client) => client.start('order', {}),
  startOrSignal: (client) => client.startOrSignal('order', {}, { name: 'approve' }),
  submitReview: (client) =>
    client.submitReview('review-1', { decision: 'approved', reviewer: 'operator' }),
  suspend: (client) => client.suspend('workflow-1'),
  timeout: (client) => client.timeout('workflow-1'),
  update: (client) => client.update('workflow-1', 'rename', { name: 'next' }),
  updateSchedule: (client) => client.updateSchedule('schedule-1', '0 * * * *'),
};

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === 'string' ? input : input.url);
}

function withoutApiPrefix(path: string): string {
  return path.startsWith(`${API_PREFIX}/`) ? path.slice(API_PREFIX.length) : path;
}

/** Call one `HttpClient` method against a recording `fetch` and return the first request it sent. */
async function recordMethodRoute(method: string): Promise<RecordedRoute | undefined> {
  const invoke = METHOD_EXAMPLES[method];
  if (invoke === undefined) return undefined;
  const requests: RecordedRoute[] = [];
  const restore = installFetchImplementation(async (input, init) => {
    requests.push({
      method: init?.method ?? 'GET',
      path: withoutApiPrefix(requestUrl(input).pathname),
    });
    return Response.json({ id: 'workflow-2', items: [], events: [], result: null });
  });
  try {
    await invoke(new HttpClient({ baseUrl: `https://weft.test${API_PREFIX}` })).catch(
      () => undefined,
    );
  } finally {
    restore();
  }
  return requests[0] ?? { method: 'NONE', path: '(no request)' };
}

function readPackageFile(path: string): string | undefined {
  const absolute = join(PACKAGE_ROOT, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined;
}

function restBindingsByOperation(): Map<string, RecordedRoute[]> {
  const bindings = new Map<string, RecordedRoute[]>();
  for (const binding of createLiveRestBindings()) {
    const routes = bindings.get(binding.operationName) ?? [];
    routes.push({ method: binding.method, path: binding.path });
    bindings.set(binding.operationName, routes);
  }
  return bindings;
}

const context: CoverageMatrixContext = {
  operationNames: CLIENT_OPERATION_NAMES,
  nonCatalogSurfaces: NON_CATALOG_SURFACES,
  restBindings: restBindingsByOperation(),
  readFile: readPackageFile,
  recordMethodRoute,
};

function readMatrix(): string {
  const matrix = readPackageFile(MATRIX_PATH);
  if (matrix === undefined) throw new Error(`${MATRIX_PATH} is missing.`);
  return matrix;
}

/** Replace the one table row for `operation` in `markdown` with `replacement`. */
function replaceRow(markdown: string, operation: string, replacement: string): string {
  const lines = markdown.split('\n');
  const index = lines.findIndex((line) => line.startsWith(`| \`${operation}\` |`));
  if (index === -1) throw new Error(`No row for ${operation}.`);
  lines.splice(index, 1, ...(replacement === '' ? [] : [replacement]));
  return lines.join('\n');
}

describe('dashboard coverage matrix', () => {
  test('has one honest row for every operation and non-catalog surface', async () => {
    expect(await checkCoverageMatrix(readMatrix(), context)).toEqual([]);
  });

  test('lists rows in CLIENT_OPERATION_NAMES order, then the non-catalog surfaces', () => {
    const operations = parseCoverageMatrix(readMatrix()).map((row) => row.Operation);
    expect(operations).toEqual([...CLIENT_OPERATION_NAMES, ...Object.keys(NON_CATALOG_SURFACES)]);
  });

  test('every Method example reaches a REST binding in the catalog', async () => {
    const bindings = [...context.restBindings.values()].flat();
    for (const method of Object.keys(METHOD_EXAMPLES)) {
      const route = await recordMethodRoute(method);
      const matched = bindings.some(
        (binding) =>
          route !== undefined &&
          binding.method === route.method &&
          routePathMatches(binding.path, route.path),
      );
      expect({ method, matched }).toEqual({ method, matched: true });
    }
  });
});

describe('dashboard coverage matrix checker', () => {
  test('fails when an operation has no row', async () => {
    const markdown = replaceRow(readMatrix(), 'weft.workers.list', '');
    expect(await checkCoverageMatrix(markdown, context)).toEqual([
      'weft.workers.list: has no row.',
    ]);
  });

  test('fails when a row names an operation Weft does not offer', async () => {
    const markdown = replaceRow(
      readMatrix(),
      'weft.reviews.get',
      '| `weft.reviews.get` | not-in-dashboard | | | | | Reason. |\n| `weft.reviews.missing` | tracked | | | | COR-1 | |',
    );
    expect(await checkCoverageMatrix(markdown, context)).toEqual([
      'weft.reviews.missing: not in CLIENT_OPERATION_NAMES and not a listed non-catalog surface.',
    ]);
  });

  test('fails when a row appears twice', async () => {
    const row = '| `weft.system.lease` | tracked | | | | COR-124 | |';
    const markdown = replaceRow(readMatrix(), 'weft.system.lease', `${row}\n${row}`);
    expect(await checkCoverageMatrix(markdown, context)).toEqual([
      'weft.system.lease: more than one row.',
    ]);
  });

  test('fails when an exposed Location does not reach its operation', async () => {
    const markdown = replaceRow(
      readMatrix(),
      'weft.alerts.list',
      '| `weft.alerts.list` | exposed | `src/ui/routes/system/realms-tab.svelte` | | `src/ui/routes/system/alerts-tab.test.ts` | | |',
    );
    expect(await checkCoverageMatrix(markdown, context)).toEqual([
      'weft.alerts.list: Location src/ui/routes/system/realms-tab.svelte neither contains the operation identifier nor calls client.<Method>(.',
    ]);
  });

  test('fails when an exposed Location calls a different Method than the row names', async () => {
    const markdown = replaceRow(
      readMatrix(),
      'weft.workflows.list',
      '| `weft.workflows.list` | exposed | `src/ui/routes/workflows/detail/events-tab.svelte` | `list` | `src/ui/routes/workflows/list/workflow-list.test.ts` | | |',
    );
    expect(await checkCoverageMatrix(markdown, context)).toEqual([
      'weft.workflows.list: Location src/ui/routes/workflows/detail/events-tab.svelte neither contains the operation identifier nor calls client.list(.',
    ]);
  });

  test('fails when a non-catalog Location lacks its marker', async () => {
    const markdown = replaceRow(
      readMatrix(),
      'mount:dashboard',
      '| `mount:dashboard` | exposed | `src/server/route-model.ts` | | `src/server/dashboard.test.ts` | | |',
    );
    expect(await checkCoverageMatrix(markdown, context)).toEqual([
      'mount:dashboard: Location src/server/route-model.ts neither contains the operation identifier nor calls client.<Method>(.',
    ]);
  });

  test('fails when an exposed Location or Test file is missing', async () => {
    const markdown = replaceRow(
      readMatrix(),
      'weft.alerts.list',
      '| `weft.alerts.list` | exposed | `src/ui/routes/system/missing.svelte` | | `src/ui/routes/system/missing.test.ts` | | |',
    );
    expect(await checkCoverageMatrix(markdown, context)).toEqual([
      'weft.alerts.list: Location src/ui/routes/system/missing.svelte does not exist.',
      'weft.alerts.list: Test src/ui/routes/system/missing.test.ts does not exist.',
    ]);
  });

  test("fails when a Method does not send its operation's REST binding", async () => {
    const markdown = replaceRow(
      readMatrix(),
      'weft.workflows.get',
      '| `weft.workflows.get` | exposed | `src/ui/routes/workflows/detail/workflow-detail.svelte` | `cancel` | `src/ui/routes/workflows/detail/workflow-detail.test.ts` | | |',
    );
    expect(await checkCoverageMatrix(markdown, context)).toEqual([
      'weft.workflows.get: Method cancel sent DELETE /v1/workflows/workflow-1, not GET /v1/workflows/:id.',
    ]);
  });

  test('fails when a Method has no example arguments', async () => {
    const markdown = replaceRow(
      readMatrix(),
      'weft.workflows.purge',
      '| `weft.workflows.purge` | exposed | `src/ui/routes/workflows/list/bulk-operations-client.ts` | `purge` | `src/ui/routes/workflows/list/bulk-operations-client.test.ts` | | |',
    );
    expect(await checkCoverageMatrix(markdown, context)).toEqual([
      'weft.workflows.purge: Method purge has no example arguments in the test.',
    ]);
  });

  test('fails when a tracked row names no Linear issue', async () => {
    const markdown = replaceRow(
      readMatrix(),
      'weft.system.lease',
      '| `weft.system.lease` | tracked | | | | | |',
    );
    expect(await checkCoverageMatrix(markdown, context)).toEqual([
      'weft.system.lease: a tracked row must name the Linear issue that exposes it.',
    ]);
  });

  test('fails when an Issue cell holds something other than a Linear identifier', async () => {
    const markdown = replaceRow(
      readMatrix(),
      'weft.system.lease',
      '| `weft.system.lease` | tracked | | | | soon | |',
    );
    expect(await checkCoverageMatrix(markdown, context)).toEqual([
      'weft.system.lease: "soon" is not a Linear identifier.',
      'weft.system.lease: a tracked row must name the Linear issue that exposes it.',
    ]);
  });

  test('fails when a not-in-dashboard row has no reason', async () => {
    const markdown = replaceRow(
      readMatrix(),
      'weft.reviews.get',
      '| `weft.reviews.get` | not-in-dashboard | | | | | |',
    );
    expect(await checkCoverageMatrix(markdown, context)).toEqual([
      'weft.reviews.get: a not-in-dashboard row must state its reason.',
    ]);
  });

  test('fails when a status is not one of the three', async () => {
    const markdown = replaceRow(
      readMatrix(),
      'weft.reviews.get',
      '| `weft.reviews.get` | partial | | | | | |',
    );
    expect(await checkCoverageMatrix(markdown, context)).toEqual([
      'weft.reviews.get: status "partial" is not one of exposed, tracked, not-in-dashboard.',
    ]);
  });

  test('fails when a Method names an operation without a REST binding', async () => {
    const markdown = replaceRow(
      readMatrix(),
      'feed:workflow-events:sse',
      '| `feed:workflow-events:sse` | exposed | `src/ui/lib/live-source/workflow-tail-source.svelte.ts` | `tail` | `src/ui/lib/live-source/workflow-tail-source.test.ts` | | |',
    );
    expect(await checkCoverageMatrix(markdown, context)).toEqual([
      'feed:workflow-events:sse: names Method tail but has no REST binding to compare.',
    ]);
  });

  test('refuses a document without the matrix header', () => {
    expect(() => parseCoverageMatrix('| Operation | Status |\n| --- | --- |')).toThrow(
      'No table with the columns',
    );
  });

  test('matches a :param segment against exactly one non-empty segment', () => {
    expect(routePathMatches('/v1/workflows/:id', '/v1/workflows/abc')).toBe(true);
    expect(routePathMatches('/v1/workflows/:id', '/v1/workflows/')).toBe(false);
    expect(routePathMatches('/v1/workflows/:id', '/v1/workflows/abc/events')).toBe(false);
    expect(routePathMatches('/v1/workflows', '/v1/schedules')).toBe(false);
  });
});
