import { expect, test } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../src/index';

test('callable tool properties are present in reflection and remain read-only', async () => {
  const metadata = { source: 'reflection-test' };
  const tool = createTool({
    name: 'reflected-tool',
    description: 'A callable tool with inspectable properties',
    input: z.object({ value: z.string() }),
    metadata,
    async execute({ value }) {
      return value;
    },
  });

  expect(await tool({ value: 'called' })).toBe('called');
  expect(Reflect.ownKeys(tool)).toContain('execute');
  expect(Reflect.ownKeys(tool)).toContain('metadata');
  expect(Reflect.ownKeys(tool)).toContain(Symbol.toPrimitive);
  expect(Object.getOwnPropertyDescriptor(tool, 'metadata')?.value).toBe(metadata);
  expect(Object.getOwnPropertyDescriptor(tool, 'name')?.writable).toBe(false);
  expect(Object.getOwnPropertyDescriptor(tool, Symbol.toPrimitive)?.writable).toBe(false);
  expect(Reflect.set(tool, 'name', 'replacement')).toBe(false);
  expect(Reflect.set(tool, 'execute', () => undefined)).toBe(false);
  expect(tool.name).toBe('reflected-tool');
  expect(String(tool)).toBe('reflected-tool');
});

test('callable lifecycle properties stay live after construction', async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<string>();
  const tool = createTool({
    name: 'lifecycle-properties',
    description: 'Exposes live execution state',
    input: z.object({}),
    async execute() {
      started.resolve();
      return finish.promise;
    },
  });

  expect(tool.activeExecutions).toBe(0);
  expect(tool.completed).toBe(false);
  const result = tool({});
  await started.promise;
  expect(tool.activeExecutions).toBe(1);
  finish.resolve('finished');
  expect(await result).toBe('finished');
  await tool.whenIdle();
  expect(tool.activeExecutions).toBe(0);
  await tool.complete();
  expect(tool.completed).toBe(true);
  expect(tool.executionSignal.aborted).toBe(true);
});

test('callable names retain identity normalization', () => {
  const tool = createTool({
    name: '  normalized-name  ',
    description: 'Retains the normalized identity',
    input: z.object({}),
    async execute() {
      return 'value';
    },
  });
  expect(tool.name).toBe('normalized-name');
  expect(String(tool)).toBe('normalized-name');
  expect(tool.identity.name).toBe('normalized-name');
});
