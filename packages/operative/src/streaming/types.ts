import type { TypedEventTarget } from '@lostgradient/lifecycle';
import type { MediaContent, MultiModalContent, TokenUsage } from 'conversationalist';

import type { JSONValue } from '../types';

/** Discriminator for blocks within a stream. */
export type BlockType = 'text' | 'tool-call' | 'thinking' | 'metadata';

/** A single block tracked by the stream state machine. */
export type StreamBlock = {
  readonly id: string;
  readonly type: BlockType;
  readonly index: number;
  content: string;
  complete: boolean;
  /** For tool-call blocks: the tool name once known. */
  toolName?: string | undefined;
  /** For tool-call blocks: partial JSON arguments as they arrive. */
  partialArguments?: string | undefined;
};

/** A part's kind: the discriminator of the content part it will become. */
export type PartKind = MultiModalContent['type'];

/**
 * A media-kind part's source is never shown by an event or a state snapshot before it
 * is a managed asset: the bytes live only in the adapter-to-wrapper hand-off.
 */
export type ManagedAssetSource = Extract<MediaContent['source'], { kind: 'managed-asset' }>;

/**
 * The incremental content of one part, suited to the part's modality. Text and
 * thinking parts receive string deltas; a citation is a JSON delta on a text part; a
 * server tool's input arrives as partial JSON. A media part never receives a delta of
 * any of these kinds: binary media reports byte progress instead.
 */
export type PartDelta =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; thinking: string }
  | { kind: 'citation'; citation: JSONValue }
  | { kind: 'input-json'; partialJson: string };

/** A completed part as an event shows it: media never carries its source. */
export type CompletedPartView =
  | Exclude<MultiModalContent, MediaContent>
  | (Omit<MediaContent, 'source'> & { byteLength?: number | undefined });

/**
 * One part of the response as the state machine tracks it, identified by
 * `(messageId, partIndex)`: the id of the row it commits to and its position in that
 * row's content.
 */
export type StreamPart = {
  readonly messageId: string;
  readonly partIndex: number;
  readonly kind: PartKind;
  readonly mimeType?: string | undefined;
  status: 'streaming' | 'complete' | 'failed';
  /** Accumulated text for a text or thinking part. */
  text?: string | undefined;
  /** Bytes received so far, for a media part. */
  receivedBytes?: number | undefined;
  totalBytes?: number | undefined;
  /** The highest sequence applied; a delta at or below it is a duplicate. */
  lastSequence: number;
  /** A media part's managed asset: `linked` once the reference exists, `available` once usable. */
  asset?: { status: 'linked' | 'available'; source: ManagedAssetSource } | undefined;
  /**
   * The final part: set at completion for a non-media part, and for a media part only
   * once its asset is available, with the managed-asset source.
   */
  part?: MultiModalContent | undefined;
  error?: unknown;
};

/** Read-only snapshot of the current stream state. */
export type StreamState = {
  readonly blocks: ReadonlyArray<StreamBlock>;
  /** Ordered response parts, by part index. */
  readonly parts: ReadonlyArray<StreamPart>;
  readonly activeBlock: StreamBlock | undefined;
  readonly textContent: string;
  readonly toolCalls: ReadonlyArray<StreamBlock>;
  readonly complete: boolean;
  readonly usage?: TokenUsage | undefined;
};

/**
 * Discriminated union of all events that flow through the streaming pipeline.
 * Each variant is keyed by its `type` field.
 */
export type StreamEvent =
  | { type: 'stream:block-start'; block: StreamBlock }
  | { type: 'stream:block-delta'; block: StreamBlock; delta: string }
  | { type: 'stream:block-complete'; block: StreamBlock }
  | { type: 'stream:text-delta'; content: string; accumulated: string }
  | { type: 'stream:tool-call-start'; toolName: string; blockId: string }
  | { type: 'stream:tool-call-delta'; toolName: string; blockId: string; partialArguments: string }
  | { type: 'stream:tool-call-complete'; toolName: string; blockId: string; arguments: unknown }
  | { type: 'stream:usage'; usage: TokenUsage }
  | { type: 'stream:complete'; state: StreamState }
  | { type: 'stream:error'; error: unknown }
  | {
      type: 'stream:part-start';
      messageId: string;
      partIndex: number;
      kind: PartKind;
      mimeType?: string;
    }
  | {
      type: 'stream:part-delta';
      messageId: string;
      partIndex: number;
      sequence: number;
      delta: PartDelta;
    }
  | {
      type: 'stream:part-progress';
      messageId: string;
      partIndex: number;
      sequence: number;
      receivedBytes: number;
      totalBytes?: number;
    }
  | { type: 'stream:part-complete'; messageId: string; partIndex: number; part: CompletedPartView }
  | {
      type: 'stream:part-asset-linked';
      messageId: string;
      partIndex: number;
      source: ManagedAssetSource;
    }
  | {
      type: 'stream:part-asset-available';
      messageId: string;
      partIndex: number;
      source: ManagedAssetSource;
    }
  | { type: 'stream:part-failed'; messageId: string; partIndex: number; error: unknown };

/**
 * What a part-aware `StreamingGenerateFunction` reports through `StreamingHandle.reportPart`
 * while the provider response is still open. The wrapper owns the row, the state machine
 * and the events; the adapter only describes what it saw, in order.
 *
 * The per-part sequence is `start`, zero or more `delta` or `progress`, then `complete`;
 * `failed` may replace `complete`. `complete` is the one event that carries a media part's
 * source (inline bytes), adapter to wrapper only: the wrapper admits it as a managed asset
 * and no event, state snapshot or row ever shows the bytes.
 */
export type LivePartEvent =
  | { type: 'start'; partIndex: number; kind: PartKind; mimeType?: string | undefined }
  | { type: 'delta'; partIndex: number; sequence: number; delta: PartDelta }
  | {
      type: 'progress';
      partIndex: number;
      sequence: number;
      receivedBytes: number;
      totalBytes?: number | undefined;
    }
  | { type: 'complete'; partIndex: number; part: MultiModalContent }
  | { type: 'failed'; partIndex: number; error: unknown };

/**
 * The subset of {@link StreamEvent} a `StreamingGenerateFunction` may report
 * through `StreamingHandle.report` while the provider response is still open.
 *
 * Deliberately narrower than `StreamEvent`. Text already has a live channel
 * (`StreamingHandle.update`), and lifecycle events like `stream:complete` or
 * `stream:usage` belong to the wrapper that owns the state machine, not to the
 * adapter feeding it. `stream:tool-call-complete` is excluded too: an adapter
 * only knows a tool call's parsed `arguments` once the stream has closed and
 * the accumulated JSON has been through `JSON.parse` — the step that raises
 * `ToolCallParseError` — so the wrapper synthesizes the completion from the
 * resolved `GenerateResponse` instead.
 */
export type LiveStreamEvent = Extract<
  StreamEvent,
  { type: 'stream:tool-call-start' | 'stream:tool-call-delta' }
>;

/** Custom event class wrapping a StreamEvent for use with TypedEventTarget. */
export class StreamCustomEvent<T extends StreamEvent['type'] = StreamEvent['type']> extends Event {
  readonly detail: Extract<StreamEvent, { type: T }>;

  constructor(type: T, detail: Extract<StreamEvent, { type: T }>) {
    super(type);
    this.detail = detail;
  }
}

/** Event map for TypedEventTarget — maps each stream event type to its custom event. */
export type StreamEventMap = {
  [K in StreamEvent['type']]: StreamCustomEvent<K>;
};

/** Options for the enhanced streaming wrapper. */
export type EnhancedStreamingOptions = {
  /** Event target to emit structured stream events on. */
  eventTarget?: TypedEventTarget<StreamEventMap> | undefined;
  /** Called with each text delta. */
  onTextDelta?: ((delta: string, accumulated: string) => void) | undefined;
  /** Called when a tool call starts. */
  onToolCallStart?: ((toolName: string) => void) | undefined;
  /** Called with partial tool call arguments. */
  onToolCallDelta?: ((toolName: string, partialArgs: string) => void) | undefined;
  /**
   * Installs `StreamingHandle.report`, letting the wrapped
   * `StreamingGenerateFunction` push tool-call events through while the
   * provider response is still open. The Anthropic and OpenAI streaming
   * adapters report from `content_block_start`/`input_json_delta` and
   * `delta.tool_calls` respectively, so a host observes
   * `stream:tool-call-start` and `stream:tool-call-delta` mid-response rather
   * than after the generate promise resolves.
   *
   * Off by default, because turning it on moves event timing and changes the
   * `blockId` on tool-call events from the wrapper's own
   * `tool-${name}-${index}-${messageId}` to the provider's block id.
   *
   * A streaming function that never reports — a hand-written one, or the
   * Gemini adapter — falls back to reconstructing the tool-call events from
   * the resolved `GenerateResponse`, exactly as with this option off.
   */
  liveToolCalls?: boolean | undefined;
};

/** Input commands the state machine accepts. */
export type StreamCommand =
  | {
      type: 'part-start';
      messageId: string;
      partIndex: number;
      kind: PartKind;
      mimeType?: string | undefined;
    }
  | {
      type: 'part-delta';
      messageId: string;
      partIndex: number;
      sequence: number;
      delta: PartDelta;
    }
  | {
      type: 'part-progress';
      messageId: string;
      partIndex: number;
      sequence: number;
      receivedBytes: number;
      totalBytes?: number | undefined;
    }
  | { type: 'part-complete'; messageId: string; partIndex: number; part: CompletedPartView }
  | { type: 'part-link-asset'; messageId: string; partIndex: number; source: ManagedAssetSource }
  | {
      type: 'part-asset-available';
      messageId: string;
      partIndex: number;
      source: ManagedAssetSource;
    }
  | { type: 'part-fail'; messageId: string; partIndex: number; error: unknown }
  | { type: 'block-start'; id: string; blockType: BlockType; toolName?: string | undefined }
  | { type: 'block-delta'; id: string; delta: string }
  | { type: 'set-block-tool-name'; id: string; toolName: string }
  | { type: 'block-complete'; id: string }
  | { type: 'set-usage'; usage: TokenUsage }
  | { type: 'complete' };

/** Interface returned by createStreamStateMachine(). */
export type StreamStateMachine = {
  /** Process a command and return the updated state. */
  process(command: StreamCommand): StreamState;
  /**
   * Whether `process(command)` would change the state. A part command that cannot (a
   * duplicate or stale sequence, a delta after completion, a string delta on a media part,
   * a command for a part that never started) is a no-op.
   */
  accepts(command: StreamCommand): boolean;
  /** Get the current state without processing a command. */
  getState(): StreamState;
  /** Reset the state machine to its initial empty state. */
  reset(): void;
};
