import type { ToolChoice } from '@lostgradient/operative/provider-kit';

/**
 * Gemini toolConfig parameter shape (camelCase per @google/genai SDK).
 */
type GeminiToolConfig = {
  functionCallingConfig: {
    mode: 'AUTO' | 'ANY' | 'NONE';
    allowedFunctionNames?: string[] | undefined;
  };
};

/**
 * Converts a ToolChoice to the Gemini API's tool_config format.
 */
export function toGeminiToolChoice(choice: ToolChoice): GeminiToolConfig {
  if (choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
  if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  return {
    functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.tool] },
  };
}
