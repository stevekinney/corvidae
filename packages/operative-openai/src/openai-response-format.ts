import type { ResponseFormat } from '@lostgradient/operative/provider-kit';
import { isStrictCompatible } from '@lostgradient/operative/provider-kit';

/**
 * OpenAI response_format parameter shape.
 */
type OpenAIResponseFormat =
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: { name: string; schema: Record<string, unknown>; strict: boolean };
    }
  | undefined;

/**
 * Converts a ResponseFormat to the OpenAI API's response_format parameter.
 *
 * Returns `undefined` for text format since OpenAI defaults to text.
 *
 * `strict: true` is sent only when the schema passes `isStrictCompatible`;
 * otherwise the `json_schema` shape is kept with `strict: false`. Schemas
 * derived from `z.object()` via `toOutputJsonSchema` lack
 * `additionalProperties: false`, so `strict: false` is their expected steady
 * state, not a silent downgrade.
 */
export function toOpenAIResponseFormat(format: ResponseFormat): OpenAIResponseFormat {
  if (format.type === 'text') return undefined;
  if (format.type === 'json') return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: {
      name: format.name ?? 'response',
      schema: format.schema,
      strict: isStrictCompatible(format.schema),
    },
  };
}
