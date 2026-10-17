import { createConversationHistory } from '../components/chat/builders.ts';
import type { ConversationHistory } from '../components/chat/conversation-model.ts';
import type {
  ChatElicitationActivity,
  ChatRunAbortedNotice,
  ChatSessionHooks,
  ChatToolActivity,
} from './session-controller-support.ts';
import { createChatSessionController } from './session-controller.ts';
import { hostileEvent } from './stream-event-codec-test-helpers.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';
import { decodeChatStreamEvents, encodeChatStreamEvent } from './stream-event-codec.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A frame as a test authors it: the harness owns the envelope. */
export type FrameInput = DistributiveOmit<ChatStreamEvent, 'wireVersion' | 'sequence'>;

/** Which observer, if any, the harness makes throw. */
export type ThrowingObserver = 'onToolActivity' | 'onElicitation' | 'onRunAborted';

export type FrameHarnessOptions = {
  /** One entry per transport turn; each is delivered as its own stream, stamped with the version its frames need. */
  turns: FrameInput[][];
  executionOwner?: 'browser' | 'server';
  throwingObserver?: ThrowingObserver;
  /** Which observer, if any, returns a rejected promise instead of throwing. */
  rejectingObserver?: ThrowingObserver;
  /** Make every observer scribble over the record it was handed. */
  mutateReceived?: boolean;
  /** Runs inside `onRunAborted`, with the controller, before it returns. */
  onAbortedEffect?: (controller: ReturnType<typeof createChatSessionController>) => void;
  /** Deliver the stream as NDJSON bytes instead of a decoded typed iterable. */
  asBytes?: boolean;
};

const thrown = new Error('observer failure');

/**
 * The one version a stream of these frames speaks: 3 when any frame is a
 * version 3 member (`run.started`, or a `stream:text-delta` naming its
 * message), otherwise 2. A stream commits to a single version.
 */
function streamVersion(frames: FrameInput[]): 2 | 3 {
  const needsVersion3 = frames.some(
    (frame) =>
      frame.type === 'run.started' ||
      (frame.type === 'stream:text-delta' && frame.messageId !== undefined),
  );
  return needsVersion3 ? 3 : 2;
}

/** Wraps frames in one envelope version with strictly increasing sequences. */
export function enveloped(frames: FrameInput[]): ChatStreamEvent[] {
  const wireVersion = streamVersion(frames);
  // The frame type is a union whose members tie `wireVersion` to their body,
  // so the stamped version is checked at runtime by the codec rather than by
  // the compiler, which is what `hostileEvent` exists for.
  return frames.map((frame, sequence) => hostileEvent({ ...frame, wireVersion, sequence }));
}

/** Encodes frames to NDJSON and decodes them back through the stream codec. */
export async function throughCodec(frames: FrameInput[]): Promise<ChatStreamEvent[]> {
  const ndjson = enveloped(frames)
    .map((event) => encodeChatStreamEvent(event))
    .join('');
  return Array.fromAsync(decodeChatStreamEvents(ndjson));
}

function encodedBytes(frames: FrameInput[]): ReadableStream<Uint8Array> {
  const ndjson = enveloped(frames)
    .map((event) => encodeChatStreamEvent(event))
    .join('');
  return new Response(ndjson).body ?? new ReadableStream<Uint8Array>();
}

/**
 * Runs `sendMessage` against scripted turns and records everything the
 * session reports. Frames are codec-constructed so the harness cannot hand
 * the reducer a shape the wire could not carry.
 */
export function createFrameHarness(options: FrameHarnessOptions) {
  let conversation: ConversationHistory = createConversationHistory({ id: 'frames' });
  const toolActivity: ChatToolActivity[] = [];
  const elicitations: ChatElicitationActivity[] = [];
  const aborted: ChatRunAbortedNotice[] = [];
  const toolResults: unknown[] = [];
  const errors: unknown[] = [];
  const requests: number[] = [];
  let snapshot: ConversationHistory | undefined;
  let turnIndex = 0;
  let writes = 0;
  const scribble = (record: object): void => {
    if (options.mutateReceived) Object.assign(record, { status: 'tampered' });
  };
  const hooks: ChatSessionHooks = {
    onToolResult: (result) => toolResults.push(result),
    onError: (error) => errors.push(error),
    onToolActivity: (activity) => {
      toolActivity.push(structuredClone(activity));
      scribble(activity);
      if (options.throwingObserver === 'onToolActivity') throw thrown;
      return options.rejectingObserver === 'onToolActivity' ? Promise.reject(thrown) : undefined;
    },
    onElicitation: (activity) => {
      elicitations.push(structuredClone(activity));
      scribble(activity);
      if (options.throwingObserver === 'onElicitation') throw thrown;
      return options.rejectingObserver === 'onElicitation' ? Promise.reject(thrown) : undefined;
    },
    onRunAborted: (notice) => {
      aborted.push(structuredClone(notice));
      options.onAbortedEffect?.(controller);
      if (options.throwingObserver === 'onRunAborted') throw thrown;
      return options.rejectingObserver === 'onRunAborted' ? Promise.reject(thrown) : undefined;
    },
  };
  const controller = createChatSessionController({
    executionOwner: options.executionOwner ?? 'server',
    getConversation: () => conversation,
    setConversation: (next) => {
      writes += 1;
      conversation = next;
    },
    hooks,
    transport: async ({ turn }) => {
      requests.push(turn);
      const frames = options.turns[turnIndex++] ?? [];
      if (options.asBytes) return encodedBytes(frames);
      const decoded = await throughCodec(frames);
      return (async function* () {
        for (const [index, event] of decoded.entries()) {
          // The conversation just before the last frame, which is the point at
          // which rows the frame under test produced still exist: the closing
          // terminal settles empty rows away.
          if (index === decoded.length - 1) snapshot = conversation;
          yield event;
        }
      })();
    },
  });
  return {
    get conversation() {
      return conversation;
    },
    get writes() {
      return writes;
    },
    controller,
    get snapshot() {
      return snapshot;
    },
    toolActivity,
    elicitations,
    aborted,
    toolResults,
    errors,
    requests,
    thrown,
    async send(): Promise<unknown> {
      try {
        await controller.adapter.sendMessage({ role: 'user', content: 'hi' }, []);
      } catch (error) {
        return error;
      }
      return undefined;
    },
  };
}

export type FrameHarness = ReturnType<typeof createFrameHarness>;

/** The closing terminal every non-terminal run ends with. */
export const abortedFrame = (reason?: string): FrameInput =>
  reason === undefined ? { type: 'run.aborted' } : { type: 'run.aborted', reason };

export function rolesOf(conversation: ConversationHistory): string[] {
  return conversation.ids.map((id) => conversation.messages[id]?.role ?? 'missing');
}
