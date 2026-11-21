/**
 * COR-2545 — the schedule writes a host panel may make: `bureau.schedules.create`, `update`,
 * `pause` and `resume` are open to a panel's `hostOnlyTools` and stay closed to a model. A model
 * sees only `mcpExposable` operations, so none of the four is listed or callable over MCP; the
 * audit trail records each write with the caller's owner as its principal and, when the call came
 * through a host panel, the panel's URI, which no request can name.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createAgent } from '@lostgradient/operative';
import { MCP_PROTOCOL_VERSION } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  decodeScheduleTransition,
  scheduleTransitionOperation,
} from '../../schedule-transition-outbox.ts';
import {
  HOST_PANEL_OPERATIONS,
  hostPanelUriOfCall,
  runAsHostPanel,
} from '../host-panel-operations.ts';
import {
  answering,
  type Handler,
  type OpenedBureau,
  OWNER,
  openBureau,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';
import { bureauSchedulesOperations } from './schedules-operations.ts';

const writer = createAgent({
  name: 'writer',
  generate: async () => ({ content: 'ok', toolCalls: [] }),
});

const PANEL = 'ui://inspectors/schedule-editor/v1';
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

async function open(): Promise<OpenedBureau> {
  // A key with no scope schedules only an agent that opts into A2A (COR-1904).
  const opened = await openBureau({
    durableHistory: true,
    agents: { writer },
    a2aAgents: ['writer'],
    generate: answering(),
    handlerOptions: { mcp: {} },
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

async function connect(handler: Handler, key: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: (url, init) => {
      const request = new Request(url, init);
      request.headers.set('X-API-Key', key);
      return handler(request);
    },
  });
  const client = new Client(
    { name: 'bureau-mcp-client', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
  );
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

const KEY = 'alice-key';

async function createdSchedule(opened: OpenedBureau): Promise<string> {
  const body = await rpc(
    opened.handler,
    'bureau.schedules.create',
    { agentName: 'writer', spec: '1h', input: 'Say hello', description: 'Hello' },
    KEY,
  );
  expect(body.error).toBeUndefined();
  return body.result!['id'] as string;
}

async function revisionOf(opened: OpenedBureau, id: string): Promise<number | undefined> {
  return (await opened.bureau.schedules.get(id))?.revision;
}

async function entriesOf(opened: OpenedBureau, id: string) {
  const entries =
    (await opened.bureau.internals.auditTrail?.query({ runId: `schedule:${id}` })) ?? [];
  return entries.toSorted((a, b) => a.sequence - b.sequence);
}

describe('the schedule writes open to a host panel', () => {
  it('lists each write in the Bureau’s set of operations open to a panel, and none is `mcpExposable`', () => {
    for (const name of WRITES) {
      expect(HOST_PANEL_OPERATIONS.has(name), name).toBe(true);
      const operation = bureauSchedulesOperations.find((candidate) => candidate.name === name);
      expect(operation?.mcpExposable, name).toBe(false);
    }
    // Each other schedule operation stays out of the set: a panel opens exactly what it was given.
    const scheduleNames = [...HOST_PANEL_OPERATIONS].filter((name) =>
      name.startsWith('bureau.schedules.'),
    );
    expect(scheduleNames.toSorted()).toEqual([...WRITES].toSorted());
  });

  it('lists none of the four over MCP, and refuses each called by name, writing nothing', async () => {
    const opened = await open();
    const id = await createdSchedule(opened);
    const before = await revisionOf(opened, id);
    const client = await connect(opened.handler, KEY);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of WRITES) expect(names, name).not.toContain(name);
    // The reads a panel's pickers use stay listed.
    expect(names).toContain('bureau.schedules.get');
    expect(names).toContain('bureau.schedules.list');

    const arguments_: Record<(typeof WRITES)[number], Record<string, unknown>> = {
      'bureau.schedules.create': { agentName: 'writer', spec: '2h', input: 'Another' },
      'bureau.schedules.update': { scheduleId: id, spec: '5m' },
      'bureau.schedules.pause': { scheduleId: id },
      'bureau.schedules.resume': { scheduleId: id },
    };
    for (const name of WRITES) {
      const refused = await client.callTool({ name, arguments: arguments_[name] }).then(
        (result) => result.isError === true,
        () => true,
      );
      expect(refused, name).toBe(true);
    }
    expect(await revisionOf(opened, id)).toBe(before);
    expect((await opened.bureau.schedules.get(id))?.status).toBe('active');
    expect((await opened.bureau.schedules.list())?.total).toBe(1);
  });
});

describe('the audit entry of a schedule write', () => {
  it('names the owner as the principal and the panel’s URI on create, update, pause and resume', async () => {
    const opened = await open();
    const asPanel = <T>(call: () => Promise<T>): Promise<T> => runAsHostPanel(PANEL, call);
    const created = await asPanel(() =>
      rpc(
        opened.handler,
        'bureau.schedules.create',
        { agentName: 'writer', spec: '1h', input: 'Say hello', description: 'Hello' },
        KEY,
      ),
    );
    expect(created.error).toBeUndefined();
    const id = created.result!['id'] as string;
    const updated = await asPanel(() =>
      rpc(opened.handler, 'bureau.schedules.update', { scheduleId: id, spec: '2h' }, KEY),
    );
    expect(updated.error).toBeUndefined();
    const paused = await asPanel(() =>
      rpc(opened.handler, 'bureau.schedules.pause', { scheduleId: id }, KEY),
    );
    expect(paused.error).toBeUndefined();
    const resumed = await asPanel(() =>
      rpc(opened.handler, 'bureau.schedules.resume', { scheduleId: id }, KEY),
    );
    expect(resumed.error).toBeUndefined();

    const entries = await entriesOf(opened, id);
    expect(entries.map((entry) => entry.type)).toEqual([
      'schedule.created',
      'schedule.updated',
      'schedule.paused',
      'schedule.resumed',
    ]);
    for (const entry of entries) {
      expect(entry.principal, entry.type).toBe(OWNER.alice);
      expect(entry.detail, entry.type).toMatchObject({ scheduleId: id, panelUri: PANEL });
    }
    expect(entries[1]?.detail).toMatchObject({ changedKeys: 'spec' });
  });

  it('names the owner and no panel for a write that did not come through one', async () => {
    const opened = await open();
    const id = await createdSchedule(opened);
    await rpc(opened.handler, 'bureau.schedules.update', { scheduleId: id, spec: '2h' }, KEY);
    await rpc(opened.handler, 'bureau.schedules.pause', { scheduleId: id }, KEY);
    const entries = await entriesOf(opened, id);
    expect(entries.map((entry) => entry.type)).toEqual([
      'schedule.created',
      'schedule.updated',
      'schedule.paused',
    ]);
    for (const entry of entries) {
      expect(entry.principal, entry.type).toBe(OWNER.alice);
      expect(Object.hasOwn(entry.detail as object, 'panelUri'), entry.type).toBe(false);
    }
  });

  it('never takes the panel from the request: a header, a parameter or a body naming one records none', async () => {
    const opened = await open();
    const id = await createdSchedule(opened);
    const forged = await opened.handler(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-API-Key': KEY,
          'x-panel-uri': PANEL,
          'x-host-panel': PANEL,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'bureau.schedules.pause',
          params: { scheduleId: id },
        }),
      }),
    );
    expect(((await forged.json()) as RpcBody).error).toBeUndefined();
    const withParameter = await rpc(
      opened.handler,
      'bureau.schedules.resume',
      { scheduleId: id, panelUri: PANEL },
      KEY,
    );
    // An unknown key is refused or ignored; either way it never reaches the audit entry.
    const entries = await entriesOf(opened, id);
    for (const entry of entries) {
      expect(Object.hasOwn(entry.detail as object, 'panelUri'), entry.type).toBe(false);
    }
    expect(withParameter.result ?? withParameter.error).toBeDefined();
  });

  it('is read from the call’s own scope: a call outside runAsHostPanel sees none', async () => {
    expect(hostPanelUriOfCall()).toBeUndefined();
    const inside = await runAsHostPanel(PANEL, async () => {
      await Promise.resolve();
      return hostPanelUriOfCall();
    });
    expect(inside).toBe(PANEL);
    expect(hostPanelUriOfCall()).toBeUndefined();
  });

  it('refuses a panel that is not a ui:// URI where it enters, so no replay can be left unreadable', () => {
    for (const bad of ['', 'ui://', 'https://example.test/panel', 'inspectors']) {
      expect(() => runAsHostPanel(bad, () => 'ran'), bad).toThrow(TypeError);
    }
    expect(runAsHostPanel(PANEL, () => 'ran')).toBe('ran');
  });

  it('keeps who asked in the pending record, so a replay writes the same entry', () => {
    const operation = scheduleTransitionOperation('bureau-schedule-transition:s:0:0', {
      kind: 'schedule.paused',
      scheduleId: 's',
      committedAtMs: 0,
      actor: { principal: OWNER.alice, panelUri: PANEL },
    });
    expect(operation.type).toBe('put');
    if (operation.type !== 'put') return;
    expect(decodeScheduleTransition(operation.value)?.actor).toEqual({
      principal: OWNER.alice,
      panelUri: PANEL,
    });
  });
});
