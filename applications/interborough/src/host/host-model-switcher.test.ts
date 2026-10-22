/**
 * The seeded `model-switcher` (COR-1565) against the real host: a session of it can be switched
 * between the two models its script names, and the next reply says which model answered. The
 * script calls no model, and the host's provider path is never reached, so no key is read.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeProviderHome } from './fake-provider.test-support.ts';
import { startHost, type Host } from './host.ts';
import { MODEL_SWITCHER_MODELS, modelSwitcherReply } from './seed.ts';

const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A host whose catalog holds the two models the script names (`models` is the allowlist). */
async function start(models: readonly string[] | undefined): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-model-switcher-'));
  directories.push(home);
  if (models !== undefined) {
    await mkdir(home, { recursive: true });
    await writeProviderHome(home, models);
  }
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
  hosts.push(host);
  return host;
}

async function call(host: Host, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) throw new Error(JSON.stringify(body.error));
  return body.result;
}

/** One run of a session, read to its end; the stream's text is what the agent said. */
async function send(host: Host, threadId: string, message: string): Promise<string> {
  const response = await fetch(new URL('/bureau/ag-ui/agents/model-switcher/run', host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      threadId,
      runId: `run-${crypto.randomUUID()}`,
      messages: [{ id: `user-${crypto.randomUUID()}`, role: 'user', content: message }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  expect(response.status).toBe(200);
  return response.text();
}

const [FIRST, SECOND] = MODEL_SWITCHER_MODELS;

describe('the seeded model-switcher', () => {
  test('is selectable over the two models its script names, once the host offers both', async () => {
    const host = await start(['sonnet', 'claude-haiku-4-5']);
    const models = (await call(host, 'bureau.agents.models', {
      agentName: 'model-switcher',
    })) as {
      selectable: boolean;
      models: { provider: string; model: string }[];
      default: unknown;
    };
    expect(models.selectable).toBe(true);
    expect(models.default).toEqual(FIRST);
    expect(models.models.map(({ provider, model }) => ({ provider, model }))).toEqual([
      ...MODEL_SWITCHER_MODELS,
    ]);
  });

  test('offers only the models the host has, and none on a host with no provider', async () => {
    const one = await start(['sonnet']);
    const offered = (await call(one, 'bureau.agents.models', {
      agentName: 'model-switcher',
    })) as { models: { model: string }[] };
    expect(offered.models.map((entry) => entry.model)).toEqual([FIRST.model]);
    const none = await start(undefined);
    const empty = (await call(none, 'bureau.agents.models', {
      agentName: 'model-switcher',
    })) as { selectable: boolean; models: unknown[] };
    expect(empty.selectable).toBe(true);
    expect(empty.models).toEqual([]);
  });

  test('says which model answered, and answers as the model it was switched to', async () => {
    const host = await start(['sonnet', 'claude-haiku-4-5']);
    const threadId = `switch-${crypto.randomUUID()}`;
    // Before any switch the script names the first model, which is the agent's default.
    expect(await send(host, threadId, 'Which model is this?')).toContain(
      modelSwitcherReply(FIRST.model),
    );
    const before = (await call(host, 'bureau.contexts.get', { contextId: threadId })) as {
      model: unknown;
      configVersion: number;
    };
    expect(before.model).toBeNull();
    const outcome = await call(host, 'bureau.contexts.steer', {
      contextId: threadId,
      commandId: `steer-${crypto.randomUUID()}`,
      override: SECOND,
      expectedRevision: before.configVersion,
    });
    expect(outcome).toMatchObject({ outcome: 'accepted' });
    expect(await send(host, threadId, 'And now?')).toContain(modelSwitcherReply(SECOND.model));
    const after = (await call(host, 'bureau.contexts.get', { contextId: threadId })) as {
      model: unknown;
    };
    expect(after.model).toEqual(SECOND);
  });
});
