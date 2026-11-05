/**
 * COR-2035 — the workflow and child-run toolset through a real Interborough host. The parent and
 * reviewer are file agents, but the provider resolver scripts their model responses, so this test
 * exercises the production toolbox without a network provider. The fixture workflow itself uses
 * only a native signal wait, which lets the harness release the exact run it just started.
 */
import { openBungalow } from '@lostgradient/bungalow';
import type { GenerateContext, GenerateFunction } from '@lostgradient/operative';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { waitUntil } from '@lostgradient/testing/wait-until';

import { startHost, type Host, type HostOptions } from './host.ts';
import { writeProviderHome } from './stub-provider.ts';

const directories: string[] = [];
const hosts: Host[] = [];
let workflowBarrier: ((runId: string) => Promise<unknown>) | undefined;

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  workflowBarrier = undefined;
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const WORKFLOW_ID = 'toolset-fixture';
const REVIEW_TEXT = 'The workflow is healthy and ready to run.';
const A2A_KEY = 'fixture-a2a-toolset-key';

const agentFile = (
  name: string,
  tools: readonly string[],
  childAgents?: readonly string[],
  allowMutations = false,
) =>
  [
    '---',
    `name: ${name}`,
    `description: Scripted ${name} for the workflow toolset fixture.`,
    'model: anthropic/sonnet',
    'a2a: true',
    `tools: [${tools.join(', ')}]`,
    ...(allowMutations
      ? [
          "toolApproval: { 'bureau:child-runs-dispatch': never, 'bureau:workflows-update': never, 'bureau:workflows-start': never }",
        ]
      : []),
    ...(childAgents === undefined ? [] : [`childAgents: [${childAgents.join(', ')}]`]),
    '---',
    `You are the scripted ${name}.`,
    '',
  ].join('\n');

const parentTools = [
  'bureau:workflows-get',
  'bureau:workflows-update',
  'bureau:workflows-start',
  'bureau:workflows-runs-get',
  'bureau:workflows-runs-history',
  'bureau:child-runs-dispatch',
  'bureau:child-runs-wait',
  'bureau:child-runs-list',
] as const;

function openerOf(context: GenerateContext): string {
  const opener = context.conversation.getMessages().findLast((message) => message.role === 'user');
  return typeof opener?.content === 'string' ? opener.content : '';
}

function resultOf(context: GenerateContext): unknown {
  const message = context.conversation.getMessages().findLast((entry) => entry.toolResult);
  const content = message?.toolResult?.content;
  if (content === undefined) return undefined;
  if (typeof content !== 'string') return content;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

function resultsOf(context: GenerateContext): unknown[] {
  return context.conversation
    .getMessages()
    .filter((message) => message.toolResult !== undefined)
    .map((message) => {
      const content = message.toolResult?.content;
      if (typeof content !== 'string') return content;
      try {
        return JSON.parse(content) as unknown;
      } catch {
        return content;
      }
    });
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function descriptionOf(value: unknown): string | undefined {
  const record = recordOf(value);
  const document = recordOf(record?.['document']);
  if (typeof document?.['description'] === 'string') return document['description'];
  if (typeof record?.['text'] !== 'string') return undefined;
  try {
    return recordOf(JSON.parse(record['text']))?.['description'] as string | undefined;
  } catch {
    return undefined;
  }
}

function runIdOf(context: GenerateContext): string {
  for (const value of resultsOf(context).toReversed()) {
    if (typeof value !== 'object' || value === null) continue;
    const record = recordOf(value);
    if (typeof record?.['runId'] === 'string') return record['runId'];
    const run = record?.['run'];
    if (
      typeof run === 'object' &&
      run !== null &&
      typeof (run as Record<string, unknown>)['id'] === 'string'
    )
      return (run as Record<string, unknown>)['id'] as string;
  }
  return '';
}

function toolCallsOf(context: GenerateContext): number {
  return context.conversation.getMessages().filter((message) => message.toolCall !== undefined)
    .length;
}

function pendingRun(value: unknown): boolean {
  const run = recordOf(recordOf(value)?.['run']);
  const status = run?.['status'];
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled';
}

function latestResult(context: GenerateContext, key: string): Record<string, unknown> | undefined {
  return resultsOf(context)
    .toReversed()
    .map(recordOf)
    .find((value) => value?.[key] !== undefined);
}

function childWaitResult(context: GenerateContext): Record<string, unknown> | undefined {
  return resultsOf(context)
    .toReversed()
    .map(recordOf)
    .find((value) => value?.['child'] !== undefined && value?.['outcome'] !== 'started');
}

function reviewTextOf(value: unknown, seen = new Set<unknown>()): string | undefined {
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (value === REVIEW_TEXT) return value;
  const record = recordOf(value);
  if (record === undefined) return undefined;
  for (const nested of Object.values(record)) {
    const text = reviewTextOf(nested, seen);
    if (text !== undefined) return text;
  }
  return undefined;
}

function call(name: string, arguments_: Record<string, unknown>) {
  return { id: `toolset-${name}-${crypto.randomUUID()}`, name, arguments: arguments_ };
}

const scriptedResolver: NonNullable<HostOptions['resolveProviderGenerate']> = () => {
  const generate: GenerateFunction = async (context) => {
    const opener = openerOf(context);
    const calls = toolCallsOf(context);
    const last = resultOf(context) as Record<string, unknown> | undefined;

    if (opener.includes('[reviewer]') || opener.includes('Review the')) {
      if (calls === 0)
        return { content: '', toolCalls: [call('bureau__workflows-get', { id: WORKFLOW_ID })] };
      return { content: REVIEW_TEXT, toolCalls: [] };
    }
    if (opener.includes('[ungranted]')) {
      return calls === 0
        ? {
            content: '',
            toolCalls: [call('bureau__workflows-start', { id: WORKFLOW_ID })],
          }
        : (() => {
            const denied = resultOf(context);
            if (typeof denied !== 'string' || !denied.includes('Tool not found'))
              throw new Error(`Expected the denied tool result, got ${JSON.stringify(denied)}`);
            return { content: `UnGranted result: ${denied}`, toolCalls: [] };
          })();
    }
    if (opener.includes('[out-of-scope]')) {
      if (calls === 0)
        return {
          content: '',
          toolCalls: [call('bureau__child-runs-dispatch', { agent: 'outsider', input: 'x' })],
        };
      if (calls === 1) {
        if (last?.['status'] !== 'refused')
          throw new Error(`Expected an out-of-scope refusal, got ${JSON.stringify(last)}`);
        return { content: '', toolCalls: [call('bureau__child-runs-list', {})] };
      }
      if (
        last?.['status'] !== 'ok' ||
        !Array.isArray(last['children']) ||
        last['children'].length
      ) {
        throw new Error(`Expected no child run after refusal, got ${JSON.stringify(last)}`);
      }
      return {
        content: `Out-of-scope result: ${JSON.stringify(
          resultsOf(context).find((value) => recordOf(value)?.['status'] === 'refused'),
        )}\nChildren result: ${JSON.stringify(last)}`,
        toolCalls: [],
      };
    }
    if (opener.includes('[foreign]')) {
      return calls === 0
        ? { content: '', toolCalls: [call('bureau__workflows-get', { id: WORKFLOW_ID })] }
        : { content: `Foreign owner result: ${JSON.stringify(last)}`, toolCalls: [] };
    }

    if (calls === 0)
      return { content: '', toolCalls: [call('bureau__workflows-get', { id: WORKFLOW_ID })] };
    if (calls === 1)
      return {
        content: '',
        toolCalls: [
          call('bureau__child-runs-dispatch', {
            agent: 'reviewer',
            input: 'Review the workflow and report your findings.',
          }),
        ],
      };
    if (calls === 2) {
      const childRunId = (last?.['child'] as Record<string, unknown> | undefined)?.['childRunId'];
      if (typeof childRunId !== 'string')
        throw new Error('The dispatch did not return a child id.');
      return { content: '', toolCalls: [call('bureau__child-runs-wait', { childRunId })] };
    }
    if (calls === 3) {
      const parsed = resultsOf(context).find(
        (value): value is Record<string, unknown> =>
          typeof value === 'object' &&
          value !== null &&
          typeof (value as Record<string, unknown>)['hash'] === 'string',
      );
      const hash = typeof parsed === 'object' && parsed !== null ? parsed['hash'] : undefined;
      if (typeof hash !== 'string') throw new Error('The workflow read did not return a hash.');
      return {
        content: '',
        toolCalls: [
          call('bureau__workflows-update', {
            id: WORKFLOW_ID,
            expectedHash: hash,
            description: 'The revised provider-free workflow fixture.',
            trigger: { kind: 'manual' },
            steps: [
              {
                kind: 'await-signal',
                signal: 'go',
              },
            ],
          }),
        ],
      };
    }
    if (calls === 4) {
      return { content: '', toolCalls: [call('bureau__workflows-get', { id: WORKFLOW_ID })] };
    }
    if (calls === 5) {
      const values = resultsOf(context);
      const initial = values.find(
        (value) =>
          recordOf(value)?.['status'] === 'ok' && recordOf(value)?.['document'] !== undefined,
      );
      const updated = values.find(
        (value) =>
          recordOf(value)?.['status'] === 'ok' &&
          recordOf(value)?.['hash'] !== recordOf(initial)?.['hash'],
      );
      const reread = values.at(-1);
      if (
        recordOf(updated)?.['status'] !== 'ok' ||
        typeof recordOf(initial)?.['hash'] !== 'string' ||
        typeof recordOf(updated)?.['hash'] !== 'string' ||
        recordOf(updated)?.['hash'] === recordOf(initial)?.['hash'] ||
        recordOf(reread)?.['status'] !== 'ok' ||
        recordOf(reread)?.['hash'] !== recordOf(updated)?.['hash'] ||
        descriptionOf(reread) !== 'The revised provider-free workflow fixture.'
      ) {
        throw new Error(`The persisted workflow witness was invalid: ${JSON.stringify(values)}`);
      }
      const staleHash = resultsOf(context).find(
        (value): value is Record<string, unknown> =>
          typeof value === 'object' &&
          value !== null &&
          typeof (value as Record<string, unknown>)['hash'] === 'string',
      )?.['hash'];
      return {
        content: '',
        toolCalls: [
          call('bureau__workflows-update', {
            id: WORKFLOW_ID,
            expectedHash: staleHash,
            description: 'The stale provider-free workflow fixture.',
            trigger: { kind: 'manual' },
            steps: [
              {
                kind: 'await-signal',
                signal: 'go',
              },
            ],
          }),
        ],
      };
    }
    if (calls === 6)
      return { content: '', toolCalls: [call('bureau__workflows-start', { id: WORKFLOW_ID })] };
    if (calls === 7) {
      const runId = runIdOf(context);
      if (runId.length === 0) throw new Error('The workflow start did not return a run id.');
      if (workflowBarrier === undefined) throw new Error('The workflow barrier is not installed.');
      await workflowBarrier(runId);
      return {
        content: '',
        toolCalls: [call('bureau__workflows-runs-get', { runId })],
      };
    }
    if (calls >= 8 && calls <= 11 && pendingRun(last)) {
      return {
        content: '',
        toolCalls: [call('bureau__workflows-runs-get', { runId: runIdOf(context) })],
      };
    }
    if (calls >= 8 && calls <= 12) {
      return {
        content: '',
        toolCalls: [call('bureau__workflows-runs-history', { runId: runIdOf(context) })],
      };
    }
    const childResult = childWaitResult(context);
    const runResult = latestResult(context, 'run');
    const history = latestResult(context, 'events');
    const values = resultsOf(context);
    const initial = values.find((value) => recordOf(value)?.['document'] !== undefined);
    const updated = values.find(
      (value) =>
        recordOf(value)?.['status'] === 'ok' &&
        recordOf(value)?.['hash'] !== recordOf(initial)?.['hash'],
    );
    const reread = values.find(
      (value) =>
        recordOf(value)?.['hash'] === recordOf(updated)?.['hash'] &&
        recordOf(value)?.['document'] !== undefined,
    );
    const stale = values.find((value) => recordOf(value)?.['status'] === 'conflict');
    const run = recordOf(runResult?.['run']);
    const runStatus = run?.['status'];
    const runValue = run?.['result'];
    const runResultRecord = recordOf(runValue);
    const eventTypes = Array.isArray(history?.['events'])
      ? history['events']
          .map((event) => recordOf(event)?.['type'])
          .filter((type): type is string => typeof type === 'string')
          .join(',')
      : '';
    return {
      content: `Update: status=${String(recordOf(updated)?.['status'])} hash-changed=${String(recordOf(initial)?.['hash'] !== recordOf(updated)?.['hash'])} persisted-description=${String(descriptionOf(reread))} persisted-hash=${String(recordOf(reread)?.['hash'])} stale=${String(recordOf(stale)?.['status'])}\nReview: ${reviewTextOf(childResult) ?? 'missing'}\nRun result: status=${String(runStatus)} content=${String(runResultRecord?.['content'])} output=${JSON.stringify(runResultRecord?.['output'])} finishReason=${String(runResultRecord?.['finishReason'])}\nHistory: events=${eventTypes}`,
      toolCalls: [],
    };
  };
  return generate;
};

async function startFixture(): Promise<{ host: Host; home: string }> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-workflow-toolset-'));
  directories.push(home);
  await writeProviderHome(home);
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  try {
    await bungalow.deploymentSecrets.write('a2a-api-key', A2A_KEY);
  } finally {
    bungalow.close();
  }
  await mkdir(join(home, 'agents'), { recursive: true });
  await mkdir(join(home, 'workflows'), { recursive: true });
  await writeFile(
    join(home, 'agents', 'parent.md'),
    agentFile('parent', parentTools, ['reviewer'], true),
  );
  await writeFile(
    join(home, 'agents', 'reviewer.md'),
    agentFile('reviewer', ['bureau:workflows-get']),
  );
  await writeFile(
    join(home, 'agents', 'outsider.md'),
    agentFile('outsider', ['bureau:workflows-get']),
  );
  await writeFile(
    join(home, 'workflows', `${WORKFLOW_ID}.json`),
    `${JSON.stringify(
      {
        name: WORKFLOW_ID,
        trigger: { kind: 'manual' },
        steps: [
          {
            kind: 'await-signal',
            signal: 'go',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    resolveProviderGenerate: scriptedResolver,
  });
  hosts.push(host);
  workflowBarrier = async (runId) => {
    const payload = {
      content: REVIEW_TEXT,
      output: null,
      finishReason: 'stop-condition',
    };
    await waitUntil(
      async () => {
        const state = await host.engine.get(runId);
        return state?.waitingForSignals?.includes('go') === true;
      },
      { message: `workflow run ${runId} to park on go` },
    );
    await host.engine.signal(runId, 'go', payload);
    await host.engine.getHandle(runId).result();
  };
  return { host, home };
}

async function chat(host: Host, message: string, agent = 'parent'): Promise<string> {
  const threadId = `toolset-${crypto.randomUUID()}`;
  const runId = `toolset-${crypto.randomUUID()}`;
  const request = async (body: Record<string, unknown>): Promise<string> => {
    const response = await fetch(new URL(`/bureau/ag-ui/agents/${agent}/run`, host.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.text();
  };
  const first = await request({
    threadId,
    runId,
    messages: [{ id: `user-${crypto.randomUUID()}`, role: 'user', content: message }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
    permissionMode: 'allow-all',
  });
  return first;
}

describe('the workflow toolset on a real Interborough host', () => {
  test('reads, delegates, edits with a hash, starts, polls and returns the review, result and history', async () => {
    const { host } = await startFixture();
    const stream = await chat(host, 'Run the fixture workflow end to end.');

    expect(stream).toContain(REVIEW_TEXT);
    expect(stream).toContain('workflow-file-changed');
    expect(stream).toMatch(
      /Update: status=ok hash-changed=true persisted-description=The revised provider-free workflow fixture\. persisted-hash=[a-f0-9]{64} stale=conflict/,
    );
    expect(stream).toContain(`Review: ${REVIEW_TEXT}`);
    expect(stream).toContain(
      'Run result: status=completed content=The workflow is healthy and ready to run. output=null finishReason=stop-condition',
    );
    expect(stream).toContain(
      'History: events=file-workflow:step-started,file-workflow:signal-waiting,file-workflow:signal-received,file-workflow:step-completed,file-workflow:run-terminal',
    );
  });

  test('denies an ungranted workflow call and an out-of-scope child', async () => {
    const { host } = await startFixture();
    const ungranted = await chat(host, '[ungranted]', 'reviewer');
    expect(ungranted).toContain('Tool not found');
    expect(ungranted).toContain('UnGranted result:');
    expect(ungranted).not.toContain('"status":"started"');
    const outOfScope = await chat(host, '[out-of-scope]');
    expect(outOfScope).toContain('Out-of-scope result:');
    expect(outOfScope).toContain('\\"status\\":\\"refused\\"');
    expect(outOfScope).toContain('Children result: {\\"status\\":\\"ok\\",\\"children\\":[]}');
  });

  test('returns not-found to the same parent when its owner is api-key:a2a', async () => {
    const { host } = await startFixture();
    const response = await fetch(new URL('/bureau/a2a/parent', host.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', 'X-API-Key': A2A_KEY },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: {
          message: { messageId: 'foreign-1', role: 'ROLE_USER', parts: [{ text: '[foreign]' }] },
        },
      }),
    });
    const sent = (await response.json()) as { result: { task: { id: string } } };
    let task = sent.result.task as {
      id: string;
      status?: { state?: string };
      [key: string]: unknown;
    };
    await waitUntil(
      async () => {
        const polled = await fetch(new URL('/bureau/a2a/parent', host.url), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'A2A-Version': '1.0',
            'X-API-Key': A2A_KEY,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'GetTask',
            params: { id: task.id },
          }),
        });
        task = ((await polled.json()) as { result: typeof task }).result;
        return task.status?.state === 'TASK_STATE_COMPLETED';
      },
      { message: `A2A task ${task.id} to complete` },
    );
    expect(JSON.stringify(task)).toContain('not-found');
  });
});
