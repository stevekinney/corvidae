/**
 * COR-1819 — the A2A handler the host mounts under `/bureau/a2a/<agent>`. An A2A client is a plain
 * HTTP client here: it fetches an agent's card at the URL the host derived from its own origin and
 * runs the agent through JSON-RPC. Only an agent that opted in is served (a file agent with
 * `a2a: true`, a code agent named in `HostOptions.a2aAgents`), turning the opt-in off keeps the
 * tombstone for tasks the agent already has, and push delivery is built only when the
 * `a2a.push.enabled` setting is on at start.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rejectionOf } from '@lostgradient/testing';
import { waitUntil } from '@lostgradient/testing/wait-until';

import { fakeProvider, writeProviderHome } from './fake-provider.test-support.ts';
import { startHost, type Host, type HostOptions } from './host.ts';

const REPLY = 'Answered over A2A.';
const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const agentFile = (name: string, a2a: boolean) =>
  [
    '---',
    `name: ${name}`,
    'description: A file agent reachable over A2A.',
    'model: anthropic/sonnet',
    `a2a: ${a2a}`,
    '---',
    'You are a careful researcher.',
    '',
  ].join('\n');

/** A home with a provider, and the agent files named by `files`. */
async function makeHome(files: Record<string, string> = {}): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-a2a-'));
  directories.push(home);
  await writeProviderHome(home);
  await mkdir(join(home, 'agents'), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(home, 'agents', name), text);
  }
  return home;
}

async function startAt(home: string, options: Partial<HostOptions> = {}): Promise<Host> {
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    seed: false,
    resolveProviderGenerate: fakeProvider(REPLY).resolver,
    ...options,
  });
  hosts.push(host);
  return host;
}

async function closeHost(host: Host): Promise<void> {
  hosts.splice(hosts.indexOf(host), 1);
  await host.close();
}

// A JSON-RPC body read back from the wire: each test asserts the shape it needs.
type Json = any;

let sends = 0;
const message = (text: string): Json => {
  sends += 1;
  return { messageId: `host-a2a-${sends}`, role: 'ROLE_USER', parts: [{ text }] };
};

/** The status and body of an agent's public card; the body is `undefined` when it is not JSON. */
async function card(host: Host, agent: string): Promise<{ status: number; body: Json }> {
  const response = await fetch(
    new URL(`/bureau/a2a/${agent}/.well-known/agent-card.json`, host.url),
  );
  const body: Json = await response.json().catch(() => undefined);
  return { status: response.status, body };
}

async function cardStatus(host: Host, agent: string): Promise<number> {
  const { status } = await card(host, agent);
  return status;
}

/** Whether an agent's card declares `pushNotifications`. */
async function declaresPush(host: Host, agent: string): Promise<boolean> {
  const { body } = await card(host, agent);
  return body.capabilities.pushNotifications;
}

async function rpc(host: Host, agent: string, method: string, params: Json): Promise<Json> {
  const response = await fetch(new URL(`/bureau/a2a/${agent}`, host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

/** Sends a message and waits until its task reaches a terminal state. */
async function runToCompletion(host: Host, agent: string, text: string): Promise<Json> {
  const sent = await rpc(host, agent, 'SendMessage', { message: message(text) });
  const id = sent.body.result.task.id as string;
  let task: Json = sent.body.result.task;
  await waitUntil(
    async () => {
      const polled = await rpc(host, agent, 'GetTask', { id });
      task = polled.body.result;
      return task.status.state === 'TASK_STATE_COMPLETED';
    },
    { message: `task ${id} to complete` },
  );
  return task;
}

describe('an agent that opted into A2A', () => {
  test('has a card at the URL the host derived, and runs to completion for a client', async () => {
    const host = await startAt(await makeHome({ 'researcher.md': agentFile('Researcher', true) }));

    const fetched = await card(host, 'researcher');

    expect(fetched.status).toBe(200);
    expect(fetched.body.name).toBe('Researcher');
    const derived = `http://127.0.0.1:${host.url.port}/bureau/a2a/researcher`;
    expect(fetched.body.supportedInterfaces.map((entry: Json) => entry.url)).toEqual([derived]);
    expect(fetched.body.capabilities.pushNotifications).toBe(false);
    const task = await runToCompletion(host, 'researcher', 'Find me a source.');
    expect(JSON.stringify(task)).toContain(REPLY);
  });

  test('a code agent in the host allowlist is reachable, and one outside it is not', async () => {
    const host = await startAt(await makeHome(), { a2aAgents: ['echo'], seed: true });

    expect(await cardStatus(host, 'echo')).toBe(200);
    const task = await runToCompletion(host, 'echo', 'ping');
    expect(JSON.stringify(task)).toContain('ping');
    expect(await cardStatus(host, 'assistant')).toBe(404);
    const refused = await rpc(host, 'assistant', 'SendMessage', { message: message('hello') });
    expect(refused.status).toBe(404);
    expect(refused.body?.result).toBeUndefined();
  });

  test('refuses to start on an allowlist that names an agent the host does not define', async () => {
    const home = await makeHome();

    const failure = await rejectionOf(startAt(home, { a2aAgents: ['no-such-agent'] }));

    expect(String(failure)).toContain('no-such-agent');
  });
});

describe('an agent that did not opt in', () => {
  test('has no card, and a send to it is refused', async () => {
    const host = await startAt(await makeHome({ 'quiet.md': agentFile('Quiet', false) }));

    expect(await cardStatus(host, 'quiet')).toBe(404);
    const refused = await rpc(host, 'quiet', 'SendMessage', { message: message('hello') });
    expect(refused.body?.result).toBeUndefined();
    expect(refused.status).toBe(404);
  });
});

describe('turning an agent’s A2A off', () => {
  test('keeps the tombstone for the task it already has: no card, no new task', async () => {
    const home = await makeHome({ 'researcher.md': agentFile('Researcher', true) });
    const host = await startAt(home);
    const finished = await runToCompletion(host, 'researcher', 'Find me a source.');

    const path = join(home, 'agents', 'researcher.md');
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace('a2a: true', 'a2a: false'));
    await host.bureau.agents.refresh();
    expect(host.bureau.agents.list().some((agent) => agent.id === 'researcher' && !agent.a2a)).toBe(
      true,
    );

    expect(await cardStatus(host, 'researcher')).toBe(404);
    const kept = await rpc(host, 'researcher', 'GetTask', { id: finished.id });
    expect(kept.body.result.id).toBe(finished.id);
    const refused = await rpc(host, 'researcher', 'SendMessage', { message: message('again') });
    expect(refused.body.error.code).toBe(-32001);
  });
});

describe('the push settings', () => {
  test('read their defaults, write through settings, and wait for a restart', async () => {
    const host = await startAt(await makeHome());

    const before = await host.bureau.settings.get();
    expect(before.values['a2a.push.enabled']).toBe(false);
    expect(before.values['a2a.push.sweepIntervalMs']).toBe(3_600_000);
    expect(before.keys['a2a.push.enabled']).toMatchObject({ apply: 'restart', locked: false });

    const applied = await host.bureau.settings.update(
      { 'a2a.push.enabled': true, 'a2a.push.sweepIntervalMs': 600_000 },
      { expectedRevision: before.revision },
    );
    expect(applied).toMatchObject({
      outcome: 'applied',
      pendingRestart: ['a2a.push.enabled', 'a2a.push.sweepIntervalMs'],
    });
    const after = await host.bureau.settings.get();
    expect(after.values['a2a.push.enabled']).toBe(true);
    expect(after.values['a2a.push.sweepIntervalMs']).toBe(600_000);
    expect(after.keys['a2a.push.enabled']?.pendingRestart).toBe(true);
  });

  test('refuse a value the host could not run with', async () => {
    const host = await startAt(await makeHome());
    const { revision } = await host.bureau.settings.get();

    for (const patch of [
      { 'a2a.push.sweepIntervalMs': 0 },
      { 'a2a.push.sweepIntervalMs': 1.5 },
      { 'a2a.push.sweepIntervalMs': 2_147_483_648 },
      { 'a2a.push.enabled': 'yes' },
    ]) {
      const result = await host.bureau.settings.update(patch, { expectedRevision: revision });
      expect(result, JSON.stringify(patch)).toMatchObject({
        outcome: 'rejected',
        reason: 'invalid-value',
      });
    }
  });

  test('start push delivery only when enabled, and only after a restart', async () => {
    const home = await makeHome({ 'researcher.md': agentFile('Researcher', true) });
    const first = await startAt(home);
    const finished = await runToCompletion(first, 'researcher', 'Find me a source.');
    const pushParams = { taskId: finished.id, url: 'https://receiver.example/hook' };

    expect(await declaresPush(first, 'researcher')).toBe(false);
    const refused = await rpc(first, 'researcher', 'CreateTaskPushNotificationConfig', pushParams);
    expect(refused.body.error.code).toBe(-32003);

    const { revision } = await first.bureau.settings.get();
    await first.bureau.settings.update(
      { 'a2a.push.enabled': true },
      { expectedRevision: revision },
    );
    // Stored, but this process booted with it off.
    expect(await declaresPush(first, 'researcher')).toBe(false);
    await closeHost(first);

    const second = await startAt(home);
    expect(await declaresPush(second, 'researcher')).toBe(true);
    const accepted = await rpc(
      second,
      'researcher',
      'CreateTaskPushNotificationConfig',
      pushParams,
    );
    expect(accepted.body.result).toMatchObject({ taskId: finished.id, url: pushParams.url });
  });
});
