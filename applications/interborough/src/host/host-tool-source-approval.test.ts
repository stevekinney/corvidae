/**
 * COR-1950: a saved MCP or OpenAPI tool that changes things asks first, and runs once a person
 * approves it. Armorer refuses to issue an approval for a tool with no version, and the loaders
 * built tools with none, so under the default `on-changes` approval a saved mutating tool raised no
 * review and ran nothing. The loader now versions each tool by what a person approves, so:
 *
 * - a review is raised, and approving it runs the tool, for an MCP tool and an OpenAPI tool;
 * - the version is the same after a restart, so a review raised before it can still be approved;
 * - a changed schema is a new version, so a review raised for the old one can no longer be approved
 *   and a tool the chat remembered asks again.
 *
 * The host is the real one: a file agent, the Bureau's reviews, the encrypted vault, and the loader.
 * Only the model is a stub, and the servers are in-process on the loopback.
 */
import { resolveProviderGenerate } from '@lostgradient/bureau';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeProviderHome } from './fake-provider.test-support.ts';
import { startHost, type Host, type HostOptions } from './host.ts';
import {
  startPetsServer,
  startRenamingMcpServer,
  writablePetsDocument,
  type PetsServer,
  type RenamingMcpServer,
} from './tool-source-servers.test-support.ts';

const BEARER = 'bearer-fixture-approval-3d71';
const OWNER = 'anonymous:local';

const directories: string[] = [];
const hosts: Host[] = [];
const servers: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const server of servers.splice(0)) await server.stop();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** The call the stub model makes on the first step of a run. */
const plan: { tool: string; input: Record<string, unknown> } = { tool: '', input: {} };

/**
 * An Anthropic client that asks for `plan`'s tool when the latest block is the person's text, and
 * answers when it is a tool's result: one call per run, however long the chat is.
 */
const client = {
  messages: {
    create: async (body: { messages: { role: string; content: unknown }[] }) => {
      const latest = body.messages.at(-1);
      // A person's message after a tool's result joins the same turn, so the last block decides.
      const blocks: unknown = latest?.content;
      const last: unknown = Array.isArray(blocks) ? blocks.at(-1) : undefined;
      const afterTool = (last as { type?: string } | undefined)?.type === 'tool_result';
      return afterTool
        ? {
            id: 'message-done',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            content: [{ type: 'text', text: 'Done.' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        : {
            id: 'message-tool',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            content: [
              {
                type: 'tool_use',
                id: `toolu_${crypto.randomUUID()}`,
                name: plan.tool,
                input: plan.input,
              },
            ],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
    },
  },
};

const resolver: NonNullable<HostOptions['resolveProviderGenerate']> = (
  definitions,
  provider,
  streamEventTarget,
  streaming,
) =>
  resolveProviderGenerate(
    definitions,
    Object.assign({}, provider, { client }),
    streamEventTarget,
    streaming,
  );

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-tool-approval-'));
  directories.push(directory);
  await writeProviderHome(directory);
  await mkdir(join(directory, 'agents'), { recursive: true });
  // The default approval: no `toolApproval`, so a tool that changes things asks first.
  await writeFile(
    join(directory, 'agents', 'helper.md'),
    [
      '---',
      'name: Helper',
      'description: Uses saved tools.',
      'model: anthropic/sonnet',
      'tools: [files__rename, pets__create-pet]',
      '---',
      'Help.',
      '',
    ].join('\n'),
  );
  return directory;
}

async function startAt(path: string): Promise<Host> {
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: path },
    port: 0,
    resolveProviderGenerate: resolver,
  });
  hosts.push(host);
  return host;
}

async function restart(host: Host, path: string): Promise<Host> {
  await host.close();
  hosts.splice(hosts.indexOf(host), 1);
  return startAt(path);
}

async function save(host: Host, id: string, body: unknown): Promise<void> {
  const response = await fetch(new URL(`/host/tool-sources/${id}`, host.url), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
}

const mcpSource = (server: RenamingMcpServer) => ({
  source: {
    id: 'files',
    kind: 'mcp',
    transport: {
      type: 'http',
      url: `${server.origin}/`,
      authentication: { type: 'bearer', credential: 'token' },
    },
  },
  credentials: { token: BEARER },
});

const petsSource = (server: PetsServer, field: string) => ({
  source: {
    id: 'pets',
    kind: 'openapi',
    specification: { type: 'document', document: writablePetsDocument(field) },
    baseUrl: `${server.origin}/`,
  },
});

type Fixture = {
  path: string;
  host: Host;
  mcp: RenamingMcpServer;
  pets: PetsServer;
};

/** A host that has saved an MCP source and an OpenAPI source, restarted so it has loaded them. */
async function savedSources(): Promise<Fixture> {
  const path = await home();
  const mcp = await startRenamingMcpServer(BEARER);
  const pets = await startPetsServer();
  servers.push(mcp, pets);
  const first = await startAt(path);
  await save(first, 'files', mcpSource(mcp));
  await save(first, 'pets', petsSource(pets, 'name'));
  const host = await restart(first, path);
  return { path, host, mcp, pets };
}

type Call = { tool: string; input: Record<string, unknown> };

const RENAME = { tool: 'files__rename', input: { target: 'a' } };
const CREATE = { tool: 'pets__create-pet', input: { body: { name: 'Rex' } } };

/** Starts a run of the agent that makes `call` on its first step, in `contextId` when given. */
async function ask(host: Host, call: Call, contextId?: string) {
  plan.tool = call.tool;
  plan.input = call.input;
  const task = await host.bureau.tasks.start('helper', 'Go.', {
    principal: OWNER,
    ...(contextId === undefined ? {} : { contextId }),
  });
  return { runId: task.id, contextId: task.contextId };
}

/** The tool approval the run raised, once it has. */
async function reviewOf(host: Host, runId: string) {
  await waitUntil(() => host.bureau.reviews.list().some((review) => review.runId === runId), {
    message: `run ${runId} to raise a review`,
  });
  const review = host.bureau.reviews.list().find((candidate) => candidate.runId === runId);
  if (review?.kind !== 'tool-approval') throw new Error('Expected a tool approval.');
  return review;
}

/** Starts a run that makes `call` and returns it with the review it raised. */
async function raise(host: Host, call: Call, contextId?: string) {
  const run = await ask(host, call, contextId);
  const review = await reviewOf(host, run.runId);
  return { ...run, review };
}

/** Whether a run has settled without raising a review. */
async function settledWithoutReview(host: Host, runId: string): Promise<boolean> {
  await waitUntil(
    async () => {
      const run = await host.bureau.tasks.workflow(runId);
      return run?.status === 'completed';
    },
    { message: `run ${runId} to complete` },
  );
  return !host.bureau.reviews.list().some((review) => review.runId === runId);
}

const approve = (host: Host, id: string, remember = false) =>
  host.bureau.reviews.resolve({
    id,
    decision: 'approve',
    principal: OWNER,
    ...(remember ? { remember: true } : {}),
  });

const VERSIONED = (name: string) => new RegExp(`^default:${name}@[0-9a-f]{32}$`);

describe('a saved tool that changes things, under the default approval', () => {
  test('an MCP tool raises a review, and runs once approved', async () => {
    const { host, mcp } = await savedSources();

    const { runId } = await ask(host, RENAME);
    const review = await reviewOf(host, runId);

    expect(review.approval.toolName).toBe('files__rename');
    expect(review.approval.approvalBinding?.toolDefinitionRevision).toMatch(
      VERSIONED('files__rename'),
    );
    expect(mcp.renamed).toEqual([]);

    await approve(host, review.id);

    await waitUntil(() => mcp.renamed.length === 1, { message: 'the approved tool to run' });
    expect(mcp.renamed).toEqual([{ target: 'a' }]);
  });

  test('an OpenAPI tool raises a review, and runs once approved', async () => {
    const { host, pets } = await savedSources();

    const { runId } = await ask(host, CREATE);
    const review = await reviewOf(host, runId);

    expect(review.approval.toolName).toBe('pets__create-pet');
    expect(review.approval.approvalBinding?.toolDefinitionRevision).toMatch(
      VERSIONED('pets__create-pet'),
    );
    expect(pets.requests).toEqual([]);

    await approve(host, review.id);

    await waitUntil(() => pets.requests.length === 1, { message: 'the approved tool to run' });
    expect(pets.requests).toEqual([{ method: 'POST', path: '/pets', body: { name: 'Rex' } }]);
  });
});

describe('the version of a saved tool across a restart', () => {
  test('is the same, so a review raised before the restart is approved after it and runs', async () => {
    const { path, host: first, mcp, pets } = await savedSources();
    const { review: rename } = await raise(first, RENAME);
    const { review: create } = await raise(first, CREATE);
    const before = [
      rename.approval.approvalBinding?.toolDefinitionRevision,
      create.approval.approvalBinding?.toolDefinitionRevision,
    ];

    const second = await restart(first, path);

    await waitUntil(() => second.bureau.reviews.list().length === 2, {
      message: 'both reviews to survive the restart',
    });
    const after = second.bureau.reviews
      .list()
      .map((review) => (review.kind === 'tool-approval' ? review : undefined))
      .toSorted((a, b) => (a?.approval.toolName ?? '').localeCompare(b?.approval.toolName ?? ''));
    expect(after.map((review) => review?.approval.toolName)).toEqual([
      'files__rename',
      'pets__create-pet',
    ]);
    expect(after.map((review) => review?.approval.approvalBinding?.toolDefinitionRevision)).toEqual(
      before,
    );

    await approve(second, rename.id);
    await approve(second, create.id);

    await waitUntil(() => mcp.renamed.length === 1 && pets.requests.length === 1, {
      message: 'both approved tools to run',
    });
  });
});

describe('a saved tool whose schema changed', () => {
  test('leaves a review raised for the old schema unavailable, and nothing runs (MCP)', async () => {
    const { path, host: first, mcp } = await savedSources();
    const { review } = await raise(first, RENAME);
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);
    await mcp.changeField('path');
    // The Bureau reports the review it can no longer restore; the report is part of the contract.
    const reported = spyOn(console, 'warn').mockImplementation(() => undefined);
    let second: Host;
    let report: string;
    try {
      second = await startAt(path);
      report = reported.mock.calls.flat().map(String).join('\n');
    } finally {
      reported.mockRestore();
    }

    expect(report).toContain('Failed to restore approval binding');
    expect(second.bureau.reviews.list()).toEqual([]);
    const outcome = await approve(second, review.id).then(
      () => 'approved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(outcome).not.toBe('approved');
    expect(mcp.renamed).toEqual([]);
  });

  test('is asked about again in a chat that remembered the old one (MCP)', async () => {
    const { path, host: first, mcp } = await savedSources();
    const firstRun = await raise(first, RENAME);
    await approve(first, firstRun.review.id, true);
    await waitUntil(() => mcp.renamed.length === 1, { message: 'the first call to run' });

    // The grant holds while the tool is unchanged, across a restart: the version is stable.
    const unchanged = await restart(first, path);
    const same = await ask(unchanged, RENAME, firstRun.contextId);
    expect(await settledWithoutReview(unchanged, same.runId)).toBe(true);
    await waitUntil(() => mcp.renamed.length === 2, { message: 'the remembered call to run' });

    // The server changes the tool's input schema: the grant no longer covers it.
    await mcp.changeField('path');
    const changed = await restart(unchanged, path);
    const asked = await ask(
      changed,
      { tool: 'files__rename', input: { path: 'a' } },
      firstRun.contextId,
    );
    const review = await reviewOf(changed, asked.runId);

    expect(review.approval.toolName).toBe('files__rename');
    expect(mcp.renamed).toHaveLength(2);
  });

  test('is asked about again in a chat that remembered the old one (OpenAPI)', async () => {
    const { path, host: first, pets } = await savedSources();
    const firstRun = await raise(first, CREATE);
    await approve(first, firstRun.review.id, true);
    await waitUntil(() => pets.requests.length === 1, { message: 'the first call to run' });

    const unchanged = await restart(first, path);
    const same = await ask(unchanged, CREATE, firstRun.contextId);
    expect(await settledWithoutReview(unchanged, same.runId)).toBe(true);
    await waitUntil(() => pets.requests.length === 2, { message: 'the remembered call to run' });

    // The document now names the body's property differently.
    await save(unchanged, 'pets', petsSource(pets, 'title'));
    const changed = await restart(unchanged, path);
    const asked = await ask(
      changed,
      { tool: 'pets__create-pet', input: { body: { title: 'Rex' } } },
      firstRun.contextId,
    );
    const review = await reviewOf(changed, asked.runId);

    expect(review.approval.toolName).toBe('pets__create-pet');
    expect(pets.requests).toHaveLength(2);
  });
});
