import type { TokenUsage } from 'conversationalist';

import type {
  CompletedPartView,
  PartDelta,
  StreamBlock,
  StreamCommand,
  StreamPart,
  StreamState,
  StreamStateMachine,
} from './types';

const TEXT_BEARING_KINDS: ReadonlySet<StreamPart['kind']> = new Set(['text', 'thinking']);
const MEDIA_KINDS: ReadonlySet<StreamPart['kind']> = new Set([
  'image',
  'audio',
  'video',
  'document',
  'file',
]);

/**
 * Creates a state machine that tracks block-level progress through an LLM stream.
 *
 * The machine processes commands (block-start, block-delta, block-complete, set-usage,
 * complete) and maintains a read-only snapshot of the current stream state including
 * active blocks, aggregated text content, filtered tool calls, and completion status.
 *
 * It also tracks the response's ordered parts, each identified by `(messageId, partIndex)`:
 * start, a delta suited to the part's modality (text for text and thinking, byte progress
 * for media), completion, asset linked and available, and failure. A delta whose sequence
 * is not above the part's last, or that arrives after the part completed or failed, is a
 * no-op that leaves the snapshot unchanged.
 */
type PartCommand = Extract<StreamCommand, { type: `part-${string}` }>;

function isPartCommand(command: StreamCommand): command is PartCommand {
  return command.type.startsWith('part-');
}

/** Whether a delta suits the part's kind: a string delta never suits a media part. */
function deltaSuitsPart(part: StreamPart, delta: PartDelta): boolean {
  switch (delta.kind) {
    case 'text':
      return part.kind === 'text';
    case 'thinking':
      return part.kind === 'thinking';
    case 'citation':
      return part.kind === 'text';
    case 'input-json':
      return part.kind === 'server_tool_use';
  }
}

/** Applies a delta that already suits the part. */
function applyPartDelta(part: StreamPart, delta: PartDelta): void {
  if (delta.kind === 'text') part.text = (part.text ?? '') + delta.text;
  else if (delta.kind === 'thinking') part.text = (part.text ?? '') + delta.thinking;
}

export function createStreamStateMachine(): StreamStateMachine {
  /** A completed media part's view, held until its asset is available. */
  const mediaViews = new WeakMap<StreamPart, CompletedPartView>();
  let blocks: StreamBlock[] = [];
  let parts: StreamPart[] = [];
  let usage: TokenUsage | undefined;
  let complete = false;

  function findPart(messageId: string, partIndex: number): StreamPart | undefined {
    return parts.find((part) => part.messageId === messageId && part.partIndex === partIndex);
  }

  function findBlock(id: string): StreamBlock | undefined {
    return blocks.find((block) => block.id === id);
  }

  function computeActiveBlock(): StreamBlock | undefined {
    // Walk backwards to find the most recently started incomplete block
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (block && !block.complete) return block;
    }
    return undefined;
  }

  function computeTextContent(): string {
    return blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.content)
      .join('');
  }

  function computeToolCalls(): ReadonlyArray<StreamBlock> {
    return blocks.filter((block) => block.type === 'tool-call');
  }

  function buildState(): StreamState {
    return {
      blocks: [...blocks],
      parts: parts.map((part) => ({ ...part })),
      activeBlock: computeActiveBlock(),
      textContent: computeTextContent(),
      toolCalls: computeToolCalls(),
      complete,
      usage,
    };
  }

  /**
   * Whether a part command would change the state. A command that cannot (a duplicate or
   * stale sequence, a delta after completion, a string delta on a media part, a command for
   * a part that never started) is a no-op, and callers use this to avoid announcing it.
   */
  function acceptsPartCommand(command: PartCommand): boolean {
    if (command.type === 'part-start') {
      return findPart(command.messageId, command.partIndex) === undefined;
    }
    const part = findPart(command.messageId, command.partIndex);
    if (!part) return false;
    switch (command.type) {
      case 'part-delta':
        return (
          part.status === 'streaming' &&
          command.sequence > part.lastSequence &&
          deltaSuitsPart(part, command.delta)
        );
      case 'part-progress':
        return (
          part.status === 'streaming' &&
          MEDIA_KINDS.has(part.kind) &&
          command.sequence > part.lastSequence
        );
      case 'part-complete':
        return part.status === 'streaming';
      case 'part-link-asset':
        return (
          part.status === 'complete' &&
          MEDIA_KINDS.has(part.kind) &&
          part.asset?.status !== 'available'
        );
      case 'part-asset-available':
        return part.status === 'complete' && MEDIA_KINDS.has(part.kind);
      case 'part-fail':
        // A completed part is only still pending while its media asset is not yet available.
        return (
          part.status === 'streaming' ||
          (part.status === 'complete' &&
            MEDIA_KINDS.has(part.kind) &&
            part.asset?.status !== 'available')
        );
    }
  }

  function processPartCommand(command: PartCommand): void {
    if (!acceptsPartCommand(command)) return;
    if (command.type === 'part-start') {
      const part: StreamPart = {
        messageId: command.messageId,
        partIndex: command.partIndex,
        kind: command.kind,
        ...(command.mimeType === undefined ? {} : { mimeType: command.mimeType }),
        status: 'streaming',
        lastSequence: 0,
        ...(TEXT_BEARING_KINDS.has(command.kind) ? { text: '' } : {}),
        ...(MEDIA_KINDS.has(command.kind) ? { receivedBytes: 0 } : {}),
      };
      const insertAt = parts.findIndex((existing) => existing.partIndex > part.partIndex);
      if (insertAt === -1) parts.push(part);
      else parts.splice(insertAt, 0, part);
      return;
    }

    const part = findPart(command.messageId, command.partIndex)!;
    switch (command.type) {
      case 'part-delta': {
        applyPartDelta(part, command.delta);
        part.lastSequence = command.sequence;
        return;
      }
      case 'part-progress': {
        part.receivedBytes = command.receivedBytes;
        if (command.totalBytes !== undefined) part.totalBytes = command.totalBytes;
        part.lastSequence = command.sequence;
        return;
      }
      case 'part-complete': {
        part.status = 'complete';
        // A media part is not final until its asset is available.
        if (!MEDIA_KINDS.has(part.kind)) part.part = command.part as StreamPart['part'];
        else mediaViews.set(part, command.part);
        return;
      }
      case 'part-link-asset': {
        part.asset = { status: 'linked', source: command.source };
        return;
      }
      case 'part-asset-available': {
        part.asset = { status: 'available', source: command.source };
        part.part = { ...mediaViews.get(part), source: command.source } as StreamPart['part'];
        mediaViews.delete(part);
        return;
      }
      case 'part-fail': {
        part.status = 'failed';
        part.error = command.error;
        return;
      }
    }
  }

  function process(command: StreamCommand): StreamState {
    if (isPartCommand(command)) {
      processPartCommand(command);
      return buildState();
    }
    switch (command.type) {
      case 'block-start': {
        const block: StreamBlock = {
          id: command.id,
          type: command.blockType,
          index: blocks.length,
          content: '',
          complete: false,
          toolName: command.toolName,
          partialArguments: command.blockType === 'tool-call' ? '' : undefined,
        };
        blocks.push(block);
        break;
      }

      case 'block-delta': {
        const block = findBlock(command.id);
        if (!block) break;
        block.content += command.delta;
        if (block.type === 'tool-call') {
          block.partialArguments = (block.partialArguments ?? '') + command.delta;
        }
        break;
      }

      case 'set-block-tool-name': {
        const block = findBlock(command.id);
        if (!block) break;
        block.toolName = command.toolName;
        break;
      }

      case 'block-complete': {
        const block = findBlock(command.id);
        if (!block) break;
        block.complete = true;
        break;
      }

      case 'set-usage': {
        usage = { ...command.usage };
        break;
      }

      case 'complete': {
        complete = true;
        break;
      }
    }

    return buildState();
  }

  function getState(): StreamState {
    return buildState();
  }

  function reset(): void {
    blocks = [];
    parts = [];
    usage = undefined;
    complete = false;
  }

  function accepts(command: StreamCommand): boolean {
    return isPartCommand(command) ? acceptsPartCommand(command) : true;
  }

  return { process, accepts, getState, reset };
}
