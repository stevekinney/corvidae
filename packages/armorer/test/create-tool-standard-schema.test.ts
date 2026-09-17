import type { StandardSchemaV1 } from '@repo/interoperability';
import { describe, expect, expectTypeOf, it } from 'bun:test';
import { z } from 'zod';

import { createTool, createToolCall } from '../src';
import type { JsonObject } from '../src/core/serialization/json';

/**
 * A minimal hand-rolled Standard Schema V1 validator (no vendor dependency
 * required — Valibot, ArkType, etc. all implement the same `~standard`
 * shape). Trims and uppercases the `name` field, so a successful parse
 * proves the validator's TRANSFORMED output — not the raw input — reaches
 * `execute()`.
 */
function greetingSchema(): StandardSchemaV1<unknown, { name: string }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        if (
          typeof value !== 'object' ||
          value === null ||
          typeof (value as Record<string, unknown>)['name'] !== 'string' ||
          (value as { name: string }).name.trim().length === 0
        ) {
          return { issues: [{ message: 'expected { name: non-empty string }' }] };
        }
        const name = (value as { name: string }).name.trim().toUpperCase();
        return { value: { name } };
      },
    },
  };
}

const greetingJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: { name: { type: 'string' } },
};

function schemaProducing<Output>(output: Output): StandardSchemaV1<unknown, Output> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate() {
        return { value: output };
      },
    },
  };
}

describe('createTool with a non-Zod Standard Schema input', () => {
  it('preserves primitive validator outputs in the callback and runtime', async () => {
    const tool = createTool({
      name: 'primitive-output',
      description: 'Receives the validator output',
      input: schemaProducing('validated'),
      inputSchema: { type: 'object' },
      async execute(value) {
        expectTypeOf(value).toEqualTypeOf<string>();
        expect(value).toBe('validated');
        return value;
      },
    });
    expect(await tool({})).toBe('validated');
  });

  it('preserves undefined validator outputs without inventing an object', async () => {
    const tool = createTool({
      name: 'undefined-output',
      description: 'Receives an undefined validator output',
      input: schemaProducing(undefined),
      inputSchema: { type: 'object' },
      async execute(value) {
        expectTypeOf(value).toEqualTypeOf<undefined>();
        expect(value).toBeUndefined();
        return 'executed';
      },
    });
    expect(await tool({})).toBe('executed');
  });

  it('keeps opaque validator outputs unknown until the callback narrows them', async () => {
    const tool = createTool({
      name: 'unknown-output',
      description: 'Narrows an opaque validator output',
      input: schemaProducing<unknown>(42),
      inputSchema: { type: 'object' },
      async execute(value) {
        expectTypeOf(value).toEqualTypeOf<unknown>();
        if (typeof value !== 'number') throw new Error('Expected a number');
        return value + 1;
      },
    });
    expect(await tool({})).toBe(43);
  });

  it('throws at creation time when `inputSchema` is not supplied', () => {
    expect(() =>
      createTool({
        name: 'greet-missing-schema',
        description: 'Greets by name',
        input: greetingSchema(),
        execute: async (params: { name: string }) => `hello, ${params.name}`,
      }),
    ).toThrow('requires an explicit `inputSchema`');
  });

  it('NEUTER CHECK: a Zod input never trips the missing-inputSchema guard', () => {
    // Confirms the guard in create-tool.ts is gated on `isStandardSchema` +
    // `!isZodSchema`, not merely "non-undefined input" — a plain Zod schema
    // must never require `inputSchema`.
    expect(() =>
      createTool({
        name: 'greet-zod',
        description: 'Greets by name',
        input: z.object({ name: z.string() }),
        execute: async (params: { name: string }) => `hello, ${params.name}`,
      }),
    ).not.toThrow();
  });

  it('validates via `~standard.validate`, transforms the input, and executes with the transformed value', async () => {
    const tool = createTool({
      name: 'greet',
      description: 'Greets by name',
      input: greetingSchema(),
      inputSchema: greetingJsonSchema,
      execute: async (params: { name: string }) => `hello, ${params.name}`,
    });

    const result = await tool.execute(createToolCall('greet', { name: '  ada  ' }));
    expect(result.outcome).toBe('success');
    expect(result.result).toBe('hello, ADA');
  });

  it('rejects invalid input with a validate-error outcome', async () => {
    const tool = createTool({
      name: 'greet-invalid',
      description: 'Greets by name',
      input: greetingSchema(),
      inputSchema: greetingJsonSchema,
      execute: async (params: { name: string }) => `hello, ${params.name}`,
    });

    const result = await tool.execute(createToolCall('greet-invalid', { name: '' }));
    expect(result.outcome).toBe('error');
    expect(result.error?.category).toBe('validation');
  });

  it('serializes using the caller-supplied `inputSchema`, not a derived Zod schema', () => {
    const tool = createTool({
      name: 'greet-serialize',
      description: 'Greets by name',
      input: greetingSchema(),
      inputSchema: greetingJsonSchema,
      execute: async (params: { name: string }) => `hello, ${params.name}`,
    });

    // AB-308: `Tool.toJSON()` is part of the public `Tool` type.
    const serialized = tool.toJSON();
    expect(serialized.input).toEqual(greetingJsonSchema);
  });

  it('rejects a non-JSON `inputSchema` at creation time, not later at serialization', () => {
    // `inputSchema` is serialized verbatim; a Date (or function, or circular
    // ref) must be rejected at the boundary where it enters the tool, not
    // silently corrupted by sortJsonValue or thrown at a distance later.
    expect(() =>
      createTool({
        name: 'greet-bad-schema',
        description: 'Greets by name',
        input: greetingSchema(),
        inputSchema: { type: 'object', createdAt: new Date(0) } as unknown as JsonObject,
        execute: async (params: { name: string }) => `hello, ${params.name}`,
      }),
    ).toThrow();
  });
});
