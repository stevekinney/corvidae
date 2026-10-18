/**
 * COR-855 — a Bureau child run is a separate native run with its own id and
 * owner. The mount projects it as a separate AG-UI run, attachable by its own id
 * under the owner predicate; the parent's stream carries none of it.
 */
import { EventType } from '@ag-ui/core';
import {
  createAgent,
  createScriptedGenerate,
  type GenerateFunction,
} from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from '../create-bureau.ts';
import {
  as,
  attachRunRequest,
  authentication,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import {
  bureauMetadata,
  FrameReader,
  readAgUiStream,
  typesOf,
} from './ag-ui-stream.test-support.ts';
import { createBureauHandler } from './create-bureau-handler.ts';

const hang: GenerateFunction = ({ signal }) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

describe('child runs', () => {
  it('never put a child’s events on the parent’s stream, and answer a non-owner as a missing run', async () => {
    const parentScript = createScriptedGenerate([
      { kind: 'block', barrier: 'hold' },
      { kind: 'respond', response: { content: 'Parent done.', toolCalls: [] } },
    ]);
    const bureau = await createBureau({
      id: 'children-fixture',
      agents: {
        assistant: createAgent({ generate: parentScript, name: 'assistant' }),
        worker: createAgent({ generate: hang, name: 'worker' }),
      },
      generate: parentScript,
      toolbox: createToolbox([]),
      storage: { type: 'memory' },
      durableExecution: true,
      children: {},
    });
    const handler = createBureauHandler(bureau, {
      authentication,
      publish: ['assistant'],
      agUi: {},
    });
    try {
      const parent = new FrameReader(await handler(startRequest(runAgentInput(), as('alice-key'))));
      await parent.until(EventType.STEP_STARTED);
      await parentScript.reached('hold');
      const parentRunId = String(bureauMetadata(parent.received[0]!.event)['runId']);
      const dispatched = await bureau.children.dispatch({
        parentRunId,
        agentName: 'worker',
        input: 'child work',
      });
      if (dispatched.outcome !== 'started') throw new Error('expected a started child');
      const childId = dispatched.child.childRunId;

      const stranger = await readAgUiStream(
        await handler(attachRunRequest(childId, as('bob-key'))),
      );
      const random = await readAgUiStream(
        await handler(attachRunRequest('child-run-never-was', as('bob-key'))),
      );
      parentScript.release('hold');
      const tail = await parent.rest();
      const everything = JSON.stringify([...parent.received, ...tail]);

      expect(stranger[0]!.event).toMatchObject({
        type: EventType.RUN_ERROR,
        code: 'RUN_NOT_FOUND',
      });
      expect(typesOf(stranger)).toEqual(typesOf(random));
      expect(everything).not.toContain(childId);
      expect(everything).not.toContain('child work');
    } finally {
      parentScript.release('hold');
      await bureau.dispose();
    }
  });
});
