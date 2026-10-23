/**
 * Gemini schema format (OpenAPI 3.0 subset), carried as JSON Schema.
 *
 * `toGeminiTools` emits JSON Schema with lowercase `type` names, which
 * `@google/genai` converts to its `Type` enum before sending a request. The
 * SDK types `Schema.type` as that string enum, which no plain string is
 * assignable to, so `type` stays under the index signature here; declaring
 * it as `string` would make every emitted tool unassignable to the SDK's
 * `Tool`.
 * @see https://ai.google.dev/gemini-api/docs/function-calling
 */
export interface GeminiSchema {
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  items?: GeminiSchema;
  enum?: string[];
  description?: string;
  format?: string;
  nullable?: boolean;
  [key: string]: unknown;
}

/**
 * Gemini function declaration.
 * @see https://ai.google.dev/gemini-api/docs/function-calling
 */
export interface GeminiFunctionDeclaration {
  /** The name of the function. */
  name: string;
  /** A description of what the function does. */
  description: string;
  /** The parameters the function accepts, described as an OpenAPI schema. */
  parameters: GeminiSchema;
}

/**
 * Gemini tool definition containing function declarations.
 * Pass this to the model's tools configuration.
 */
export interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[];
}

export interface GeminiFunctionCallPart {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
  };
}

export interface GeminiFunctionResponsePart {
  functionResponse: {
    /** The originating `functionCall.id`; present only when Gemini issued one (an id recorded by `parseGeminiToolCalls`). */
    id?: string;
    name: string;
    response: Record<string, unknown>;
    /** Ordered inline media for a result that carries parts, named from `response.output`. */
    parts?: Array<{ inlineData: { mimeType: string; data: string; displayName: string } }>;
  };
}

export interface GeminiTextPart {
  text: string;
}

export interface GeminiInlineDataPart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

export interface GeminiFileDataPart {
  fileData: {
    mimeType: string;
    fileUri: string;
  };
}

/**
 * A response part as `parseGeminiToolCalls` reads it. Every field is optional,
 * matching `@google/genai`'s `Part`, whose `functionCall` carries an optional
 * `name`, optional `args`, and (from Gemini 3) an optional call `id`.
 */
export interface GeminiResponsePart {
  functionCall?:
    | {
        id?: string | undefined;
        name?: string | undefined;
        args?: Record<string, unknown> | undefined;
      }
    | undefined;
}

export type GeminiPart =
  | GeminiFileDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart
  | GeminiInlineDataPart
  | GeminiTextPart;
