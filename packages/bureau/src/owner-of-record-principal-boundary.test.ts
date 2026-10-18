/**
 * COR-718 — every entry point that derives an owner from a caller-supplied
 * principal accepts text or nothing. Anything else is refused before anything is
 * persisted, so a persisted owner can only be a string.
 */
import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import {
  answering,
  createCheckValidator,
  goalRequest,
  workerAgent,
} from './testing/goal-fixtures.test-support';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';

const generate: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });
const NOT_TEXT = [
  ['a number', 7],
  ['null', null],
  ['an object', {}],
  ['an array', ['api-key:alice']],
  ['a boolean', true],
] as const;

async function openDurableBureau() {
  return createBureau({
    agents: { worker: workerAgent(answering('done')) },
    validators: [createCheckValidator()],
    generate,
    storage: { type: 'memory' },
    durableExecution: true,
    stopWhen: stopWhen.noToolCalls(),
  });
}

describe('a principal that is not text (COR-718)', () => {
  it.each(NOT_TEXT)(
    'is refused by createRun, which persists nothing (%s)',
    async (_label, principal) => {
      const bureau = await openDurableBureau();
      try {
        const plain = await rejectionOf(
          bureau.createRun({ message: 'x', sessionId: 'refused', principal: principal as never }),
        );
        const withReceipt = await rejectionOf(
          bureau.createRun({
            message: 'x',
            sessionId: 'refused',
            principal: principal as never,
            runCreationRequestId: 'request-1',
          }),
        );

        expect(plain).toMatchObject({ code: 'BAD_REQUEST' });
        expect(withReceipt).toMatchObject({ code: 'BAD_REQUEST' });
        expect(bureau.listRuns()).toEqual([]);
        expect(await bureau.getSession('refused')).toBeUndefined();
      } finally {
        await bureau.dispose();
      }
    },
  );

  it.each(NOT_TEXT)(
    'is refused by createSchedule, which registers nothing (%s)',
    async (_label, principal) => {
      const bureau = await openDurableBureau();
      try {
        const refusal = await rejectionOf(
          bureau.createSchedule({
            agentName: 'worker',
            input: 'tick',
            spec: '1h',
            principal: principal as never,
          }),
        );

        expect(refusal).toMatchObject({ code: 'BAD_REQUEST' });
        const listed = await bureau.listSchedules();
        expect(listed?.items ?? []).toHaveLength(0);
      } finally {
        await bureau.dispose();
      }
    },
  );

  it.each(NOT_TEXT)(
    'is refused by goals.create, which stores no goal (%s)',
    async (_label, principal) => {
      const bureau = await openDurableBureau();
      try {
        const outcome = await bureau.goals.create(
          goalRequest({ goalRunId: 'g-refused', principal: principal as never }),
        );

        expect(outcome).toMatchObject({ outcome: 'rejected', code: 'invalid-configuration' });
        expect(await bureau.goals.get('g-refused')).toBeUndefined();
      } finally {
        await bureau.dispose();
      }
    },
  );

  it.each(NOT_TEXT)('is refused by bureau.run (%s)', async (_label, principal) => {
    const bureau = await createBureau({
      agents: { worker: createAgent({ name: 'worker', generate }) },
    });
    try {
      expect(() => bureau.run('worker', 'work', { principal: principal as never })).toThrow(
        '"options.principal" must be a string',
      );
    } finally {
      await bureau.dispose();
    }
  });

  it.each(NOT_TEXT)(
    'is refused by children.dispatch, which records no child (%s)',
    async (_label, principal) => {
      const bureau = await createBureau({
        agents: { worker: createAgent({ name: 'worker', generate }) },
        generate: () => new Promise<never>(() => {}),
      });
      try {
        const parent = await bureau.createRun({ message: 'plan' });
        const refusal = await rejectionOf(
          bureau.children.dispatch({
            parentRunId: parent.id,
            agentName: 'worker',
            input: 'x',
            principal: principal as never,
          }),
        );

        expect(refusal).toMatchObject({ code: 'BAD_REQUEST' });
        expect(await bureau.children.list(parent.id)).toEqual([]);
      } finally {
        await bureau.dispose();
      }
    },
  );
});
