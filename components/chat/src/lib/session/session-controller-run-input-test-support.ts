import { createConversationHistory } from '../components/chat/builders.ts';
import type { ConversationHistory, MessageInput } from '../components/chat/conversation-model.ts';
import type { ChatAttachment } from '../components/chat/input/chat-attachment.ts';
import type {
  ChatSessionControllerOptions,
  ChatSessionHooks,
  ChatSessionRequest,
} from './session-controller-support.ts';
import { createChatSessionController } from './session-controller.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export function deferred<T = void>(): Deferred<T> {
  let resolveDeferred!: (value: T) => void;
  let rejectDeferred!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export function textOf(message: MessageInput): string {
  return typeof message.content === 'string' ? message.content : '';
}

const knownAttachments = new Map<string, ChatAttachment>();

/** One attachment per id, so a test can compare what the controller passed on by equality. */
export function attachment(id: string): ChatAttachment {
  const existing = knownAttachments.get(id);
  if (existing) return existing;
  const created: ChatAttachment = {
    id,
    file: new File([id], `${id}.txt`),
    previewUrl: '',
    kind: 'document',
    status: 'ready',
  };
  knownAttachments.set(id, created);
  return created;
}

export type RunInputCall = {
  conversationId: string;
  message: MessageInput;
  attachments: ChatAttachment[];
  options: { messageId: string };
};

/** What one transport turn is handed, kept so a test can read it afterwards. */
export type RecordedTurn = {
  turn: number;
  attachments: ChatAttachment[];
  conversation: ConversationHistory;
};

/** One scripted transport turn. */
export type TurnScript = (request: ChatSessionRequest) => AsyncIterable<ChatStreamEvent>;

export async function* eventsOf(values: ChatStreamEvent[]): AsyncGenerator<ChatStreamEvent> {
  yield* values;
}

export type HarnessOptions = {
  conversation?: ConversationHistory;
  /** `null` leaves the hook out. Left alone, every call is acknowledged at once. */
  sendRunInput?: ChatSessionControllerOptions['sendRunInput'] | null;
  /** The transport's turns in order. The first holds open until `releaseRun`. */
  turns?: Array<TurnScript | undefined>;
  hooks?: ChatSessionHooks;
  executionOwner?: 'browser' | 'server';
};

/**
 * A controller around scripted turns. The first turn streams "working" and
 * then holds until `releaseRun`, so a test can submit follow-ups mid-run; every
 * later turn defaults to a short reply.
 */
export function createHarness(options: HarnessOptions = {}) {
  let conversation = options.conversation ?? createConversationHistory({ id: 'run-input' });
  const calls: RunInputCall[] = [];
  const turns: RecordedTurn[] = [];
  const errors: unknown[] = [];
  const run = deferred();
  const sendRunInput: ChatSessionControllerOptions['sendRunInput'] =
    options.sendRunInput === undefined
      ? async (conversationId, message, attachments, hookOptions) => {
          calls.push({ conversationId, message, attachments, options: hookOptions });
        }
      : (options.sendRunInput ?? undefined);
  const scripted = options.turns ?? [];
  const controller = createChatSessionController({
    getConversation: () => conversation,
    setConversation: (next) => {
      conversation = next;
    },
    // Follow-ups are a server-owned feature, so the harness is server-owned by default.
    executionOwner: options.executionOwner ?? 'server',
    transport: async (request) => {
      turns.push({
        turn: turns.length,
        attachments: request.attachments,
        conversation: request.conversation,
      });
      const script = scripted[turns.length - 1];
      if (script) return script(request);
      if (turns.length === 1)
        return (async function* held(): AsyncGenerator<ChatStreamEvent> {
          yield { type: 'text', text: 'working' };
          // Held until the test releases the run, or the user stops it.
          await Promise.race([
            run.promise,
            new Promise<void>((resolve) =>
              request.signal.addEventListener('abort', () => resolve(), { once: true }),
            ),
          ]);
        })();
      return eventsOf([{ type: 'text', text: 'reply' }]);
    },
    ...(sendRunInput ? { sendRunInput } : {}),
    hooks: { ...options.hooks, onError: (error) => errors.push(error) },
  });
  const startRun = async (attachments: ChatAttachment[] = []) => {
    const pending = controller.adapter.sendMessage({ role: 'user', content: 'start' }, attachments);
    await settle();
    return pending;
  };
  return {
    controller,
    calls,
    turns,
    errors,
    releaseRun: () => run.resolve(),
    startRun,
    setConversation: (next: ConversationHistory) => {
      conversation = next;
    },
    conversation: () => conversation,
    rows: () => conversation.ids.map((id) => conversation.messages[id]!),
    rowNamed: (content: string) =>
      Object.values(conversation.messages).find((message) => message.content === content),
  };
}

export function deliveryStatus(history: ConversationHistory, content: string): unknown {
  return Object.values(history.messages).find((message) => message.content === content)?.metadata[
    '_deliveryStatus'
  ];
}

export function isFollowUp(history: ConversationHistory, content: string): boolean {
  return (
    Object.values(history.messages).find((message) => message.content === content)?.metadata[
      '_followUp'
    ] === true
  );
}

export const approvalAction = {
  type: 'approval',
  message: 'Approve this tool call',
  risk: 'high',
  operation: { kind: 'command', command: 'echo approval', argsPreview: {} },
  policyVersion: 'test-policy',
  idempotencyKey: 'test-approval',
} as const;

/** The two frames that park a run on an approval. */
export const approvalFrames: ChatStreamEvent[] = [
  { type: 'tool_call', id: 'call', name: 'write', arguments: {} },
  {
    type: 'tool_result',
    callId: 'call',
    outcome: 'action_required',
    content: null,
    action: approvalAction,
  },
];
