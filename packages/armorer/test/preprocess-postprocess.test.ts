import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { createTool } from '../src/create-tool';
import { postprocess } from '../src/utilities/postprocess';
import { preprocess } from '../src/utilities/preprocess';

describe('preprocess', () => {
  it('preserves primitive output through preprocessing', async () => {
    const stringify = createTool({
      name: 'stringify-number',
      description: 'Formats a number',
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => String(value),
    });
    const formatted = preprocess(stringify, z.object({ value: z.number() }), (input) => input);

    expect(await formatted({ value: 12345 })).toBe('12345');
  });

  it('validates the new input before invoking the mapper', async () => {
    const tool = createTool({
      name: 'validated-preprocess',
      description: 'Validates preprocessed input',
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => value,
    });
    const preprocessed = preprocess(tool, z.object({ value: z.string() }), (input) => ({
      value: Number(input.value),
    }));

    return expect(await throwingRejectionOf(preprocessed.execute({ value: 1 }))).toThrow();
  });

  it('transforms inputs before passing to the tool', async () => {
    const addNumbers = createTool({
      name: 'add-numbers',
      description: 'Add two numbers',
      input: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => a + b,
    });

    const addNumbersWithPreprocessing = preprocess(
      addNumbers,
      z.object({ a: z.string(), b: z.string() }),
      async (input: { a: string; b: string }) => ({
        a: Number(input.a),
        b: Number(input.b),
      }),
    );

    const result = await addNumbersWithPreprocessing({ a: '5', b: '3' });
    expect(result).toBe(8);
  });

  it('has correct name and description', () => {
    const tool = createTool({
      name: 'original',
      description: 'Original tool',
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => value * 2,
    });

    const preprocessed = preprocess(
      tool,
      z.object({ value: z.number() }),
      async (input: { value: number }) => input,
    );
    expect(preprocessed.name).toBe('preprocess(original)');
    expect(preprocessed.description).toBe('Preprocessed tool: Original tool');
  });

  it('preserves tags from original tool', async () => {
    const tool = createTool({
      name: 'tagged-tool',
      description: 'A tool with tags',
      input: z.object({ value: z.number() }),
      tags: ['math', 'utility'],
      execute: async ({ value }) => value,
    });

    const preprocessed = preprocess(
      tool,
      z.object({ value: z.number() }),
      async (input: { value: number }) => input,
    );
    expect(preprocessed.tags).toEqual(['math', 'utility']);
  });

  it('preserves metadata from original tool', async () => {
    const tool = createTool({
      name: 'metadata-tool',
      description: 'A tool with metadata',
      input: z.object({ value: z.number() }),
      metadata: { category: 'test', priority: 1 },
      execute: async ({ value }) => value,
    });

    const preprocessed = preprocess(
      tool,
      z.object({ value: z.number() }),
      async (input: { value: number }) => input,
    );
    // AB-308: `preprocess()`'s return type now propagates the wrapped
    // tool's metadata type parameter, so this reads it back typed, no cast.
    expect(preprocessed.metadata).toEqual({ category: 'test', priority: 1 });
  });

  it('works with sync mapper', async () => {
    const tool = createTool({
      name: 'double',
      description: 'Double a number',
      input: z.object({ n: z.number() }),
      execute: async ({ n }) => n * 2,
    });

    const preprocessed = preprocess(
      tool,
      z.object({ str: z.string() }),
      (input: { str: string }) => ({
        n: parseInt(input.str, 10),
      }),
    );

    const result = await preprocessed({ str: '10' });
    expect(result).toBe(20);
  });

  it('handles no tags gracefully', async () => {
    const tool = createTool({
      name: 'no-tags',
      description: 'A tool without tags',
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => value,
    });

    const preprocessed = preprocess(
      tool,
      z.object({ value: z.number() }),
      async (input: { value: number }) => input,
    );
    expect(preprocessed.tags).toBeUndefined();
  });

  it('forwards timeout and an execution-scoped signal through preprocess', async () => {
    const observed: { signal: AbortSignal | undefined; timeout: number | undefined } = {
      signal: undefined,
      timeout: undefined,
    };
    const tool = createTool({
      name: 'context-forward',
      description: 'captures context',
      input: z.object({ value: z.number() }),
      async execute(_params, context) {
        observed.signal = context.signal;
        observed.timeout = context.timeout;
        return 1;
      },
    });

    const preprocessed = preprocess(
      tool,
      z.object({ value: z.number() }),
      async (input: { value: number }) => input,
    );
    const controller = new AbortController();
    await preprocessed.executeWith({
      params: { value: 1 },
      signal: controller.signal,
      timeout: 123,
    });

    expect(observed.signal).not.toBe(controller.signal);
    controller.abort('caller stopped');
    expect(observed.signal?.aborted).toBe(false);
    expect(observed.timeout).toBe(123);
  });

  it('forwards stream to the wrapped tool', async () => {
    const observed: Array<{ stream?: boolean }> = [];
    const tool = createTool({
      name: 'preprocess-stream-forward',
      description: 'captures stream',
      input: z.object({ value: z.number() }),
      async execute(_params, context) {
        observed.push(context.stream !== undefined ? { stream: context.stream } : {});
        return 7;
      },
    });

    const preprocessed = preprocess(
      tool,
      z.object({ value: z.number() }),
      async (input: { value: number }) => input,
    );
    const result = await preprocessed.executeWith({
      params: { value: 1 },
      stream: true,
    });

    expect(result.result).toBe(7);
    expect(observed).toEqual([{ stream: true }]);
  });
});

describe('preprocess and postprocess composition', () => {
  it('can be chained together', async () => {
    const baseTool = createTool({
      name: 'multiply',
      description: 'Multiply by 2',
      input: z.object({ n: z.number() }),
      execute: async ({ n }) => n * 2,
    });

    const preprocessed = preprocess(
      baseTool,
      z.object({ str: z.string() }),
      async (input: { str: string }) => ({
        n: parseInt(input.str, 10),
      }),
    );

    const composed = postprocess(preprocessed, async (output) => `Result: ${formatScalar(output)}`);

    const result = await composed({ str: '5' });
    expect(result).toBe('Result: 10');
  });
});

function formatScalar(output: unknown): string {
  if (typeof output === 'number' || typeof output === 'string') return String(output);
  throw new Error('Expected a scalar output');
}
