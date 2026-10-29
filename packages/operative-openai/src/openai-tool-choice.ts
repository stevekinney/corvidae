import type { ToolChoice } from '@lostgradient/operative/provider-kit';

/**
 * OpenAI tool_choice parameter shape.
 */
type OpenAIToolChoice =
  'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };

/**
 * Converts a ToolChoice to the OpenAI API's tool_choice format.
 */
export function toOpenAIToolChoice(choice: ToolChoice): OpenAIToolChoice {
  if (choice === 'auto') return 'auto';
  if (choice === 'required') return 'required';
  if (choice === 'none') return 'none';
  return { type: 'function', function: { name: choice.tool } };
}
