import { describe, expect, it } from 'bun:test';

import { fromMcpTools, MCP_JSON_SCHEMA_DIALECT, McpToolSchemaError } from '../src/integrations/mcp';

const ok = async () => ({ content: [{ type: 'text' as const, text: 'ok' }] });

describe('inbound MCP tool schemas', () => {
  it('resolves local $ref and $defs and enforces them', async () => {
    const calls: unknown[] = [];
    const [tool] = fromMcpTools(
      [
        {
          name: 'move',
          inputSchema: {
            $schema: MCP_JSON_SCHEMA_DIALECT,
            type: 'object',
            properties: { to: { $ref: '#/$defs/point' } },
            required: ['to'],
            $defs: {
              point: {
                type: 'object',
                properties: { x: { type: 'number' }, y: { type: 'number' } },
                required: ['x', 'y'],
              },
            },
          },
        },
      ],
      {
        callTool: async (request) => {
          calls.push(request.arguments);
          return ok();
        },
      },
    );
    expect(await tool?.execute({ to: { x: 1, y: 2 } })).toBe('ok');
    expect(calls).toEqual([{ to: { x: 1, y: 2 } }]);
    const rejected = await tool?.executeWith({ params: { to: { x: 'one' } } });
    expect(rejected?.outcome).toBe('error');
    expect(calls).toHaveLength(1);
  });

  it('rejects a remote $ref instead of accepting anything', () => {
    expect(() =>
      fromMcpTools([
        {
          name: 'remote',
          inputSchema: {
            type: 'object',
            properties: { payload: { $ref: 'https://example.com/schemas/payload.json' } },
          },
        },
      ]),
    ).toThrow(McpToolSchemaError);
  });

  it('rejects a $ref to a missing definition', () => {
    expect(() =>
      fromMcpTools([
        {
          name: 'dangling',
          inputSchema: { type: 'object', properties: { a: { $ref: '#/$defs/missing' } } },
        },
      ]),
    ).toThrow('Reference not found');
  });

  it('rejects a dialect other than JSON Schema 2020-12', () => {
    expect(() =>
      fromMcpTools([
        {
          name: 'draft-seven',
          inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' },
        },
      ]),
    ).toThrow('unsupported $schema');
  });

  it('rejects keywords the validator cannot enforce', () => {
    expect(() =>
      fromMcpTools([
        {
          name: 'conditional',
          inputSchema: {
            type: 'object',
            if: { properties: { kind: { const: 'a' } } },
            then: { required: ['a'] },
          },
        },
      ]),
    ).toThrow(McpToolSchemaError);
  });
});
