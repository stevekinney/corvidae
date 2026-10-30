/**
 * The context-window report of a context (COR-1937): how many tokens the next step's prompt would
 * hold, split by what fills it, against the window of the model that would answer.
 *
 * It is a pure read of rows a Bureau already keeps: the session's persisted history, the agent's
 * instructions and tool schemas, the model catalog, and the usage a step reported. It calls no
 * model and writes no state. Every figure here is a size estimate (four characters to a token, the
 * estimator conversationalist's `estimateTokens` and Operative's compaction already share) except
 * `usedReported`, which is the provider's own count.
 *
 * @module context-window
 */

import {
  type BackendDescriptor,
  createCatalogMediaCostEstimator,
  MEMORY_EVIDENCE_METADATA_KEY,
} from '@lostgradient/operative';
import {
  type ConversationHistory,
  getMessages,
  isMediaContent,
  type Message,
  simpleTokenEstimator,
} from 'conversationalist';

import type {
  ContextWindowCategory,
  ContextWindowCategoryName,
  ContextWindowReport,
} from '../types.ts';

/** The order the categories are reported in, so a client can rely on it. */
export const CONTEXT_WINDOW_CATEGORIES: readonly ContextWindowCategoryName[] = [
  'system',
  'tools',
  'messages',
  'memory',
  'attachments',
];

/** One tool as the model is offered it: the name, what it does, and the JSON schema of its input. */
export interface ContextWindowTool {
  readonly name: string;
  readonly description?: string | undefined;
  /** The tool's input as JSON Schema. */
  readonly input?: unknown;
}

/** The usage a provider reported for one step; cache counters are absent when it reported none. */
export interface ReportedStepUsage {
  readonly prompt: number;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheCreationTokens?: number | undefined;
}

/** What {@link buildContextWindow} reads. */
export interface ContextWindowInputs {
  /** The context's persisted history: the rows the next step's prompt is built from. */
  readonly history: ConversationHistory;
  /**
   * The agent's system instructions. They stand in for the `system` rows when the history holds
   * none, as for a context that has not run yet, and are never counted beside such a row.
   */
  readonly instructions?: string | undefined;
  /** The tools the next step would offer. */
  readonly tools: readonly ContextWindowTool[];
  /** The catalog row of the model that would answer, or `undefined` when it is not known. */
  readonly model: BackendDescriptor | undefined;
  /** The catalog, which prices attachments when `model` is not known. */
  readonly catalog: readonly BackendDescriptor[];
  /** The last step's reported usage, or `undefined` when the provider reported none. */
  readonly reported: ReportedStepUsage | undefined;
}

/** A row that carries no stored message, so the shared estimator can size a bare string. */
function textRow(role: Message['role'], content: string): Message {
  return { id: '', role, content, position: 0, createdAt: '', metadata: {}, hidden: false };
}

/** The tokens of `text`, by the estimator every size figure here shares. */
export function estimateText(text: string): number {
  return simpleTokenEstimator(textRow('user', text));
}

/** A stored counter that is a finite, non-negative number; anything else counts as absent. */
function counter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * What the provider counted as input for the step: fresh prompt tokens plus both cache counters,
 * or `null` when it reported no prompt count. The usage may have been read back from storage, so
 * each counter is checked rather than trusted.
 */
export function reportedInputTokens(usage: ReportedStepUsage | undefined): number | null {
  const prompt = counter(usage?.prompt);
  if (usage === undefined || prompt === undefined) return null;
  return prompt + (counter(usage.cacheReadTokens) ?? 0) + (counter(usage.cacheCreationTokens) ?? 0);
}

function isMemoryRow(message: Message): boolean {
  return Object.hasOwn(message.metadata, MEMORY_EVIDENCE_METADATA_KEY);
}

function isInstructionRow(message: Message): boolean {
  return (message.role === 'system' || message.role === 'developer') && !isMemoryRow(message);
}

/**
 * The tokens a message costs: its content and tool result through the shared estimator, and the
 * call it carries, which that estimator does not read.
 */
function messageTokens(message: Message): number {
  const call =
    message.toolCall === undefined
      ? 0
      : estimateText(
          JSON.stringify({ name: message.toolCall.name, arguments: message.toolCall.arguments }),
        );
  return simpleTokenEstimator(message) + call;
}

/**
 * The bytes of every media part in `messages`, costed against `descriptors`. A part the backend
 * would refuse costs nothing here, because nothing is sent for it.
 */
function attachmentTokens(
  messages: readonly Message[],
  descriptors: readonly BackendDescriptor[],
): number {
  const estimate = createCatalogMediaCostEstimator(descriptors);
  let tokens = 0;
  for (const message of messages) {
    const parts = typeof message.content === 'string' ? [] : message.content;
    const resultParts = message.toolResult?.parts ?? [];
    for (const [partIndex, part] of parts.entries()) {
      if (!isMediaContent(part)) continue;
      const outcome = estimate(part, { messageId: message.id, partIndex });
      if (outcome.outcome === 'estimated') tokens += outcome.tokens;
    }
    for (const [partIndex, part] of resultParts.entries()) {
      if (!isMediaContent(part)) continue;
      const outcome = estimate(part, { messageId: message.id, partIndex });
      if (outcome.outcome === 'estimated') tokens += outcome.tokens;
    }
  }
  return tokens;
}

function toolTokens(tools: readonly ContextWindowTool[]): number {
  let tokens = 0;
  for (const tool of tools) {
    tokens += estimateText(
      JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.input }),
    );
  }
  return tokens;
}

/**
 * The report for one context. `usedEstimated` is the sum of the categories, taken from them and
 * never counted separately, so the two cannot disagree.
 */
export function buildContextWindow(inputs: ContextWindowInputs): ContextWindowReport {
  const messages = getMessages(inputs.history);
  const instructionRows = messages.filter(isInstructionRow);
  const memoryRows = messages.filter(isMemoryRow);
  const conversationRows = messages.filter((row) => !isInstructionRow(row) && !isMemoryRow(row));
  const sum = (rows: readonly Message[]): number =>
    rows.reduce((total, row) => total + messageTokens(row), 0);

  const system =
    instructionRows.length > 0
      ? sum(instructionRows)
      : inputs.instructions === undefined || inputs.instructions === ''
        ? 0
        : estimateText(inputs.instructions);
  const tokens: Record<ContextWindowCategoryName, number> = {
    system,
    tools: toolTokens(inputs.tools),
    messages: sum(conversationRows),
    memory: sum(memoryRows),
    attachments: attachmentTokens(
      messages,
      inputs.model === undefined ? inputs.catalog : [inputs.model],
    ),
  };
  const categories: ContextWindowCategory[] = CONTEXT_WINDOW_CATEGORIES.map((name) => ({
    name,
    tokens: tokens[name],
  }));
  return {
    maxTokens: inputs.model?.contextWindowTokens ?? null,
    usedEstimated: categories.reduce((total, category) => total + category.tokens, 0),
    usedReported: reportedInputTokens(inputs.reported),
    categories,
  };
}
