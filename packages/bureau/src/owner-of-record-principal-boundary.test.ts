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
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import type { AgentDefinitions } from './agent-catalog';
import { listHeldTasks } from './test';

const generate: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });
const NOT_TEXT = [
  ['a number', 7],
  ['null', null],
  ['an object', {}],
  ['an array', ['api-key:alice']],
  ['a boolean', true],
] as const;

async function openDurableBureau() {
  return createBureau<AgentDefinitions>({
    agents: {
      worker: workerAgent(answering('done')),
      default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }),
    },
    validators: [createCheckValidator()],
    storage: { type: 'memory' },
    durable: true,
  });
}

describe('a principal that is not text (COR-718)', () => {
  it.each(NOT_TEXT)(
    'is refused by tasks.start, which persists nothing (%s)',
    async (_label, principal) => {
      const bureau = await openDurableBureau();
      try {
        const plain = await rejectionOf(
          bureau.tasks.start('default', 'x', {
            contextId: 'refused',
            principal: principal as never,
          }),
        );
        const withReceipt = await rejectionOf(
          bureau.tasks.start('default', 'x', {
            contextId: 'refused',
            principal: principal as never,
            commandId: 'request-1',
          }),
        );

        expect(plain).toMatchObject({ code: 'BAD_REQUEST' });
        expect(withReceipt).toMatchObject({ code: 'BAD_REQUEST' });
        expect(listHeldTasks(bureau)).toEqual([]);
        expect(await bureau.contexts.get('refused')).toBeUndefined();
      } finally {
        await bureau.dispose();
      }
    },
  );

  it.each(NOT_TEXT)(
    'is refused by schedules.create, which registers nothing (%s)',
    async (_label, principal) => {
      const bureau = await openDurableBureau();
      try {
        const refusal = await rejectionOf(
          bureau.schedules.create({
            agentName: 'worker',
            input: 'tick',
            spec: '1h',
            principal: principal as never,
          }),
        );

        expect(refusal).toMatchObject({ code: 'BAD_REQUEST' });
        const listed = await bureau.schedules.list();
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

  it.each(NOT_TEXT)('is refused by tasks.start (%s)', async (_label, principal) => {
    const bureau = await createBureau({
      agents: { worker: createAgent({ name: 'worker', generate }) },
    });
    try {
      const error = await rejectionOf(
        bureau.tasks.start('worker', 'work', { principal: principal as never }),
      );
      expect((error as Error).message).toContain('principal');
    } finally {
      await bureau.dispose();
    }
  });

  it.each(NOT_TEXT)(
    'is refused by children.dispatch, which records no child (%s)',
    async (_label, principal) => {
      const bureau = await createBureau<AgentDefinitions>({
        agents: {
          worker: createAgent({ name: 'worker', generate }),
          default: createAgent({ generate: () => new Promise<never>(() => {}) }),
        },
      });
      try {
        const parent = await bureau.tasks.start('default', 'plan');
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
    'is refused by tasks.start, which persists nothing (%s)',
    async (_label, principal) => {
      const bureau = await openDurableBureau();
      try {
        const refusal = await rejectionOf(
          bureau.tasks.start('default', 'x', { contextId: 'reserved', principal }),
        );

        expect(refusal).toMatchObject({ code: 'BAD_REQUEST' });
        expect(listHeldTasks(bureau)).toEqual([]);
        expect(await bureau.contexts.get('reserved')).toBeUndefined();
      } finally {
        await bureau.dispose();
      }
    },
  );

  it.each(RESERVED)(
    'is refused by schedules.create, which registers nothing (%s)',
    async (_label, principal) => {
      const bureau = await openDurableBureau();
      try {
        const refusal = await rejectionOf(
          bureau.schedules.create({ agentName: 'worker', input: 'tick', spec: '1h', principal }),
        );

        expect(refusal).toMatchObject({ code: 'BAD_REQUEST' });
        const listed = await bureau.schedules.list();
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

  it.each(RESERVED)('is refused by tasks.start (%s)', async (_label, principal) => {
    const bureau = await createBureau({
      agents: { worker: createAgent({ name: 'worker', generate }) },
    });
    try {
      const error = await rejectionOf(bureau.tasks.start('worker', 'work', { principal }));
      expect((error as Error).message).toMatch(/reserved/);
      expect(listHeldTasks(bureau)).toEqual([]);
    } finally {
      await bureau.dispose();
    }
  });

  it.each(RESERVED)(
    'is refused by children.dispatch, which records no child (%s)',
    async (_label, principal) => {
      const bureau = await createBureau<AgentDefinitions>({
        agents: {
          worker: createAgent({ name: 'worker', generate }),
          default: createAgent({ generate: () => new Promise<never>(() => {}) }),
        },
      });
      try {
        const parent = await bureau.tasks.start('default', 'plan');
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
      const run = await bureau.tasks.start('default', 'x', {
        contextId: 'local',
        principal: 'anonymous:local',
      });

      expect(bureau.tasks.detail(run.id)?.principal).toBe('anonymous:local');
      expect(await bureau.ownerOf({ kind: 'run', id: run.id })).toBe('anonymous:local');
      expect(await bureau.ownerOf({ kind: 'session', id: 'local' })).toBe('anonymous:local');
    } finally {
      await bureau.dispose();
    }
  });
});
