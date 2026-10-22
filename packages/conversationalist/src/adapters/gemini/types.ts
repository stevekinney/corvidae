import type { ContentPartLineage } from '../../multi-modal';

/**
 * Gemini text part.
 */
export interface GeminiTextPart {
  text: string;
}

/**
 * Gemini inline data part (for images).
 */
export interface GeminiInlineDataPart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

/**
 * Gemini file data part (for URLs).
 */
export interface GeminiFileDataPart {
  fileData: {
    mimeType: string;
    fileUri: string;
  };
}

/**
 * Gemini function call part.
 */
export interface GeminiFunctionCallPart {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
  };
}

/**
 * Gemini function response part.
 */
export interface GeminiFunctionResponsePart {
  functionResponse: {
    name: string;
    response: Record<string, unknown>;
    /** Ordered media for a result that carries parts; inline bytes only. */
    parts?: Array<{ inlineData: { mimeType: string; data: string } }>;
  };
}

/**
 * Gemini content part union type.
 */
export type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFileDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

/**
 * Gemini content (message) format.
 */
export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/**
 * Result of converting a conversation to Gemini format.
 */
export interface GeminiConversation {
  systemInstruction?: GeminiContent;
  contents: GeminiContent[];
}

/**
 * Result of exporting a conversation for Gemini: the wire payload, and one
 * lineage entry per media part delivered.
 */
export interface GeminiExport extends GeminiConversation {
  lineage: readonly ContentPartLineage[];
}
