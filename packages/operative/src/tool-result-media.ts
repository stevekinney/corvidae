import type { ToolExecutionResult } from 'armorer';
import { isToolContent, type ToolResultPart } from 'armorer/protocol';
import { parseDataUrl, type MediaContent, type Message } from 'conversationalist';

import { GeneratedMediaNotAdmittedError } from './errors';
import {
  admitInlineMedia,
  type GeneratedMediaAdmitter,
  type StepGeneratedMediaAdmitter,
} from './generated-media';
import { toolResultMessageIdentifier } from './message-identifiers';

/**
 * COR-792: a tool's media reaches durable Agent state only as a managed asset
 * or a reference the run's resolver authorizes on every read.
 *
 * | Part source            | On the way into the conversation                        |
 * | ---------------------- | ------------------------------------------------------- |
 * | `inline`, `data-url`   | admitted through the run's media admitter               |
 * | `managed-asset`        | kept; the resolver checks the run's principal on read   |
 * | `mcp-resource`         | kept as a reference to the server that returned it      |
 * | anything else          | refused: a tool cannot hand the run a URL, path, upload |
 * |                        | or foreign file handle and have it trusted              |
 *
 * A result whose media cannot be admitted becomes an error result naming the
 * part, so the model sees the refusal and the call is still answered.
 */
const KEPT_SOURCE_KINDS = new Set(['managed-asset', 'mcp-resource']);

class ToolResultMediaRefusal extends Error {
  constructor(
    readonly partIndex: number,
    readonly partType: string,
    detail: string,
  ) {
    super(`Tool result ${partType} part ${partIndex} was not admitted: ${detail}`);
  }
}

/** A part with a `data-url` source rewritten as inline base64, the form the admitter takes. */
function inlineDataUrl(part: ToolResultPart, partIndex: number): ToolResultPart {
  if (part.type === 'text' || part.source.kind !== 'data-url') return part;
  const parsed = parseDataUrl(part.source.url);
  if (parsed === undefined) {
    throw new ToolResultMediaRefusal(partIndex, part.type, 'its data URL is malformed');
  }
  // The URL's own type describes its bytes; the part's label may be stale.
  const mimeType = parsed.mimeType ?? part.mimeType;
  return {
    ...part,
    ...(mimeType === undefined ? {} : { mimeType }),
    source: { kind: 'inline', data: parsed.data, encoding: 'base64' },
  };
}

function assertTrustedSources(parts: readonly ToolResultPart[]): void {
  parts.forEach((part, partIndex) => {
    if (part.type === 'text') return;
    const { kind } = part.source;
    if (kind === 'inline' || kind === 'data-url' || KEPT_SOURCE_KINDS.has(kind)) return;
    throw new ToolResultMediaRefusal(
      partIndex,
      part.type,
      `a tool cannot hand the run a ${kind} source`,
    );
  });
}

/** Why a part was refused, in the tool result's own terms; never the part's bytes or URL. */
function refusalMessage(error: unknown): string {
  if (error instanceof GeneratedMediaNotAdmittedError) {
    const subject = `Tool result ${error.modality} part ${error.partIndex} was not admitted`;
    if (error.reason === 'no-admitter') return `${subject}: this run has no media admission port.`;
    return `${subject}${error.rejectionCode === undefined ? '' : ` (${error.rejectionCode})`}.`;
  }
  return error instanceof Error ? error.message : 'Tool result media was not admitted.';
}

/**
 * The error result that answers a call whose media was refused. A result that already failed keeps
 * its own message (an MCP error's text is what the model needs), with the refusal beside it in
 * `details`; a result that succeeded is replaced by the refusal.
 */
function refusedResult(result: ToolExecutionResult, error: unknown): ToolExecutionResult {
  const refusal = refusalMessage(error);
  const original = result.outcome === 'error' ? result.error?.message : undefined;
  const message = original ?? refusal;
  return {
    callId: result.callId,
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    outcome: 'error',
    content: message,
    result: message,
    error: {
      code: 'TOOL_RESULT_MEDIA_NOT_ADMITTED',
      category: 'permission',
      retryable: false,
      message,
      ...(original === undefined ? {} : { details: { refusal } }),
    },
    ...(result.inputDigest === undefined ? {} : { inputDigest: result.inputDigest }),
    ...(result.outputDigest === undefined ? {} : { outputDigest: result.outputDigest }),
    ...(result.providerCallId === undefined ? {} : { providerCallId: result.providerCallId }),
  };
}

async function admitResult(
  admitter: StepGeneratedMediaAdmitter | undefined,
  result: ToolExecutionResult,
  context: { readonly step: number; readonly runId: string | undefined },
): Promise<ToolExecutionResult> {
  const parts = result.parts;
  // Any outcome may carry parts (a hook can return an error result with media), so every
  // result with parts is checked and admitted, not only a success.
  if (parts === undefined) return result;
  try {
    assertTrustedSources(parts);
    const inlined = parts.map(inlineDataUrl);
    const messageId = toolResultMessageIdentifier(context.runId, context.step, result.callId);
    const admitted = (await admitInlineMedia(admitter, inlined, {
      step: context.step,
      messageId,
    })) as ToolResultPart[];
    if (admitted === parts) return result;
    return {
      ...result,
      parts: admitted,
      // The raw value carries the same parts; it must not keep the bytes either.
      result: isToolContent(result.result) ? { ...result.result, parts: admitted } : result.result,
    };
  } catch (error) {
    return refusedResult(result, error);
  }
}

/**
 * Admits the media in a step's tool results before anything else sees them:
 * the conversation, the step's events, and the validation hooks. Results
 * without parts are returned unchanged.
 */
export async function admitToolResultMedia(
  admitter: StepGeneratedMediaAdmitter | undefined,
  results: readonly ToolExecutionResult[],
  context: { readonly step: number; readonly runId: string | undefined },
): Promise<ToolExecutionResult[]> {
  return Promise.all(results.map((result) => admitResult(admitter, result, context)));
}

/** What retaining a step's committed tool-result media needs from the step. */
export interface ToolResultRetentionContext {
  readonly admitter: GeneratedMediaAdmitter | undefined;
  readonly runId: string | undefined;
  readonly conversation: {
    getMessages(options?: { includeHidden?: boolean }): readonly Message[];
  };
}

/**
 * After a step's tool-result rows are committed, claims the managed assets they reference through
 * the admitter's `retainCommitted`, as an assistant row's are, so none can expire while the row
 * exists. Rows are found by call id, which also covers a run with no id (minted row ids).
 */
export async function retainToolResultMedia(
  context: ToolResultRetentionContext,
  results: readonly ToolExecutionResult[],
): Promise<void> {
  const retain = context.admitter?.retainCommitted?.bind(context.admitter);
  if (retain === undefined) return;
  const managedByCall = new Map<string, MediaContent[]>();
  for (const result of results) {
    const managed = (result.parts ?? []).filter(
      (part): part is MediaContent => part.type !== 'text' && part.source.kind === 'managed-asset',
    );
    if (managed.length > 0) managedByCall.set(result.callId, managed);
  }
  if (managedByCall.size === 0) return;
  // A plugin may hide a committed row; a hidden row still references its assets.
  for (const message of context.conversation.getMessages({ includeHidden: true })) {
    const callId = message.role === 'tool-result' ? message.toolResult?.callId : undefined;
    const parts = callId === undefined ? undefined : managedByCall.get(callId);
    if (parts === undefined) continue;
    await retain({ runId: context.runId, messageId: message.id, parts });
  }
}
