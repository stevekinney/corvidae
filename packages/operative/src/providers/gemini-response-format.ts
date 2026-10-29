import type { ResponseFormat } from '../structured-output/types.ts';

/**
 * Gemini `GenerateContentConfig` fields for response format (camelCase per @google/genai).
 */
type GeminiResponseFormat =
  | { responseMimeType: 'application/json'; responseSchema?: Record<string, unknown> | undefined }
  | undefined;

/**
 * Converts a ResponseFormat to the Gemini API's generation config fields.
 *
 * Returns `undefined` for text format since Gemini defaults to text.
 */
export function toGeminiResponseFormat(format: ResponseFormat): GeminiResponseFormat {
  if (format.type === 'text') return undefined;
  if (format.type === 'json') return { responseMimeType: 'application/json' };
  return {
    responseMimeType: 'application/json',
    responseSchema: format.schema,
  };
}
