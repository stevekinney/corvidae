/**
 * `weft.workflows.get` operation + REST binding — behavior tests.
 *
 * Exercises the operation through the shared `executeOperation`
 * pipeline (the only dispatch path). Happy path returns the workflow
 * state; nonexistent id returns a 404 with the `{ error: <message> }`
 * body shape.
 */

import { describe, expect, it } from 'bun:test';

import {
  type OperationFault,
  defineOperation,
  principalFromApiKey,
} from '@lostgradient/backchannel';
import {
  createOperationRegistry,
  handleJsonRpcHttpRequest,
} from '@lostgradient/backchannel/internals';
import { MemoryStorage } from '@lostgradient/storage';
import { Engine } from '../../core/engine.ts';
import { type WorkflowContext, workflow } from '../../core/types.ts';
import { handleRequestAsLocalUser as handleRequest } from '../local-user-request.test-support.ts';
import { getWorkflowOperation, getWorkflowRestBinding } from './get-workflow.ts';
import { waitForWorkflowStatus } from './operation-test-helpers.test-support.ts';

const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (
  ctx: WorkflowContext,
  _input: unknown,
) {
  return yield* ctx.waitForSignal<string>('release');
});

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(holdWorkflow);
  return engine;
}

const registry = createOperationRegistry([getWorkflowOperation]);
const bindings = [getWorkflowRestBinding];

describe('weft.workflows.get', () => {
  it('returns the workflow state on the happy path', async () => {
    await using engine = createEngine();
    const handle = await engine.start('hold', { hello: 'world' }, {});
    await waitForWorkflowStatus(engine, handle.id, 'running');

    const request = new Request(`http://localhost/v1/workflows/${handle.id}`, { method: 'GET' });
    const response = await handleRequest(request, engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toMatchObject({ id: handle.id });
  });

  it('preserves opaque input and returns identical detail over REST and JSON-RPC', async () => {
    await using engine = createEngine();
    const input = { nested: { arbitrary: [1, null, { value: true }] } };
    const handle = await engine.start('hold', input, {});
    await waitForWorkflowStatus(engine, handle.id, 'running');
    const rest = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}`),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );
    const rpc = await handleJsonRpcHttpRequest(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'weft.workflows.get',
          params: { workflowId: handle.id },
        }),
      }),
      {
        registry,
        host: engine,
        principal: principalFromApiKey({ subject: 'reader', scopes: ['workflows:read'] }),
      },
    );
    expect(rest.status).toBe(200);
    expect(rpc.status).toBe(200);
    const restBody = await rest.json();
    const rpcBody = await rpc.json();
    expect(rpcBody.result).toEqual(restBody);
    expect(restBody).toMatchObject({ id: handle.id, status: 'running', input });
  });

  it('returns 404 with the error-message body when the workflow does not exist', async () => {
    await using engine = createEngine();

    const request = new Request('http://localhost/v1/workflows/does-not-exist', { method: 'GET' });
    const response = await handleRequest(request, engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Workflow "does-not-exist" not found',
      data: { resource: 'workflow', identifier: 'does-not-exist' },
      retryable: false,
    });
  });

  it('masks EngineFailure faults to a 500 with a generic error body', async () => {
    await using engine = createEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForWorkflowStatus(engine, handle.id, 'running');

    const failingOperation = defineOperation({
      ...getWorkflowOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'secret internal detail',
          data: {},
        };
        throw fault;
      },
    });
    const failingRegistry = createOperationRegistry([failingOperation]);

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}`, { method: 'GET' }),
      engine,
      {
        operationRegistry: failingRegistry,
        restBindings: [getWorkflowRestBinding],
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error', retryable: false });
  });
});
