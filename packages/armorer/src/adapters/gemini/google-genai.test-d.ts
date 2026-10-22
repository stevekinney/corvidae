import type { GenerateContentConfig, GenerateContentResponse, Part, Tool } from '@google/genai';

import type { AnyToolbox } from '../../index';
import { parseGeminiToolCalls, toGeminiTools } from './index';

// The provider-adapter guides pass armorer's Gemini output straight to
// `@google/genai` and its response parts straight back. Armorer carries no
// runtime dependency on the SDK, so this contract keeps its structural types
// assignable in both directions.
declare const toolbox: AnyToolbox;
declare const response: GenerateContentResponse;

const config: GenerateContentConfig = { tools: toGeminiTools(toolbox) };
const tools: Tool[] = toGeminiTools(toolbox);
const availableTools: Promise<Tool[]> = toolbox.toGeminiTools();
void config;
void tools;
void availableTools;

void parseGeminiToolCalls(response.candidates?.[0]?.content?.parts ?? []);
void parseGeminiToolCalls(response.candidates?.[0]?.content);
void parseGeminiToolCalls(response.candidates?.[0]);
const parts: Part[] = [{ text: 'thinking' }, { functionCall: { name: 'search' } }];
void parseGeminiToolCalls(parts);
