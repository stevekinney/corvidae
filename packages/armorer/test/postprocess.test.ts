import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../src/create-tool';
import { postprocess } from '../src/utilities/postprocess';

function formatScalar(output: unknown): string {
  if (typeof output === 'number' || typeof output === 'string') return String(output);
  throw new Error('Expected a scalar output');
}

describe('postprocess', () => {
  it('transforms outputs after tool execution', async () => {
    const fetchUser = createTool({
      name: 'fetch-user',
      description: 'Fetch user data',
      input: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ userId: id, name: 'John' }),
    });

    const fetchUserFormatted = postprocess(fetchUser, async (output) => {
      if (!isUserOutput(output)) throw new Error('Expected a user output');
      return {
        ...output,
        displayName: `${output.name} (${output.userId})`,
      };
    });

    const result = await fetchUserFormatted({ id: '123' });
    expect(result).toEqual({
      userId: '123',
      name: 'John',
      displayName: 'John (123)',
    });
  });

  it('has correct name and description', () => {
    const tool = createTool({
      name: 'original',
      description: 'Original tool',
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => value * 2,
    });

    const postprocessed = postprocess(tool, async (output) => output);
    expect(postprocessed.name).toBe('postprocess(original)');
    expect(postprocessed.description).toBe('Postprocessed tool: Original tool');
  });

  it('preserves tags from original tool', async () => {
    const tool = createTool({
      name: 'tagged-tool',
      description: 'A tool with tags',
      input: z.object({ value: z.number() }),
      tags: ['math', 'utility'],
      execute: async ({ value }) => value,
    });

    const postprocessed = postprocess(tool, async (output) => output);
    expect(postprocessed.tags).toEqual(['math', 'utility']);
  });

  it('preserves metadata from original tool', async () => {
    const tool = createTool({
      name: 'metadata-tool',
      description: 'A tool with metadata',
      input: z.object({ value: z.number() }),
      metadata: { category: 'test', priority: 1 },
      execute: async ({ value }) => value,
    });

    const postprocessed = postprocess(tool, async (output) => output);
    // AB-308: `postprocess()`'s return type now propagates the wrapped
    // tool's metadata type parameter, so this reads it back typed, no cast.
    expect(postprocessed.metadata).toEqual({ category: 'test', priority: 1 });
  });

  it('works with sync mapper', async () => {
    const tool = createTool({
      name: 'double',
      description: 'Double a number',
      input: z.object({ n: z.number() }),
      execute: async ({ n }) => n * 2,
    });

    const postprocessed = postprocess(tool, (output) => `Result: ${formatScalar(output)}`);

    const result = await postprocessed({ n: 5 });
    expect(result).toBe('Result: 10');
  });

  it('handles no tags gracefully', async () => {
    const tool = createTool({
      name: 'no-tags',
      description: 'A tool without tags',
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => value,
    });

    const postprocessed = postprocess(tool, async (output) => output);
    expect(postprocessed.tags).toBeUndefined();
  });

  it('uses same input as original tool', () => {
    const input = z.object({ value: z.number() });
    const tool = createTool({
      name: 'original',
      description: 'Original tool',
      input,
      execute: async ({ value }) => value,
    });

    const postprocessed = postprocess(tool, async (output) => output);
    expect(postprocessed.input).toBe(input);
  });

  it('forwards timeout and an execution-scoped signal through postprocess', async () => {
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

    const postprocessed = postprocess(tool, async (output) => output);
    const controller = new AbortController();
    await postprocessed.executeWith({
      params: { value: 1 },
      signal: controller.signal,
      timeout: 321,
    });

    expect(observed.signal).not.toBe(controller.signal);
    controller.abort('caller stopped');
    expect(observed.signal?.aborted).toBe(false);
    expect(observed.timeout).toBe(321);
  });

  it('forwards stream to the wrapped tool', async () => {
    const observed: Array<{ stream?: boolean }> = [];
    const tool = createTool({
      name: 'postprocess-stream-forward',
      description: 'captures stream',
      input: z.object({ value: z.number() }),
      async execute(_params, context) {
        observed.push(context.stream !== undefined ? { stream: context.stream } : {});
        return 9;
      },
    });

    const postprocessed = postprocess(tool, async (output) => output);
    const result = await postprocessed.executeWith({
      params: { value: 1 },
      stream: true,
    });

    expect(result.result).toBe(9);
    expect(observed).toEqual([{ stream: true }]);
  });
});

function isUserOutput(output: unknown): output is { userId: string; name: string } {
  return (
    typeof output === 'object' &&
    output !== null &&
    !Array.isArray(output) &&
    !(Symbol.asyncIterator in output) &&
    'userId' in output &&
    typeof output.userId === 'string' &&
    'name' in output &&
    typeof output.name === 'string'
  );
}
