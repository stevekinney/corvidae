/**
 * COR-1911 — `bureau.agents.try` over a real Bureau and its handler: it answers with the new
 * context, refuses a caller without `bureau.agents:write`, names the field of a definition that
 * would not load, and leaves no agent file.
 */
import { readdir } from 'node:fs/promises';

import { EventType } from '@ag-ui/core';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  callAs,
  DEFINITION,
  disposeServed,
  serve,
} from './agent-definitions-fixtures.test-support.ts';
import { createBureauHandler } from '../create-bureau-handler.ts';
import { runAgentInput, startRequest } from '../ag-ui-fixtures.test-support.ts';
import { readAgUiStream, typesOf } from '../ag-ui-stream.test-support.ts';
import { waitForTaskState } from '../../test';
import { rpc } from './management-fixtures.test-support.ts';

afterEach(disposeServed);

const filesIn = async (directory: string) => {
  const names = await readdir(directory);
  return names.filter((name) => !name.startsWith('.')).toSorted();
};

describe('bureau.agents.try', () => {
  it('starts a throwaway context for a writer, and writes no agent file', async () => {
    const served = await serve();
    const before = await filesIn(served.directory);

    const response = await rpc(
      served.keyed,
      'bureau.agents.try',
      { definition: DEFINITION, message: 'hello' },
      'agents-writer-key',
    );

    expect(response.error).toBeUndefined();
    const { contextId, agentName, taskId } = response.result as {
      contextId: string;
      agentName: string;
      taskId: string;
    };
    expect(agentName.startsWith('try:')).toBe(true);
    const task = await served.bureau.tasks.get(taskId);
    expect(task?.contextId).toBe(contextId);
    const tries = await served.bureau.contexts.list({ origin: 'try' });
    expect(tries.map((context) => context.id)).toEqual([contextId]);
    expect(await filesIn(served.directory)).toEqual(before);
    expect(served.bureau.agents.list().map((listing) => listing.id)).toEqual(['alpha']);
  });

  it('is served to the owner with no scope, and refused to a caller without bureau.agents:write', async () => {
    const served = await serve();

    const owner = await callAs(served.owner, 'bureau.agents.try', {
      definition: DEFINITION,
      message: 'hello',
    });
    const reader = await rpc(
      served.keyed,
      'bureau.agents.try',
      { definition: DEFINITION, message: 'hello' },
      'agents-reader-key',
    );
    const nobody = await rpc(
      served.keyed,
      'bureau.agents.try',
      { definition: DEFINITION, message: 'hello' },
      'alice-key',
    );

    expect(owner.error).toBeUndefined();
    for (const denied of [reader, nobody]) {
      expect(denied.error?.data?.httpStatus).toBe(403);
      expect(denied.result).toBeUndefined();
    }
    // Only the owner's context exists: a refused call started nothing.
    expect(await served.bureau.contexts.list({ origin: 'try' })).toHaveLength(1);
  });

  it('names the field of a definition that would not load, and starts nothing', async () => {
    const served = await serve();

    const unknownModel = await rpc(
      served.keyed,
      'bureau.agents.try',
      { definition: { ...DEFINITION, model: 'anthropic/no-such-model' }, message: 'hello' },
      'agents-writer-key',
    );
    const memoryTool = await rpc(
      served.keyed,
      'bureau.agents.try',
      { definition: { ...DEFINITION, tools: ['lookup-order', 'memory_store'] }, message: 'hello' },
      'agents-writer-key',
    );
    const references = await rpc(
      served.keyed,
      'bureau.agents.try',
      { definition: { ...DEFINITION, references: ['notes.md'] }, message: 'hello' },
      'agents-writer-key',
    );

    // The same fault `create` answers, its message naming each field at fault.
    expect(unknownModel.error?.message).toContain('model: ');
    expect(memoryTool.error?.message).toContain('tools.1: "memory_store"');
    expect(references.error?.message).toContain('references: ');
    expect(unknownModel.error?.data?.['reason']).toBe('unknown-model');
    expect(memoryTool.error?.data?.['reason']).toBe('invalid-frontmatter');
    expect(references.error?.data?.['reason']).toBe('invalid-frontmatter');
    expect(await served.bureau.contexts.list({ origin: 'try' })).toEqual([]);
  });

  it('is continued over AG-UI in its own context, and its name starts no other', async () => {
    const served = await serve({ overrides: { durable: true } });
    const handler = createBureauHandler(served.bureau, {
      unauthenticatedAccess: 'allow',
      agUi: {},
    });
    const started = await callAs(handler, 'bureau.agents.try', {
      definition: DEFINITION,
      message: 'hello',
    });
    const { contextId, agentName, taskId } = started.result as {
      contextId: string;
      agentName: string;
      taskId: string;
    };
    await waitForTaskState(served.bureau, taskId);

    const response = await handler(
      startRequest(runAgentInput({ threadId: contextId, runId: 'follow-up' }), {}, agentName),
    );
    const refused = await handler(
      startRequest(
        runAgentInput({ threadId: 'another-thread', runId: 'elsewhere' }),
        {},
        agentName,
      ),
    );

    expect(response.status).toBe(200);
    expect(typesOf(await readAgUiStream(response))).toContain(EventType.RUN_FINISHED);
    // The name of a tried agent is not a way to start a chat: the context it belongs to is.
    const refusedFrames = await readAgUiStream(refused);
    const refusal = refusedFrames.map((frame) => frame.event);
    expect(refusal).toMatchObject([{ type: 'RUN_ERROR', code: 'THREAD_NOT_FOUND' }]);
    expect(await served.bureau.contexts.get('another-thread')).toBeUndefined();
    expect(served.bureau.agents.find(agentName)).toBeUndefined();
  });
});
