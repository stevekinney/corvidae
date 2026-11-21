/**
 * COR-2545: the schedule editor's writes through the host's panel route into a real Bureau, not a
 * double. A panel that declares the four schedule writes host-only saves through `/jsonrpc`, the
 * result reads back from the Bureau, and the audit entry of each write names the owner as its
 * principal and the panel's URI. A panel that does not declare a write gets 403 before the Bureau is
 * called, and one that lists it without `hostOnlyTools` goes to `/mcp`, where no such tool is
 * served, so the write is refused on both paths.
 */
import { createBureau, createBureauHandler, createMemoryAssetStorage } from '@lostgradient/bureau';
import { createAgent } from '@lostgradient/operative';
import { scheduleEditor } from '@lostgradient/plugin-inspectors';
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, test } from 'bun:test';

import type { ServedPanel } from './panel-mounts.ts';
import { panelRoutes } from './panel-routes.ts';
import { createRequestGuard } from './request-guard.ts';

const PORT = 4321;
const HOST = `127.0.0.1:${PORT}`;
const EDITOR_URI = scheduleEditor.uri;
const WRITES = [
  'bureau.schedules.create',
  'bureau.schedules.update',
  'bureau.schedules.pause',
  'bureau.schedules.resume',
] as const;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const writer = createAgent({
  name: 'writer',
  generate: async () => ({ content: 'ok', toolCalls: [] }),
});
const editorAgent = createAgent({
  name: 'editor',
  generate: async () => ({ content: 'ok', toolCalls: [] }),
});

/** The editor as the host serves it: the plugin's own declarations, with a page that is not built. */
const editor = (overrides: Partial<ServedPanel> = {}): ServedPanel => ({
  plugin: 'inspectors',
  name: scheduleEditor.name,
  title: scheduleEditor.title,
  uri: EDITOR_URI,
  placements: scheduleEditor.placements ?? [],
  allowedTools: [...scheduleEditor.allowedTools],
  hostOnlyTools: [...(scheduleEditor.hostOnlyTools ?? [])],
  html: '<div id="root"></div>',
  ...overrides,
});

async function open(served: readonly ServedPanel[] = [editor()]) {
  const bureau = await createBureau({
    id: 'panel-bureau',
    agents: { writer, editor: editorAgent },
    storage: new MemoryStorage(),
    durable: true,
    assets: { storage: createMemoryAssetStorage() },
  });
  cleanups.push(() => bureau.dispose());
  // A host with no credential serves the local caller, as the application does for its own person.
  const handler = createBureauHandler(bureau, { unauthenticatedAccess: 'allow', mcp: {} });
  const table = panelRoutes(
    served,
    createRequestGuard(() => PORT),
    (request) => handler(request),
  );
  const entry = Object.entries(table).find(([pattern]) => pattern.endsWith('/tool-calls'));
  const post = entry?.[1] as { POST: (request: never) => Response | Promise<Response> };
  return {
    bureau,
    /** One tool call as the panel `name` makes it, answered as the host answers it. */
    async call(
      name: string,
      args: Record<string, unknown>,
      panel = scheduleEditor.name,
      headers: Record<string, string> = {},
    ) {
      const path = `/host/plugins/inspectors/apps/${panel}/tool-calls`;
      const request = Object.assign(
        new Request(`http://${HOST}${path}`, {
          method: 'POST',
          headers: { host: HOST, 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ name, arguments: args }),
        }),
        { params: { name: 'inspectors', app: panel } },
      );
      const response = await post.POST(request as never);
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    },
  };
}

type Opened = Awaited<ReturnType<typeof open>>;

async function entriesOf(opened: Opened, id: string) {
  const entries =
    (await opened.bureau.internals.auditTrail?.query({ runId: `schedule:${id}` })) ?? [];
  return entries.toSorted((a, b) => a.sequence - b.sequence);
}

async function createSchedule(opened: Opened): Promise<string> {
  const created = await opened.call('bureau.schedules.create', {
    agentName: 'writer',
    spec: '1h',
    input: 'Say hello',
    description: 'Hello',
  });
  expect(created.status).toBe(200);
  expect(created.body['isError']).toBeUndefined();
  return created.body['structuredContent']['id'] as string;
}

describe('the schedule editor through the panel route', () => {
  test('creates, changes when it runs, changes what it runs and pauses, each read back from the Bureau', async () => {
    const opened = await open();
    const id = await createSchedule(opened);
    const created = await opened.bureau.schedules.get(id);
    expect(created).toMatchObject({
      status: 'active',
      revision: 1,
      intervalMs: 3_600_000,
    });
    expect(await opened.bureau.schedules.agentName(id)).toBe('writer');

    // When it runs.
    const updated = await opened.call('bureau.schedules.update', {
      scheduleId: id,
      spec: '0 9 * * *',
      timeZone: 'Europe/Paris',
      expectedRevision: 1,
    });
    expect(updated.body['structuredContent']).toMatchObject({ id, revision: 2 });
    expect(await opened.bureau.schedules.get(id)).toMatchObject({
      cronExpression: '0 9 * * *',
      timeZone: 'Europe/Paris',
    });

    // Whether it is paused, fenced by the revision the update answered.
    const paused = await opened.call('bureau.schedules.pause', {
      scheduleId: id,
      expectedRevision: 2,
    });
    expect(paused.body['structuredContent']).toMatchObject({ status: 'paused', revision: 3 });
    expect((await opened.bureau.schedules.get(id))?.status).toBe('paused');
    const resumed = await opened.call('bureau.schedules.resume', {
      scheduleId: id,
      expectedRevision: 3,
    });
    expect(resumed.body['structuredContent']).toMatchObject({ status: 'active', revision: 4 });
    expect((await opened.bureau.schedules.get(id))?.status).toBe('active');

    // Which agent it runs: the cadence resent as it is and no new text, so the text it sends is kept.
    const moved = await opened.call('bureau.schedules.update', {
      scheduleId: id,
      spec: '0 9 * * *',
      agentName: 'editor',
      expectedRevision: 4,
    });
    expect(moved.body['structuredContent']).toMatchObject({ id, revision: 5 });
    expect(await opened.bureau.schedules.agentName(id)).toBe('editor');

    // The reads a picker makes go to MCP, as the same caller.
    const read = await opened.call('bureau.schedules.get', { scheduleId: id });
    expect(read.status).toBe(200);
    expect(read.body['structuredContent']).toMatchObject({
      id,
      status: 'active',
      revision: 5,
      target: { kind: 'agent', agentName: 'editor' },
    });
    const agents = await opened.call('bureau.agents.list', {});
    expect(
      (agents.body['structuredContent']['agents'] as { name: string }[]).map((agent) => agent.name),
    ).toEqual(['writer', 'editor']);
  });

  test('says which field a Bureau fault belongs to: an invalid cadence is an issue on `spec`', async () => {
    const opened = await open();
    const id = await createSchedule(opened);
    const refused = await opened.call('bureau.schedules.update', {
      scheduleId: id,
      spec: 'not a schedule',
    });
    expect(refused.status).toBe(200);
    expect(refused.body['isError']).toBe(true);
    expect(refused.body['structuredContent']['issues']).toEqual([
      expect.objectContaining({ path: ['spec'] }),
    ]);
    // Nothing was written.
    expect((await opened.bureau.schedules.get(id))?.revision).toBe(1);
    const invalidNew = await opened.call('bureau.schedules.create', {
      agentName: 'writer',
      spec: 'not a schedule',
      input: 'x',
    });
    expect(invalidNew.body['isError']).toBe(true);
    expect(invalidNew.body['structuredContent']['issues'][0]['path']).toEqual(['spec']);
  });

  test('names the owner as the principal and the panel’s URI in the audit entry of each write', async () => {
    const opened = await open();
    const id = await createSchedule(opened);
    await opened.call('bureau.schedules.update', { scheduleId: id, spec: '2h' });
    await opened.call('bureau.schedules.pause', { scheduleId: id });
    await opened.call('bureau.schedules.resume', { scheduleId: id });
    const entries = await entriesOf(opened, id);
    expect(entries.map((entry) => entry.type)).toEqual([
      'schedule.created',
      'schedule.updated',
      'schedule.paused',
      'schedule.resumed',
    ]);
    for (const entry of entries) {
      expect(entry.principal, entry.type).toBe('anonymous:local');
      expect(entry.detail, entry.type).toMatchObject({ scheduleId: id, panelUri: EDITOR_URI });
    }
  });

  test('takes the panel from the host’s own list, never from the page', async () => {
    const opened = await open();
    const created = await opened.call(
      'bureau.schedules.create',
      {
        agentName: 'writer',
        spec: '1h',
        input: 'x',
        panelUri: 'ui://inspectors/forged/v1',
      },
      scheduleEditor.name,
      { 'x-panel-uri': 'ui://inspectors/forged/v1' },
    );
    // The Bureau refuses or ignores an argument it does not know, and a header it does not read
    // changes nothing: either way the entry names the panel the host served.
    const id: unknown = created.body['structuredContent']?.['id'];
    if (typeof id === 'string') {
      const [entry] = await entriesOf(opened, id);
      expect(entry?.detail).toMatchObject({ panelUri: EDITOR_URI });
    } else {
      expect(created.body['isError']).toBe(true);
    }
    const second = await createSchedule(opened);
    const [entry] = await entriesOf(opened, second);
    expect(entry?.detail).toMatchObject({ panelUri: EDITOR_URI });
  });
});

describe('the schedule writes a panel may not make', () => {
  test.each(WRITES)(
    'refuses %s from a panel that does not declare it with 403, before the Bureau',
    async (name) => {
      const opened = await open([
        editor(),
        editor({
          name: 'run-inspector',
          uri: 'ui://inspectors/run-inspector/v1',
          allowedTools: ['bureau.tasks.inspect'],
          hostOnlyTools: [],
        }),
      ]);
      const id = await createSchedule(opened);
      const refused = await opened.call(name, { scheduleId: id, spec: '5m' }, 'run-inspector');
      expect(refused.status).toBe(403);
      expect(refused.body).toEqual({
        error: 'forbidden-tool',
        message: 'This panel may not call that tool.',
      });
      expect((await opened.bureau.schedules.get(id))?.revision).toBe(1);
      expect(await entriesOf(opened, id)).toHaveLength(1);
    },
  );

  test.each(WRITES)(
    'refuses %s from a panel that lists it but not as host-only: it goes to /mcp, which serves no such tool',
    async (name) => {
      const opened = await open([editor({ hostOnlyTools: [] })]);
      // A schedule made in process, because this panel cannot make one itself.
      const created = await opened.bureau.schedules.create({
        agentName: 'writer',
        spec: '1h',
        input: 'x',
        principal: 'anonymous:local',
      });
      const scheduleId = created!.id;
      const refused = await opened.call(name, {
        scheduleId,
        spec: '5m',
        agentName: 'writer',
        input: 'x',
      });
      expect(refused.status).not.toBe(200);
      expect((await opened.bureau.schedules.get(scheduleId))?.revision).toBe(1);
      expect((await opened.bureau.schedules.get(scheduleId))?.status).toBe('active');
      expect((await opened.bureau.schedules.list())?.total).toBe(1);
    },
  );
});
