import { createAgent, createScriptedGenerate, stopWhen } from '@lostgradient/operative';
import { DEMO_AGENT_NAMES } from '@lostgradient/plugin-demo';
import { rejectionOf } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createRegenerationProofAgent,
  REMEMBER_APPROVAL_AGENT,
} from '../../tests/e2e/regeneration-proof-agent.ts';
import { enableDemoPlugin } from './demo-plugin-home.ts';
import { startHost, type Host } from './host.ts';

const directories: string[] = [];
const hosts: Host[] = [];

const extraAgent = createAgent({
  name: 'extra',
  description: 'An agent a test brought.',
  generate: createScriptedGenerate([
    { kind: 'respond', response: { content: 'Hello from the extra agent.', toolCalls: [] } },
  ]),
  stopWhen: stopWhen.noToolCalls(),
});

async function start(options: Parameters<typeof startHost>[0] = {}): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-ag-ui-'));
  directories.push(home);
  await enableDemoPlugin(home);
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0, ...options });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** The event types of the stream a run answers with, read to its end. */
async function runEventTypes(host: Host, agent: string, threadId: string): Promise<string[]> {
  const response = await fetch(new URL(`/bureau/ag-ui/agents/${agent}/run`, host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      threadId,
      runId: `run-${crypto.randomUUID()}`,
      messages: [{ id: `user-${crypto.randomUUID()}`, role: 'user', content: 'Hello' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  return [...text.matchAll(/"type":"([A-Z_]+)"/g)].map((match) => match[1]!);
}

describe('the AG-UI mount', () => {
  test('streams a demo agent’s run under the /bureau prefix', async () => {
    const host = await start();
    const types = await runEventTypes(host, 'demo:assistant', 'thread-assistant');
    expect(types[0]).toBe('RUN_STARTED');
    expect(types).toContain('TEXT_MESSAGE_START');
    expect(types.at(-1)).toBe('RUN_FINISHED');
  });

  test('streams the run of the demo agent the host once kept private, and refuses a name it does not have', async () => {
    const host = await start();
    const internal = await runEventTypes(host, 'demo:internal', 'thread-internal');
    expect(internal[0]).toBe('RUN_STARTED');
    expect(internal.at(-1)).toBe('RUN_FINISHED');
    expect(await runEventTypes(host, 'no-such-agent', 'thread-missing')).toEqual(['RUN_ERROR']);
  });
});

describe('extra agents', () => {
  test('an extra agent runs over the mount', async () => {
    const host = await start({ extraAgents: { agents: { extra: extraAgent } } });
    const types = await runEventTypes(host, 'extra', 'thread-extra');
    expect(types[0]).toBe('RUN_STARTED');
    expect(types.at(-1)).toBe('RUN_FINISHED');
  });

  test('an extra agent named like a demo agent stops the host and names the agent, rather than being replaced', async () => {
    for (const name of DEMO_AGENT_NAMES.map((agent) => `demo:${agent}`)) {
      const home = await mkdtemp(join(tmpdir(), 'interborough-ag-ui-'));
      directories.push(home);
      const refusal = await rejectionOf(
        startHost({
          environment: { INTERBOROUGH_HOME: home },
          port: 0,
          extraAgents: { agents: { [name]: extraAgent } },
        }),
      );
      expect(String(refusal)).toContain(
        `The extra agent "${name}" has the name of an agent the demo plugin contributes`,
      );
    }
  });

  test('an extra agent is listed with the demo ones, none of which opts into A2A', async () => {
    const host = await start({ extraAgents: { agents: { extra: extraAgent } } });
    const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bureau.agents.list', params: {} }),
    });
    const body = (await response.json()) as {
      result: { agents: Array<{ name: string; kind: string; a2a: boolean }> };
    };
    const listed = body.result.agents
      .map((agent) => [agent.name, agent.kind, agent.a2a] as const)
      .toSorted(([left], [right]) => left.localeCompare(right));
    expect(listed).toEqual([
      ['demo:assistant', 'code', false],
      ['demo:changelog-writer', 'code', false],
      ['demo:echo', 'code', false],
      ['demo:internal', 'code', false],
      ['demo:model-switcher', 'code', false],
      ['demo:release-helper', 'code', false],
      ['demo:request-human-input', 'code', false],
      ['demo:tool-runner', 'code', false],
      ['extra', 'code', false],
    ]);
  });
});

/** A `RunAgentInput` body, with whatever `extra` adds, for the thread `threadId`. */
function body(threadId: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    threadId,
    runId: `run-${crypto.randomUUID()}`,
    messages: [{ id: `user-${crypto.randomUUID()}`, role: 'user', content: 'Refund order-1001' }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
    ...extra,
  });
}

async function streamOf(host: Host, agent: string, text: string): Promise<string> {
  const response = await fetch(new URL(`/bureau/ag-ui/agents/${agent}/run`, host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: text,
  });
  return response.text();
}

const interruptOf = (stream: string): string =>
  /"interrupts":\[\{"id":"([^"]+)"/.exec(stream)?.[1] ?? '';

describe('the tool-runner approval over the mount', () => {
  test('the harmless on-changes fixture runs after a remembered approval', async () => {
    const host = await start({ extraAgents: { agents: createRegenerationProofAgent() } });
    const first = await streamOf(host, REMEMBER_APPROVAL_AGENT, body('remember-proof'));
    expect(first).toContain('"type":"interrupt"');
    expect(first).toContain('(mode: on-mutation)');
    const approved = await streamOf(
      host,
      REMEMBER_APPROVAL_AGENT,
      body('remember-proof', {
        messages: [],
        resume: [
          {
            interruptId: interruptOf(first),
            status: 'resolved',
            payload: { decision: 'approve', remember: true },
          },
        ],
      }),
    );
    expect(approved).toContain('The fixture value was recorded.');
    expect(approved).toContain('"remembered":true');
  });

  test('an explicitly always-gated refund requires both independent approval rounds', async () => {
    const host = await start();
    type Review = {
      id: string;
      sessionId?: string;
      approval: { round?: number; policyPauseTier?: string };
    };
    type Answer = {
      result: {
        hash: string;
        overrides: object;
        reviews: Review[];
        decision?: string;
        receipt?: string;
      };
      error?: unknown;
    };
    async function rpc(method: string, params: object): Promise<Answer> {
      const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return (await response.json()) as Answer;
    }
    const initial = await rpc('bureau.agents.overrides.get', { id: 'demo:tool-runner' });
    const updated = await rpc('bureau.agents.overrides.update', {
      id: 'demo:tool-runner',
      expectedHash: initial.result.hash,
      overrides: { ...initial.result.overrides, approvals: { 'issue-refund': 'always' } },
    });
    expect(updated.error).toBeUndefined();
    for (const thread of ['direct-always', 'retry-always']) {
      await streamOf(host, 'demo:tool-runner', body(thread));
      const listed = await rpc('bureau.reviews.list', {});
      const review = listed.result.reviews.find((item) => item.sessionId === thread);
      expect(review).toBeDefined();
      if (!review) throw new Error('Missing review');
      const result = await rpc('bureau.reviews.resolve', {
        id: review.id,
        round: review.approval.round,
        decision: 'approve',
      });
      expect(result.error).toBeUndefined();
      expect(result.result).toMatchObject({ decision: 'approve' });
      expect(result.result.receipt).toBe('superseded');
      const after = await rpc('bureau.reviews.list', {});
      const replacement = after.result.reviews.find((item) => item.id === review.id);
      if (!replacement) throw new Error('Missing replacement review');
      expect(review.approval.policyPauseTier).toBe('tool');
      expect(replacement.approval.policyPauseTier).toBe('registry');
      const final = await rpc('bureau.reviews.resolve', {
        id: replacement.id,
        round: replacement.approval.round,
        decision: 'approve',
      });
      expect(final.error).toBeUndefined();
      expect(final.result).toMatchObject({ decision: 'approve' });
      expect(final.result.receipt).not.toBe('superseded');
      const remaining = await rpc('bureau.reviews.list', {});
      expect(remaining.result.reviews.some((item) => item.id === review.id)).toBe(false);
      const messages = await fetch(new URL(`/bureau/ag-ui/threads/${thread}/messages`, host.url));
      const transcript = (await messages.json()) as {
        messages: Array<{ role?: string; content?: unknown }>;
      };
      const results = transcript.messages.filter(
        (message) =>
          message.role === 'tool' && JSON.stringify(message.content).includes('provider-pending'),
      );
      expect(results).toHaveLength(1);
    }
  });

  test('approving the refund runs a run that reports it, and a later turn raises its own approval', async () => {
    const host = await start();
    const first = await streamOf(host, 'demo:tool-runner', body('thread-refund'));
    expect(first).toContain('"type":"interrupt"');
    expect(first).toContain('Refund order order-1001 for 4200 minor units (USD)');
    expect(first).toContain('(mode: always)');
    expect(first).not.toContain('provider-pending');

    const approved = await streamOf(
      host,
      'demo:tool-runner',
      body('thread-refund', {
        messages: [],
        resume: [
          { interruptId: interruptOf(first), status: 'resolved', payload: { decision: 'approve' } },
        ],
      }),
    );
    expect(approved).toContain('The refund for order order-1001 is pending with the processor.');
    expect(approved).toContain('provider-pending');
    expect(approved).toContain('"type":"success"');

    // The next turn's calls are its own: a call identifier names one call in a conversation.
    const next = await streamOf(host, 'demo:tool-runner', body('thread-refund'));
    expect(next).toContain('"type":"interrupt"');
    expect(next).toContain('seeded-issue-refund-2');
  });

  test('denying the refund reports that it was not issued', async () => {
    const host = await start();
    const first = await streamOf(host, 'demo:tool-runner', body('thread-denied'));

    const denied = await streamOf(
      host,
      'demo:tool-runner',
      body('thread-denied', {
        messages: [],
        resume: [
          { interruptId: interruptOf(first), status: 'resolved', payload: { decision: 'deny' } },
        ],
      }),
    );

    expect(denied).toContain('The refund of order order-1001 was not issued.');
  });
});

describe('the request-human-input question over the mount', () => {
  test('answering it finishes the run, and a later turn asks its own question', async () => {
    const host = await start();
    const first = await streamOf(host, 'demo:request-human-input', body('thread-question'));
    expect(first).toContain('"reason":"human-wait"');

    const answered = await streamOf(
      host,
      'demo:request-human-input',
      body('thread-question', {
        messages: [],
        resume: [
          {
            interruptId: interruptOf(first),
            status: 'resolved',
            payload: { decision: 'approve', answer: 'staging' },
          },
        ],
      }),
    );
    expect(answered).toContain('"type":"success"');

    // The next turn's call is its own: a call identifier names one call in a conversation, and a
    // run that repeated the first one's would fail without ever ending its stream.
    const next = await streamOf(host, 'demo:request-human-input', body('thread-question'));
    expect(next).toContain('"reason":"human-wait"');
  });
});
