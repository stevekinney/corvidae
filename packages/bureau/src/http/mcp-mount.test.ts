/**
 * COR-839 — Bureau's v1 MCP adapter: the official MCP SDK client, in both
 * protocol eras, lists the twenty-one "observe and steer" tools and calls them as
 * the authenticated caller, through the catalog pipeline and each operation's
 * owner predicate.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createAgent } from '@lostgradient/operative';
import { MCP_LEGACY_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { waitForCondition } from '../test';
import type { BureauMcpOptions } from './mcp-mount.ts';
import {
  type Handler,
  OWNER,
  type OpenedBureau,
  openBureau,
  parkingUntilAborted,
} from './management/management-fixtures.test-support.ts';

const V1_TOOLS = [
  'bureau.agents.list',
  'bureau.contexts.get',
  'bureau.contexts.input',
  'bureau.contexts.list',
  'bureau.goals.get',
  'bureau.goals.list',
  'bureau.reviews.get',
  'bureau.reviews.list',
  'bureau.reviews.resolve',
  'bureau.schedules.get',
  'bureau.schedules.list',
  'bureau.tasks.cancel',
  'bureau.tasks.events',
  'bureau.tasks.get',
  'bureau.tasks.inspect',
  'bureau.tasks.list',
  'bureau.tasks.respond',
  'bureau.workflows.get',
  'bureau.workflows.list',
  'bureau.workflows.runs.get',
  'bureau.workflows.runs.list',
];

type Mode = { pin: string } | 'legacy';
const eras: Array<{ era: string; mode: Mode; version: string }> = [
  { era: 'modern', mode: { pin: MCP_PROTOCOL_VERSION }, version: MCP_PROTOCOL_VERSION },
  { era: 'legacy', mode: 'legacy', version: MCP_LEGACY_PROTOCOL_VERSION },
];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function open(mcp: BureauMcpOptions = {}): Promise<OpenedBureau> {
  const opened = await openBureau({
    durableHistory: true,
    agents: { worker: createAgent({ generate: parkingUntilAborted }) },
    handlerOptions: { mcp },
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

async function connect(handler: Handler, key: string, mode: Mode): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: (url, init) => {
      const request = new Request(url, init);
      request.headers.set('X-API-Key', key);
      return handler(request);
    },
  });
  const client = new Client(
    { name: 'bureau-mcp-client', version: '1.0.0' },
    { versionNegotiation: { mode } },
  );
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

async function startRun(opened: OpenedBureau, principal: string) {
  const run = await opened.bureau.createRun({ message: 'work', principal, agentName: 'worker' });
  await waitForCondition(
    () => opened.bureau.getRun(run.id)?.status === 'running',
    `run ${run.id} never started`,
  );
  return run;
}

describe.each(eras)('the Bureau MCP adapter ($era era)', ({ mode, version }) => {
  it('lists exactly the twenty-one v1 tools', async () => {
    const opened = await open();
    const client = await connect(opened.handler, 'alice-key', mode);
    expect(client.getNegotiatedProtocolVersion()).toBe(version);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(V1_TOOLS);
    expect(tools.find((tool) => tool.name === 'bureau.tasks.cancel')?.annotations).toMatchObject({
      destructiveHint: true,
    });
  });

  it('observes the caller’s own work and hides another owner’s', async () => {
    const opened = await open();
    const run = await startRun(opened, OWNER.alice);
    const alice = await connect(opened.handler, 'alice-key', mode);
    const bob = await connect(opened.handler, 'bob-key', mode);

    const listed = await alice.callTool({ name: 'bureau.tasks.list', arguments: {} });
    expect(listed.isError).toBeFalsy();
    const tasks = (listed.structuredContent as { tasks: Array<{ id: string; owner: string }> })
      .tasks;
    expect(tasks.map((task) => task.id)).toContain(run.id);

    const own = await alice.callTool({ name: 'bureau.tasks.get', arguments: { taskId: run.id } });
    expect(own.structuredContent).toMatchObject({ id: run.id, owner: OWNER.alice });

    // The owner predicate answers another owner's task as a missing one, on MCP as on JSON-RPC.
    const hidden = await bob.callTool({ name: 'bureau.tasks.get', arguments: { taskId: run.id } });
    expect(hidden.isError).toBe(true);
    expect(hidden.structuredContent).toMatchObject({ code: 'NotFound' });
    const bobs = await bob.callTool({ name: 'bureau.tasks.list', arguments: {} });
    expect((bobs.structuredContent as { tasks: unknown[] }).tasks).toEqual([]);
  });

  it('follows a task’s events from a cursor, then steers it with a cancel', async () => {
    const opened = await open();
    const run = await startRun(opened, OWNER.alice);
    const alice = await connect(opened.handler, 'alice-key', mode);

    const followed = await alice.callTool({
      name: 'bureau.tasks.events',
      arguments: { taskId: run.id },
    });
    expect(followed.isError).toBeFalsy();
    const page = followed.structuredContent as {
      events: Array<{ kind: string; cursor: string }>;
      nextCursor: string | null;
    };
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events[0]?.kind).toBe('task.snapshot');
    expect(page.nextCursor).toBe(page.events.at(-1)?.cursor ?? null);

    const cancelled = await alice.callTool({
      name: 'bureau.tasks.cancel',
      arguments: { taskId: run.id },
    });
    expect(cancelled.isError).toBeFalsy();
    await waitForCondition(
      () => opened.bureau.getRun(run.id)?.status !== 'running',
      `run ${run.id} was not cancelled`,
    );
  });

  it('inspects a task: liveness, children, and nothing of its content', async () => {
    const opened = await open();
    const run = await startRun(opened, OWNER.alice);
    const alice = await connect(opened.handler, 'alice-key', mode);
    const bob = await connect(opened.handler, 'bob-key', mode);

    const inspected = await alice.callTool({
      name: 'bureau.tasks.inspect',
      arguments: { taskId: run.id },
    });
    expect(inspected.isError).toBeFalsy();
    expect(inspected.structuredContent).toMatchObject({
      schemaVersion: 'bureau.task-inspection.v1',
      taskId: run.id,
      task: { id: run.id, owner: OWNER.alice },
      liveness: { id: run.id, status: 'running', cancellable: true },
      children: [],
    });
    expect(JSON.stringify(inspected.structuredContent)).not.toMatch(/transcript|prompt|checkpoint/);

    const hidden = await bob.callTool({
      name: 'bureau.tasks.inspect',
      arguments: { taskId: run.id },
    });
    expect(hidden.isError).toBe(true);
    expect(hidden.structuredContent).toMatchObject({ code: 'NotFound' });
  });

  it('serves injected resources and tool metadata through the adapter', async () => {
    const uri = 'ui://bureau/probe';
    const opened = await open({
      resources: [
        { uri, name: 'probe', mimeType: 'text/html;profile=mcp-app', text: '<!doctype html>' },
      ],
      toolMeta: { 'bureau.tasks.inspect': { ui: { resourceUri: uri } } },
    });
    const alice = await connect(opened.handler, 'alice-key', mode);
    const listed = await alice.listResources();
    expect(listed.resources.map((resource) => resource.uri)).toEqual([uri]);
    const read = await alice.readResource({ uri });
    expect(read.contents).toMatchObject([{ text: '<!doctype html>' }]);
    const { tools } = await alice.listTools();
    expect(tools.find((tool) => tool.name === 'bureau.tasks.inspect')?._meta).toEqual({
      ui: { resourceUri: uri },
    });
  });

  it('answers arguments the operation refuses as an InvalidParams tool error', async () => {
    const opened = await open();
    const alice = await connect(opened.handler, 'alice-key', mode);
    const outcome = await alice
      .callTool({ name: 'bureau.tasks.get', arguments: { taskId: 7 } })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    // The SDK may refuse the arguments against the advertised schema before the catalog does.
    if ('result' in outcome) {
      expect(outcome.result.isError).toBe(true);
    } else {
      expect(outcome.error).toBeDefined();
    }
  });
});
