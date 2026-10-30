/**
 * COR-1812 — the wire half of workflow schemas: `bureau.workflows.start` refuses a bad input with
 * field issues and creates nothing, the signal reports the workflows it refused, a failed run
 * reads back with its finish reason, a file carries its schemas through `create` and `get`, and a
 * code-defined workflow's description and source are readable with `bureau.workflows:read` and
 * not without it.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { rpc } from './management-fixtures.test-support.ts';
import { ownerRpc, serveWorkflows } from './workflows-fixtures.test-support.ts';
import { AGENT_STEP } from '../../testing/workflow-file-fixtures.test-support.ts';
import { waitUntil } from '@lostgradient/testing/wait-until';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const ON_GO = { kind: 'signal', name: 'go' };
const CITY_INPUT = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
};
const DEFINITION = {
  agent: 'writer',
  trigger: ON_GO,
  steps: [AGENT_STEP],
  inputSchema: CITY_INPUT,
  outputSchema: { type: 'string' },
};

async function seeded() {
  const served = await serveWorkflows(cleanups);
  await served.bureau.workflows!.create('lookup', DEFINITION);
  return served;
}

describe('a file’s schemas on the wire', () => {
  it('are written by create and read back by get and list', async () => {
    const served = await serveWorkflows(cleanups);

    const created = await ownerRpc(served.owner, 'bureau.workflows.create', {
      id: 'lookup',
      definition: DEFINITION,
    });
    expect(created.error).toBeUndefined();

    const got = await ownerRpc(served.owner, 'bureau.workflows.get', { id: 'lookup' });
    expect(got.result).toMatchObject({ inputSchema: CITY_INPUT, outputSchema: { type: 'string' } });
    const listed = await ownerRpc(served.owner, 'bureau.workflows.list', {});
    expect(listed.result?.['workflows']).toMatchObject([
      { id: 'lookup', inputSchema: CITY_INPUT, outputSchema: { type: 'string' } },
    ]);
  });

  it('are null when the file declares none', async () => {
    const served = await serveWorkflows(cleanups);
    await served.bureau.workflows!.create('bare', { trigger: ON_GO, steps: [AGENT_STEP] });

    const got = await ownerRpc(served.owner, 'bureau.workflows.get', { id: 'bare' });

    expect(got.result).toMatchObject({ inputSchema: null, outputSchema: null });
  });

  it('are refused by create when they break the limits, as Unprocessable, and write nothing', async () => {
    const served = await serveWorkflows(cleanups);

    const response = await ownerRpc(served.owner, 'bureau.workflows.create', {
      id: 'lookup',
      definition: { ...DEFINITION, inputSchema: { type: 'string', pattern: '^a' } },
    });

    expect(response.error?.data?.httpStatus).toBe(422);
    expect(response.error?.message).toContain('inputSchema');
    expect(served.bureau.workflows!.list()).toEqual([]);
  });
});

describe('bureau.workflows.start', () => {
  it('starts an instance and answers its run, which reads back with its trigger and origin', async () => {
    const served = await seeded();

    const response = await ownerRpc(served.owner, 'bureau.workflows.start', {
      id: 'lookup',
      input: { city: 'Oslo' },
      surface: 'web',
    });

    expect(response.error).toBeUndefined();
    const { runId, workflow, workflowVersion } = response.result as {
      runId: string;
      workflow: string;
      workflowVersion: string;
    };
    expect(workflow).toBe('lookup');
    expect(workflowVersion).toBe(served.bureau.workflows!.list()[0]?.version ?? '');
    const engine = served.bureau.durableEngine()!;
    await waitUntil(
      async () => {
        const state = await engine.get(runId);
        return state?.status === 'failed';
      },
      { message: 'the run failed its string output schema' },
    );
    const run = await ownerRpc(served.owner, 'bureau.workflows.runs.get', { runId });
    expect(run.result).toMatchObject({
      status: 'failed',
      finishReason: 'output-invalid',
      error: 'output-invalid: The output must be string',
      trigger: {
        kind: 'manual',
        input: { city: 'Oslo' },
        origin: { kind: 'person', principal: 'anonymous:local', surface: 'web' },
      },
    });
  });

  it('refuses a bad input as InvalidParams with a path for each field, and creates no run', async () => {
    const served = await seeded();

    const response = await ownerRpc(served.owner, 'bureau.workflows.start', {
      id: 'lookup',
      input: { city: 7 },
    });

    expect(response.error?.data?.httpStatus).toBe(400);
    expect(response.error?.data?.['issues']).toEqual([
      { path: ['input', 'city'], message: '"city" must be string', code: 'custom' },
    ]);
    const runs = await ownerRpc(served.owner, 'bureau.workflows.runs.list', {});
    expect(runs.result?.['runs']).toEqual([]);
  });

  it('answers a workflow that does not exist as NotFound', async () => {
    const served = await seeded();

    const response = await ownerRpc(served.owner, 'bureau.workflows.start', { id: 'nobody' });

    expect(response.error?.data?.httpStatus).toBe(404);
  });

  it('is served to a caller holding write, and answered as not found to one holding only read', async () => {
    const served = await seeded();

    const reader = await rpc(
      served.keyed,
      'bureau.workflows.start',
      { id: 'lookup', input: { city: 'Oslo' } },
      'workflows-reader-key',
    );
    const writer = await rpc(
      served.keyed,
      'bureau.workflows.start',
      { id: 'lookup', input: { city: 'Oslo' } },
      'workflows-writer-key',
    );

    expect(reader.error?.data?.httpStatus).toBe(404);
    expect(writer.error).toBeUndefined();
    const run = await ownerRpc(served.owner, 'bureau.workflows.runs.get', {
      runId: (writer.result as { runId: string }).runId,
    });
    const trigger = run.result?.['trigger'] as { origin: { principal: string } };
    expect(trigger.origin.principal).toMatch(/^api-key:/);
  });
});

describe('bureau.workflows.signal with a schema', () => {
  it('lists the workflow whose schema the payload broke, with its issues', async () => {
    const served = await seeded();

    const response = await ownerRpc(served.owner, 'bureau.workflows.signal', {
      name: 'go',
      payload: { town: 'Oslo' },
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      started: [],
      delivered: [],
      rejected: [
        {
          id: 'lookup',
          issues: [{ path: ['city'], message: '"city" is required' }],
        },
      ],
    });
  });
});

describe('bureau.workflows.internal.get', () => {
  it('reads a code-defined workflow’s description and source with the owner’s access', async () => {
    const served = await serveWorkflows(cleanups);

    const response = await ownerRpc(served.owner, 'bureau.workflows.internal.get', {
      id: 'agentRun',
    });

    expect(response.error).toBeUndefined();
    const result = response.result as {
      id: string;
      description: string | null;
      source: { kind: string; text: string };
    };
    expect(result.id).toBe('agentRun');
    expect(result.description).toBeTruthy();
    expect(result.source.kind).toBe('code');
    expect(result.source.text.startsWith(`${result.description}\n\n{`)).toBe(true);
    expect(JSON.parse(result.source.text.slice(`${result.description}\n\n`.length))).toMatchObject({
      type: 'agentRun',
    });
  });

  it('is readable with bureau.workflows:read and refused, as not found, without it', async () => {
    const served = await serveWorkflows(cleanups);

    const allowed = await rpc(
      served.keyed,
      'bureau.workflows.internal.get',
      { id: 'agentRun' },
      'workflows-reader-key',
    );
    const refused = await rpc(
      served.keyed,
      'bureau.workflows.internal.get',
      { id: 'agentRun' },
      'alice-key',
    );

    expect(allowed.error).toBeUndefined();
    expect((allowed.result as { source: { kind: string } }).source.kind).toBe('code');
    expect(refused.error?.data?.httpStatus).toBe(404);
    expect(refused.result).toBeUndefined();
  });

  it('describes every workflow the Bureau registers itself', async () => {
    const served = await serveWorkflows(cleanups);

    for (const id of ['agentRun', 'durableHeartbeatTick']) {
      const response = await ownerRpc(served.owner, 'bureau.workflows.internal.get', { id });
      expect((response.result as { description: string | null }).description, id).toBeTruthy();
    }
  });

  it('does not answer for a workflow a file defines, or one that does not exist', async () => {
    const served = await seeded();

    for (const id of ['lookup', 'nobody']) {
      const response = await ownerRpc(served.owner, 'bureau.workflows.internal.get', { id });
      expect(response.error?.data?.httpStatus, id).toBe(404);
    }
  });
});

describe('bureau.workflows.internal.get without a workflow directory', () => {
  it('reads a code-defined workflow from a durable Bureau that has no workflowSource', async () => {
    const served = await serveWorkflows(cleanups, { withoutDirectory: true });
    expect(served.bureau.workflows).toBeUndefined();

    const found = await ownerRpc(served.owner, 'bureau.workflows.internal.get', { id: 'agentRun' });
    const missing = await ownerRpc(served.owner, 'bureau.workflows.internal.get', { id: 'nobody' });

    expect(found.error).toBeUndefined();
    expect((found.result as { source: { kind: string } }).source.kind).toBe('code');
    expect(missing.error?.data?.httpStatus).toBe(404);
  });
});
