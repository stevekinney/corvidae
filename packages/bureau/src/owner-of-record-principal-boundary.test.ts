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

/**
 * The `system:` namespace belongs to Bureau's service principals and `anonymous:`
 * to callers with no credential, so a caller may not own as either; the one
 * exception is the exact `anonymous:local`, which the local handler flow states
 * explicitly for every uncredentialed caller.
 */
const RESERVED = [
  ['a service principal', 'system:scheduler'],
  ['an anonymous principal other than the local one', 'anonymous:other'],
] as const;

describe('a principal in a reserved namespace (COR-718)', () => {
  it.each(RESERVED)(
    'is refused by createRun, which persists nothing (%s)',
    async (_label, principal) => {
      const bureau = await openDurableBureau();
      try {
        const refusal = await rejectionOf(
          bureau.createRun({ message: 'x', sessionId: 'reserved', principal }),
        );

        expect(refusal).toMatchObject({ code: 'BAD_REQUEST' });
        expect(bureau.listRuns()).toEqual([]);
        expect(await bureau.getSession('reserved')).toBeUndefined();
      } finally {
        await bureau.dispose();
      }
    },
  );

  it.each(RESERVED)(
    'is refused by createSchedule, which registers nothing (%s)',
    async (_label, principal) => {
      const bureau = await openDurableBureau();
      try {
        const refusal = await rejectionOf(
          bureau.createSchedule({ agentName: 'worker', input: 'tick', spec: '1h', principal }),
        );

        expect(refusal).toMatchObject({ code: 'BAD_REQUEST' });
        const listed = await bureau.listSchedules();
        expect(listed?.items ?? []).toHaveLength(0);
      } finally {
        await bureau.dispose();
      }
    },
  );

  it.each(RESERVED)(
    'is refused by goals.create, which stores no goal (%s)',
    async (_label, principal) => {
      const bureau = await openDurableBureau();
      try {
        const outcome = await bureau.goals.create(
          goalRequest({ goalRunId: 'g-reserved', principal }),
        );

        expect(outcome).toMatchObject({ outcome: 'rejected', code: 'invalid-configuration' });
        expect(await bureau.goals.get('g-reserved')).toBeUndefined();
      } finally {
        await bureau.dispose();
      }
    },
  );

  it.each(RESERVED)('is refused by bureau.run (%s)', async (_label, principal) => {
    const bureau = await createBureau({
      agents: { worker: createAgent({ name: 'worker', generate }) },
    });
    try {
      expect(() => bureau.run('worker', 'work', { principal })).toThrow(/reserved/);
      expect(bureau.listRuns()).toEqual([]);
    } finally {
      await bureau.dispose();
    }
  });

  it.each(RESERVED)(
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
            principal,
          }),
        );

        expect(refusal).toMatchObject({ code: 'BAD_REQUEST' });
        expect(await bureau.children.list(parent.id)).toEqual([]);
      } finally {
        await bureau.dispose();
      }
    },
  );

  it('still lets the exact local owner create and read a run, as the local handler flow does', async () => {
    const bureau = await openDurableBureau();
    try {
      const run = await bureau.createRun({
        message: 'x',
        sessionId: 'local',
        principal: 'anonymous:local',
      });

      expect(bureau.getRun(run.id)?.principal).toBe('anonymous:local');
      expect(await bureau.getOwner({ kind: 'run', id: run.id })).toBe('anonymous:local');
      expect(await bureau.getOwner({ kind: 'session', id: 'local' })).toBe('anonymous:local');
    } finally {
      await bureau.dispose();
    }
  });
});
