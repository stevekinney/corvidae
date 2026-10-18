import { z } from 'zod';

import { isZodSchema } from '../../core/schema-utilities';
import { jsonSchemaToZod } from '../../json-schema-to-zod';

/** The JSON Schema dialect MCP tool schemas use when they declare none. */
export const MCP_JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Resolves a schema an Armorer author configured for an outbound MCP tool
 * (`metadata.mcp.schema` or `toolConfiguration().schema`): a Zod schema, a
 * raw Zod shape, or a JSON Schema. Returns `undefined` when the value is not
 * a usable schema, and the caller then keeps the tool's own validated input
 * schema. The SDK publishes the result as JSON Schema 2020-12 and validates
 * every call's arguments against it.
 */
export function resolveOutboundMcpSchema(schema: unknown): z.ZodType | undefined {
  if (schema === undefined) return undefined;
  if (isZodSchema(schema)) return schema;
  if (isZodRawShape(schema)) {
    return z.object(schema);
  }
  return jsonSchemaToZod(schema) ?? undefined;
}

/**
 * Thrown when a remote MCP tool's `inputSchema` cannot be enforced as
 * written: an external or unresolvable `$ref`, a dialect other than JSON
 * Schema 2020-12, or a keyword the validator does not support.
 */
export class McpToolSchemaError extends TypeError {
  readonly toolName: string;
  constructor(toolName: string, reason: string) {
    super(`MCP tool "${toolName}" declares an input schema Armorer cannot enforce: ${reason}`);
    this.name = 'McpToolSchemaError';
    this.toolName = toolName;
  }
}

/**
 * Resolves a remote MCP tool's input schema for an inbound (client
 * direction) tool. Zod schemas and raw shapes pass through. A JSON Schema is
 * converted strictly: local `$ref`/`$defs` resolve, while a remote
 * reference, a missing definition, another dialect, or an unsupported keyword
 * throws {@link McpToolSchemaError} instead of degrading to a schema that
 * accepts anything. A tool that declares no schema at all accepts an object.
 */
export function resolveInboundMcpSchema(toolName: string, schema: unknown): z.ZodType {
  if (schema === undefined) return z.object({}).loose();
  if (isZodSchema(schema)) return schema;
  if (isZodRawShape(schema)) return z.object(schema);
  if (!isRecord(schema)) {
    throw new McpToolSchemaError(toolName, 'the schema is not a JSON Schema object');
  }
  const dialect = schema['$schema'];
  if (dialect !== undefined && dialect !== MCP_JSON_SCHEMA_DIALECT) {
    throw new McpToolSchemaError(
      toolName,
      `unsupported $schema ${JSON.stringify(dialect)} (expected ${MCP_JSON_SCHEMA_DIALECT})`,
    );
  }
  try {
    return z.fromJSONSchema(schema, { defaultTarget: 'draft-2020-12' });
  } catch (error) {
    throw new McpToolSchemaError(toolName, error instanceof Error ? error.message : String(error));
  }
}

function isZodRawShape(value: unknown): value is Record<string, z.ZodType> {
  if (!isRecord(value)) return false;
  const entries = Object.values(value);
  return entries.length > 0 && entries.every((entry) => isZodSchema(entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
